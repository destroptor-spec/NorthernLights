import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ChildProcessPool } from '../workers/processPool';
import * as mm from 'music-metadata';
import { addDirectory, addTrack, addTrackFeatures, getTracksWithoutFeatures, getTracksWithSimulatedFeatures, getSimulatedFeatureTracks, getTrackCountWithFeatures, getAllTracks, getTrackById, getDirectories, removeDirectory, removeTracksByDirectory, getOrCreateArtist, getOrCreateAlbum, getOrCreateGenre, getAllArtists, getAllAlbums, getAllGenres, getPathsWithMeta, countTracksByArtHash, deleteTracksByPaths, purgeOrphanedEntities, recordUnparsedTrack, purgeOrphanedTracks, setTrackLovedForUser, getUserSetting, getSystemSetting, normalizeArtistNames, getPrimaryArtistName, normalizeArtistIdentityKey, setTrackCredits, isCompilationArtistName, setTrackLoudness, getTracksWithoutLoudness, getTracksWithFailedLoudness } from '../database';
import { measureLoudness } from '../services/loudness.service';
import { cleanupOrphanArt } from '../services/artCache';
import { genreMatrixService } from '../services/genreMatrix.service';
import { loveTrack, unloveTrack } from '../services/lastfm.service';
import { submitMbRecordingRating } from '../services/musicbrainz.service';
import { scanStatus, scanClients, broadcastScanStatus } from '../state';
import { requireAdmin } from '../middleware/auth';
import { startMbCreditsEnrichment, getMbCreditsProgress, startGeniusCreditsEnrichment, getGeniusCreditsProgress } from '../services/creditsEnrichment.service';
import { enrichArtistImages, enrichArtistImagesInBackground } from '../services/artistImageEnrichment.service';
import { getCreditsStatus, refreshArtistAudioProfiles, searchLibrary, searchLibraryRanked, InvalidSearchCursorError, getExistingTrackIds } from '../database';
import { createRateLimiter } from '../middleware/rateLimit';
import { areAnalysisModelsReady } from '../services/downloadModels';

const router = Router();

// Library scan/add/enrich routes drive filesystem walks and DB writes. Apply a
// per-user/IP rate limit across every route on this router.
router.use(createRateLimiter({
  keyPrefix: 'library',
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many library requests. Try again later.',
}));

// Mime type map
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

