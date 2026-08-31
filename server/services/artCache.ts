import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import type { IPicture } from 'music-metadata';
import { ARTWORK_EXTRACTION_VERSION } from './artworkVersion';

// Pre-encoded album-art cache.
//
// Album art is encoded ONCE at ingestion time (in the scanTrack worker) to AVIF
// at fixed sizes and stored on disk, addressed by the SHA-256 of the embedded
// picture bytes. Because the key is the image content, an album's N tracks that
// share identical embedded art collapse to ONE set of files. The /api/art
// endpoint then streams these bytes directly instead of re-parsing the audio
// file and sending the full-resolution embedded image on every request.
//
// This module is intentionally DB-free so the scanTrack worker (spawned as a
// separate process) can import it without pulling in the pg pool.

// Sibling to the Postgres data dir by convention (see DB_DATA_DIR usage).
export const ART_CACHE_DIR = path.resolve(process.env.ART_CACHE_DIR || './art-cache');

// Square bounding boxes (px). Covers are resized "inside" this box without
// enlargement, so non-square art keeps its aspect ratio.
//   256  — grid thumbnails (album/artist/playlist cards)
//   640  — detail-page hero
//   1024 — full-screen now-playing
export const ART_SIZES = [256, 640, 1024] as const;
export type ArtSize = (typeof ART_SIZES)[number];
export const DEFAULT_ART_SIZE: ArtSize = 640;

export { ARTWORK_EXTRACTION_VERSION };

export interface NormalizedArtwork {
  data: Buffer;
  format: string;
  width: number;
  height: number;
  source: 'embedded' | 'folder';
  sourcePath?: string;
  pictureType?: string;
}

export function isValidArtSize(n: number): n is ArtSize {
  return (ART_SIZES as readonly number[]).includes(n);
}

// SHA-256 of the picture bytes, truncated to 32 hex chars — ample to avoid
// collisions across a personal library while keeping filenames short.
export function hashArt(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

// Sharded by the first two hex chars to avoid one enormous flat directory.
/**
 * Resolve a cache file for an artwork hash, refusing anything that lands
 * outside the cache directory.
 *
 * Both HTTP surfaces that reach here — `/api/art?hash=` and
 * `/api/v1/artwork/:hash` — validate the id against an anchored
 * `/^[0-9a-f]{1,64}$/` allowlist, which cannot express a separator, a `..` or a
 * null byte, so traversal is already unreachable. The check below is not
 * fixing a hole: it moves the guarantee next to the filesystem call instead of
 * leaving it several lines away in each caller. A later change to the id scheme
 * — uppercase digests, a UUID, some other cache key — would otherwise make
 * these paths attacker-controlled with nothing anywhere failing.
 *
 * Throwing rather than returning null keeps callers unchanged: every one of
 * them either wraps this in try/catch or passes a server-generated hash, so a
 * throw here means a genuine bug or an attack, not an ordinary miss.
 */
export function artCachePath(hash: string, size: ArtSize): string {
  const file = path.resolve(path.join(ART_CACHE_DIR, hash.slice(0, 2), `${hash}_${size}.avif`));
  if (file !== ART_CACHE_DIR && !file.startsWith(ART_CACHE_DIR + path.sep)) {
    throw new Error('Artwork cache path escapes the cache directory');
  }
  return file;
}

export function artExists(hash: string, size: ArtSize): boolean {
  try {
    return fs.statSync(artCachePath(hash, size)).size > 0;
  } catch {
    return false;
  }
}

// Scan for the first JPEG/PNG/GIF/WebP/BMP signature in `buf`. Returns the
// offset, or -1 if none found within the first 4 KiB. Recovers the real image
// data when music-metadata's WMA WM/Picture parser slices the buffer at the
// wrong offset (the description terminator is skipped), leaving a small
// UTF-16LE prefix in front of the actual image bytes.
export function findImageStart(buf: Uint8Array): number {
  const maxScan = Math.min(buf.length - 12, 4096);
  for (let i = 0; i <= maxScan; i++) {
    const b0 = buf[i], b1 = buf[i + 1], b2 = buf[i + 2], b3 = buf[i + 3];
    if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return i;
    if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) return i;
    if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return i;
    if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46
        && buf[i + 8] === 0x57 && buf[i + 9] === 0x45 && buf[i + 10] === 0x42 && buf[i + 11] === 0x50) return i;
    if (b0 === 0x42 && b1 === 0x4D) return i;
  }
  return -1;
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

