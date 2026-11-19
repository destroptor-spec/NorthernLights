/**
 * Moves and renames in a library walk (issue #78). A track whose file moved
 * looks like a missing track plus a new file; deleting the missing one
 * cascades away its playlist entries, likes, play history and analysis. Before
 * anything is removed, the walk pairs missing tracks with new files and moves
 * the track to its new path instead.
 *
 * A false match would merge two different songs, which is worse than losing
 * the data, so only one-to-one matches count:
 *  1. Same file: the same size in bytes and the same modified time. A move or
 *     rename keeps both (mv, a file manager, rsync -a, SMB renames).
 *  2. Same song: the same size, title, artist and album, and a length within
 *     LENGTH_TOLERANCE_S where both are known. For a file whose modified time
 *     changed on the way (some copy tools); it is re-read after the move.
 * Anything with several candidates on either side is left alone: deleted and
 * added as before.
 */

export interface MissingTrack {
  /** tracks.path (base64). */
  path: string;
  size: number | null;
  mtime: number | null;
  duration: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
}

export interface NewFile {
  /** base64 path, as tracks.path would store it. */
  path: string;
  size: number;
  mtime: number;
}

export interface FileTags {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
}

export interface DetectedMove {
  from: string;
  to: string;
  /** 'same-file': size and modified time; 'same-song': size and tags (re-read after the move). */
  by: 'same-file' | 'same-song';
  size: number;
  mtime: number;
}

export const LENGTH_TOLERANCE_S = 1.5;

function normalise(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Pairs keys that occur exactly once on each side. */
function uniquePairs<A, B>(left: A[], right: B[], keyOfLeft: (a: A) => string | null, keyOfRight: (b: B) => string | null): Array<[A, B]> {
  const group = <T>(items: T[], keyOf: (item: T) => string | null) => {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const key = keyOf(item);
      if (key === null) continue;
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return map;
  };
  const lefts = group(left, keyOfLeft);
  const rights = group(right, keyOfRight);
  const pairs: Array<[A, B]> = [];
  for (const [key, ls] of lefts) {
    const rs = rights.get(key);
    if (ls.length === 1 && rs?.length === 1) pairs.push([ls[0], rs[0]]);
  }
  return pairs;
}

export async function detectMoves(
  missing: MissingTrack[],
  fresh: NewFile[],
  readTags: (file: NewFile) => Promise<FileTags | null>,
  { maxTagReads = 20_000, concurrency = 8 }: { maxTagReads?: number; concurrency?: number } = {},
): Promise<DetectedMove[]> {
  const moves: DetectedMove[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();

  // 1. Same file: size and modified time.
  for (const [track, file] of uniquePairs(
    missing,
    fresh,
    (track) => (track.size != null && track.mtime != null ? `${track.size}|${track.mtime}` : null),
    (file) => `${file.size}|${file.mtime}`,
  )) {
    moves.push({ from: track.path, to: file.path, by: 'same-file', size: file.size, mtime: file.mtime });
    movedFrom.add(track.path);
    movedTo.add(file.path);
  }

  // 2. Same song: size and tags, for what is left. Only new files whose size
  // a missing track has are read, and at most maxTagReads of them.
  const leftMissing = missing.filter((track) => !movedFrom.has(track.path) && track.size != null && normalise(track.title) !== '');
  const sizes = new Set(leftMissing.map((track) => track.size));
  const candidates = fresh.filter((file) => !movedTo.has(file.path) && sizes.has(file.size)).slice(0, maxTagReads);
  if (leftMissing.length === 0 || candidates.length === 0) return moves;

  const tags = new Map<string, FileTags>();
  for (let at = 0; at < candidates.length; at += concurrency) {
    const batch = candidates.slice(at, at + concurrency);
    const read = await Promise.all(batch.map((file) => readTags(file).catch(() => null)));
    batch.forEach((file, index) => { if (read[index]) tags.set(file.path, read[index]!); });
  }
  const songKey = (size: number | null, title?: string | null, artist?: string | null, album?: string | null) =>
    normalise(title) === '' ? null : `${size}|${normalise(title)}|${normalise(artist)}|${normalise(album)}`;

  for (const [track, file] of uniquePairs(
    leftMissing,
    candidates.filter((file) => tags.has(file.path)),
    (track) => songKey(track.size, track.title, track.artist, track.album),
    (file) => { const t = tags.get(file.path)!; return songKey(file.size, t.title, t.artist, t.album); },
  )) {
    const length = tags.get(file.path)?.duration;
    if (track.duration && length && Math.abs(track.duration - length) > LENGTH_TOLERANCE_S) continue;
    moves.push({ from: track.path, to: file.path, by: 'same-song', size: file.size, mtime: file.mtime });
  }
  return moves;
}