// ─── Scan status SSE ─────────────────────────────────────────────────
router.get('/scan/status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  scanClients.add(res);
  res.write(`data: ${JSON.stringify(scanStatus)}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    scanClients.delete(res);
  });
});

router.get('/artist-duplicates', requireAdmin, async (_req, res) => {
  try {
    const { getArtistDuplicateCandidates } = await import('../database');
    const candidates = await getArtistDuplicateCandidates();
    res.json({ candidates });
  } catch (error: any) {
    console.error('[ArtistDuplicates] list error:', error);
    res.status(500).json({ error: error.message || 'Failed to load artist duplicate candidates' });
  }
});

router.post('/artist-duplicates/dismiss', requireAdmin, async (req, res) => {
  try {
    const { candidateKey, signature, artistIds } = req.body || {};
    if (!candidateKey || !signature || !Array.isArray(artistIds) || artistIds.length < 2) {
      return res.status(400).json({ error: 'candidateKey, signature, and artistIds are required' });
    }
    const { dismissArtistDuplicateCandidate } = await import('../database');
    await dismissArtistDuplicateCandidate({
      candidateKey,
      signature,
      artistIds: artistIds.map(String),
      userId: req.user?.userId || null,
    });
    res.json({ status: 'dismissed' });
  } catch (error: any) {
    console.error('[ArtistDuplicates] dismiss error:', error);
    res.status(500).json({ error: error.message || 'Failed to dismiss artist duplicate candidate' });
  }
});

router.post('/artist-duplicates/merge', requireAdmin, async (req, res) => {
  try {
    const { candidateKey, signature, canonicalArtistId, duplicateArtistIds } = req.body || {};
    if (!candidateKey || !signature || !canonicalArtistId || !Array.isArray(duplicateArtistIds) || duplicateArtistIds.length < 1) {
      return res.status(400).json({ error: 'candidateKey, signature, canonicalArtistId, and duplicateArtistIds are required' });
    }
    const { mergeArtistDuplicateCandidate, purgeOrphanedEntities } = await import('../database');
    await mergeArtistDuplicateCandidate({
      candidateKey,
      signature,
      canonicalArtistId: String(canonicalArtistId),
      duplicateArtistIds: duplicateArtistIds.map(String),
      userId: req.user?.userId || null,
    });
    await purgeOrphanedEntities();
    res.json({ status: 'merged' });
  } catch (error: any) {
    console.error('[ArtistDuplicates] merge error:', error);
    res.status(500).json({ error: error.message || 'Failed to merge artist duplicate candidate' });
  }
});

// Manual merge — used when the auto-detector doesn't cluster two rows
// (e.g. "DJ Tiësto" vs "Tiësto") but the user knows they're the same.
router.post('/artists/manual-merge', requireAdmin, async (req, res) => {
  try {
    const { canonicalArtistId, duplicateArtistIds } = req.body || {};
    if (!canonicalArtistId || !Array.isArray(duplicateArtistIds) || duplicateArtistIds.length < 1) {
      return res.status(400).json({ error: 'canonicalArtistId and duplicateArtistIds are required' });
    }
    const cleanedDuplicates = duplicateArtistIds
      .map(String)
      .filter(id => id && id !== String(canonicalArtistId));
    if (cleanedDuplicates.length < 1) {
      return res.status(400).json({ error: 'At least one duplicate artist id distinct from the canonical is required' });
    }
    const { mergeArtistsManually, purgeOrphanedEntities } = await import('../database');
    await mergeArtistsManually({
      canonicalArtistId: String(canonicalArtistId),
      duplicateArtistIds: cleanedDuplicates,
      userId: req.user?.userId || null,
    });
    await purgeOrphanedEntities();
    res.json({ status: 'merged' });
  } catch (error: any) {
    console.error('[ArtistDuplicates] manual merge error:', error);
    res.status(500).json({ error: error.message || 'Failed to merge artists' });
  }
});

router.get('/genre-duplicates', requireAdmin, async (_req, res) => {
  try {
    const { getGenreReviewState } = await import('../services/genreCanonicalization.service');
    res.json(await getGenreReviewState());
  } catch (error: any) {
    console.error('[GenreDuplicates] list error:', error);
    res.status(500).json({ error: error.message || 'Failed to load genre duplicate candidates' });
  }
});

router.post('/genre-duplicates/dismiss', requireAdmin, async (req, res) => {
  try {
    const { candidateKey, signature, genreIds } = req.body || {};
    if (!candidateKey || !signature || !Array.isArray(genreIds) || genreIds.length < 1) {
      return res.status(400).json({ error: 'candidateKey, signature, and genreIds are required' });
    }
    const { dismissGenreCandidate } = await import('../services/genreCanonicalization.service');
    await dismissGenreCandidate({
      candidateKey: String(candidateKey),
      signature: String(signature),
      genreIds: genreIds.map(String),
      userId: req.user?.userId || null,
    });
    res.json({ status: 'dismissed' });
  } catch (error: any) {
    console.error('[GenreDuplicates] dismiss error:', error);
    res.status(500).json({ error: error.message || 'Failed to dismiss genre candidate' });
  }
});

router.post('/genres/merge', requireAdmin, async (req, res) => {
  try {
    const {
      canonicalGenreId,
      aliasGenreIds,
      candidateKey,
      signature,
      scoreEvidence,
      acknowledgeTaxonomyConflict,
    } = req.body || {};
    if (!canonicalGenreId || !Array.isArray(aliasGenreIds) || aliasGenreIds.length < 1) {
      return res.status(400).json({ error: 'canonicalGenreId and aliasGenreIds are required' });
    }
    const { groupGenres } = await import('../services/genreCanonicalization.service');
    await groupGenres({
      canonicalGenreId: String(canonicalGenreId),
      aliasGenreIds: aliasGenreIds.map(String),
      candidateKey: candidateKey ? String(candidateKey) : undefined,
      signature: signature ? String(signature) : undefined,
      scoreEvidence,
      acknowledgeTaxonomyConflict: acknowledgeTaxonomyConflict === true,
      userId: req.user?.userId || null,
    });
    res.json({ status: 'grouped' });
  } catch (error: any) {
    console.error('[GenreDuplicates] merge error:', error);
    const isConflict = error?.code === 'GENRE_TAXONOMY_CONFLICT';
    res.status(isConflict ? 409 : 400).json({
      error: error.message || 'Failed to group genres',
      code: isConflict ? 'GENRE_TAXONOMY_CONFLICT' : undefined,
    });
  }
});

router.post('/genres/:aliasId/restore', requireAdmin, async (req, res) => {
  try {
    const { restoreGenreAlias } = await import('../services/genreCanonicalization.service');
    await restoreGenreAlias({
      aliasGenreId: String(req.params.aliasId),
      userId: req.user?.userId || null,
    });
    res.json({ status: 'restored' });
  } catch (error: any) {
    console.error('[GenreDuplicates] restore error:', error);
    res.status(400).json({ error: error.message || 'Failed to restore genre alias' });
  }
});

// ─── Credit enrichment from external providers ──────────────────────
// Admin-triggered. Aurora's role-credit table is populated from on-disk
// tags during scan (always-on); these endpoints layer additional rows
// from MusicBrainz and Genius when those providers are connected.

router.get('/credits/status', requireAdmin, async (_req, res) => {
  try {
    const status = await getCreditsStatus();
    res.json(status);
  } catch (err: any) {
    console.error('[Credits] status error:', err);
    res.status(500).json({ error: err?.message || 'Failed to read credits status' });
  }
});

// Start the MusicBrainz credit-enrichment background job (throttled to ~1 req/s,
// so it can run for minutes). Returns immediately; the client polls /progress.
router.post('/credits/enrich/musicbrainz', requireAdmin, async (_req, res) => {
  try {
    const result = await startMbCreditsEnrichment();
    res.json(result);
  } catch (err: any) {
    console.error('[Credits] MB enrichment error:', err);
    res.status(500).json({ error: err?.message || 'MusicBrainz enrichment failed' });
  }
});

router.get('/credits/enrich/musicbrainz/progress', requireAdmin, (_req, res) => {
  res.json(getMbCreditsProgress());
});

// Start the Genius credit-enrichment background job. Returns immediately; the
// client polls /progress.
router.post('/credits/enrich/genius', requireAdmin, async (_req, res) => {
  try {
    const result = await startGeniusCreditsEnrichment();
    res.json(result);
  } catch (err: any) {
    console.error('[Credits] Genius enrichment error:', err);
    res.status(500).json({ error: err?.message || 'Genius enrichment failed' });
  }
});

router.get('/credits/enrich/genius/progress', requireAdmin, (_req, res) => {
  res.json(getGeniusCreditsProgress());
});

// Backfill artist pictures for the whole library using the configured artist-image
// provider. No-ops (skipped: 'no_provider') when no metadata provider is set up.
router.post('/artist-images/enrich', requireAdmin, async (_req, res) => {
  try {
    const result = await enrichArtistImages();
    res.json(result);
  } catch (err: any) {
    console.error('[ArtistImages] enrichment error:', err);
    res.status(500).json({ error: err?.message || 'Artist image enrichment failed' });
  }
});

router.post('/love', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { trackId, loved } = req.body || {};
    if (!trackId || typeof trackId !== 'string') {
      return res.status(400).json({ error: 'trackId is required' });
    }
    if (typeof loved !== 'boolean') {
      return res.status(400).json({ error: 'loved must be a boolean' });
    }

    const track = await getTrackById(trackId);
    if (!track) return res.status(404).json({ error: 'Track not found' });

    await setTrackLovedForUser(userId, trackId, loved);

    const syncJobs: Array<Promise<{ provider: string; status: 'ok' | 'skipped'; reason?: string }>> = [];

    const lastFmConnected = await getUserSetting(userId, 'lastFmConnected');
    if ((lastFmConnected === true || lastFmConnected === 'true') && track.artist && track.title) {
      syncJobs.push(
        (loved ? loveTrack(userId, track.artist, track.title) : unloveTrack(userId, track.artist, track.title))
          .then(() => ({ provider: 'lastfm', status: 'ok' as const }))
      );
    } else {
      syncJobs.push(Promise.resolve({ provider: 'lastfm', status: 'skipped' as const, reason: 'not_connected_or_missing_metadata' }));
    }

    const musicBrainzConnected = await getSystemSetting('musicBrainzConnected');
    if ((musicBrainzConnected === true || musicBrainzConnected === 'true') && track.mbRecordingId) {
      syncJobs.push(
        submitMbRecordingRating(track.mbRecordingId, loved ? 100 : 0)
          .then(() => ({ provider: 'musicbrainz', status: 'ok' as const }))
      );
    } else {
      syncJobs.push(Promise.resolve({ provider: 'musicbrainz', status: 'skipped' as const, reason: 'not_connected_or_missing_recording_mbid' }));
    }

    const settled = await Promise.allSettled(syncJobs);
    const providers = settled.map((result) => {
      if (result.status === 'fulfilled') return result.value;
      return { provider: 'unknown', status: 'failed', error: result.reason?.message || 'Provider sync failed' };
    });

    res.json({ status: 'ok', loved, providers });
  } catch (error: any) {
    console.error('[Library] love toggle error:', error.message);
    res.status(500).json({ error: 'Failed to update loved track' });
  }
});

// ─── Phase 1: Recursive directory walk ────────────────────────────────
interface WalkedFile {
  buf: Buffer;
  mtime: number; // epoch ms, floored
  size: number;  // bytes
}

async function collectAudioFiles(dirBuf: Buffer, results: WalkedFile[] = []): Promise<WalkedFile[]> {
  const sep = Buffer.from(path.sep);
  let entries: Buffer[];
  try {
    entries = await fs.promises.readdir(dirBuf, { encoding: 'buffer' });
  } catch {
    return results;
  }

  await Promise.all(entries.map(async (nameBuffer) => {
    const fullBuf = Buffer.concat([
      dirBuf,
      dirBuf[dirBuf.length - 1] === sep[0] ? Buffer.alloc(0) : sep,
      nameBuffer,
    ]);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullBuf);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      await collectAudioFiles(fullBuf, results);
    } else if (stat.isFile() && nameBuffer.toString('utf8').match(/\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i)) {
      results.push({ buf: fullBuf, mtime: Math.floor(stat.mtimeMs), size: stat.size });
    }
  }));

  return results;
}

// ─── Phase 2: Parallel metadata extraction (ID3 tags only, no audio analysis) ─
async function getScannerConcurrency(): Promise<number> {
  try {
    const { getSystemSetting } = await import('../database');
    const setting = await getSystemSetting('scannerConcurrency');
    switch (setting) {
      case 'HDD': return 4;
      case 'NVMe': return 12;
      case 'SSD':
      default: return 10;
    }
  } catch {
    return 10;
  }
}

interface ScanItem {
  buf: Buffer;
  mtime?: number | null;
  size?: number | null;
  knownArtHash?: string | null;
}

// Accepts either raw Buffers (refresh-metadata path) or ScanItems carrying
// mtime + the previously-stored art hash (incremental scan path).
async function processMetadataBatch(input: Array<Buffer | ScanItem>, concurrency: number): Promise<void> {
  const items: ScanItem[] = input.map((it) => (Buffer.isBuffer(it) ? { buf: it } : it));
  const startTime = Date.now();
  let errorCount = 0;
  const { settingsEmitter } = await import('../state');
  let index = 0;
  const activeMap = new Map<number, string>();
  const total = items.length;
  // Old art hashes displaced by a re-encode (changed cover). Cleaned up after
  // all upserts complete, so the refcount reflects the final state.
  const displacedArtHashes = new Set<string>();

  let currentConcurrency = Math.min(concurrency, total);
  const pool = new ChildProcessPool(path.resolve(__dirname, '../workers/scanTrack.ts'), currentConcurrency);
  await pool.init();

  let activeLoops = 0;
  let orchestrationActive = true;
  const activePromises = new Set<Promise<void>>();

  const runWorkerLoop = async () => {
    activeLoops++;
    try {
      while (orchestrationActive && activeLoops <= currentConcurrency && index < total) {
        const i = index++;
        if (i >= total) break;

        // Graceful degradation: pause if DB is down
        const { dbConnected } = await import('../state');
        if (!dbConnected) {
          console.warn('[Scanner] Database disconnected. Pausing metadata batch...');
          while (!(await import('../state')).dbConnected && orchestrationActive) {
            await new Promise(r => setTimeout(r, 5000));
          }
          if (!orchestrationActive) break;
          console.log('[Scanner] Database reconnected. Resuming metadata batch.');
        }

        const item = items[i];
        const fullBuf = item.buf;
        const dbPath = fullBuf.toString('base64');
        const utf8StringPath = fullBuf.toString('utf8');
        const nameStr = path.basename(utf8StringPath);
        let activeLabel = nameStr;

        activeMap.set(i, activeLabel);
        scanStatus.activeFiles = Array.from(activeMap.values());
        scanStatus.currentFile = activeLabel;
        scanStatus.scannedFiles++;
        try {
          const jobPromise = pool.runJob({
            id: dbPath,
            payload: {
              id: dbPath,
              filePathBase64: dbPath,
              nameStr: nameStr,
              processArt: true,
              knownArtHash: item.knownArtHash ?? null,
            }
          });

          scanStatus.activeWorkers = pool.getActiveCount();
          broadcastScanStatus();

          const result = await jobPromise;

          if (result.metadata) {
            const metadata = result.metadata;
            const displayArtist = metadata.artist || metadata.albumartist;
            const displayTitle = metadata.title || nameStr;
            activeLabel = displayArtist ? `${displayArtist} - ${displayTitle}` : nameStr;
            
            activeMap.set(i, activeLabel);
            scanStatus.activeFiles = Array.from(activeMap.values());
            scanStatus.currentFile = activeLabel;
            broadcastScanStatus();

            const rawArtistsField = metadata.artists;
            const rawArtist = metadata.artist;
            const finalArtists = normalizeArtistNames(rawArtistsField, rawArtist);
            const albumArtistName = getPrimaryArtistName(metadata.albumartist, rawArtist, finalArtists);
            const albumTitle = metadata.album || null;

            // Split genres
            let finalGenres: string[] = [];
            const rawGenreLine = metadata.genre && metadata.genre.length > 0 ? metadata.genre[0] : null;
            if (rawGenreLine) {
              const { splitGenreNames } = await import('../database');
              finalGenres = splitGenreNames(rawGenreLine);
            }
            const primaryGenreName = finalGenres.length > 0 ? finalGenres[0] : null;

            let artistId = null;
            let albumId = null;
            let genreId = null;
            // The track's PRIMARY credit is its performer. The album-artist
            // label only stands in for the performer on normal albums; on a
            // compilation it is "Various Artists", and crediting the track to
            // it would fold every performer onto one VA row. Detect the
            // compilation context and fall back to the real performer for the
            // track's artist_id (the *album* still keys off albumArtistName, so
            // the comp album groups correctly).
            const isCompilationContext =
              !!metadata.isCompilation || isCompilationArtistName(albumArtistName);
            const trackPrimaryArtistName = isCompilationContext
              ? (finalArtists[0] || (rawArtist && rawArtist.trim()) || albumArtistName)
              : albumArtistName;
            // On a comp the performer's id is the track-level mb_artist_id, not
            // the album-artist id.
            const primaryArtistMbid = isCompilationContext
              ? (metadata.mbArtistId || null)
              : (metadata.mbAlbumArtistId || metadata.mbArtistId || null);
            const primaryArtistKey = normalizeArtistIdentityKey(trackPrimaryArtistName);
            // If the primary artist was derived from a compound credit
            // ("A, B & C"), the file's MB artist id was scanned against the
            // compound string and doesn't belong to the first individual.
            const { splitArtistNames } = await import('../database');
            const primarySource = isCompilationContext ? rawArtist : (metadata.albumartist || rawArtist);
            const primaryFromCompound = splitArtistNames(primarySource).length > 1;
            const safePrimaryMbid = primaryFromCompound ? null : primaryArtistMbid;
            try { artistId = await getOrCreateArtist(trackPrimaryArtistName, safePrimaryMbid); } catch (e) {
              console.warn(`[Scanner] Failed to get/create artist "${trackPrimaryArtistName}" for ${nameStr}:`, e);
            }
            for (const a of finalArtists) {
              const artistMbid = normalizeArtistIdentityKey(a) === primaryArtistKey ? safePrimaryMbid : null;
              try { await getOrCreateArtist(a, artistMbid); } catch (e) {
                console.warn(`[Scanner] Failed to get/create artist "${a}" for ${nameStr}:`, e);
              }
            }
            try {
              albumId = await getOrCreateAlbum(albumTitle, albumArtistName, {
                mbReleaseGroupId: metadata.mbReleaseGroupId || null,
                year: metadata.year || null,
                releaseType: metadata.releaseType || null,
                isCompilation: metadata.isCompilation || false,
              });
            } catch (e) {
              console.warn(`[Scanner] Failed to get/create album "${albumTitle}" for ${nameStr}:`, e);
            }
            try { genreId = await getOrCreateGenre(primaryGenreName); } catch (e) {
              console.warn(`[Scanner] Failed to get/create genre "${primaryGenreName}" for ${nameStr}:`, e);
            }

            await addTrack({
              path: dbPath,
              title: metadata.title || nameStr,
              artist: metadata.artist || metadata.albumartist || null,
              albumArtist: metadata.albumartist || null,
              artists: finalArtists.length > 0 ? finalArtists : null,
              album: albumTitle,
              genre: primaryGenreName,
              duration: metadata.duration || 0,
              trackNumber: metadata.trackNumber || null,
              discNumber: metadata.discNumber || null,
              year: metadata.year || null,
              releaseType: metadata.releaseType || null,
              isCompilation: metadata.isCompilation || false,
              bitrate: metadata.bitrate || null,
              format: metadata.format || null,
              lossless: typeof metadata.lossless === 'boolean' ? metadata.lossless : null,
              artistId,
              albumId,
              genreId,
              genres: finalGenres.length > 0 ? finalGenres : null,
              isrc: metadata.isrc || null,
              mbRecordingId: metadata.mbRecordingId || null,
              mbTrackId: metadata.mbTrackId || null,
              mbAlbumId: metadata.mbAlbumId || null,
              mbArtistId: metadata.mbArtistId || null,
              mbAlbumArtistId: metadata.mbAlbumArtistId || null,
              mbReleaseGroupId: metadata.mbReleaseGroupId || null,
              mbWorkId: metadata.mbWorkId || null,
              rawUrls: metadata.rawUrls || null,
              artHash: metadata.artHash,
              artworkVersion: metadata.artworkVersion,
              fileMtime: item.mtime ?? null,
              fileSize: item.size ?? null,
            });

            // If a re-tag changed the cover, the previous hash may now be
            // orphaned — queue it for a refcount check after the batch.
            if (item.knownArtHash && metadata.artHash !== undefined && item.knownArtHash !== metadata.artHash) {
              displacedArtHashes.add(item.knownArtHash);
            }

            // Tag-derived multi-role credits (composer, conductor, remixer,
            // producer, etc.). DELETE-then-INSERT is scoped to source='tag'
            // inside setTrackCredits so any future MB-sourced rows survive.
            if (Array.isArray(metadata.credits) && metadata.credits.length > 0) {
              const trackId = Buffer.from(dbPath).toString('base64');
              try { await setTrackCredits(trackId, metadata.credits); } catch (e) {
                console.warn(`[Scanner] Failed to write credits for ${nameStr}:`, e);
              }
            }

            if (!metadata.genre || metadata.genre.length === 0) {
              console.warn(`[Scanner] No genre found for "${nameStr}". Hop-cost logic will be restricted.`);
            }
          } else {
            console.warn(`Failed to parse metadata for ${nameStr}: ${result.error}`);
            errorCount++;
            await recordUnparsedTrack({ path: dbPath, title: nameStr, fileMtime: item.mtime ?? null, fileSize: item.size ?? null });
          }
        } catch (err) {
          console.warn(`Failed metadata processing for ${nameStr}`, err);
          errorCount++;
          await recordUnparsedTrack({ path: dbPath, title: nameStr, fileMtime: item.mtime ?? null, fileSize: item.size ?? null });
        } finally {
          activeMap.delete(i);
          scanStatus.activeFiles = Array.from(activeMap.values());
          scanStatus.activeWorkers = pool.getActiveCount();
          broadcastScanStatus();
        }
      }
    } finally {
      activeLoops--;
    }
  };

  const updateConcurrency = (newLimit: number) => {
    currentConcurrency = newLimit;
    pool.resize(newLimit);
    while (activeLoops < currentConcurrency && index < total) {
      const p = runWorkerLoop();
      activePromises.add(p);
      p.finally(() => activePromises.delete(p));
    }
  };

  const onSettingsChanged = async () => {
    if (!orchestrationActive) return;
    try {
      const newLimitConf = await getScannerConcurrency();
      const newLimit = Math.min(newLimitConf, total);
      if (newLimit !== currentConcurrency) {
        console.log(`[Scanner] Dynamically scaling metadata concurrency ${currentConcurrency} -> ${newLimit}`);
        updateConcurrency(newLimit);
      }
    } catch { /* ignore */ }
  };

  settingsEmitter.on('concurrencyChanged', onSettingsChanged);
  updateConcurrency(currentConcurrency);

  while (index < total || activePromises.size > 0) {
    await new Promise(r => setTimeout(r, 100));
  }

  orchestrationActive = false;
  settingsEmitter.off('concurrencyChanged', onSettingsChanged);
  pool.terminate();

  // Remove encoded art for covers displaced by a re-tag, but only if no other
  // track still references the hash (album-shared art stays).
  if (displacedArtHashes.size > 0) {
    try {
      await cleanupOrphanArt(displacedArtHashes, async (h) => (await countTracksByArtHash(h)) > 0);
    } catch (e) {
      console.warn('[Scanner] Orphan art cleanup failed:', e);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Scanner] Phase: metadata - Duration: ${duration}s, Errors: ${errorCount}`);
}

