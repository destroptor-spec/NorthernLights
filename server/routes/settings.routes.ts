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

    const serverKeys = ['audioAnalysisCpu', 'scannerConcurrency', 'hubGenerationSchedule', 'llmBaseUrl', 'llmApiKey', 'llmModelName', 'genreMatrixLastRun', 'genreMatrixLastResult', 'genreMatrixProgress'];
    const settings: Record<string, any> = {};
    for (const k of serverKeys) {
      settings[k] = await getSystemSetting(k);
    }

    if (userId) {
      const userKeys = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'llmPlaylistDiversity', 'genreBlendWeight', 'llmTracksPerPlaylist', 'llmPlaylistCount'];
      for (const k of userKeys) {
        const userVal = await getUserSetting(userId, k);
        if (userVal !== null) {
          settings[k] = userVal;
        } else {
          settings[k] = await getSystemSetting(k);
        }
      }
    } else {
      const fallbackKeys = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'llmPlaylistDiversity', 'genreBlendWeight', 'llmTracksPerPlaylist', 'llmPlaylistCount'];
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

    const userKeys = new Set(['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit', 'llmPlaylistDiversity', 'genreBlendWeight', 'llmTracksPerPlaylist', 'llmPlaylistCount']);
    const serverKeys = new Set(['llmBaseUrl', 'llmApiKey', 'llmModelName', 'hubGenerationSchedule', 'audioAnalysisCpu', 'scannerConcurrency']);

    for (const [k, v] of Object.entries(settings)) {
      if (userKeys.has(k) && userId) {
        await setUserSetting(userId, k, v);
      } else if (serverKeys.has(k)) {
        if (req.user?.role === 'admin') {
          await setSystemSetting(k, v);
        }
      } else {
        await setSystemSetting(k, v);
      }
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

export default router;
