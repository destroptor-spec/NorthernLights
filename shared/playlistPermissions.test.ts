import { playlistPermissions, type PlaylistKind } from './playlistPermissions';

const own = { isOwner: true, isSystem: false, isLlmGenerated: false };
const row = (p: ReturnType<typeof playlistPermissions>) =>
  [p.rename, p.editTracks, p.share, p.pin, p.setPrivacy, p.delete].map((v) => (v ? 'Y' : '-')).join(' ');

describe('playlistPermissions', () => {
  // Columns: rename, editTracks, share, pin, setPrivacy, delete
  const cases: Array<[string, PlaylistKind, string]> = [
    ['manual playlist', { ...own, generationSource: 'manual' }, 'Y Y Y Y Y Y'],
    ['manual playlist from before generation_source', { ...own }, 'Y Y Y Y Y Y'],
    ['custom AI mix', { ...own, isLlmGenerated: true, generationSource: 'custom' }, 'Y Y Y Y Y Y'],
    ['Hub collection', { ...own, isLlmGenerated: true, generationSource: 'hub' }, '- - Y Y Y Y'],
    ['AI playlist with no recorded source', { ...own, isLlmGenerated: true, generationSource: null }, '- - Y Y Y Y'],
    ['Daylist', { ...own, isSystem: true, generationSource: 'daylist' }, '- - - Y - -'],
    ['artist radio', { ...own, isSystem: true, generationSource: 'artist-radio' }, '- - - Y - -'],
    ['Wrapped', { ...own, isSystem: true, generationSource: 'wrapped' }, '- - - Y - -'],
    ["someone else's manual playlist", { ...own, isOwner: false }, '- - - - - -'],
    ["someone else's custom mix", { ...own, isOwner: false, isLlmGenerated: true, generationSource: 'custom' }, '- - - - - -'],
  ];

  it.each(cases)('%s', (_name, kind, expected) => {
    expect(row(playlistPermissions(kind))).toBe(expected);
  });

  it('never lets a system flag be overridden by an AI source', () => {
    // A system playlist must stay read-only even if a source string says custom.
    expect(row(playlistPermissions({ ...own, isSystem: true, isLlmGenerated: true, generationSource: 'custom' }))).toBe('- - - Y - -');
  });

  it('returns a fresh object each time, so callers cannot mutate the shared defaults', () => {
    const a = playlistPermissions({ ...own, isOwner: false });
    a.pin = true;
    expect(playlistPermissions({ ...own, isOwner: false }).pin).toBe(false);
  });
});