// ─── Phase 3: Parallel audio analysis (ffmpeg + Essentia) ────────────

async function getAnalysisConcurrency(): Promise<number> {
  try {
    const { getSystemSetting } = await import('../database');
    const setting = await getSystemSetting('audioAnalysisCpu');
    switch (setting) {
      case 'Background':   return 1;
      case 'Balanced':     return 4;
      case 'Performance':  return 8;
      case 'Intensive':    return 16;
      case 'Maximum': {
        // Use all logical CPU cores reported by the OS
        const { cpus } = await import('os');
        return Math.max(1, cpus().length);
      }
      default: return 4; // Balanced
    }
  } catch {
    return 4;
  }
}

async function processAnalysisBatch(tracks: { id: string; filePath: Buffer; title: string; artist?: string | null }[], concurrency: number): Promise<void> {
  const startTime = Date.now();
  let errorCount = 0;
  let featuresWritten = 0;
  const { settingsEmitter } = await import('../state');
  const { getVectorStats } = await import('../database');
  let index = 0;
  const total = tracks.length;

  // Fetch vector stats once for the entire batch instead of per-track
  let vectorStats: any = null;
  try {
    vectorStats = await getVectorStats();
    console.log(`[Analysis] Loaded vector stats for ${total} tracks (cached for batch)`);
  } catch (err) {
    console.warn('[Analysis] Failed to fetch vector stats, will use per-track fallback');
  }

  let currentConcurrency = Math.min(concurrency, total);
  const pool = new ChildProcessPool(path.resolve(__dirname, '../workers/analyzeTrack.ts'), currentConcurrency);
  await pool.init();

  let activeLoops = 0;
  let orchestrationActive = true;
  const activePromises = new Set<Promise<void>>();
  const activeMap = new Map<number, string>();

  const runWorkerLoop = async () => {
    activeLoops++;
    try {
      while (orchestrationActive && activeLoops <= currentConcurrency && index < total) {
        const i = index++;
        if (i >= total) break;

        const track = tracks[i];
        const displayName = track.artist ? `${track.artist} - ${track.title}` : track.title;
        
        activeMap.set(i, displayName);
        scanStatus.activeFiles = Array.from(activeMap.values());
        scanStatus.currentFile = displayName;
        scanStatus.scannedFiles++;
        try {
          const jobPromise = pool.runJob({
            id: track.id,
            payload: {
              id: track.id,
              filePathBase64: track.filePath.toString('base64'),
              title: track.title,
              artist: track.artist || null,
              vectorStats
            }
          });

          scanStatus.activeWorkers = pool.getWorkerCount();
          broadcastScanStatus();

          const result = await jobPromise;

          if (result.audioFeatures) {
            try {
              await addTrackFeatures(result.id, result.audioFeatures);
              featuresWritten++;
              if (result.audioFeatures.is_simulated) {
                const decodedPath = track.filePath.toString('utf8');
                console.warn(`[Analysis] Stored simulated features trackId=${track.id} title="${track.title}" artist="${track.artist || ''}" filePath="${decodedPath}"`);
              }
            } catch (err) {
              console.warn(`[Analysis] DB write failed for track ${result.id}:`, err);
            }
          } else if (result.error) {
            console.warn(`[Analysis] Failed for "${track.title || result.id}": ${result.error}`);
            errorCount++;
          }
        } catch (err) {
          console.error(`[Analysis] Job failed for "${track.title}":`, err);
          errorCount++;
        } finally {
          activeMap.delete(i);
          scanStatus.activeFiles = Array.from(activeMap.values());
          scanStatus.activeWorkers = pool.getWorkerCount();
          broadcastScanStatus();
        }
      }
    } finally {
      activeLoops--;
    }
  };

  const updateConcurrency = (newLimit: number) => {
    currentConcurrency = newLimit;
    pool.resize(newLimit);
    while (activeLoops < currentConcurrency && index < total) {
      const p = runWorkerLoop();
      activePromises.add(p);
      p.finally(() => activePromises.delete(p));
    }
  };

  const onSettingsChanged = async () => {
    if (!orchestrationActive) return;
    try {
      const newLimitConf = await getAnalysisConcurrency();
      const newLimit = Math.min(newLimitConf, total);
      if (newLimit !== currentConcurrency) {
        console.log(`[Analysis] Dynamically scaling worker concurrency ${currentConcurrency} -> ${newLimit}`);
        updateConcurrency(newLimit);
      }
    } catch { /* ignore */ }
  };

  settingsEmitter.on('concurrencyChanged', onSettingsChanged);
  updateConcurrency(currentConcurrency);

  while (index < total || activePromises.size > 0) {
    await new Promise(r => setTimeout(r, 100));
  }

  orchestrationActive = false;
  settingsEmitter.off('concurrencyChanged', onSettingsChanged);
  pool.terminate();

  // Single chokepoint for every analysis path (scan, standalone /analyze,
  // simulated re-analysis, future workers): refresh the per-artist audio
  // profiles MV so "similar artists" reflects the new vectors. Fire-and-forget;
  // errors are logged internally. Skipped when nothing was written.
  if (featuresWritten > 0) void refreshArtistAudioProfiles();
}

