/**
 * The genre review queue (Settings → Library entities → Genres), phase 1b of
 * docs/Aurora genre and style redesign.md.
 *
 * One entry per original tag the mapping can't settle on its own (no match, a
 * style name under two genres, a MusicBrainz-parent guess, a compound tag),
 * plus spelling duplicates from the old genre list, whose answers still group
 * `genres` for the old engine until phase 4. Name matches are accepted in
 * bulk. Every answer stores the tags' rows from before, so it can be undone
 * for 30 days; a later answer on the same tag has to be undone first.
 *
 * Only tags used by tracks are reviewed (the phase-1 gate counts those);
 * artist-tag-only keys are evidence, not questions.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  GENRE_REVIEW_UNDO_DAYS,
  listJoin,
  targetKey,
  targetLabel,
  type GenreAudioEvidence,
  type GenreExactMatch,
  type GenreGroup,
  type GenreIgnoredTag,
  type GenreReviewDecision,
  type GenreReviewDecisionKind,
  type GenreReviewEntry,
  type GenreReviewEvidence,
  type GenreReviewKind,
  type GenreReviewOutcome,
  type GenreReviewState,
  type GenreSuggestion,
  type GenreTarget,
} from '../../../shared/genreReview';
import { getMappingCoverage, COVERAGE_TARGET } from './coverage';
import { loadDiscogsLabels, loadTagAliases, tagKey } from './data';
import { mappingVersion, runTagMapping } from './mapping';

const TAG_PREFIX = 'tag:';
const SPELLING_PREFIX = 'spelling:';
const LEAN_MIN_WEIGHT = 0.3;
/** Share of artists that must lean one way before artist tags suggest a genre. */
const LEAN_SUGGEST_SHARE = 0.6;
/** Audio alone suggests a genre only when this share of the tracks agrees. */
const AUDIO_ALONE_SHARE = 0.7;
/** A style is suggested only when this share of the tracks has it as top style. */
const STYLE_SUGGEST_SHARE = 0.5;
const AUDIO_MIN_TRACKS = 3;
const AUDIO_SAMPLE = 1000;

export class GenreReviewError extends Error {
  constructor(message: string, public code?: string) { super(message); this.name = 'GenreReviewError'; }
}

interface MapRow {
  tag: string; genre: string; style_id: number | null; style: string | null;
  method: string; reliability: number; detail: string | null; reviewed: boolean;
}
interface TagUsage { key: string; subject: string; tracks: number }

// ── Loading ──────────────────────────────────────────────────────────────

async function loadUsage(db: Pool | PoolClient, keys?: string[]): Promise<Map<string, TagUsage>> {
  const rows = (await db.query(`
    SELECT tag_key, mode() WITHIN GROUP (ORDER BY tag) AS subject, COUNT(DISTINCT track_id)::int AS tracks
    FROM track_tags ${keys ? 'WHERE tag_key = ANY($1)' : ''} GROUP BY tag_key`, keys ? [keys] : [])).rows;
  return new Map(rows.map((r: any) => [r.tag_key, { key: r.tag_key, subject: r.subject, tracks: r.tracks }]));
}

async function loadRows(db: Pool | PoolClient, keys?: string[]): Promise<Map<string, MapRow[]>> {
  const rows = (await db.query(`
    SELECT m.tag, m.genre, m.style_id, s.name AS style, m.method, m.reliability, m.detail,
           (m.reviewed_at IS NOT NULL OR m.method = 'manual') AS reviewed
    FROM tag_map m LEFT JOIN style s ON s.id = m.style_id
    WHERE ${keys ? 'm.tag = ANY($1)' : 'm.tag IN (SELECT DISTINCT tag_key FROM track_tags)'}
    ORDER BY m.tag, m.genre, s.name NULLS FIRST`, keys ? [keys] : [])).rows as MapRow[];
  const byTag = new Map<string, MapRow[]>();
  for (const row of rows) byTag.set(row.tag, [...(byTag.get(row.tag) || []), row]);
  return byTag;
}

async function loadIgnored(db: Pool | PoolClient, keys?: string[]): Promise<Map<string, { source: string }>> {
  const rows = (await db.query(
    `SELECT tag, source FROM tag_ignored ${keys ? 'WHERE tag = ANY($1)' : ''}`, keys ? [keys] : [])).rows;
  return new Map(rows.map((r: any) => [r.tag, { source: r.source }]));
}

// ── Entries ──────────────────────────────────────────────────────────────

const toTarget = (row: Pick<MapRow, 'genre' | 'style_id' | 'style'>): GenreTarget =>
  ({ genre: row.genre, styleId: row.style_id ?? null, style: row.style ?? null });

