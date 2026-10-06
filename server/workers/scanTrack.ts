import { workerLog } from './workerLog';
import * as mm from 'music-metadata';
import sharp from 'sharp';
import { hashArt, resolveArtwork, encodeArt, artExists, ART_SIZES, ARTWORK_EXTRACTION_VERSION } from '../services/artCache';

// Pin libvips to a single thread per worker. By default sharp uses one thread
// per CPU *per operation*; with one worker process per CPU (processPool), that
// is cores×cores threads contending during a fresh-library scan. One thread per
// worker keeps total art-encode parallelism at ~#cores.
sharp.concurrency(1);

// Protocol: Each line on stdin: { id, filePathBase64, nameStr, processArt?, knownArtHash? }
// Each line on stdout: { id, metadata: { ..., artHash } } or { id, error }
//
// artHash semantics in the result: a hex hash = cover encoded (or already
// present); '' = file processed, no embedded art; undefined = art not processed
// this run (processArt was false).

// Extract the embedded cover, hash it, and ensure AVIF variants exist on disk.
// Returns the hash, or '' when the file has no embedded art. Skips re-encoding
// when the hash matches `knownArtHash` and all sizes already exist.
async function processArtwork(metadata: mm.IAudioMetadata, audioPath: string, knownArtHash?: string | null): Promise<string> {
  const artwork = await resolveArtwork(metadata.common.picture, audioPath);
  if (!artwork) return '';

  const hash = hashArt(artwork.data);
  const allPresent = ART_SIZES.every((size) => artExists(hash, size));
  if (hash === knownArtHash && allPresent) return hash;
  if (!allPresent) await encodeArt(artwork.data, hash);
  return hash;
}

function sanitizeUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  // Strip null bytes, BOM, and ASCII control characters (except tab)
  const cleaned = raw
    .replace(/\x00/g, '')           // null bytes (crash Postgres)
    .replace(/\uFEFF/g, '')         // BOM
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars
    .trim();
  if (!cleaned) return null;
  // Must be http(s) and a plausible length
  if (!/^https?:\/\/.{3,}/i.test(cleaned)) return null;
  if (cleaned.length > 2048) return null;
  // Validate parseable by URL constructor
  try { new URL(cleaned); } catch { return null; }
  return cleaned;
}

function extractUrlTags(native: Record<string, any[]>): { url: string; type: string }[] {
  const results: { url: string; type: string }[] = [];
  const seen = new Set<string>();

  const add = (raw: string, type: string) => {
    const url = sanitizeUrl(raw);
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ url, type });
  };

  for (const [format, tags] of Object.entries(native || {})) {
    if (!Array.isArray(tags)) continue;

    if (format === 'vorbis') {
      for (const tag of tags) {
        const id = (tag.id || '').toUpperCase();
        const val = typeof tag.value === 'string' ? tag.value : '';
        switch (id) {
          case 'URL_OFFICIAL_ARTIST_SITE':
          case 'WEBSITE': add(val, 'official homepage'); break;
          case 'URL_OFFICIAL_RELEASE_SITE': add(val, 'official audio source'); break;
          case 'URL_DISCOGS_ARTIST_PAGE':
          case 'URL_DISCOGS_RELEASE_PAGE': add(val, 'discogs'); break;
          case 'URL_SOUNDCLOUD': add(val, 'soundcloud'); break;
          case 'URL_YOUTUBE': add(val, 'youtube'); break;
          case 'URL_WIKIPEDIA_ARTIST':
          case 'URL_WIKIPEDIA_RELEASE': add(val, 'wikipedia'); break;
          case 'URL_SPOTIFY_ARTIST':
          case 'URL_SPOTIFY_ALBUM': add(val, 'spotify'); break;
          case 'URL_BANDCAMP': add(val, 'bandcamp'); break;
        }
      }
    } else if (format.startsWith('ID3v2')) {
      for (const tag of tags) {
        const id = tag.id || '';
        const val = tag.value;
        switch (id) {
          case 'WOAR': if (typeof val === 'string') add(val, 'official homepage'); break;
          case 'WOAS': if (typeof val === 'string') add(val, 'official audio source'); break;
          case 'WORS': if (typeof val === 'string') add(val, 'streaming'); break;
          case 'WPUB': if (typeof val === 'string') add(val, 'official homepage'); break;
          case 'WCOM': if (typeof val === 'string') add(val, 'commercial'); break;
          case 'WXXX': {
            if (typeof val === 'object' && val?.url) {
              const desc = (val.description || '').toLowerCase();
              let type = 'other';
              if (desc.includes('spotify')) type = 'spotify';
              else if (desc.includes('youtube')) type = 'youtube';
              else if (desc.includes('instagram') || desc.includes('facebook') || desc.includes('twitter') || desc.includes('x.com')) type = 'social network';
              else if (desc.includes('discogs')) type = 'discogs';
              else if (desc.includes('bandcamp')) type = 'bandcamp';
              else if (desc.includes('soundcloud')) type = 'soundcloud';
              else if (desc.includes('wikipedia')) type = 'wikipedia';
              add(val.url, type);
            }
            break;
          }
        }
      }
    }
  }

  return results;
}