// Loudness (EBU R128) backfill. Mirrors processAnalysisBatch's dynamic worker
// loop + concurrencyChanged scaling + scan-status progress, but runs the ffmpeg
// measurement in-process (ffmpeg is its own binary — no worker/pool subsystem).
// Shares the audioAnalysisCpu concurrency knob; callers run it AFTER the feature
// batch so two full-file decode workloads don't contend for cores.
async function processLoudnessBatch(tracks: { id: string; filePath: Buffer; title: string; artist?: string | null }[], concurrency: number): Promise<void> {
  const { settingsEmitter } = await import('../state');
  let index = 0;
  const total = tracks.length;
  let currentConcurrency = Math.max(1, Math.min(concurrency, total));
  let activeLoops = 0;
  let orchestrationActive = true;
  const activePromises = new Set<Promise<void>>();
  const activeMap = new Map<number, string>();

  const runWorkerLoop = async () => {
    activeLoops++;
    try {
      while (orchestrationActive && activeLoops <= currentConcurrency && index < total) {
        const i = index++;
        if (i >= total) break;
        const track = tracks[i];
        const displayName = track.artist ? `${track.artist} - ${track.title}` : track.title;
        activeMap.set(i, displayName);
        scanStatus.activeFiles = Array.from(activeMap.values());
        scanStatus.currentFile = displayName;
        scanStatus.scannedFiles++;
        scanStatus.activeWorkers = activeMap.size;
        broadcastScanStatus();
        try {
          const result = await measureLoudness(track.filePath.toString('utf8'));
          // (null, null) records a failure sentinel so it isn't retried forever.
          await setTrackLoudness(track.id, result?.lufs ?? null, result?.truePeakDbfs ?? null);
        } catch (err) {
          console.error(`[Loudness] batch job failed for "${track.title}":`, err);
        } finally {
          activeMap.delete(i);
          scanStatus.activeFiles = Array.from(activeMap.values());
          scanStatus.activeWorkers = activeMap.size;
          broadcastScanStatus();
        }
      }
    } finally {
      activeLoops--;
    }
  };

  const updateConcurrency = (newLimit: number) => {
    currentConcurrency = newLimit;
    while (activeLoops < currentConcurrency && index < total) {
      const p = runWorkerLoop();
      activePromises.add(p);
      p.finally(() => activePromises.delete(p));
    }
  };

  const onSettingsChanged = async () => {
    if (!orchestrationActive) return;
    try {
      const newLimit = Math.min(await getAnalysisConcurrency(), total);
      if (newLimit !== currentConcurrency) {
        console.log(`[Loudness] Dynamically scaling concurrency ${currentConcurrency} -> ${newLimit}`);
        updateConcurrency(newLimit);
      }
    } catch { /* ignore */ }
  };

  settingsEmitter.on('concurrencyChanged', onSettingsChanged);
  updateConcurrency(currentConcurrency);

  while (index < total || activePromises.size > 0) {
    await new Promise(r => setTimeout(r, 100));
  }

  orchestrationActive = false;
  settingsEmitter.off('concurrencyChanged', onSettingsChanged);
}