function classify(rows: MapRow[], ignored: boolean): GenreReviewKind {
  if (ignored) return 'ignored';
  if (rows.length === 0) return 'unmapped';
  const open = rows.filter(r => !r.reviewed);
  if (open.length === 0) return 'reviewed';
  if (open.some(r => r.method === 'compound')) return 'compound';
  if (open.some(r => (r.detail || '').includes('ambiguous'))) return 'two-genres';
  if (open.some(r => r.method === 'mb_parent')) return 'guessed';
  return 'exact';
}

function noteFor(kind: GenreReviewKind, rows: MapRow[]): string | undefined {
  const details = rows.map(r => r.detail || '');
  const via = details.map(d => /^via (.+), (\d+) up/.exec(d)).find(Boolean);
  if (via) return `MusicBrainz lists it under ${via[1]}`;
  if (kind === 'two-genres') return 'A style name found under two genres';
  if (kind === 'compound') return 'Several genres in one tag';
  const alias = details.map(d => /^MusicBrainz alias of (.+)/.exec(d)).find(Boolean);
  if (alias) return `MusicBrainz spells it ${alias[1]}`;
  const merged = details.map(d => /^merged into (.+)/.exec(d)).find(Boolean);
  if (merged) return `Kept as one genre with ${merged[1]}`;
  return undefined;
}

function signatureOf(parts: unknown): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function tagEntry(usage: TagUsage, rows: MapRow[], ignored: boolean): GenreReviewEntry {
  const kind = classify(rows, ignored);
  const current = rows.map(toTarget);
  const all = listJoin(current.map(targetLabel));
  const outcomes: GenreReviewOutcome[] = [];
  const pick: GenreReviewOutcome = { id: 'pick', kind: 'pick', label: rows.length ? 'Something else' : 'Choose a genre or style' };
  const ignore: GenreReviewOutcome = { id: 'ignore', kind: 'ignore', label: 'Not a genre' };
  switch (kind) {
    case 'unmapped': outcomes.push(pick, ignore); break;
    case 'two-genres':
      current.forEach((target, index) => outcomes.push({ id: `only:${index}`, kind: 'only', label: targetLabel(target), targets: [target] }));
      outcomes.push({ id: 'accept', kind: 'accept', label: 'Both', targets: current }, pick);
      break;
    case 'guessed': case 'compound': case 'exact':
      outcomes.push({ id: 'accept', kind: 'accept', label: all, targets: current }, pick, ignore);
      break;
    case 'reviewed': outcomes.push({ ...pick, label: 'Change to…' }, ignore); break;
    case 'ignored': outcomes.push({ id: 'restore', kind: 'restore', label: 'It is a genre' }, pick); break;
  }
  return {
    key: `${TAG_PREFIX}${usage.key}`,
    signature: signatureOf([ignored, rows.map(r => [r.genre, r.style_id, r.method, r.reviewed])]),
    kind,
    subject: usage.subject,
    tagKey: usage.key,
    totalTracks: usage.tracks,
    current,
    note: noteFor(kind, rows),
    outcomes,
  };
}

async function spellingEntries(): Promise<{ entries: GenreReviewEntry[]; groups: GenreGroup[] }> {
  const { getGenreReviewState } = await import('../genreCanonicalization.service');
  const state = await getGenreReviewState();
  const spelling = (g: { id: string; name: string; trackCount: number }) => ({ id: g.id, name: g.name, trackCount: g.trackCount });
  const entries = state.candidates.map(candidate => ({
    key: `${SPELLING_PREFIX}${candidate.candidateKey}`,
    signature: candidate.signature,
    kind: 'spelling' as const,
    subject: listJoin(candidate.genres.map(g => g.name)),
    totalTracks: candidate.genres.reduce((sum, g) => sum + g.trackCount, 0),
    current: [],
    spellings: candidate.genres.map(spelling),
    taxonomyConflict: candidate.taxonomyConflict,
    outcomes: [
      ...candidate.genres.map(g => ({ id: `merge:${g.id}`, kind: 'merge' as const, label: `Keep "${g.name}"` })),
      { id: 'keep-apart', kind: 'keep-apart' as const, label: 'Keep apart' },
    ],
  }));
  const groups = state.groups.map(g => ({ canonical: spelling(g.canonical), aliases: g.aliases.map(spelling) }));
  return { entries, groups };
}

const QUEUE_KINDS = new Set<GenreReviewKind>(['unmapped', 'two-genres', 'guessed', 'compound']);

