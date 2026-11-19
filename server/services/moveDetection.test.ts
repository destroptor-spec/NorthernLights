/** @jest-environment node */
import { detectMoves, type FileTags, type MissingTrack, type NewFile } from './moveDetection';

const missing = (path: string, extra: Partial<MissingTrack> = {}): MissingTrack => ({
  path, size: 1000, mtime: 111, duration: 200, title: 'Song', artist: 'Artist', album: 'Album', ...extra,
});
const file = (path: string, extra: Partial<NewFile> = {}): NewFile => ({ path, size: 1000, mtime: 111, ...extra });
const noTags = async () => null;

it('pairs a missing track with a new file of the same size and date (a rename)', async () => {
  const moves = await detectMoves([missing('old')], [file('new')], noTags);
  expect(moves).toEqual([{ from: 'old', to: 'new', by: 'same-file', size: 1000, mtime: 111 }]);
});

it('pairs many renames at once, each by its own size and date', async () => {
  const moves = await detectMoves(
    [missing('a', { size: 1, mtime: 1 }), missing('b', { size: 2, mtime: 2 }), missing('c', { size: 3, mtime: 3 })],
    [file('c2', { size: 3, mtime: 3 }), file('a2', { size: 1, mtime: 1 }), file('b2', { size: 2, mtime: 2 })],
    noTags,
  );
  expect(moves.map((move) => `${move.from}>${move.to}`).sort()).toEqual(['a>a2', 'b>b2', 'c>c2']);
});

it('leaves an ambiguous match alone: two copies of a file, or two missing tracks alike', async () => {
  expect(await detectMoves([missing('old')], [file('copy1'), file('copy2')], noTags)).toEqual([]);
  expect(await detectMoves([missing('a'), missing('b')], [file('new')], noTags)).toEqual([]);
});

it('a new date: pairs by size and tags, when one file has them', async () => {
  const tags: Record<string, FileTags> = {
    new: { title: 'Song', artist: 'ARTIST ', album: 'Album', duration: 200.4 },
    other: { title: 'Another', artist: 'Artist', album: 'Album', duration: 200 },
  };
  const read = jest.fn(async (f: NewFile) => tags[f.path] ?? null);
  const moves = await detectMoves([missing('old')], [file('new', { mtime: 999 }), file('other', { mtime: 999 })], read);
  expect(moves).toEqual([{ from: 'old', to: 'new', by: 'same-song', size: 1000, mtime: 999 }]);
});

it('does not pair by tags when the length is off, or the size differs (re-encoded or re-tagged)', async () => {
  const longer = async () => ({ title: 'Song', artist: 'Artist', album: 'Album', duration: 230 });
  expect(await detectMoves([missing('old')], [file('new', { mtime: 999 })], longer)).toEqual([]);
  const read = jest.fn(async () => ({ title: 'Song', artist: 'Artist', album: 'Album', duration: 200 }));
  expect(await detectMoves([missing('old')], [file('new', { size: 1001, mtime: 999 })], read)).toEqual([]);
  expect(read).not.toHaveBeenCalled(); // no missing track of that size: not even read
});

it('does not pair a track without a title by tags (its title was its file name)', async () => {
  const read = async () => ({ title: '', artist: 'Artist', album: 'Album' });
  expect(await detectMoves([missing('old', { title: '' })], [file('new', { mtime: 999 })], read)).toEqual([]);
});

it('a file that cannot be read is simply not a match', async () => {
  const read = async () => { throw new Error('EACCES'); };
  expect(await detectMoves([missing('old')], [file('new', { mtime: 999 })], read)).toEqual([]);
});