// ─── Shared scan lifecycle helpers ────────────────────────────────────

function resetScanStatus(libraryChanged = false) {
  scanStatus.isScanning = false;
  scanStatus.phase = 'idle';
  scanStatus.currentFile = '';
  scanStatus.activeFiles = [];
  scanStatus.activeWorkers = 0;
  scanStatus.libraryChanged = libraryChanged;
  broadcastScanStatus(true);
}

// ─── API Endpoints ────────────────────────────────────────────────────

// Add a mapped folder
router.post('/add', requireAdmin, async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Missing absolute path parameter' });
  }
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: 'Path does not exist or is not a directory' });
  }
  try {
    await addDirectory(dirPath);
    res.json({ status: 'added' });
  } catch (error) {
    console.error('Add mapping error:', error);
    res.status(500).json({ error: 'Failed to add directory mapping' });
  }
});

// Trigger library scan (walk → metadata → analysis, all in one)
router.post('/scan', requireAdmin, async (req, res) => {
  console.log('Scan Request Received. Body:', JSON.stringify(req.body));
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Missing absolute path parameter in body' });
  }

  if (!fs.existsSync(dirPath)) {
    return res.status(400).json({ error: 'Path does not exist' });
  }

  if (!fs.statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: 'Path is not a directory' });
  }

  if (scanStatus.isScanning) {
    return res.status(400).json({ error: 'Scan already in progress' });
  }

  let walkResult: { added: number; removed: number } | null = null;
  try {
    scanStatus.isScanning = true;
    scanStatus.scannedFiles = 0;
    scanStatus.totalFiles = 0;
    scanStatus.activeFiles = [];
    scanStatus.activeWorkers = 0;
    scanStatus.phase = 'walk';
    scanStatus.currentFile = `Walking ${path.basename(dirPath)}...`;
    broadcastScanStatus(true);

    await addDirectory(dirPath);

    console.log(`[Scan] Starting scan for: ${dirPath}`);
    walkResult = await runSyncWalk(dirPath);
    console.log(`[Scan] Completed for ${dirPath}: ${walkResult.added} added, ${walkResult.removed} removed`);

    res.json({ 
      status: 'completed', 
      added: walkResult.added, 
      removed: walkResult.removed,
      message: walkResult.added > 0 || walkResult.removed > 0 
        ? `Added ${walkResult.added} tracks, removed ${walkResult.removed} stale`
        : 'No changes detected'
    });
  } catch (error) {
    console.error('Scan init error:', error);
    res.status(500).json({ error: 'Failed to complete scan' });
  } finally {
    resetScanStatus(walkResult ? (walkResult.added > 0 || walkResult.removed > 0) : false);
  }
});