export async function getGenreReviewState(db: Pool): Promise<GenreReviewState> {
  const [usage, rows, ignored, coverage, spellings] = await Promise.all([
    loadUsage(db), loadRows(db), loadIgnored(db), getMappingCoverage(db, 0), spellingEntries(),
  ]);
  const entries: GenreReviewEntry[] = [];
  const exact: GenreExactMatch[] = [];
  const ignoredTags: GenreIgnoredTag[] = [];
  for (const tag of usage.values()) {
    const ignore = ignored.get(tag.key);
    const entry = tagEntry(tag, rows.get(tag.key) || [], Boolean(ignore));
    if (QUEUE_KINDS.has(entry.kind)) entries.push(entry);
    else if (entry.kind === 'exact') exact.push({ key: entry.key, signature: entry.signature, subject: entry.subject, targets: entry.current, tracks: entry.totalTracks });
    else if (entry.kind === 'ignored') ignoredTags.push({ key: entry.key, signature: entry.signature, subject: entry.subject, tracks: entry.totalTracks, byHand: ignore!.source === 'manual' });
  }
  const byTracks = <T extends { tracks?: number; totalTracks?: number; subject: string }>(a: T, b: T) =>
    (b.totalTracks ?? b.tracks ?? 0) - (a.totalTracks ?? a.tracks ?? 0) || a.subject.localeCompare(b.subject);
  entries.push(...spellings.entries);
  const effective = coverage.tracks.tagged - coverage.tracks.ignoredOnly;
  return {
    entries: entries.sort(byTracks),
    exact: exact.sort(byTracks),
    ignored: ignoredTags.sort(byTracks),
    groups: spellings.groups,
    coverage: { tagged: effective, mapped: coverage.tracks.mapped, ratio: coverage.tracks.coverage, target: COVERAGE_TARGET },
  };
}

/** Any tag's entry (queue, bulk, Find a tag) or a spelling entry still in the queue. */
export async function getGenreReviewEntry(db: Pool | PoolClient, key: string): Promise<GenreReviewEntry | null> {
  if (key.startsWith(SPELLING_PREFIX)) {
    return (await spellingEntries()).entries.find(entry => entry.key === key) || null;
  }
  if (!key.startsWith(TAG_PREFIX)) return null;
  const tag = key.slice(TAG_PREFIX.length);
  const usage = (await loadUsage(db, [tag])).get(tag);
  if (!usage) return null;
  const ignored = await loadIgnored(db, [tag]);
  return tagEntry(usage, (await loadRows(db, [tag])).get(tag) || [], ignored.has(tag));
}

/** Find a tag: tags whose spelling contains the query, most tracks first. */
export async function searchGenreTags(db: Pool, query: string, limit = 12): Promise<GenreReviewEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const keys = (await db.query(`
    SELECT tag_key FROM track_tags
    WHERE strpos(tag_key, $1) > 0 OR strpos(lower(tag), $1) > 0
    GROUP BY tag_key ORDER BY COUNT(DISTINCT track_id) DESC, tag_key LIMIT $2`, [q, limit])).rows.map((r: any) => r.tag_key);
  if (!keys.length) return [];
  const [usage, rows, ignored] = await Promise.all([loadUsage(db, keys), loadRows(db, keys), loadIgnored(db, keys)]);
  return keys.map(key => tagEntry(usage.get(key)!, rows.get(key) || [], ignored.has(key)));
}

export async function listTaxonomy(db: Pool): Promise<{ genres: string[]; styles: Array<{ id: number; genre: string; name: string }> }> {
  const genres = (await db.query('SELECT name FROM taxonomy_genre WHERE NOT hidden ORDER BY name')).rows.map((r: any) => r.name);
  const styles = (await db.query(`
    SELECT s.id, s.genre, s.name FROM style s JOIN taxonomy_genre g ON g.name = s.genre
    WHERE NOT g.hidden ORDER BY s.name, s.genre`)).rows;
  return { genres, styles };
}

// ── Evidence ─────────────────────────────────────────────────────────────

