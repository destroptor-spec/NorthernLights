/** @jest-environment node */
import { loadDiscogsLabels, loadMbSnapshot, loadTagAliases, tagKey, validateAliases, validateLabels } from './data';
import { buildContext, resolveTag } from './mapping';
import { parseSetting, snapshotDecision } from './seed';
import { splitStoredGenres } from './trackTags';

describe('shipped data files', () => {
  test('the Discogs label list has 400 unique labels in 15 genres and 16 repeated style names', () => {
    const { genres, styles } = loadDiscogsLabels();
    expect(styles).toHaveLength(400);
    expect(genres).toHaveLength(15);
    const names = new Map<string, number>();
    for (const s of styles) names.set(s.name, (names.get(s.name) || 0) + 1);
    expect([...names.values()].filter(n => n > 1)).toHaveLength(16);
    expect(styles[0].modelIndex).toBe(0);
  });

  test('every alias points at a real genre or style, and the MusicBrainz snapshot is consistent', () => {
    const { raw } = loadDiscogsLabels();
    const aliases = loadTagAliases(raw.classes);
    expect(Object.keys(aliases.aliases).length).toBeGreaterThan(20);
    expect(aliases.aliases[tagKey('R&B')]).toBe('Funk / Soul---Contemporary R&B');
    const snapshot = loadMbSnapshot();
    expect(snapshot.version).toMatch(/^mb-\d{8}-\d{6}$/);
    expect(snapshot.genres.length).toBeGreaterThan(2000);
  });

  test('validation rejects broken files instead of seeding them', () => {
    expect(() => validateLabels({ taxonomyVersion: 1, model: 'm', classes: ['Rock---Punk'] })).toThrow(/400/);
    expect(() => validateAliases({ aliasVersion: 1, aliases: { dance: 'Electronic---Nope' }, ignored: {} }, ['Electronic---House']))
      .toThrow(/unknown/);
  });
});

describe('tag keys and stored genres', () => {
  test('connector spellings share a key; non-Latin tags keep a non-empty key', () => {
    expect(tagKey('Drum & Bass')).toBe(tagKey('Drum n Bass'));
    expect(tagKey('Drum and Bass')).toBe('drum and bass');
    expect(tagKey('R&B')).toBe('r&b');
    expect(tagKey('サウンドトラック')).toBe('サウンドトラック');
    expect(tagKey('サウンドトラック')).not.toBe(tagKey('ロック'));
  });

  test('tracks.genres is split in file order, deduplicated, with the single genre as fallback', () => {
    expect(splitStoredGenres('["Trip Hop","Downtempo","Trip Hop"," "]', null)).toEqual(['Trip Hop', 'Downtempo']);
    expect(splitStoredGenres(null, 'Rock')).toEqual(['Rock']);
    expect(splitStoredGenres('Not JSON', null)).toEqual(['Not JSON']);
    expect(splitStoredGenres('[]', null)).toEqual([]);
  });
});