// ─── Sync Walk: diff disk vs DB, remove stale, scan new ───────────────
// Exported so the auto-walk scheduler in server/index.ts can reuse it.
export async function runSyncWalk(dirPath: string): Promise<{ removed: number; added: number }> {
  const totalStartTime = Date.now();
  const dirBuf = Buffer.from(dirPath, 'utf8');

  // ── Walk ──
  const walkStartTime = Date.now();
  const walkedFiles = await collectAudioFiles(dirBuf);
  console.log(`[Scanner] Phase: walk - Duration: ${((Date.now() - walkStartTime) / 1000).toFixed(1)}s`);
  const diskPaths = new Set(walkedFiles.map(f => f.buf.toString('base64')));

  // ── Diff against DB ──
  // One query gives us both the known paths and their stored mtime + art hash.
  const existingMeta = await getPathsWithMeta(); // Map<base64, { mtime, artHash }>

  const stalePaths: string[] = [];
  for (const existingPath of existingMeta.keys()) {
    // Only consider tracks that belong to this directory (byte-level prefix check)
    const fileBuf = Buffer.from(existingPath, 'base64');
    const prefixMatches = fileBuf.length >= dirBuf.length &&
      fileBuf.slice(0, dirBuf.length).equals(dirBuf);
    const atBoundary = fileBuf.length === dirBuf.length || fileBuf[dirBuf.length] === 0x2F;
    if (!prefixMatches || !atBoundary) continue;

    // If this path is no longer on disk, mark for removal
    if (!diskPaths.has(existingPath)) {
      stalePaths.push(existingPath);
    }
  }

  // Remove stale DB entries (collect their art hashes first so we can clean up
  // any now-orphaned encoded covers afterwards).
  if (stalePaths.length > 0) {
    const staleArtHashes = new Set<string>();
    for (const p of stalePaths) {
      const h = existingMeta.get(p)?.artHash;
      if (h) staleArtHashes.add(h);
    }

    console.log(`[Scanner] Removing ${stalePaths.length} stale track(s) from ${dirPath}`);
    await deleteTracksByPaths(stalePaths);
    // Clean up any albums/artists/genres that now have zero tracks
    const purged = await purgeOrphanedEntities();
    if (purged.albums > 0 || purged.artists > 0 || purged.genres > 0) {
      console.log(`[Scanner] Purged orphans after stale removal: ${purged.albums} albums, ${purged.artists} artists, ${purged.genres} genres`);
    }
    if (staleArtHashes.size > 0) {
      try {
        await cleanupOrphanArt(staleArtHashes, async (h) => (await countTracksByArtHash(h)) > 0);
      } catch (e) {
        console.warn('[Scanner] Orphan art cleanup after stale removal failed:', e);
      }
    }
  }

  // New files, plus existing files whose mtime changed (re-tagged / replaced).
  // A stored mtime of null is a pre-feature row — treat as unchanged here and
  // let "Refresh metadata" backfill it, rather than reprocessing the whole
  // library on the first scan after upgrade.
  const itemsToProcess: ScanItem[] = [];
  for (const f of walkedFiles) {
    const b64 = f.buf.toString('base64');
    const meta = existingMeta.get(b64);
    if (!meta) {
      itemsToProcess.push({ buf: f.buf, mtime: f.mtime, size: f.size, knownArtHash: null });
    } else if (meta.mtime != null && meta.mtime !== f.mtime) {
      itemsToProcess.push({ buf: f.buf, mtime: f.mtime, size: f.size, knownArtHash: meta.artHash });
    } else if (meta.needsReparse) {
      // Never-parsed row (format IS NULL): re-attempt regardless of mtime so a
      // transient failure (file scanned mid-copy, cover sharp couldn't decode)
      // self-heals on the next walk.
      itemsToProcess.push({ buf: f.buf, mtime: f.mtime, size: f.size, knownArtHash: meta.artHash });
    }
  }

  // Backfill file_size for rows that predate the column (cheap stat-only pass;
  // a no-op once every on-disk track has a size). Runs even when there are no
  // metadata changes so an existing library gets sizes on the next scan.
  try {
    const { backfillTrackFileSizes } = await import('../database');
    const filled = await backfillTrackFileSizes();
    if (filled > 0) console.log(`[Scanner] Backfilled file_size for ${filled} track(s)`);
  } catch (e) {
    console.warn('[Scanner] file_size backfill failed:', e);
  }

  if (itemsToProcess.length === 0 && stalePaths.length === 0) {
    console.log(`[Scanner] No changes detected in ${dirPath}`);
    return { removed: stalePaths.length, added: 0 };
  }

  if (itemsToProcess.length > 0) {
    // ── Metadata (also encodes/updates artwork) ──
    scanStatus.phase = 'metadata';
    scanStatus.totalFiles = itemsToProcess.length;
    scanStatus.scannedFiles = 0;
    scanStatus.currentFile = '';
    broadcastScanStatus(true);
    const metadataConcurrency = await getScannerConcurrency();
    await processMetadataBatch(itemsToProcess, metadataConcurrency);
    console.log(`[Scanner] Metadata phase complete: ${itemsToProcess.length} new/changed file(s)`);

    // ── Analysis ──
    const tracksNeedingAnalysis = await getTracksWithoutFeatures();
    const analysisModelsReady = tracksNeedingAnalysis.length > 0
      ? await areAnalysisModelsReady()
      : false;
    if (tracksNeedingAnalysis.length > 0 && analysisModelsReady) {
      scanStatus.phase = 'analysis';
      scanStatus.totalFiles = tracksNeedingAnalysis.length;
      scanStatus.scannedFiles = 0;
      scanStatus.currentFile = '';
      broadcastScanStatus(true);
      const concurrency = await getAnalysisConcurrency();
      await processAnalysisBatch(tracksNeedingAnalysis, concurrency);
      console.log(`[Scanner] Analysis phase complete: ${tracksNeedingAnalysis.length} track(s) analyzed`);
    } else if (tracksNeedingAnalysis.length > 0) {
      console.log(`[Scanner] Analysis deferred for ${tracksNeedingAnalysis.length} track(s): ML models are not ready`);
    }

    // ── Loudness (EBU R128) — after features so two full-decode passes don't contend.
    // Skipped in 'lazy' mode (tracks are measured on play instead). ──
    const loudnessMode = (await getSystemSetting('loudnessComputeMode')) || 'both';
    if (loudnessMode === 'full' || loudnessMode === 'both') {
      const tracksNeedingLoudness = await getTracksWithoutLoudness();
      if (tracksNeedingLoudness.length > 0) {
        scanStatus.phase = 'loudness';
        scanStatus.totalFiles = tracksNeedingLoudness.length;
        scanStatus.scannedFiles = 0;
        scanStatus.currentFile = '';
        broadcastScanStatus(true);
        await processLoudnessBatch(tracksNeedingLoudness, await getAnalysisConcurrency());
        console.log(`[Scanner] Loudness phase complete: ${tracksNeedingLoudness.length} track(s) measured`);
      }
    }
  }

  // Trigger Genre Matrix regeneration after any change
  if (itemsToProcess.length > 0 || stalePaths.length > 0) {
    setImmediate(() => {
      genreMatrixService.runDiffAndGenerate()
        .catch(e => console.error('[Genre Matrix] Post-scan categorization failed:', e));
    });
  }

  // Fill in pictures for any newly-added artists (and backfill the rest), bounded
  // and throttled. No-ops when no metadata provider is configured — library is
  // canon, and no provider simply means initials in the Artists grid.
  if (itemsToProcess.length > 0) {
    enrichArtistImagesInBackground();
  }

  const totalDuration = ((Date.now() - totalStartTime) / 1000).toFixed(1);
  console.log(`[Scanner] Sync walk complete for ${dirPath}: ~${itemsToProcess.length} processed, -${stalePaths.length} removed (Total: ${totalDuration}s)`);
  return { removed: stalePaths.length, added: itemsToProcess.length };
}