export interface ExtractedCredit {
  role: string;
  name: string;
  detail?: string;
}

// Canonical (lowercase, stable) role identifiers. The UI maps these to
// display labels; the DB stores them as-is. Anything not in this list
// is dropped silently by extractCredits so we don't surface roles we
// can't render consistently.
const ROLE_COMPOSER = 'composer';
const ROLE_LYRICIST = 'lyricist';
const ROLE_WRITER = 'writer';
const ROLE_CONDUCTOR = 'conductor';
const ROLE_PERFORMER = 'performer';
const ROLE_PRODUCER = 'producer';
const ROLE_REMIXER = 'remixer';
const ROLE_ENGINEER = 'engineer';
const ROLE_ARRANGER = 'arranger';
const ROLE_MIXER = 'mixer';
const ROLE_DJ_MIXER = 'dj-mixer';
const ROLE_ORIGINAL_ARTIST = 'original-artist';

// Maps a free-text role string (from TIPL "producer", Vorbis comment
// "PRODUCER", MB relationship "producer", etc.) to one of our canonical
// role tokens. Returns null when the role isn't one we surface.
function canonicalRole(raw: string): string | null {
  const r = (raw || '').trim().toLowerCase();
  if (!r) return null;
  if (r === 'composer' || r === 'composers') return ROLE_COMPOSER;
  if (r === 'lyricist' || r === 'lyricists' || r === 'text' || r === 'lyrics by') return ROLE_LYRICIST;
  if (r === 'writer' || r === 'writers' || r === 'songwriter') return ROLE_WRITER;
  if (r === 'conductor' || r === 'conductors') return ROLE_CONDUCTOR;
  if (r === 'performer' || r === 'performers' || r === 'musician') return ROLE_PERFORMER;
  if (r === 'producer' || r === 'producers' || r === 'produced by') return ROLE_PRODUCER;
  if (r === 'remixer' || r === 'remixed by' || r === 'mixed by remixer') return ROLE_REMIXER;
  if (r === 'engineer' || r === 'engineers' || r === 'engineered by') return ROLE_ENGINEER;
  if (r === 'arranger' || r === 'arrangers' || r === 'arranged by') return ROLE_ARRANGER;
  if (r === 'mixer' || r === 'mix' || r === 'mixed by') return ROLE_MIXER;
  if (r === 'djmixer' || r === 'dj-mixer' || r === 'dj mixer') return ROLE_DJ_MIXER;
  if (r === 'originalartist' || r === 'original artist' || r === 'original-artist') return ROLE_ORIGINAL_ARTIST;
  return null;
}

// Splits names on conventional separators. Mirrors the server-side
// splitArtistNames but lives in the worker because the worker is
// shipped as a standalone child process without DB imports.
function splitNames(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Split on common separators that taggers use for compound credits.
  // ";", " / ", " & ", ", " — but keep parenthesized fragments intact.
  const parts = trimmed
    .split(/\s*;\s*|\s+\/\s+|\s+&\s+|\s+vs\.?\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s*,\s*/i)
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [trimmed];
}