describe('tag resolution', () => {
  const labels = ['Electronic---House', 'Electronic---Trip Hop', 'Hip Hop---Trip Hop', 'Electronic---Drum n Bass',
    'Rock---Heavy Metal', 'Rock---Hard Rock', 'Funk / Soul---Soul'];
  // MusicBrainz ids: 1 metal, 2 groove metal (child of 1), 3 extreme metal (child of 1), 4 blackgaze (child of 3)
  const ctx = buildContext(labels, { dance: 'Electronic', metal: 'Rock---Heavy Metal' }, {
    mergedInto: new Map([[tagKey('Hous'), 'House']]),
    mbNameByKey: new Map([['metal', 1], ['groove metal', 2], ['extreme metal', 3], ['blackgaze', 4]]),
    mbAliasByKey: new Map([['heavy metal music', 1]]),
    mbName: new Map([[1, 'metal'], [2, 'groove metal'], [3, 'extreme metal'], [4, 'blackgaze']]),
    mbParents: new Map([[2, [1]], [3, [1]], [4, [3]]]),
  });
  const brief = (tag: string, original?: string) => resolveTag(tagKey(tag), ctx, original)
    .map(r => `${r.method}:${r.styleLabel ?? r.genre}@${r.reliability}`).sort();

  test('aliases win, then exact genre and style names', () => {
    expect(brief('Dance')).toEqual(['alias:Electronic@1']);
    expect(brief('Electronic')).toEqual(['exact:Electronic@1']);
    expect(brief('Drum & Bass')).toEqual(['exact:Electronic---Drum n Bass@1']);
  });

  test('a repeated style name maps to both genres at low reliability, for review', () => {
    expect(brief('Trip Hop')).toEqual(['exact:Electronic---Trip Hop@0.5', 'exact:Hip Hop---Trip Hop@0.5']);
  });

  test('duplicate-review merges and MusicBrainz aliases resolve through the canonical name', () => {
    expect(brief('Hous')).toEqual(['merge:Electronic---House@1']);
    expect(brief('Heavy Metal Music')).toEqual(['mb_alias:Rock---Heavy Metal@1']);
  });

  test('MusicBrainz parents map a subgenre to its nearest mapped ancestor', () => {
    expect(brief('Groove Metal')).toEqual(['mb_parent:Rock---Heavy Metal@0.8']);
    const deep = resolveTag(tagKey('Blackgaze'), ctx);
    expect(deep.map(r => r.detail)).toEqual(['via metal, 2 up']);
  });

  test('compound tags map each part when the whole tag does not resolve', () => {
    expect(brief('Hard Rock/Heavy Metal', 'Hard Rock/Heavy Metal')).toEqual(['compound:Rock---Hard Rock@0.8', 'compound:Rock---Heavy Metal@0.8']);
    expect(brief('Soul / Unknownwave', 'Soul / Unknownwave')).toEqual(['compound:Funk / Soul---Soul@0.8']);
    expect(brief('Unknownwave')).toEqual([]);
  });
});

describe('MusicBrainz snapshot decision', () => {
  test('loads into empty tables or over older data, never over a newer import', () => {
    const v = 'mb-20260408-002212';
    expect(snapshotDecision(v, false, null, null)).toBe('tables empty');
    expect(snapshotDecision(v, true, { kind: 'snapshot', version: 'mb-20250101-000000' }, null)).toMatch(/older/);
    expect(snapshotDecision(v, true, { kind: 'snapshot', version: v }, null)).toBeNull();
    expect(snapshotDecision(v, true, null, '20261001-000000')).toBeNull();
    expect(snapshotDecision(v, true, null, '20250101-000000')).toMatch(/older/);
    expect(snapshotDecision(v, true, null, null)).toBe('unknown genre source');
  });

  test('settings stored double-encoded still parse', () => {
    expect(parseSetting(JSON.stringify(JSON.stringify({ kind: 'import' })))).toEqual({ kind: 'import' });
    expect(parseSetting({ kind: 'snapshot' })).toEqual({ kind: 'snapshot' });
    expect(parseSetting('not json')).toBeNull();
  });
});

describe('artist tags per provider', () => {
  const { normaliseProviderTags, mergeForDisplay } = jest.requireActual('./artistTags') as typeof import('./artistTags');

  test('MusicBrainz genres and tags merge by maximum, then weight against the strongest tag', () => {
    const tags = normaliseProviderTags([
      { name: 'electronic', count: 4 }, { name: 'Electronic', count: 4 }, // genre + tag, same votes
      { name: 'downtempo', count: 2 }, { name: 'zero', count: 0 }, { name: '', count: 3 },
    ]);
    expect(tags.map(t => [t.name, t.rawCount, t.weight])).toEqual([['electronic', 4, 1], ['downtempo', 2, 0.5]]);
    expect(tags[0].key).toBe('electronic');
    expect(normaliseProviderTags([{ name: 'x', count: 0 }])).toEqual([]);
  });

  test('display chips use the strongest provider weight, never a sum across providers', () => {
    const lastfm = normaliseProviderTags([{ name: 'trip-hop', count: 100 }, { name: 'electronic', count: 40 }]);
    const mb = normaliseProviderTags([{ name: 'electronic', count: 3 }, { name: 'trip-hop', count: 1 }]);
    expect(mergeForDisplay({ lastfm, musicbrainz: mb })).toEqual([
      { name: 'electronic', count: 100, providers: ['lastfm', 'musicbrainz'] },
      { name: 'trip-hop', count: 100, providers: ['lastfm', 'musicbrainz'] },
    ]);
    expect(mergeForDisplay({})).toBeUndefined();
  });
});