// Trigger standalone analysis (no scan — analyzes tracks missing features)
router.post('/refresh-metadata', async (req, res) => {
  const dirPath = req.body.path;

  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Folder path is required' });
  }

  if (scanStatus.isScanning) {
    return res.status(400).json({ error: 'Scan already in progress' });
  }

  // Run the refresh logic asynchronously to prevent blocking the HTTP response
  // and correctly trigger the UI scanning indicator via SSE.
  (async () => {
    scanStatus.isScanning = true;
    scanStatus.phase = 'metadata';
    scanStatus.scannedFiles = 0;
    scanStatus.totalFiles = 0;
    scanStatus.activeFiles = [];
    scanStatus.activeWorkers = 0;
    scanStatus.currentFile = `Refreshing metadata for ${path.basename(dirPath)}...`;
    scanStatus.libraryChanged = false;
    broadcastScanStatus(true);
    let processedExistingFiles = false;

    try {
      const { getPathsForDirectory } = await import('../database');
      const fileBufs = await getPathsForDirectory(dirPath);

      if (fileBufs.length === 0) {
        resetScanStatus(false);
        return;
      }

      processedExistingFiles = true;
      scanStatus.totalFiles = fileBufs.length;
      scanStatus.scannedFiles = 0;
      scanStatus.currentFile = '';
      broadcastScanStatus(true);

      const metadataConcurrency = await getScannerConcurrency();

      // Re-read every file in the dir (this is also the artwork backfill path:
      // it encodes any missing covers). Stat for mtime so backfilled rows also
      // get file_mtime stamped — future incremental scans can then detect
      // re-tags on these files too.
      const refreshItems: ScanItem[] = await Promise.all(fileBufs.map(async (buf) => {
        let mtime: number | null = null;
        let size: number | null = null;
        try { const st = await fs.promises.stat(buf); mtime = Math.floor(st.mtimeMs); size = st.size; } catch { /* missing → leave null */ }
        return { buf, mtime, size };
      }));

      await processMetadataBatch(refreshItems, metadataConcurrency);
      
      const purged = await purgeOrphanedEntities();
      console.log(`[Scanner] Purged orphaned entities after refresh: ${purged.artists} artists, ${purged.albums} albums, ${purged.genres} genres`);

      resetScanStatus(true);

      const { genreMatrixService } = await import('../services/genreMatrix.service');
      setImmediate(() => {
        genreMatrixService.runDiffAndGenerate().catch(e => console.error('[Genre Matrix]', e));
      });

      // Backfill artist pictures for the whole library (no-op without a provider).
      enrichArtistImagesInBackground();

    } catch (error: any) {
      resetScanStatus(processedExistingFiles);
      console.error('[Refresh Metadata Error]', error);
    }
  })();

  return res.status(202).json({ message: 'Refresh metadata accepted' });
});

// Admin-only visibility into fallback analysis. File paths are local server paths,
// so keep this behind requireAdmin even though the settings UI is admin-only too.
router.get('/analyze/simulated', requireAdmin, async (req, res) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
    const tracks = await getSimulatedFeatureTracks(limit);
    res.json({ tracks, count: tracks.length });
  } catch (error) {
    console.error('[Analysis] Failed to list simulated tracks:', error);
    res.status(500).json({ error: 'Failed to list simulated tracks' });
  }
});

// Trigger standalone analysis (no scan — analyzes tracks missing features)
router.post('/analyze', async (req, res) => {
  if (scanStatus.isScanning) {
    return res.status(400).json({ 
      error: 'A scan or analysis is already in progress',
      phase: scanStatus.phase,
      detail: `Currently in ${scanStatus.phase} phase. Please wait for it to complete.`
    });
  }

  if (!await areAnalysisModelsReady()) {
    return res.status(409).json({
      error: 'Audio analysis models are not ready.',
      detail: 'Download MusiCNN and Discogs-EffNet before starting analysis.',
    });
  }

  const force = req.body?.force === true;
  const simulatedOnly = req.body?.simulatedOnly === true;

  try {
    let tracksToAnalyze: { id: string; filePath: Buffer; title: string; artist?: string | null }[];

    if (simulatedOnly) {
      tracksToAnalyze = await getTracksWithSimulatedFeatures();
    } else if (force) {
      // Re-analyze ALL tracks (e.g., after Essentia upgrade)
      const { initDB } = await import('../database');
      const db = await initDB();
      const dbRes = await db.query('SELECT t.id, t.path, t.title, t.artist FROM tracks t ORDER BY t.title');
      tracksToAnalyze = dbRes.rows.map((r: any) => ({
        id: r.id,
        filePath: Buffer.from(r.path, 'base64'),
        title: r.title,
        artist: r.artist || null,
      }));
    } else {
      tracksToAnalyze = await getTracksWithoutFeatures();
    }

    if (tracksToAnalyze.length === 0) {
      const message = simulatedOnly
        ? 'No simulated fallback tracks need re-analysis'
        : 'All tracks already have audio features';
      return res.json({ status: 'completed', message, count: 0 });
    }

    scanStatus.isScanning = true;
    scanStatus.phase = 'analysis';
    scanStatus.totalFiles = tracksToAnalyze.length;
    scanStatus.scannedFiles = 0;
    scanStatus.activeFiles = [];
    scanStatus.activeWorkers = 0;
    scanStatus.currentFile = '';
    broadcastScanStatus(true);

    const concurrency = await getAnalysisConcurrency();
    await processAnalysisBatch(tracksToAnalyze, concurrency);
    console.log(`[Analysis] Standalone analysis complete: ${tracksToAnalyze.length} tracks`);

    // Trigger Genre Matrix regeneration after analysis
    setImmediate(() => {
      genreMatrixService.runDiffAndGenerate()
        .catch(e => console.error('[Genre Matrix] Post-analysis categorization failed:', e));
    });

    res.json({ status: 'completed', message: `Analyzed ${tracksToAnalyze.length} tracks`, count: tracksToAnalyze.length });
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Failed to complete analysis' });
  } finally {
    resetScanStatus();
  }
});