export async function getGenreReviewEvidence(db: Pool, key: string): Promise<GenreReviewEvidence | null> {
  const entry = await getGenreReviewEntry(db, key);
  if (!entry) return null;
  // The tracks the question is about: by original tag, or by the old genre list for spellings.
  const tracksSql = entry.tagKey !== undefined
    ? 'SELECT DISTINCT track_id FROM track_tags WHERE tag_key = $1'
    : 'SELECT DISTINCT track_id FROM track_genres WHERE genre_id = ANY($1::uuid[])';
  const param = entry.tagKey !== undefined ? entry.tagKey : (entry.spellings || []).map(s => s.id);

  const artistRows = (await db.query(`
    WITH t AS (${tracksSql})
    SELECT a.id, a.name, a.image_url, COUNT(*)::int AS tracks
    FROM t JOIN tracks tr ON tr.id = t.track_id JOIN artists a ON a.id = tr.artist_id
    WHERE lower(a.name) <> 'various artists'
    GROUP BY a.id ORDER BY tracks DESC, a.name LIMIT 20`, [param])).rows;
  const albums = (await db.query(`
    WITH t AS (${tracksSql})
    SELECT al.title FROM t JOIN tracks tr ON tr.id = t.track_id JOIN albums al ON al.id = tr.album_id
    GROUP BY al.id, al.title ORDER BY COUNT(*) DESC, al.title LIMIT 3`, [param])).rows.map((r: any) => String(r.title));

  // Optional: where provider artist tags put these artists. Per artist, each
  // provider gives a genre its strongest mapped tag's weight; the providers'
  // weights add up, and the highest genre is the artist's. Without Last.fm or
  // MusicBrainz data this is simply absent.
  const artistIds = artistRows.map((r: any) => r.id);
  const artistGenres = (await db.query(`
    WITH per_provider AS (
      SELECT at.artist_id, at.provider, m.genre, MAX(at.weight) AS w
      FROM artist_tags at JOIN tag_map m ON m.tag = at.tag_key
      WHERE at.artist_id = ANY($1::uuid[]) AND at.weight >= $2 AND m.reliability >= 0.8
        AND ($3::text IS NULL OR at.tag_key <> $3)
      GROUP BY at.artist_id, at.provider, m.genre
    ), per_genre AS (
      SELECT artist_id, genre, SUM(w) AS w FROM per_provider GROUP BY artist_id, genre
    )
    SELECT DISTINCT ON (artist_id) artist_id, genre FROM per_genre ORDER BY artist_id, w DESC, genre`,
  [artistIds, LEAN_MIN_WEIGHT, entry.tagKey ?? null])).rows.map((r: any) => String(r.genre));
  const leanCounts = new Map<string, number>();
  for (const genre of artistGenres) leanCounts.set(genre, (leanCounts.get(genre) || 0) + 1);
  const [leanGenre, leanArtists] = [...leanCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || [];
  const lean = leanGenre ? { genre: leanGenre, artists: leanArtists!, of: artistGenres.length } : null;

  // One artist has no lean to show, so show their own tags instead: both
  // providers together, one entry per tag, by its stronger weight.
  let artistTags: GenreReviewEvidence['artistTags'] = null;
  if (artistRows.length === 1) {
    const tags = (await db.query(`
      SELECT mode() WITHIN GROUP (ORDER BY tag) AS tag, MAX(weight) AS weight
      FROM artist_tags WHERE artist_id = $1 AND weight >= 0.2
      GROUP BY tag_key ORDER BY weight DESC, tag_key LIMIT 8`, [artistRows[0].id])).rows.map((r: any) => String(r.tag));
    if (tags.length) artistTags = tags;
  }

  const audio = await loadAudioEvidence(db, tracksSql, param, entry.totalTracks);
  const artistLean = lean && { genre: lean.genre, strong: lean.of === 1 || lean.artists / lean.of >= LEAN_SUGGEST_SHARE };

  const targets = new Map<string, GenreTarget>();
  for (const outcome of entry.outcomes) for (const target of outcome.targets || []) targets.set(targetKey(target), target);
  const targetTracks: Record<string, number> = {};
  if (targets.size) {
    const list = [...targets.values()];
    const counts = (await db.query(`
      SELECT k.genre, k.style_id,
             (SELECT COUNT(DISTINCT tt.track_id) FROM track_tags tt JOIN tag_map m ON m.tag = tt.tag_key
               WHERE m.genre = k.genre AND (k.style_id IS NULL OR m.style_id = k.style_id)
                 AND tt.tag_key IS DISTINCT FROM $3)::int AS n
      FROM unnest($1::text[], $2::int[]) AS k(genre, style_id)`,
    [list.map(t => t.genre), list.map(t => t.styleId), entry.tagKey ?? null])).rows;
    for (const row of counts) targetTracks[targetKey({ genre: row.genre, styleId: row.style_id })] = row.n;
  }

  return {
    key,
    artists: artistRows.slice(0, 3).map((r: any) => ({ name: r.name, imageUrl: r.image_url || null, tracks: r.tracks })),
    albums,
    lean: lean && lean.of >= 2 ? lean : null,
    artistTags,
    audio,
    suggestion: suggestGenre(audio, artistLean),
    targetTracks,
  };
}

/**
 * Per track, its top style among the 400 scores (and that style's genre),
 * counted over the tag's analysed, non-simulated tracks. Large tags are
 * sampled, which keeps this to about 0.1 s.
 */
async function loadAudioEvidence(db: Pool, tracksSql: string, param: unknown, totalTracks: number): Promise<GenreAudioEvidence | null> {
  const rows = (await db.query(`
    WITH t AS (${tracksSql}),
    scored AS (
      SELECT t.track_id, ss.scores
      FROM t JOIN track_style_scores ss ON ss.track_id = t.track_id
      JOIN track_features tf ON tf.track_id = t.track_id AND tf.is_simulated IS NOT TRUE
      ORDER BY md5(t.track_id) LIMIT ${AUDIO_SAMPLE}
    ), top AS (
      SELECT (SELECT u.idx FROM unnest(scored.scores) WITH ORDINALITY u(score, idx) ORDER BY u.score DESC LIMIT 1) - 1 AS model_index
      FROM scored
    )
    SELECT st.genre, st.id, st.name, COUNT(*)::int AS tracks
    FROM top JOIN style st ON st.model_index = top.model_index
    GROUP BY st.genre, st.id, st.name ORDER BY tracks DESC, st.genre, st.name`, [param])).rows;
  const analysed = rows.reduce((sum: number, r: any) => sum + r.tracks, 0);
  if (!analysed) return null;
  const sampled = analysed === AUDIO_SAMPLE && totalTracks > AUDIO_SAMPLE;
  const genres = new Map<string, number>();
  for (const row of rows) genres.set(row.genre, (genres.get(row.genre) || 0) + row.tracks);
  return {
    analysed,
    sampled,
    genres: [...genres.entries()].map(([genre, tracks]) => ({ genre, tracks }))
      .sort((a, b) => b.tracks - a.tracks || a.genre.localeCompare(b.genre)),
    styles: rows.map((r: any) => ({ genre: r.genre, styleId: r.id, style: r.name, tracks: r.tracks })),
  };
}

/**
 * A starting answer from the audio and the optional artist tags. Artist tags
 * describe the artist, and on genre they beat audio (docs: Artist tags), so
 * when both exist they must agree. Alone, artist tags need a strong lean
 * (most artists, or the only one) and audio most of the tracks. A style is
 * suggested only when most tracks share it; otherwise the genre alone, so one
 * tag doesn't stamp every track of an artist whose albums differ with one style.
 */
export function suggestGenre(
  audio: GenreAudioEvidence | null,
  artist: { genre: string; strong: boolean } | null,
): GenreSuggestion | null {
  const usable = audio && audio.analysed >= AUDIO_MIN_TRACKS ? audio : null;
  const audioTop = usable?.genres[0] || null;
  let genre: string;
  let basis: GenreSuggestion['basis'];
  if (artist && audioTop) {
    if (audioTop.genre !== artist.genre) return null;
    genre = artist.genre;
    basis = 'both';
  } else if (artist?.strong) {
    genre = artist.genre;
    basis = 'artists';
  } else if (artist) {
    return null;
  } else if (audioTop && audioTop.tracks / usable!.analysed >= AUDIO_ALONE_SHARE) {
    genre = audioTop.genre;
    basis = 'audio';
  } else {
    return null;
  }
  const topStyle = usable?.styles.find(s => s.genre === genre);
  if (topStyle && topStyle.tracks / usable!.analysed >= STYLE_SUGGEST_SHARE) {
    return { targets: [{ genre, styleId: topStyle.styleId, style: topStyle.style }], basis, stylesVary: false };
  }
  return { targets: [{ genre, styleId: null, style: null }], basis, stylesVary: Boolean(usable) };
}

// ── Decisions ────────────────────────────────────────────────────────────

interface Snapshot { map: any[]; ignored: any[] }

async function snapshot(client: PoolClient, tags: string[]): Promise<Snapshot> {
  const map = (await client.query(
    `SELECT tag, genre, style_id, method, reliability, mapping_version, detail, reviewed_at, reviewed_by
     FROM tag_map WHERE tag = ANY($1)`, [tags])).rows;
  const ignored = (await client.query(
    'SELECT tag, reason, source, reviewed_at, reviewed_by FROM tag_ignored WHERE tag = ANY($1)', [tags])).rows;
  return { map, ignored };
}

async function restoreSnapshot(client: PoolClient, tags: string[], before: Snapshot) {
  await client.query('DELETE FROM tag_map WHERE tag = ANY($1)', [tags]);
  await client.query('DELETE FROM tag_ignored WHERE tag = ANY($1)', [tags]);
  for (const r of before.map || []) {
    await client.query(
      `INSERT INTO tag_map (tag, genre, style_id, method, reliability, mapping_version, detail, reviewed_at, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.tag, r.genre, r.style_id, r.method, r.reliability, r.mapping_version, r.detail, r.reviewed_at, r.reviewed_by]);
  }
  for (const r of before.ignored || []) {
    await client.query('INSERT INTO tag_ignored (tag, reason, source, reviewed_at, reviewed_by) VALUES ($1, $2, $3, $4, $5)',
      [r.tag, r.reason, r.source, r.reviewed_at, r.reviewed_by]);
  }
}

async function record(client: PoolClient, opts: {
  key: string; decision: GenreReviewDecisionKind; summary: string; tags: string[]; before: Snapshot; detail?: unknown; userId?: string | null;
}): Promise<string> {
  return String((await client.query(
    `INSERT INTO genre_review_decisions (entry_key, decision, summary, tags, before, detail, decided_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING id`,
    [opts.key, opts.decision, opts.summary, opts.tags, JSON.stringify(opts.before), JSON.stringify(opts.detail ?? null), opts.userId || null],
  )).rows[0].id);
}

async function inTransaction<T>(db: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Checks hand-picked targets against the genre list; the client sends genre + style id. */
async function validTargets(client: PoolClient, raw: unknown): Promise<GenreTarget[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) throw new GenreReviewError('Choose one or more genres or styles');
  const out = new Map<string, GenreTarget>();
  for (const item of raw as Array<{ genre?: unknown; styleId?: unknown }>) {
    const genre = typeof item?.genre === 'string' ? item.genre : '';
    const styleId = item?.styleId === null || item?.styleId === undefined ? null : Number(item.styleId);
    if (styleId === null) {
      const ok = (await client.query('SELECT 1 FROM taxonomy_genre WHERE name = $1 AND NOT hidden', [genre])).rowCount;
      if (!ok) throw new GenreReviewError(`Unknown genre: ${genre}`);
      out.set(targetKey({ genre, styleId }), { genre, styleId: null, style: null });
    } else {
      const style = (await client.query('SELECT name FROM style WHERE id = $1 AND genre = $2', [styleId, genre])).rows[0];
      if (!style) throw new GenreReviewError('Unknown style');
      out.set(targetKey({ genre, styleId }), { genre, styleId, style: style.name });
    }
  }
  return [...out.values()];
}

async function setManual(client: PoolClient, tag: string, targets: GenreTarget[], userId: string | null) {
  const { raw } = loadDiscogsLabels();
  const version = mappingVersion(loadTagAliases(raw.classes).aliasVersion);
  await client.query('DELETE FROM tag_map WHERE tag = $1', [tag]);
  await client.query('DELETE FROM tag_ignored WHERE tag = $1', [tag]);
  for (const target of targets) {
    await client.query(
      `INSERT INTO tag_map (tag, genre, style_id, method, reliability, mapping_version, reviewed_at, reviewed_by)
       VALUES ($1, $2, $3, 'manual', 1, $4, NOW(), $5)`, [tag, target.genre, target.styleId, version, userId]);
  }
}

export async function decideGenreReview(db: Pool, opts: {
  key: string; signature: string; outcomeId: string; targets?: unknown; acknowledgeConflict?: boolean; userId?: string | null;
}): Promise<{ decisionId: string; summary: string }> {
  const entry = await getGenreReviewEntry(db, opts.key);
  if (!entry || entry.signature !== opts.signature) throw new GenreReviewError('This entry has changed since it was loaded');
  const outcome = entry.outcomes.find(o => o.id === opts.outcomeId);
  if (!outcome) throw new GenreReviewError('Unknown outcome');
  const userId = opts.userId || null;

  if (entry.kind === 'spelling') return decideSpelling(db, entry, outcome, opts);

  const tag = entry.tagKey!;
  let remap = false;
  const result = await inTransaction(db, async client => {
    const before = await snapshot(client, [tag]);
    let decision: GenreReviewDecisionKind;
    let summary: string;
    switch (outcome.kind) {
      case 'accept':
        await client.query(
          'UPDATE tag_map SET reviewed_at = NOW(), reviewed_by = $2 WHERE tag = $1 AND reviewed_at IS NULL', [tag, userId]);
        decision = 'accepted';
        summary = `${entry.subject} → ${listJoin(entry.current.map(targetLabel))}`;
        break;
      case 'only': case 'pick': {
        const targets = outcome.kind === 'only' ? outcome.targets! : await validTargets(client, opts.targets);
        await setManual(client, tag, targets, userId);
        decision = 'mapped';
        summary = `${entry.subject} → ${listJoin(targets.map(targetLabel))}`;
        break;
      }
      case 'ignore':
        await client.query('DELETE FROM tag_map WHERE tag = $1', [tag]);
        await client.query(
          `INSERT INTO tag_ignored (tag, reason, source, reviewed_at, reviewed_by) VALUES ($1, 'not a genre', 'manual', NOW(), $2)
           ON CONFLICT (tag) DO UPDATE SET reason = EXCLUDED.reason, source = 'manual', reviewed_at = NOW(), reviewed_by = EXCLUDED.reviewed_by`,
          [tag, userId]);
        decision = 'ignored';
        summary = `${entry.subject}: not a genre`;
        break;
      case 'restore':
        await client.query('DELETE FROM tag_ignored WHERE tag = $1', [tag]);
        remap = true;
        decision = 'restored';
        summary = `${entry.subject}: a genre again`;
        break;
      default:
        throw new GenreReviewError('Unknown outcome');
    }
    const decisionId = await record(client, { key: entry.key, decision, summary, tags: [tag], before, userId });
    return { decisionId, summary };
  });
  // A restored tag goes back through the automatic mapping (and into the queue).
  if (remap) await runTagMapping(db);
  return result;
}

async function decideSpelling(db: Pool, entry: GenreReviewEntry, outcome: GenreReviewOutcome, opts: {
  acknowledgeConflict?: boolean; userId?: string | null;
}): Promise<{ decisionId: string; summary: string }> {
  const canonicalModule = await import('../genreCanonicalization.service');
  const candidateKey = entry.key.slice(SPELLING_PREFIX.length);
  const spellings = entry.spellings || [];
  const tags = [...new Set(spellings.map(s => tagKey(s.name)))];
  const client = await db.connect();
  let before: Snapshot;
  try { before = await snapshot(client, tags); } finally { client.release(); }

  let decision: GenreReviewDecisionKind;
  let summary: string;
  let detail: Record<string, unknown>;
  if (outcome.kind === 'merge') {
    const canonicalId = outcome.id.slice('merge:'.length);
    const canonical = spellings.find(s => s.id === canonicalId);
    if (!canonical) throw new GenreReviewError('Unknown outcome');
    const aliasIds = spellings.filter(s => s.id !== canonicalId).map(s => s.id);
    try {
      await canonicalModule.groupGenres({
        canonicalGenreId: canonicalId, aliasGenreIds: aliasIds, candidateKey, signature: entry.signature,
        acknowledgeTaxonomyConflict: opts.acknowledgeConflict === true, userId: opts.userId,
      });
    } catch (error: any) {
      if (error?.code === 'GENRE_TAXONOMY_CONFLICT') {
        throw new GenreReviewError('These spellings sit in different parts of the genre tree', 'GENRE_TAXONOMY_CONFLICT');
      }
      throw error;
    }
    // The other spellings now map through the kept one.
    await runTagMapping(db);
    decision = 'grouped';
    summary = `${entry.subject} → ${canonical.name}`;
    detail = { canonicalId, aliasIds };
  } else {
    await canonicalModule.dismissGenreCandidate({
      candidateKey, signature: entry.signature, genreIds: spellings.map(s => s.id), userId: opts.userId,
    });
    decision = 'kept-apart';
    summary = `Kept ${entry.subject} apart`;
    detail = {};
  }
  const reviewId = (await db.query(
    'SELECT id FROM genre_duplicate_reviews WHERE candidate_key = $1 ORDER BY created_at DESC LIMIT 1', [candidateKey])).rows[0]?.id;
  return inTransaction(db, async c => ({
    decisionId: await record(c, { key: entry.key, decision, summary, tags, before, detail: { ...detail, reviewId }, userId: opts.userId }),
    summary,
  }));
}

/** Accepts the listed name matches that are still unchanged, as one decision. */
export async function acceptExactMatches(db: Pool, opts: {
  items: Array<{ key: string; signature: string }>; userId?: string | null;
}): Promise<{ decisionId: string | null; summary: string; accepted: number }> {
  const wanted = new Map(opts.items.filter(i => typeof i?.key === 'string' && i.key.startsWith(TAG_PREFIX))
    .map(i => [i.key.slice(TAG_PREFIX.length), String(i.signature)]));
  const keys = [...wanted.keys()];
  if (!keys.length) return { decisionId: null, summary: 'Nothing to accept', accepted: 0 };
  const [usage, rows, ignored] = await Promise.all([loadUsage(db, keys), loadRows(db, keys), loadIgnored(db, keys)]);
  const tags = keys.filter(key => {
    const u = usage.get(key);
    if (!u) return false;
    const entry = tagEntry(u, rows.get(key) || [], ignored.has(key));
    return entry.kind === 'exact' && entry.signature === wanted.get(key);
  });
  if (!tags.length) throw new GenreReviewError('These matches have changed since they were loaded');
  const summary = `Accepted ${tags.length} name match${tags.length === 1 ? '' : 'es'}`;
  return inTransaction(db, async client => {
    const before = await snapshot(client, tags);
    await client.query(
      'UPDATE tag_map SET reviewed_at = NOW(), reviewed_by = $2 WHERE tag = ANY($1) AND reviewed_at IS NULL', [tags, opts.userId || null]);
    const decisionId = await record(client, { key: 'exact', decision: 'accepted-exact', summary, tags, before, userId: opts.userId });
    return { decisionId, summary, accepted: tags.length };
  });
}

/** Separates a spelling kept as one genre in the old genre list (also groups from before this queue). */
export async function separateGenreSpelling(db: Pool, opts: { aliasGenreId: string; userId?: string | null }) {
  const alias = (await db.query(
    `SELECT a.name, a.merged_into, c.name AS canonical FROM genres a JOIN genres c ON c.id = a.merged_into WHERE a.id = $1`,
    [opts.aliasGenreId])).rows[0];
  if (!alias) throw new GenreReviewError('This spelling is not grouped');
  const tags = [tagKey(alias.name)];
  const client = await db.connect();
  let before: Snapshot;
  try { before = await snapshot(client, tags); } finally { client.release(); }
  const { restoreGenreAlias } = await import('../genreCanonicalization.service');
  await restoreGenreAlias({ aliasGenreId: opts.aliasGenreId, userId: opts.userId });
  // A tag mapped only through the grouping is mapped again on its own.
  await db.query(`DELETE FROM tag_map WHERE tag = $1 AND method = 'merge'`, tags);
  await runTagMapping(db);
  const summary = `Separated ${alias.name} from ${alias.canonical}`;
  return inTransaction(db, async c => ({
    decisionId: await record(c, {
      key: `group:${opts.aliasGenreId}`, decision: 'restored', summary, tags, before,
      detail: { separated: { canonicalId: String(alias.merged_into), aliasId: opts.aliasGenreId } }, userId: opts.userId,
    }),
    summary,
  }));
}

const undoableUntil = (decidedAt: Date) => new Date(decidedAt.getTime() + GENRE_REVIEW_UNDO_DAYS * 86_400_000);

export async function getRecentGenreReviewDecisions(db: Pool): Promise<GenreReviewDecision[]> {
  const rows = (await db.query(`
    SELECT id, entry_key, decision, summary, created_at FROM genre_review_decisions
    WHERE created_at > NOW() - make_interval(days => $1) ORDER BY created_at DESC`, [GENRE_REVIEW_UNDO_DAYS])).rows;
  return rows.map((r: any) => {
    const decidedAt = new Date(r.created_at);
    return {
      id: String(r.id), key: r.entry_key, decision: r.decision, summary: r.summary,
      decidedAt: decidedAt.toISOString(), undoableUntil: undoableUntil(decidedAt).toISOString(),
    };
  });
}

export async function undoGenreReviewDecision(db: Pool, decisionId: string): Promise<void> {
  const row = (await db.query('SELECT * FROM genre_review_decisions WHERE id = $1', [decisionId])).rows[0];
  if (!row) throw new GenreReviewError('Decision not found');
  if (undoableUntil(new Date(row.created_at)) < new Date()) {
    throw new GenreReviewError(`Decisions can be undone for ${GENRE_REVIEW_UNDO_DAYS} days`);
  }
  const later = (await db.query(
    `SELECT summary FROM genre_review_decisions WHERE created_at > $1 AND tags && $2 AND id <> $3 ORDER BY created_at DESC LIMIT 1`,
    [row.created_at, row.tags, decisionId])).rows[0];
  if (later) throw new GenreReviewError(`Undo the later decision first: ${later.summary}`);

  const detail = row.detail || {};
  const canonicalModule = await import('../genreCanonicalization.service');
  if (row.decision === 'grouped') {
    for (const aliasId of detail.aliasIds || []) {
      const still = (await db.query('SELECT 1 FROM genres WHERE id = $1 AND merged_into = $2', [aliasId, detail.canonicalId])).rowCount;
      if (still) await canonicalModule.restoreGenreAlias({ aliasGenreId: aliasId });
    }
  } else if (row.decision === 'restored' && detail.separated) {
    await canonicalModule.groupGenres({
      canonicalGenreId: detail.separated.canonicalId, aliasGenreIds: [detail.separated.aliasId], acknowledgeTaxonomyConflict: true,
    });
  }
  await inTransaction(db, async client => {
    // Spellings: the old list asks again once its review row is gone.
    if (detail.reviewId) await client.query('DELETE FROM genre_duplicate_reviews WHERE id = $1', [detail.reviewId]);
    if (row.tags?.length) await restoreSnapshot(client, row.tags, row.before || { map: [], ignored: [] });
    await client.query('DELETE FROM genre_review_decisions WHERE id = $1', [decisionId]);
  });
}
