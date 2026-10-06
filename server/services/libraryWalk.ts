import fs from 'fs';
import path from 'path';

export interface WalkedFile {
  buf: Buffer;
  mtime: number; // epoch ms, floored
  size: number;  // bytes
}

/** A directory or entry the walk could not read, so it cannot vouch for. */
export interface WalkFailure {
  /** Raw bytes: library paths are not guaranteed to be valid UTF-8. */
  buf: Buffer;
  /** For logging only. */
  path: string;
  op: 'readdir' | 'stat';
  code: string;
}

export interface WalkResult {
  files: WalkedFile[];
  failures: WalkFailure[];
}

/** The two filesystem calls the walk makes, injectable so it is testable without a disk. */
export interface WalkFs {
  readdir(dir: Buffer): Promise<Buffer[]>;
  stat(entry: Buffer): Promise<{ isDirectory(): boolean; isFile(): boolean; mtimeMs: number; size: number }>;
}

const nodeFs: WalkFs = {
  readdir: (dir) => fs.promises.readdir(dir, { encoding: 'buffer' }),
  stat: (entry) => fs.promises.stat(entry),
};

const AUDIO_EXTENSION = /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i;

// An entry that vanished between readdir and stat, or a dangling symlink, is
// not a readable file — and is not evidence the walk missed anything. Treating
// these as failures would hold its folder's removals over one broken link.
const BENIGN_STAT_CODES = new Set(['ENOENT', 'ELOOP']);

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/**
 * Recursively collect audio files under `root`, recording everything it could
 * not read instead of silently treating it as empty.
 *
 * The walk it replaces swallowed every error (`catch { return results; }`), so
 * an unreadable folder looked exactly like an empty one — and the sync walk
 * deletes every known track it does not see. The library lives on an NFS
 * automount that idles out after ten minutes, so nearly every scheduled walk
 * remounts it; a NAS that does not answer at that moment would have had the
 * whole library deleted, cascading away every playlist entry, loved track and
 * play stat. Tracks under a failed path are held instead (see
 * partitionStaleByFailures).
 */
export async function walkAudioFiles(root: Buffer, fsImpl: WalkFs = nodeFs): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const failures: WalkFailure[] = [];
  const sep = Buffer.from(path.sep);

  async function visit(dir: Buffer): Promise<void> {
    let entries: Buffer[];
    try {
      entries = await fsImpl.readdir(dir);
    } catch (error) {
      // Always a failure, whatever the code: an ENOENT root is precisely what a
      // failed automount looks like.
      failures.push({ buf: dir, path: dir.toString('utf8'), op: 'readdir', code: errorCode(error) });
      return;
    }

    await Promise.all(entries.map(async (name) => {
      const full = Buffer.concat([dir, dir[dir.length - 1] === sep[0] ? Buffer.alloc(0) : sep, name]);
      let stat;
      try {
        stat = await fsImpl.stat(full);
      } catch (error) {
        const code = errorCode(error);
        if (!BENIGN_STAT_CODES.has(code)) failures.push({ buf: full, path: full.toString('utf8'), op: 'stat', code });
        return;
      }
      if (stat.isDirectory()) {
        await visit(full);
      } else if (stat.isFile() && AUDIO_EXTENSION.test(name.toString('utf8'))) {
        files.push({ buf: full, mtime: Math.floor(stat.mtimeMs), size: stat.size });
      }
    }));
  }

  await visit(root);
  return { files, failures };
}

/**
 * Split stale tracks into those the walk can vouch for and those it cannot.
 *
 * A stale track under a folder that could not be read — or one that could not
 * itself be stat-ed — may well still be on disk, so it is held. Everything
 * else was walked past and genuinely not found, so it may go. Holding only
 * what is in doubt means one permanently unreadable folder (a permissions
 * mistake, say) does not freeze every removal in the library; an unreadable
 * root still holds everything, which is the outage case.
 *
 * Byte-level comparison with a directory boundary, matching how the sync walk
 * scopes tracks to a root.
 */
export function partitionStaleByFailures(
  stalePaths: Buffer[],
  failures: WalkFailure[],
): { removable: Buffer[]; held: Buffer[] } {
  const removable: Buffer[] = [];
  const held: Buffer[] = [];
  for (const stale of stalePaths) {
    const inDoubt = failures.some((failure) => {
      if (failure.op === 'stat') return stale.equals(failure.buf);
      const dir = failure.buf;
      if (stale.length < dir.length || !stale.subarray(0, dir.length).equals(dir)) return false;
      return stale.length === dir.length || stale[dir.length] === 0x2f || dir[dir.length - 1] === 0x2f;
    });
    (inDoubt ? held : removable).push(stale);
  }
  return { removable, held };
}

/**
 * An unattended walk may remove at most this share of a root's tracks in one
 * pass. Prod's largest legitimate removal on record was 1129 of ~19.5k (5.8%,
 * a reorganisation via manual scan); a vanished subtree is usually far larger.
 */
export const MAX_UNATTENDED_REMOVAL_FRACTION = 0.2;

/** Below this many removals the fraction cap does not apply — small libraries churn. */
export const REMOVAL_FRACTION_FLOOR = 50;

export type RemovalSkipReason = 'root-empty' | 'too-many';

export type RemovalDecision =
  | { remove: true }
  | { remove: false; reason: RemovalSkipReason; detail: string };

/**
 * Decide whether the stale tracks a walk found may be deleted.
 *
 * Deleting a track cascades to its playlist entries, loves, play stats and
 * audio features, and nothing restores them when the file reappears — the next
 * walk re-adds the track as new. So removal needs positive evidence the files
 * are gone, not merely the absence of evidence they exist.
 *
 * Read failures are handled before this, by partitionStaleByFailures: tracks
 * under an unreadable path never reach here.
 *
 * - A root that walked empty while the database holds tracks for it: the
 *   signature of an unmounted share (the empty mountpoint directory reads fine).
 * - Unattended walks only: more than MAX_UNATTENDED_REMOVAL_FRACTION of the
 *   root at once. A manual scan is someone acting deliberately after a
 *   reorganisation, and the empty-root check still protects it from an outage.
 *
 * Skipping only defers: the next complete walk removes whatever is truly gone.
 */
export function decideStaleRemoval(input: {
  staleCount: number;
  knownCount: number;
  walkedCount: number;
  unattended: boolean;
  maxFraction?: number;
  floor?: number;
}): RemovalDecision {
  if (input.staleCount <= 0) return { remove: true };
  if (input.knownCount > 0 && input.walkedCount === 0) {
    return { remove: false, reason: 'root-empty', detail: `walked 0 files where ${input.knownCount} are known` };
  }
  const maxFraction = input.maxFraction ?? MAX_UNATTENDED_REMOVAL_FRACTION;
  const floor = input.floor ?? REMOVAL_FRACTION_FLOOR;
  if (input.unattended && input.staleCount > floor && input.staleCount > input.knownCount * maxFraction) {
    return {
      remove: false,
      reason: 'too-many',
      detail: `${input.staleCount} of ${input.knownCount} (${Math.round((input.staleCount / input.knownCount) * 100)}%) exceeds the ${Math.round(maxFraction * 100)}% unattended limit`,
    };
  }
  return { remove: true };
}
