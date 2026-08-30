import { Router } from 'express';
import { getPlaylists } from '../database';
import { generateCustomPlaylist } from '../services/llm.service';
import { getHubCollections } from '../services/recommendation.service';
import { getLlmPlaylistSettings, queueLlmHubRefreshForUser, runLlmHubRegeneration } from '../services/hubRefresh.service';
import {
  computeSmartHubBundle,
  generateArtistRadio,
  evaluateArtistRadioEligibility,
  computeOnRepeat,
  computeRepeatRewind,
  computeDaylist,
  computeJumpBackIn,
  queueSmartHubRefreshForUser,
} from '../services/smartHub.service';
import { publishApiV1Event } from '../services/apiV1Events.service';

const router = Router();

// Get Hub Data (per-user)
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const shouldQueueRefresh = req.query.queueRefresh !== 'false';
    if (shouldQueueRefresh) {
      queueLlmHubRefreshForUser(userId, 'hub-view');
      queueSmartHubRefreshForUser(userId);
    }
    const collections = await getHubCollections([], userId);
    res.json({ collections });
  } catch (error) {
    console.error('Hub fetch error:', error);
    res.status(500).json({ error: 'Failed to generate hub' });
  }
});

// Trigger LLM Hub Regeneration explicitly (per-user)
router.post('/regenerate', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { force } = req.body;
    const result = await runLlmHubRegeneration(userId, { force: !!force, source: 'manual' });
    res.json(result);
  } catch (error) {
    console.error('Hub regeneration error:', error);
    res.status(500).json({ error: 'Failed to regenerate hub' });
  }
});

// Generate a single custom playlist from a user prompt
router.post('/generate-custom', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'A prompt is required' });
    }
    const hubSettings = await getLlmPlaylistSettings(userId);
    const existingPlaylists = await getPlaylists(userId);
    const existingIds = new Set(existingPlaylists.map((playlist: any) => playlist.id));

    let playlist = null;
    let attempts = 0;
    while (attempts < 3) {
      const concept = await generateCustomPlaylist(prompt.trim());
      if (!concept) {
        attempts++;
        continue;
      }
      
      const saved = await getHubCollections([concept], userId, {
        ...hubSettings,
        llmGenerationSource: 'custom',
      });
      playlist = saved.find((candidate: any) => candidate.isLlmGenerated && candidate.id && !existingIds.has(candidate.id));
      
      if (!playlist || (concept as any).dropped) {
        console.warn(`[LLM Hub] Custom concept failed/dropped on attempt ${attempts + 1}. Retrying...`);
        attempts++;
        if (attempts < 3) await new Promise(r => setTimeout(r, 2000)); // Backoff
        continue;
      }
      break; // Success
    }

    if (!playlist) {
      return res.status(503).json({ error: 'LLM generated genres could not be matched after 3 retries or failed completely.' });
    }

    publishApiV1Event(userId, 'playlist.changed', { playlistId: playlist.id, action: 'generated', source: 'web' });

    res.json({ playlist });
  } catch (error) {
    console.error('Custom playlist generation error:', error);
    res.status(500).json({ error: 'Failed to generate custom playlist' });
  }
});

// Smart Hub bundle: jump-back-in tiles + on-repeat + repeat-rewind +
// daylist + artist-radio candidates, all in one call.
router.get('/smart', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const bundle = await computeSmartHubBundle(userId);
    res.json(bundle);
  } catch (error) {
    console.error('Smart hub error:', error);
    res.status(500).json({ error: 'Failed to load smart hub' });
  }
});

// Per-section endpoints (used by direct refresh, e.g. pull-to-refresh on a tile)
router.get('/jump-back-in', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const tiles = await computeJumpBackIn(userId);
    res.json({ tiles });
  } catch (error) {
    console.error('Jump back in error:', error);
    res.status(500).json({ error: 'Failed to compute jump back in' });
  }
});

router.get('/on-repeat', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const playlist = await computeOnRepeat(userId);
    res.json({ playlist });
  } catch (error) {
    console.error('On repeat error:', error);
    res.status(500).json({ error: 'Failed to compute on repeat' });
  }
});

router.get('/repeat-rewind', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const playlist = await computeRepeatRewind(userId);
    res.json({ playlist });
  } catch (error) {
    console.error('Repeat rewind error:', error);
    res.status(500).json({ error: 'Failed to compute repeat rewind' });
  }
});

router.get('/daylist', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const playlist = await computeDaylist(userId);
    res.json({ playlist });
  } catch (error) {
    console.error('Daylist error:', error);
    res.status(500).json({ error: 'Failed to compute daylist' });
  }
});

// Generate a fresh artist radio for a specific artist. Regenerates on every
// press (forceRefresh) so each play yields a new mix.
router.post('/artist-radio', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { artistId } = req.body;
    if (!artistId || typeof artistId !== 'string') {
      return res.status(400).json({ error: 'artistId required' });
    }
    const playlist = await generateArtistRadio(userId, artistId, { forceRefresh: true });
    res.json({ playlist });
  } catch (error: any) {
    console.error('Artist radio error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate artist radio' });
  }
});

// Whether a quality radio can be built for an artist — drives the Play-Radio
// button's enabled state on the client.
router.get('/artist-radio-eligibility', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const artistId = typeof req.query.artistId === 'string' ? req.query.artistId : '';
    if (!artistId) {
      return res.status(400).json({ error: 'artistId required' });
    }
    const { eligible, reason, targetLength } = await evaluateArtistRadioEligibility(userId, artistId);
    res.json({ eligible, reason, targetLength });
  } catch (error: any) {
    console.error('Artist radio eligibility error:', error);
    res.status(500).json({ error: error.message || 'Failed to evaluate radio eligibility' });
  }
});

export default router;