// Backfill loudness (EBU R128). Default: tracks never attempted. force: ALL
// tracks (re-measure). retryFailures: tracks whose prior measurement failed.
router.post('/analyze/loudness', async (req, res) => {
  if (scanStatus.isScanning) {
    return res.status(400).json({
      error: 'A scan or analysis is already in progress',
      phase: scanStatus.phase,
      detail: `Currently in ${scanStatus.phase} phase. Please wait for it to complete.`,
    });
  }

  const force = req.body?.force === true;
  const retryFailures = req.body?.retryFailures === true;

  try {
    let tracks: { id: string; filePath: Buffer; title: string; artist?: string | null }[];
    if (force) {
      const { initDB } = await import('../database');
      const db = await initDB();
      const dbRes = await db.query('SELECT t.id, t.path, t.title, t.artist FROM tracks t ORDER BY t.title');
      tracks = dbRes.rows.map((r: any) => ({ id: r.id, filePath: Buffer.from(r.path, 'base64'), title: r.title, artist: r.artist || null }));
    } else if (retryFailures) {
      tracks = await getTracksWithFailedLoudness();
    } else {
      tracks = await getTracksWithoutLoudness();
    }

    if (tracks.length === 0) {
      return res.json({ status: 'completed', message: 'All tracks already have loudness', count: 0 });
    }

    scanStatus.isScanning = true;
    scanStatus.phase = 'loudness';
    scanStatus.totalFiles = tracks.length;
    scanStatus.scannedFiles = 0;
    scanStatus.activeFiles = [];
    scanStatus.activeWorkers = 0;
    scanStatus.currentFile = '';
    broadcastScanStatus(true);

    await processLoudnessBatch(tracks, await getAnalysisConcurrency());
    console.log(`[Loudness] Standalone backfill complete: ${tracks.length} tracks`);
    res.json({ status: 'completed', message: `Measured ${tracks.length} tracks`, count: tracks.length });
  } catch (error) {
    console.error('Loudness backfill error:', error);
    res.status(500).json({ error: 'Failed to complete loudness backfill' });
  } finally {
    resetScanStatus();
  }
});

// Get analysis status (how many tracks have features vs total)
router.get('/analyze/status', async (req, res) => {
  try {
    const counts = await getTrackCountWithFeatures();
    res.json(counts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get analysis status' });
  }
});

// Remove a mapped folder
router.post('/remove', requireAdmin, async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Missing absolute path parameter' });
  }

  try {
    // 1. Remove the directory registration first so isPathAllowed starts rejecting it immediately
    await removeDirectory(dirPath);
    // 2. Primary path-prefix deletion
    await removeTracksByDirectory(dirPath);
    // 3. Safety-net: catch any tracks missed by path-prefix matching
    const staleTracks = await purgeOrphanedTracks();
    // 4. Clean up entity rows that now have zero tracks
    const purged = await purgeOrphanedEntities();
    console.log(`[Scanner] Removed directory ${dirPath}. Purged ${staleTracks} stale tracks, ${purged.albums} albums, ${purged.artists} artists, ${purged.genres} genres`);
    res.json({ status: 'removed', staleTracks, purged });
  } catch (error) {
    console.error('Remove error:', error);
    res.status(500).json({ error: 'Failed to remove directory' });
  }
});

// Get entire library
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const [tracks, directories, artists, albums, genres] = await Promise.all([
      getAllTracks(userId),
      getDirectories(),
      getAllArtists(),
      getAllAlbums(),
      getAllGenres(),
    ]);
    res.json({ tracks, directories, artists, albums, genres });
  } catch (error) {
    console.error('DB fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch library' });
  }
});

// Tracks-only bulk endpoint. Splitting tracks out of GET / lets the client load
// the lightweight entity lists first (artists/albums/genres) and pull the large
// track list in the background, so views don't wait on it.
router.get('/tracks', async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const tracks = await getAllTracks(userId);
    res.json({ tracks });
  } catch (error) {
    console.error('DB tracks fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// Global search across artists/albums/tracks (trigram ILIKE). Replaces the
// client-side in-memory scan so search scales without the full track list.
router.get('/search', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const userId = req.user?.userId || null;
    const num = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined);
    if (req.query.mode === 'ranked') {
      const result = await searchLibraryRanked(q, userId, {
        limit: num(req.query.limit),
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      });
      res.json(result);
      return;
    }
    const result = await searchLibrary(q, userId, {
      artistLimit: num(req.query.artistLimit),
      albumLimit: num(req.query.albumLimit),
      trackLimit: num(req.query.trackLimit),
    });
    res.json(result);
  } catch (error) {
    if (error instanceof InvalidSearchCursorError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Library search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Which of the supplied track ids still exist. Lets the client prune a
// restored play queue without fetching the whole library.
router.post('/tracks/exists', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === 'string') : [];
    res.json({ ids: await getExistingTrackIds(ids) });
  } catch (error) {
    console.error('tracks/exists error:', error);
    res.status(500).json({ error: 'Failed to check tracks' });
  }
});

// Mapped library folders (paths only) — lightweight companion to the entity
// lists for the entity-first load path.
router.get('/directories', async (_req, res) => {
  try {
    res.json({ directories: await getDirectories() });
  } catch (error) {
    console.error('DB directories fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch directories' });
  }
});

// Get per-directory stats (total tracks, with metadata, analyzed)
router.get('/stats', async (req, res) => {
  try {
    const { getDirectories } = await import('../database');
    const db = await (await import('../database')).initDB();

    const dirs = await getDirectories();
    if (dirs.length === 0) {
      return res.json({ directories: [] });
    }

    // path is stored as base64 in the tracks table.
    // Fetch all tracks once and decode them for fast accurate matching.
    const tracksRes = await db.query(`
      SELECT t.path,
             t.artist IS NOT NULL AND t.artist != '' AS has_artist,
             t.album IS NOT NULL AND t.album != '' AS has_album,
             tf.embedding_vector IS NOT NULL AS has_features
      FROM tracks t
      LEFT JOIN track_features tf ON t.id = tf.track_id
    `);

    // Pre-decode all paths
    const tracks = tracksRes.rows.map(row => ({
      decodedPath: Buffer.from(row.path, 'base64').toString('utf8'),
      has_metadata: row.has_artist || row.has_album,
      has_features: row.has_features
    }));

    const result = [];

    for (const rawDir of dirs) {
      // Ensure trailing slash for accurate prefix matching
      const prefix = rawDir.endsWith('/') ? rawDir : rawDir + '/';
      
      let total = 0;
      let withMetadata = 0;
      let analyzed = 0;

      for (const t of tracks) {
        if (t.decodedPath.startsWith(prefix)) {
          total++;
          if (t.has_metadata) withMetadata++;
          if (t.has_features) analyzed++;
        }
      }

      result.push({
        path: rawDir,
        totalTracks: total,
        withMetadata,
        analyzed
      });
    }

    res.json({ directories: result });
  } catch (error) {
    console.error('Library stats error:', error);
    res.status(500).json({ error: 'Failed to get library stats' });
  }
});

export default router;
