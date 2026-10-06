import { decideStaleRemoval, partitionStaleByFailures, walkAudioFiles, type WalkFailure, type WalkFs } from './libraryWalk';

type Node =
  | { dir: Record<string, Node>; readdirError?: string }
  | { file: true; mtimeMs?: number; size?: number }
  | { statError: string };

function errorWithCode(code: string) {
  return Object.assign(new Error(code), { code });
}

/** A fake filesystem rooted at /music, so the walk runs without a disk. */
function fakeFs(tree: Record<string, Node>, rootReaddirError?: string): WalkFs {
  const root: Node = { dir: tree, readdirError: rootReaddirError };
  const lookup = (p: string): Node | undefined => {
    if (p === '/music') return root;
    let node: Node | undefined = root;
    for (const part of p.replace(/^\/music\//, '').split('/')) {
      if (!node || !('dir' in node)) return undefined;
      node = node.dir[part];
    }
    return node;
  };
  return {
    async readdir(dir) {
      const node = lookup(dir.toString('utf8'));
      if (!node || !('dir' in node)) throw errorWithCode('ENOENT');
      if (node.readdirError) throw errorWithCode(node.readdirError);
      return Object.keys(node.dir).map((name) => Buffer.from(name));
    },
    async stat(entry) {
      const node = lookup(entry.toString('utf8'));
      if (!node) throw errorWithCode('ENOENT');
      if ('statError' in node) throw errorWithCode(node.statError);
      const isDir = 'dir' in node;
      return {
        isDirectory: () => isDir,
        isFile: () => !isDir,
        mtimeMs: isDir ? 0 : (node as { mtimeMs?: number }).mtimeMs ?? 1000.7,
        size: isDir ? 0 : (node as { size?: number }).size ?? 42,
      };
    },
  };
}

const ROOT = Buffer.from('/music');
const names = (r: { files: { buf: Buffer }[] }) => r.files.map((f) => f.buf.toString('utf8')).sort();
const plain = (failures: WalkFailure[]) => failures.map(({ path, op, code }) => ({ path, op, code }));

describe('walkAudioFiles', () => {
  it('collects audio files recursively and nothing else', async () => {
    const result = await walkAudioFiles(ROOT, fakeFs({
      'Artist A': { dir: { 'a.flac': { file: true }, 'cover.jpg': { file: true }, 'b.MP3': { file: true } } },
      'c.m4a': { file: true },
    }));
    expect(names(result)).toEqual(['/music/Artist A/a.flac', '/music/Artist A/b.MP3', '/music/c.m4a']);
    expect(result.failures).toEqual([]);
  });

  it('keeps the same file shape the scanner used before', async () => {
    const result = await walkAudioFiles(ROOT, fakeFs({ 'a.flac': { file: true, mtimeMs: 1234.9, size: 99 } }));
    expect(result.files[0]).toEqual({ buf: Buffer.from('/music/a.flac'), mtime: 1234, size: 99 });
  });

  it('reports an unreadable root instead of returning an empty library', async () => {
    // The automount case: the NAS does not answer and reading the root fails.
    // The old walk returned [] here, and the sync walk deleted everything.
    const result = await walkAudioFiles(ROOT, fakeFs({ 'a.flac': { file: true } }, 'EIO'));
    expect(result.files).toEqual([]);
    expect(plain(result.failures)).toEqual([{ path: '/music', op: 'readdir', code: 'EIO' }]);
  });

  it('reports an unreadable subfolder and still walks the rest', async () => {
    const result = await walkAudioFiles(ROOT, fakeFs({
      Good: { dir: { 'a.flac': { file: true } } },
      Bad: { dir: { 'b.flac': { file: true } }, readdirError: 'ESTALE' },
    }));
    expect(names(result)).toEqual(['/music/Good/a.flac']);
    expect(plain(result.failures)).toEqual([{ path: '/music/Bad', op: 'readdir', code: 'ESTALE' }]);
  });

  it('reports an entry that could not be stat-ed for a real I/O reason', async () => {
    const result = await walkAudioFiles(ROOT, fakeFs({ 'a.flac': { statError: 'EIO' }, 'b.flac': { file: true } }));
    expect(names(result)).toEqual(['/music/b.flac']);
    expect(plain(result.failures)).toEqual([{ path: '/music/a.flac', op: 'stat', code: 'EIO' }]);
  });

  it('does not count a dangling symlink or a vanished entry as a failure', async () => {
    const result = await walkAudioFiles(ROOT, fakeFs({
      'broken-link.flac': { statError: 'ENOENT' },
      'loop.flac': { statError: 'ELOOP' },
      'a.flac': { file: true },
    }));
    expect(names(result)).toEqual(['/music/a.flac']);
    expect(result.failures).toEqual([]);
  });

  it('treats a missing root as a failure even though the code is ENOENT', async () => {
    // A failed automount can surface as ENOENT on the root itself.
    const result = await walkAudioFiles(Buffer.from('/elsewhere'), fakeFs({}));
    expect(plain(result.failures)).toEqual([{ path: '/elsewhere', op: 'readdir', code: 'ENOENT' }]);
  });
});

describe('partitionStaleByFailures', () => {
  const b = (p: string) => Buffer.from(p);
  const readdirFailure = (p: string): WalkFailure => ({ buf: b(p), path: p, op: 'readdir', code: 'EIO' });
  const statFailure = (p: string): WalkFailure => ({ buf: b(p), path: p, op: 'stat', code: 'EIO' });
  const strs = (bufs: Buffer[]) => bufs.map((x) => x.toString('utf8')).sort();

  it('holds every stale track when the root itself could not be read', () => {
    // The automount outage: nothing was walked, so nothing can be vouched for.
    const out = partitionStaleByFailures([b('/music/A/1.flac'), b('/music/B/2.flac')], [readdirFailure('/music')]);
    expect(strs(out.held)).toEqual(['/music/A/1.flac', '/music/B/2.flac']);
    expect(out.removable).toEqual([]);
  });

  it('holds only what is under an unreadable folder', () => {
    // One bad folder must not freeze removals everywhere else.
    const out = partitionStaleByFailures(
      [b('/music/Bad/1.flac'), b('/music/Bad/deep/2.flac'), b('/music/Good/3.flac')],
      [readdirFailure('/music/Bad')],
    );
    expect(strs(out.held)).toEqual(['/music/Bad/1.flac', '/music/Bad/deep/2.flac']);
    expect(strs(out.removable)).toEqual(['/music/Good/3.flac']);
  });

  it('respects the directory boundary', () => {
    // /music/Bad failing says nothing about /music/Badlands.
    const out = partitionStaleByFailures([b('/music/Badlands/1.flac')], [readdirFailure('/music/Bad')]);
    expect(strs(out.removable)).toEqual(['/music/Badlands/1.flac']);
  });

  it('holds a single file that could not be stat-ed, and only that file', () => {
    const out = partitionStaleByFailures([b('/music/A/1.flac'), b('/music/A/2.flac')], [statFailure('/music/A/1.flac')]);
    expect(strs(out.held)).toEqual(['/music/A/1.flac']);
    expect(strs(out.removable)).toEqual(['/music/A/2.flac']);
  });

  it('compares raw bytes, so non-UTF-8 folder names still match', () => {
    // Latin-1 "Communiqué" — not valid UTF-8, so a string comparison would miss.
    const dir = Buffer.concat([b('/music/Communiqu'), Buffer.from([0xe9])]);
    const track = Buffer.concat([dir, b('/02.flac')]);
    const out = partitionStaleByFailures([track], [{ buf: dir, path: dir.toString('utf8'), op: 'readdir', code: 'EIO' }]);
    expect(out.held).toHaveLength(1);
  });

  it('removes everything when the walk had no failures', () => {
    const out = partitionStaleByFailures([b('/music/A/1.flac')], []);
    expect(strs(out.removable)).toEqual(['/music/A/1.flac']);
  });
});

describe('decideStaleRemoval', () => {
  const unattended = { unattended: true };

  it('removes nothing when a root walks empty but has known tracks', () => {
    // An unmounted share leaves an empty mountpoint directory that reads fine.
    expect(decideStaleRemoval({ ...unattended, staleCount: 28_379, knownCount: 28_379, walkedCount: 0 }))
      .toMatchObject({ remove: false, reason: 'root-empty' });
  });

  it('protects a manual scan from an empty root as well', () => {
    expect(decideStaleRemoval({ staleCount: 28_379, knownCount: 28_379, walkedCount: 0, unattended: false }))
      .toMatchObject({ remove: false, reason: 'root-empty' });
  });

  it('refuses even a single removal when the root walks empty', () => {
    expect(decideStaleRemoval({ ...unattended, staleCount: 1, knownCount: 1, walkedCount: 0 }))
      .toMatchObject({ remove: false, reason: 'root-empty' });
  });

  it('allows the removals prod actually performed', () => {
    // 1129 of ~19.5k (a reorganisation) and 101 (a replaced batch).
    expect(decideStaleRemoval({ ...unattended, staleCount: 1129, knownCount: 19_520, walkedCount: 19_550 })).toEqual({ remove: true });
    expect(decideStaleRemoval({ ...unattended, staleCount: 101, knownCount: 19_520, walkedCount: 19_547 })).toEqual({ remove: true });
  });

  it('refuses an unattended walk that would remove most of a root', () => {
    // A subtree that vanished without an error being raised.
    expect(decideStaleRemoval({ ...unattended, staleCount: 15_000, knownCount: 19_520, walkedCount: 4_520 }))
      .toMatchObject({ remove: false, reason: 'too-many' });
  });

  it('lets a deliberate manual scan remove a large share', () => {
    expect(decideStaleRemoval({ staleCount: 15_000, knownCount: 19_520, walkedCount: 4_520, unattended: false }))
      .toEqual({ remove: true });
  });

  it('is exact at the fraction cap', () => {
    const at = { ...unattended, knownCount: 1_000, walkedCount: 800 };
    expect(decideStaleRemoval({ ...at, staleCount: 200 })).toEqual({ remove: true });
    expect(decideStaleRemoval({ ...at, staleCount: 201 })).toMatchObject({ remove: false, reason: 'too-many' });
  });

  it('does not apply the cap to small numbers in a small library', () => {
    // 40 of 60 is 67%, but a tiny library churns; the floor keeps it usable.
    expect(decideStaleRemoval({ ...unattended, staleCount: 40, knownCount: 60, walkedCount: 25 })).toEqual({ remove: true });
    expect(decideStaleRemoval({ ...unattended, staleCount: 51, knownCount: 60, walkedCount: 9 }))
      .toMatchObject({ remove: false, reason: 'too-many' });
  });

  it('has nothing to decide when nothing is stale', () => {
    expect(decideStaleRemoval({ ...unattended, staleCount: 0, knownCount: 10, walkedCount: 0 })).toEqual({ remove: true });
  });
});