function normalizedMime(format: string | undefined): string {
  switch ((format || '').toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
    case 'heif':
      return 'image/avif';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

function findJpegRecoveryStart(buf: Uint8Array): number {
  const maxScan = Math.min(buf.length - 1, 4096);
  for (let i = 0; i < maxScan; i++) {
    if (buf[i] !== 0xFF) continue;
    const marker = buf[i + 1];
    // WMP can drop the JPEG SOI/JFIF prefix while leaving a complete stream
    // beginning at a table or frame marker. sharp validates the reconstruction
    // before it is accepted, so incidental marker bytes are harmless.
    if (marker === 0xDB || marker === 0xC4 || marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      return i;
    }
  }
  return -1;
}

interface ByteCandidate {
  data: Buffer;
  reconstructed: boolean;
}

function byteCandidates(input: Uint8Array): ByteCandidate[] {
  const raw = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const candidates: ByteCandidate[] = [{ data: raw, reconstructed: false }];
  const imageStart = findImageStart(raw);
  if (imageStart > 0) candidates.push({ data: raw.subarray(imageStart), reconstructed: false });

  // Some malformed WM/Picture values start immediately after a JPEG segment
  // marker. Infer the missing marker only for recognizable segment bodies.
  const segmentLength = raw.length >= 4 ? raw.readUInt16BE(0) : 0;
  if (segmentLength >= 2 && segmentLength <= 4096 && segmentLength <= raw.length) {
    let marker: number | null = null;
    if (raw.subarray(2, 6).toString('ascii') === 'Exif') marker = 0xE1;
    else if (raw.subarray(2, 6).toString('ascii') === 'JFIF') marker = 0xE0;
    else if ((segmentLength === 67 || segmentLength === 132) && raw[2] <= 3) marker = 0xDB;
    if (marker !== null) {
      candidates.push({
        data: Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, marker]), raw]),
        reconstructed: true,
      });
    }
  }

  // Try JPEG reconstruction independently of the generic signature result.
  // Compressed JPEG bytes can contain an incidental "BM" pair long after the
  // real DQT start; treating that as authoritative recreates the original WMA
  // failure. Every candidate is validated by sharp below.
  const jpegStart = findJpegRecoveryStart(raw);
  if (jpegStart >= 0 && !(raw[0] === 0xFF && raw[1] === 0xD8)) {
    candidates.push({
      data: Buffer.concat([Buffer.from([0xFF, 0xD8]), raw.subarray(jpegStart)]),
      reconstructed: true,
    });
  }

  return candidates;
}

function artworkScore(art: NormalizedArtwork): number {
  const type = (art.pictureType || '').toLowerCase();
  const frontBonus = type.includes('front') ? 1_000_000_000 : 0;
  const squareRatio = Math.min(art.width, art.height) / Math.max(art.width, art.height);
  return frontBonus + (art.width * art.height) + Math.round(squareRatio * 100_000);
}

async function normalizePicture(
  picture: Pick<IPicture, 'data' | 'type'>,
  source: NormalizedArtwork['source'],
  sourcePath?: string,
): Promise<NormalizedArtwork | null> {
  const seen = new Set<string>();
  for (const { data: candidate, reconstructed } of byteCandidates(picture.data)) {
    if (candidate.length === 0) continue;
    const fingerprint = hashArt(candidate);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    try {
      const metadata = await sharp(candidate, { failOn: 'error' }).metadata();
      if (!metadata.format || !metadata.width || !metadata.height) continue;
      if (reconstructed) {
        // metadata() only parses headers. A stream can advertise dimensions but
        // still lack an earlier quantization table, so force one full decode
        // before accepting any repaired byte sequence.
        await sharp(candidate, { failOn: 'error' }).stats();
      }
      return {
        data: candidate,
        format: normalizedMime(metadata.format),
        width: metadata.width,
        height: metadata.height,
        source,
        sourcePath,
        pictureType: picture.type,
      };
    } catch {
      // Try the next alignment or picture. A malformed cover must not sink the
      // track metadata or hide a later valid front cover.
    }
  }
  return null;
}

