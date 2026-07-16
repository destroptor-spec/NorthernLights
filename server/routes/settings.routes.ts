import { Router } from 'express';
import { getSystemSetting, setSystemSetting, getUserSetting, setUserSetting, getSubGenreMappings } from '../database';
import { requireAdmin } from '../middleware/auth';
import { genreMatrixService } from '../services/genreMatrix.service';
import OpenAI from 'openai';

const router = Router();

const userKeys = new Set(['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'playedThresholdPercent', 'llmPlaylistDiversity', 'llmVetoMode', 'llmGenreCohesion', 'llmDiscoveryBias', 'llmArtistSpread', 'genrePenaltyCurve', 'llmRecoveryStrength', 'llmAdjacentReach', 'llmTracksPerPlaylist', 'llmPlaylistCount', 'lastFmScrobbleEnabled', 'listenBrainzScrobbleEnabled', 'subsonicProviderScrobbleEnabled', 'concertsEnabled', 'concertsLat', 'concertsLng', 'concertsLocationLabel', 'concertsRadiusKm', 'concertsAutoAddEnabled', 'loudnessNormEnabled', 'loudnessTargetLufs', 'loudnessPreampDb', 'loudnessMode']);
const serverKeys = new Set(['llmBaseUrl', 'llmApiKey', 'llmModelName', 'hubGenerationSchedule', 'systemPlaylistConfig', 'audioAnalysisCpu', 'scannerConcurrency', 'loudnessComputeMode', 'geniusApiKey', 'lastFmApiKey', 'lastFmSharedSecret', 'musicBrainzEnabled', 'musicBrainzClientId', 'musicBrainzClientSecret', 'musicBrainzRedirectUri', 'providerArtistImage', 'providerArtistArtwork', 'providerArtistBio', 'providerAlbumArt', 'autoFolderWalk', 'jambaseEnabled', 'jambaseMaxSubscriptionsPerUser', 'jambaseCacheTtlDays', 'jambaseMonthlyCap', 'jambaseHardStop', 'youtubeEnabled', 'youtubeApiKey', 'youtubeCacheTtlDays', 'youtubeDailyQuotaCap', 'youtubeHardStop', 'hlsLoggingEnabled', 'ffmpegLoggingEnabled', 'openSubsonicEnabled', 'turnstileEnabled', 'turnstileSiteKey', 'turnstileSecretKey']);
const secretServerKeys = new Set(['llmApiKey', 'geniusApiKey', 'lastFmApiKey', 'lastFmSharedSecret', 'musicBrainzClientSecret', 'youtubeApiKey', 'turnstileSecretKey']);
const nonAdminReadableServerKeys = new Set(['hubGenerationSchedule', 'systemPlaylistConfig', 'providerArtistImage', 'providerArtistArtwork', 'providerArtistBio', 'providerAlbumArt', 'musicBrainzEnabled', 'musicBrainzConnected', 'openSubsonicEnabled', 'youtubeEnabled']);
// Keys that are written by OAuth2/connect flows server-side, not exposed to frontend
const protectedKeys = new Set(['musicBrainzAccessToken', 'musicBrainzRefreshToken', 'musicBrainzTokenExpiresAt', 'musicBrainzConnected', 'musicBrainzUsername', 'lastFmSessionKey', 'lastFmUsername', 'lastFmConnected', 'listenBrainzUserToken', 'listenBrainzUsername', 'listenBrainzConnected', 'jwtSecret']);

// Get settings (merged: server-wide + user-specific)
router.get('/settings', async (req, res) => {
  try {
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';

    // System-level (server-wide) settings
    const serverKeys = ['audioAnalysisCpu', 'scannerConcurrency', 'loudnessComputeMode', 'hubGenerationSchedule', 'systemPlaylistConfig', 'llmBaseUrl', 'llmApiKey', 'llmModelName', 'genreMatrixLastRun', 'genreMatrixLastResult', 'genreMatrixProgress', 'geniusApiKey', 'lastFmApiKey', 'lastFmSharedSecret', 'musicBrainzEnabled', 'musicBrainzClientId', 'musicBrainzClientSecret', 'musicBrainzConnected', 'musicBrainzRedirectUri', 'providerArtistImage', 'providerArtistArtwork', 'providerArtistBio', 'providerAlbumArt', 'autoFolderWalk', 'mbdbLastImport', 'jambaseEnabled', 'jambaseMaxSubscriptionsPerUser', 'jambaseCacheTtlDays', 'jambaseMonthlyCap', 'jambaseHardStop', 'youtubeEnabled', 'youtubeApiKey', 'youtubeCacheTtlDays', 'youtubeDailyQuotaCap', 'youtubeHardStop', 'hlsLoggingEnabled', 'ffmpegLoggingEnabled', 'openSubsonicEnabled', 'turnstileEnabled', 'turnstileSiteKey', 'turnstileSecretKey'];
    const settings: Record<string, any> = {};
    for (const k of serverKeys) {
      if (!isAdmin && (secretServerKeys.has(k) || !nonAdminReadableServerKeys.has(k))) continue;
      settings[k] = await getSystemSetting(k);
    }

    // User-level settings (includes Last.fm which is per-user)
    const allUserKeys = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'playedThresholdPercent', 'llmPlaylistDiversity', 'llmVetoMode', 'llmGenreCohesion', 'llmDiscoveryBias', 'llmArtistSpread', 'genrePenaltyCurve', 'llmRecoveryStrength', 'llmAdjacentReach', 'llmTracksPerPlaylist', 'llmPlaylistCount', 'lastFmScrobbleEnabled', 'lastFmConnected', 'lastFmUsername', 'listenBrainzScrobbleEnabled', 'listenBrainzConnected', 'listenBrainzUsername', 'subsonicProviderScrobbleEnabled', 'concertsEnabled', 'concertsLat', 'concertsLng', 'concertsLocationLabel', 'concertsRadiusKm', 'concertsAutoAddEnabled', 'loudnessNormEnabled', 'loudnessTargetLufs', 'loudnessPreampDb', 'loudnessMode'];
    const userOnlyKeys = ['lastFmConnected', 'lastFmUsername', 'lastFmScrobbleEnabled', 'listenBrainzConnected', 'listenBrainzUsername', 'listenBrainzScrobbleEnabled', 'subsonicProviderScrobbleEnabled'];
    if (userId) {
      for (const k of allUserKeys) {
        const userVal = await getUserSetting(userId, k);
        if (userVal !== null) {
          settings[k] = userVal;
        } else if (!userOnlyKeys.includes(k) && isAdmin) {
          // Fallback to system setting for non-user-only keys
          settings[k] = await getSystemSetting(k);
        }
      }
    } else {
      const fallbackKeys = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'playedThresholdPercent', 'llmPlaylistDiversity', 'llmVetoMode', 'llmGenreCohesion', 'llmDiscoveryBias', 'llmArtistSpread', 'genrePenaltyCurve', 'llmRecoveryStrength', 'llmAdjacentReach', 'llmTracksPerPlaylist', 'llmPlaylistCount', 'loudnessNormEnabled', 'loudnessTargetLufs', 'loudnessPreampDb', 'loudnessMode'];
      for (const k of fallbackKeys) {
        settings[k] = await getSystemSetting(k);
      }
    }

    if (settings.llmGenreCohesion === null || settings.llmGenreCohesion === undefined) {
      if (userId) {
        const legacyUserGenreBlend = await getUserSetting(userId, 'genreBlendWeight');
        settings.llmGenreCohesion = legacyUserGenreBlend !== null ? legacyUserGenreBlend : await getSystemSetting('genreBlendWeight');
      } else {
        settings.llmGenreCohesion = await getSystemSetting('genreBlendWeight');
      }
    }

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update settings
router.post('/settings', async (req, res) => {
  try {
    const userId = req.user?.userId;
    const settings = req.body;

    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'Settings payload must be an object' });
    }

    const unknownKeys: string[] = [];
    const forbiddenKeys: string[] = [];

    for (const k of Object.keys(settings)) {
      if (protectedKeys.has(k)) {
        forbiddenKeys.push(k);
      } else if (userKeys.has(k)) {
        if (!userId) forbiddenKeys.push(k);
      } else if (serverKeys.has(k)) {
        if (req.user?.role !== 'admin') forbiddenKeys.push(k);
      } else {
        unknownKeys.push(k);
      }
    }

    if (forbiddenKeys.length > 0) {
      return res.status(403).json({ error: 'Admin access required for one or more settings', keys: forbiddenKeys });
    }
    if (unknownKeys.length > 0) {
      return res.status(400).json({ error: 'Unknown settings keys', keys: unknownKeys });
    }

    for (const [k, v] of Object.entries(settings)) {
      if (userKeys.has(k)) {
        await setUserSetting(userId!, k, v);
      } else if (serverKeys.has(k)) {
        await setSystemSetting(k, v);
      }
    }

    // Stamp when the Hub system-playlist toggles change so the engine-playlist
    // cache is treated as stale and re-enabled families regenerate on the next
    // Hub load (see getHubCollections), rather than waiting out the schedule.
    if (settings.systemPlaylistConfig !== undefined) {
      await setSystemSetting('systemPlaylistConfigUpdatedAt', Date.now());
    }

    if (settings.audioAnalysisCpu !== undefined || settings.scannerConcurrency !== undefined) {
      import('../state').then(m => m.settingsEmitter.emit('concurrencyChanged'));
    }

    if (settings.hlsLoggingEnabled !== undefined || settings.ffmpegLoggingEnabled !== undefined) {
      const logging = await import('../services/loggingConfig');
      if (settings.hlsLoggingEnabled !== undefined) logging.setHlsLogging(!!settings.hlsLoggingEnabled);
      if (settings.ffmpegLoggingEnabled !== undefined) logging.setFfmpegLogging(!!settings.ffmpegLoggingEnabled);
    }

    res.json({ status: 'updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// LLM connection test
router.post('/health/llm', requireAdmin, async (req, res) => {
  try {
    const { llmBaseUrl, llmApiKey } = req.body;
    const openai = new OpenAI({
      baseURL: llmBaseUrl || 'https://api.openai.com/v1',
      apiKey: llmApiKey || 'dummy-key',
    });
    const modelsResponse = await openai.models.list();
    const models = modelsResponse.data.map((m: any) => m.id);
    res.json({ status: 'ok', models });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Genre Matrix mappings
router.get('/genre-matrix/mappings', async (req, res) => {
  try {
    const mappings = await getSubGenreMappings();
    res.json(mappings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch mappings' });
  }
});

// Full re-mapping of all genres
router.post('/genre-matrix/remap-all', requireAdmin, async (req, res) => {
  try {
    genreMatrixService.remapAll();
    res.json({ status: 'started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start full remap' });
  }
});

// Manually trigger genre matrix regeneration
router.post('/genre-matrix/regenerate', requireAdmin, async (req, res) => {
  try {
    await genreMatrixService.runDiffAndGenerate();
    const lastRun = await getSystemSetting('genreMatrixLastRun');
    const lastResult = await getSystemSetting('genreMatrixLastResult');
    res.json({ status: 'ok', lastRun, lastResult });
  } catch (error) {
    console.error('Genre matrix regeneration error:', error);
    res.status(500).json({ error: 'Failed to regenerate genre matrix' });
  }
});

// ─── ML Model Management ──────────────────────────────────────────────────
import { getModelStatus, clearAndRedownloadModels, modelProgressEmitter, isDownloadInProgress } from '../services/downloadModels';

// Get model download status
router.get('/settings/models/status', requireAdmin, async (_req, res) => {
  try {
    const models = await getModelStatus();
    res.json({ models, isDownloading: isDownloadInProgress() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get model status' });
  }
});

// Trigger model redownload
router.post('/settings/models/download', requireAdmin, async (_req, res) => {
  try {
    if (isDownloadInProgress()) {
      res.json({ status: 'already_downloading' });
      return;
    }
    // Start download in background
    clearAndRedownloadModels().catch(err => {
      console.error('[Models] Redownload failed:', err.message);
    });
    res.json({ status: 'started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start model download' });
  }
});

// SSE stream for real-time download progress
router.get('/settings/models/progress', requireAdmin, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const onProgress = (progress: any) => {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  };

  modelProgressEmitter.on('progress', onProgress);

  // Send current status immediately
  getModelStatus().then(models => {
    res.write(`data: ${JSON.stringify({ type: 'status', models })}\n\n`);
  }).catch(() => {});

  req.on('close', () => {
    modelProgressEmitter.off('progress', onProgress);
  });
});

export default router;
