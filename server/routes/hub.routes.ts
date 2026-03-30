import { Router } from 'express';
import { getSystemSetting, getUserSetting, getPlaylists, deleteOldLlmPlaylists, getUserRecentTracks, listUsers } from '../database';
import { generateHubConcepts, generateCustomPlaylist, HubCollection } from '../services/llm.service';
import { getHubCollections } from '../services/recommendation.service';

const router = Router();

// Internal helper: generate LLM playlists if config is present and cache is stale
async function runLlmHubRegeneration(userId: string, opts: { force?: boolean } = {}) {
  const llmBaseUrl = (await getSystemSetting('llmBaseUrl')) || process.env.LLM_BASE_URL || '';

  if (!llmBaseUrl) {
    return { skipped: true, reason: 'No LLM base URL configured' };
  }

  const maxAgeMs = opts.force ? 0 : 24 * 60 * 60 * 1000;
  const deletedCount = await deleteOldLlmPlaylists(maxAgeMs, userId);
  if (deletedCount && deletedCount > 0) {
    console.log(`[LLM Hub] ${opts.force ? 'Reset' : 'Cleaned up'} ${deletedCount} LLM playlist(s) for user ${userId}`);
  }

  const existingPlaylists = await getPlaylists(userId);

  const fourHoursMs = 4 * 60 * 60 * 1000;
  const hasRecentLlm = existingPlaylists.some((pl: any) =>
    pl.isLlmGenerated && (Date.now() - pl.createdAt) < fourHoursMs
  );

  if (hasRecentLlm && !opts.force) {
    return { skipped: true, reason: 'Recent LLM playlists exist (< 4h old)' };
  }

  const recentTracks = await getUserRecentTracks(userId, 10);
  const historySummary = recentTracks.map((t: any) => `${t.title} by ${t.artist}`).join(', ');

  const timeOfDay = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening';

  const llmPlaylistCountRaw = await getUserSetting(userId, 'llmPlaylistCount');
  const llmPlaylistCount = llmPlaylistCountRaw ? Number(llmPlaylistCountRaw) : 3;

  const concepts: HubCollection[] = await generateHubConcepts({ timeOfDay, historySummary, count: llmPlaylistCount });

  if (concepts.length > 0) {
    const genreBlendRaw = await getUserSetting(userId, 'genreBlendWeight');
    const tracksPerRaw = await getUserSetting(userId, 'llmTracksPerPlaylist');
    const diversityRaw = await getUserSetting(userId, 'llmPlaylistDiversity');

    const hubSettings = {
      genreBlendWeight: genreBlendRaw !== null ? Number(genreBlendRaw) : 50,
      llmTracksPerPlaylist: tracksPerRaw !== null ? Number(tracksPerRaw) : 10,
      llmPlaylistDiversity: diversityRaw !== null ? Number(diversityRaw) : 50,
    };

    await getHubCollections(concepts, userId, hubSettings);
  }

  console.log(`[LLM Hub] Generated and saved ${concepts.length} playlist(s) for user ${userId} (${timeOfDay})`);
  return { generated: concepts.length };
}

// Get Hub Data (per-user)
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

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
    const result = await runLlmHubRegeneration(userId, { force: !!force });
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
    const concept = await generateCustomPlaylist(prompt.trim());
    if (!concept) {
      return res.status(503).json({ error: 'LLM did not return a valid playlist concept. Check your LLM configuration.' });
    }
    const genreBlendRaw = userId ? await getUserSetting(userId, 'genreBlendWeight') : null;
    const tracksPerRaw = userId ? await getUserSetting(userId, 'llmTracksPerPlaylist') : null;
    const diversityRaw = userId ? await getUserSetting(userId, 'llmPlaylistDiversity') : null;
    const hubSettings = {
      genreBlendWeight: genreBlendRaw !== null ? Number(genreBlendRaw) : 50,
      llmTracksPerPlaylist: tracksPerRaw !== null ? Number(tracksPerRaw) : 10,
      llmPlaylistDiversity: diversityRaw !== null ? Number(diversityRaw) : 50,
    };
    const saved = await getHubCollections([concept], userId, hubSettings);
    const playlist = saved.find(c => c.isLlmGenerated);
    res.json({ playlist });
  } catch (error) {
    console.error('Custom playlist generation error:', error);
    res.status(500).json({ error: 'Failed to generate custom playlist' });
  }
});

// Schedule: Re-run LLM hub regeneration periodically (per-user)
const LLM_HUB_INTERVAL_MS = 60 * 60 * 1000;
setInterval(async () => {
  const schedule = await getSystemSetting('hubGenerationSchedule') || 'Daily';
  if (schedule === 'Manual Only') return;

  console.log('[LLM Hub] Scheduled refresh check...');
  try {
    const users = await listUsers();
    for (const user of users) {
      try {
        await runLlmHubRegeneration(user.id);
      } catch (e) {
        console.error(`[LLM Hub] Scheduled refresh failed for user ${user.username}:`, e);
      }
    }
  } catch (e) {
    console.error('[LLM Hub] Scheduled refresh failed:', e);
  }
}, LLM_HUB_INTERVAL_MS);

export default router;