function folderArtworkPriority(fileName: string): number | null {
  const ext = path.extname(fileName).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  const stem = path.basename(fileName, ext).toLowerCase();
  if (stem === 'cover') return 0;
  if (stem === 'folder') return 1;
  if (stem === 'front') return 2;
  if (/^albumart.*_large$/.test(stem)) return 3;
  if (stem === 'albumartlarge') return 3;
  if (/^albumart.*_small$/.test(stem)) return 4;
  if (stem === 'albumartsmall') return 4;
  return null;
}

export async function findFolderArtwork(audioPath: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(path.dirname(audioPath));
  } catch {
    return [];
  }

  return names
    .map((name) => ({ name, priority: folderArtworkPriority(name) }))
    .filter((entry): entry is { name: string; priority: number } => entry.priority !== null)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    .map((entry) => path.join(path.dirname(audioPath), entry.name));
}

export async function resolveArtwork(
  pictures: readonly IPicture[] | undefined,
  audioPath?: string,
): Promise<NormalizedArtwork | null> {
  const embedded: NormalizedArtwork[] = [];
  for (const picture of pictures || []) {
    const normalized = await normalizePicture(picture, 'embedded');
    if (normalized) embedded.push(normalized);
  }
  if (embedded.length > 0) {
    embedded.sort((a, b) => artworkScore(b) - artworkScore(a));
    return embedded[0];
  }

  if (!audioPath) return null;
  for (const candidatePath of await findFolderArtwork(audioPath)) {
    try {
      const data = await fs.promises.readFile(candidatePath);
      const normalized = await normalizePicture({ data, type: 'Cover (front)' }, 'folder', candidatePath);
      if (normalized) return normalized;
    } catch {
      // A broken Folder.jpg should not prevent trying the next conventional
      // Windows Media artwork filename.
    }
  }
  return null;
}

// Encode `bytes` to AVIF at every configured size, skipping any size whose file
// already exists (the on-disk dedup guard — safe across concurrent workers and
// repeat scans). Idempotent.
export async function encodeArt(bytes: Uint8Array, hash: string): Promise<void> {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Encode sizes sequentially rather than Promise.all: three simultaneous AVIF
  // encodes per worker (× one worker per CPU) saturated all cores and the I/O
  // path during fresh-library ingestion. Serializing keeps peak memory to one
  // decoded image and bounds per-worker CPU to a single encode.
  for (const size of ART_SIZES) {
    if (artExists(hash, size)) continue;
    const outPath = artCachePath(hash, size);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    // Write to a temp file then rename so a concurrent reader never sees a
    // half-written file.
    const tmpPath = `${outPath}.${process.pid}.tmp`;
    try {
      await sharp(input)
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .avif({ quality: 62, effort: 4 })
        .toFile(tmpPath);
      await fs.promises.rename(tmpPath, outPath);
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }
}

// Remove every size variant for hashes that are no longer referenced. The
// caller supplies `isReferenced` (a DB-backed refcount check) so this module
// stays DB-free. Removes the shard directory too when it empties out.
export async function cleanupOrphanArt(
  hashes: Iterable<string>,
  isReferenced: (hash: string) => Promise<boolean>,
): Promise<void> {
  const seen = new Set<string>();
  for (const hash of hashes) {
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    if (await isReferenced(hash)) continue;
    for (const size of ART_SIZES) {
      await fs.promises.rm(artCachePath(hash, size), { force: true }).catch(() => {});
    }
    const shardDir = path.join(ART_CACHE_DIR, hash.slice(0, 2));
    try {
      const remaining = await fs.promises.readdir(shardDir);
      if (remaining.length === 0) await fs.promises.rmdir(shardDir).catch(() => {});
    } catch {
      /* shard already gone */
    }
  }
}
