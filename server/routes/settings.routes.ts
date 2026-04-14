import { Router } from 'express';
import { getSystemSetting, setSystemSetting, getUserSetting, setUserSetting, getSubGenreMappings } from '../database';
import { requireAdmin } from '../middleware/auth';
import { genreMatrixService } from '../services/genreMatrix.service';
import OpenAI from 'openai';

const router = Router();

// Get settings (merged: server-wide + user-specific)
router.get('/settings', async (req, res) => {
  try {
    const userId = req.user?.userId;

    // System-level (server-wide) settings
    const serverKeys = ['audioAnalysisCpu', 'scannerConcurrency', 'hubGenerationSchedule', 'llmBaseUrl', 'llmApiKey', 'llmModelName', 'genreMatrixLastRun', 'genreMatrixLastResult', 'genreMatrixProgress', 'geniusApiKey', 'lastFmApiKey', 'lastFmSharedSecret', 'musicBrainzEnabled', 'musicBrainzClientId', 'musicBrainzClientSecret', 'musicBrainzConnected', 'providerArtistImage', 'providerArtistBio', 'providerAlbumArt', 'autoFolderWalk', 'mbdbLastImport'];
    const settings: Record<string, any> = {};
    for (const k of serverKeys) {
      settings[k] = await getSystemSetting(k);
    }

    // User-level settings (includes Last.fm which is per-user)
    const allUserKeys = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'llmPlaylistDiversity', 'genreBlendWeight', 'genrePenaltyCurve', 'llmTracksPerPlaylist', 'llmPlaylistCount', 'lastFmScrobbleEnabled', 'lastFmConnected', 'lastFmUsername'];
    if (userId) {
      for (const k of allUserKeys) {
        const userVal = await getUserSetting(userId, k);
        if (userVal !== null) {
          settings[k] = userVal;
        } else if (!['lastFmConnected', 'lastFmUsername', 'lastFmScrobbleEnabled'].includes(k)) {
          // Fallback to system setting for non-Last.fm keys
          settings[k] = await getSystemSetting(k);
        }
      }
    } else {
      const fallbackKeys = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'llmPlaylistDiversity', 'genreBlendWeight', 'genrePenaltyCurve', 'llmTracksPerPlaylist', 'llmPlaylistCount'];
      for (const k of fallbackKeys) {
        settings[k] = await getSystemSetting(k);
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

    const userKeys = new Set(['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'llmPlaylistDiversity', 'genreBlendWeight', 'genrePenaltyCurve', 'llmTracksPerPlaylist', 'llmPlaylistCount', 'lastFmScrobbleEnabled']);
    const serverKeys = new Set(['llmBaseUrl', 'llmApiKey', 'llmModelName', 'hubGenerationSchedule', 'audioAnalysisCpu', 'scannerConcurrency', 'geniusApiKey', 'lastFmApiKey', 'lastFmSharedSecret', 'musicBrainzEnabled', 'musicBrainzClientId', 'musicBrainzClientSecret', 'providerArtistImage', 'providerArtistBio', 'providerAlbumArt', 'autoFolderWalk']);
    // Keys that are written by OAuth2 flows server-side, not exposed to frontend
    const protectedKeys = new Set(['musicBrainzAccessToken', 'musicBrainzRefreshToken', 'musicBrainzTokenExpiresAt', 'musicBrainzConnected', 'musicBrainzUsername', 'lastFmSessionKey', 'lastFmUsername', 'lastFmConnected']);

    for (const [k, v] of Object.entries(settings)) {
      if (protectedKeys.has(k)) {
        // Protected keys can only be set by server-side OAuth2 flows, ignore from client
        continue;
      } else if (userKeys.has(k) && userId) {
        await setUserSetting(userId, k, v);
      } else if (serverKeys.has(k)) {
        if (req.user?.role === 'admin') {
          await setSystemSetting(k, v);
        }
      } else {
        await setSystemSetting(k, v);
      }
    }

    if (settings.audioAnalysisCpu !== undefined || settings.scannerConcurrency !== undefined) {
      import('../state').then(m => m.settingsEmitter.emit('concurrencyChanged'));
    }

    res.json({ status: 'updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// LLM connection test
router.post('/health/llm', async (req, res) => {
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