// Pulls "Name (instrument)" apart, returning { name, detail }. Used
// for Vorbis PERFORMER lines and MB performer relationships where the
// instrument lives in a trailing parenthetical.
function splitNameAndDetail(raw: string): { name: string; detail?: string } {
  const m = raw.match(/^(.*)\s*\(([^()]+)\)\s*$/);
  if (m) return { name: m[1].trim(), detail: m[2].trim() };
  return { name: raw.trim() };
}

function extractCredits(metadata: mm.IAudioMetadata): ExtractedCredit[] {
  const out: ExtractedCredit[] = [];
  const seen = new Set<string>();

  const push = (role: string | null, rawName: string, detail?: string) => {
    if (!role) return;
    if (typeof rawName !== 'string') return;
    for (const piece of splitNames(rawName)) {
      const { name, detail: nameDetail } = splitNameAndDetail(piece);
      if (!name) continue;
      const finalDetail = (detail || nameDetail || '').trim();
      const key = `${role}::${name.toLowerCase()}::${finalDetail.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ role, name, ...(finalDetail ? { detail: finalDetail } : {}) });
    }
  };

  const common: any = metadata.common || {};
  const pushArr = (arr: any, role: string) => {
    if (!arr) return;
    const list = Array.isArray(arr) ? arr : [arr];
    for (const v of list) {
      if (typeof v === 'string') push(role, v);
    }
  };

  // 1. common fields (music-metadata normalizes a handful of role tags).
  pushArr(common.composer, ROLE_COMPOSER);
  pushArr(common.lyricist, ROLE_LYRICIST);
  pushArr(common.writer, ROLE_WRITER);
  if (typeof common.conductor === 'string') push(ROLE_CONDUCTOR, common.conductor);
  if (Array.isArray(common.conductor)) pushArr(common.conductor, ROLE_CONDUCTOR);
  if (typeof common.producer === 'string') push(ROLE_PRODUCER, common.producer);
  if (Array.isArray(common.producer)) pushArr(common.producer, ROLE_PRODUCER);
  if (typeof common.remixer === 'string') push(ROLE_REMIXER, common.remixer);
  if (Array.isArray(common.remixer)) pushArr(common.remixer, ROLE_REMIXER);
  if (typeof common.djmixer === 'string') push(ROLE_DJ_MIXER, common.djmixer);
  if (Array.isArray(common.djmixer)) pushArr(common.djmixer, ROLE_DJ_MIXER);
  if (typeof common.mixer === 'string') push(ROLE_MIXER, common.mixer);
  if (Array.isArray(common.mixer)) pushArr(common.mixer, ROLE_MIXER);
  if (typeof common.engineer === 'string') push(ROLE_ENGINEER, common.engineer);
  if (Array.isArray(common.engineer)) pushArr(common.engineer, ROLE_ENGINEER);
  if (typeof common.arranger === 'string') push(ROLE_ARRANGER, common.arranger);
  if (Array.isArray(common.arranger)) pushArr(common.arranger, ROLE_ARRANGER);
  if (typeof common.originalartist === 'string') push(ROLE_ORIGINAL_ARTIST, common.originalartist);
  if (Array.isArray(common.performer)) pushArr(common.performer, ROLE_PERFORMER);

  // 2. native[format][] arrays for tags music-metadata doesn't normalize.
  const native: Record<string, any[]> = (metadata.native as any) || {};
  for (const [format, tags] of Object.entries(native)) {
    if (!Array.isArray(tags)) continue;

    if (format.startsWith('ID3v2')) {
      for (const tag of tags) {
        const id = String(tag.id || '');
        const val = tag.value;
        switch (id) {
          case 'TCOM': if (typeof val === 'string') push(ROLE_COMPOSER, val); break;
          case 'TPE3': if (typeof val === 'string') push(ROLE_CONDUCTOR, val); break;
          case 'TPE4': if (typeof val === 'string') push(ROLE_REMIXER, val); break;
          case 'TEXT': if (typeof val === 'string') push(ROLE_LYRICIST, val); break;
          // TIPL: Involved People List — alternating [role, name, role, name, ...]
          case 'IPLS':
          case 'TIPL': {
            // music-metadata exposes TIPL as either an array of {role, name}
            // pairs or as a flat alternating array; handle both shapes.
            if (Array.isArray(val)) {
              for (let i = 0; i < val.length; i++) {
                const item = val[i];
                if (typeof item === 'object' && item && 'role' in item && 'name' in item) {
                  push(canonicalRole(String(item.role)), String(item.name));
                } else if (typeof item === 'string' && typeof val[i + 1] === 'string') {
                  push(canonicalRole(item), val[i + 1]);
                  i++;
                }
              }
            } else if (typeof val === 'string') {
              const parts = val.split(/\x00|;/);
              for (let i = 0; i < parts.length - 1; i += 2) {
                push(canonicalRole(parts[i]), parts[i + 1]);
              }
            }
            break;
          }
          // TMCL: Musician Credits List — alternating [instrument, name, ...]
          // all map to performer with detail = instrument.
          case 'TMCL': {
            if (Array.isArray(val)) {
              for (let i = 0; i < val.length; i++) {
                const item = val[i];
                if (typeof item === 'object' && item && 'role' in item && 'name' in item) {
                  push(ROLE_PERFORMER, String(item.name), String(item.role));
                } else if (typeof item === 'string' && typeof val[i + 1] === 'string') {
                  push(ROLE_PERFORMER, val[i + 1], item);
                  i++;
                }
              }
            } else if (typeof val === 'string') {
              const parts = val.split(/\x00|;/);
              for (let i = 0; i < parts.length - 1; i += 2) {
                push(ROLE_PERFORMER, parts[i + 1], parts[i]);
              }
            }
            break;
          }
          // TXXX:<DESC> custom frames — Picard writes a few role-ish tags
          // here in addition to TIPL (e.g. "TXXX:ARRANGER").
          case 'TXXX': {
            if (typeof val === 'object' && val && typeof val.description === 'string') {
              const role = canonicalRole(val.description);
              if (role && typeof val.text === 'string') push(role, val.text);
              else if (role && Array.isArray(val.text)) for (const t of val.text) push(role, String(t));
            }
            break;
          }
        }
      }
    } else if (format === 'vorbis') {
      for (const tag of tags) {
        const id = String(tag.id || '').toUpperCase();
        const val = tag.value;
        if (typeof val !== 'string') continue;
        switch (id) {
          case 'CONDUCTOR': push(ROLE_CONDUCTOR, val); break;
          case 'PERFORMER': push(ROLE_PERFORMER, val); break;
          case 'PRODUCER': push(ROLE_PRODUCER, val); break;
          case 'REMIXER':
          case 'MIXARTIST': push(ROLE_REMIXER, val); break;
          case 'ENGINEER': push(ROLE_ENGINEER, val); break;
          case 'ARRANGER': push(ROLE_ARRANGER, val); break;
          case 'MIXER': push(ROLE_MIXER, val); break;
          case 'DJMIXER': push(ROLE_DJ_MIXER, val); break;
          case 'ORIGINALARTIST':
          case 'ORIGINAL ARTIST': push(ROLE_ORIGINAL_ARTIST, val); break;
          case 'LYRICIST': push(ROLE_LYRICIST, val); break;
          case 'WRITER': push(ROLE_WRITER, val); break;
          case 'COMPOSER': push(ROLE_COMPOSER, val); break;
        }
      }
    } else if (format === 'iTunes' || format === 'MP4') {
      for (const tag of tags) {
        const id = String(tag.id || '');
        const val = tag.value;
        // Standard atoms
        if (id === '©wrt' && typeof val === 'string') push(ROLE_COMPOSER, val);
        // Freeform "----:com.apple.iTunes:NAME" atoms — Picard uses these
        // for the non-standard role tags. music-metadata exposes them
        // either as the full path or with the trailing segment.
        if (id.startsWith('----:com.apple.iTunes:') && typeof val === 'string') {
          const role = canonicalRole(id.split(':').pop() || '');
          if (role) push(role, val);
        }
      }
    }
  }

  return out;
}

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: { id: string; filePathBase64: string; nameStr: string; processArt?: boolean; knownArtHash?: string | null };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    try {
      const utf8Path = Buffer.from(msg.filePathBase64, 'base64').toString('utf8');

      // parseFile() accepts a plain string path — no Buffer hacks needed.
      // duration: true forces music-metadata to scan MPEG frames when the
      // file lacks a Xing/Info/LAME header or TLEN tag (common for DJ-mix
      // compilations); without it format.duration is undefined and we
      // persist 0 forever.
      // skipCovers only when we're not encoding art this run — reading the
      // cover is extra I/O we avoid on art-less passes.
      const metadata = await mm.parseFile(utf8Path, { skipCovers: !msg.processArt, duration: true });
      const rawUrls = extractUrlTags(metadata.native || {});

      // Artwork encoding is isolated: a cover in a format sharp can't decode
      // ("unsupported image format") must NOT sink the track's metadata. Leave
      // failed artwork unresolved so a transient worker/memory failure retries
      // on the next walk, while still emitting the parsed tags.
      let artHash: string | undefined = undefined;
      let artworkVersion: number | undefined = undefined;
      if (msg.processArt) {
        try {
          artHash = await processArtwork(metadata, utf8Path, msg.knownArtHash);
          artworkVersion = ARTWORK_EXTRACTION_VERSION;
        } catch (artErr: any) {
          workerLog('warn', `[scanTrack] art decode failed (${artErr?.message || artErr}), keeping metadata`);
        }
      }

      process.stdout.write(JSON.stringify({
        id: msg.id,
        metadata: {
            artHash,
            artworkVersion,
            artist: metadata.common.artist || metadata.common.albumartist || null,
            albumartist: metadata.common.albumartist || null,
            title: metadata.common.title || null,
            artists: metadata.common.artists || null,
            album: metadata.common.album || null,
            genre: metadata.common.genre || null,
            duration: metadata.format.duration || 0,
            trackNumber: metadata.common.track.no || null,
            discNumber: metadata.common.disk?.no || null,
            year: metadata.common.year || null,
            releaseType: metadata.common.releasetype ? metadata.common.releasetype[0] : null,
            isCompilation: metadata.common.compilation || false,
            bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null,
            format: metadata.format.container || metadata.format.codec || null,
            // music-metadata computes this per-codec (distinguishes ALAC from AAC in M4A);
            // authoritative lossless flag, used for cast-lossless eligibility + UI labels.
            lossless: typeof metadata.format.lossless === 'boolean' ? metadata.format.lossless : null,
            isrc: metadata.common.isrc?.[0] || null,
            mbRecordingId: metadata.common.musicbrainz_recordingid || null,
            mbTrackId: metadata.common.musicbrainz_trackid || null,
            mbAlbumId: metadata.common.musicbrainz_albumid || null,
            mbArtistId: Array.isArray(metadata.common.musicbrainz_artistid) ? metadata.common.musicbrainz_artistid[0] : (metadata.common.musicbrainz_artistid || null),
            mbAlbumArtistId: Array.isArray(metadata.common.musicbrainz_albumartistid) ? metadata.common.musicbrainz_albumartistid[0] : (metadata.common.musicbrainz_albumartistid || null),
            mbReleaseGroupId: metadata.common.musicbrainz_releasegroupid || null,
            mbWorkId: metadata.common.musicbrainz_workid || null,
            rawUrls: rawUrls.length > 0 ? rawUrls : null,
            credits: extractCredits(metadata),
        }
      }) + '\n');
    } catch (err: any) {
      process.stdout.write(JSON.stringify({ id: msg.id, error: err?.message || String(err) }) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
