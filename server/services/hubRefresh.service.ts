import {
  deleteOldLlmPlaylists,
  getPlaylists,
  getSystemSetting,
  getUserRecentTracks,
  getUserSetting,
} from '../database';
import { generateHubConcepts, HubCollection } from './llm.service';
import { getHubCollections } from './recommendation.service';
import { publishApiV1Event } from './apiV1Events.service';

type LlmVetoMode = 'hard' | 'adaptive';
type HubGenerationSource = 'login' | 'manual' | 'hub-view' | 'subsonic';

const HOUR_MS = 60 * 60 * 1000;
const runningRefreshes = new Set<string>();

export function getHubGenerationIntervalMs(schedule: string | null | undefined): number | null {
  const normalized = String(schedule || 'Daily').trim().toLowerCase();

  switch (normalized) {
    case 'manual only':
      return null;
    case 'hourly':
      return HOUR_MS;
    case 'every 2 hours':
    case 'every 2 hrs':
      return 2 * HOUR_MS;
    case 'every 4 hours':
    case 'every 4 hrs':
      return 4 * HOUR_MS;
    case 'daily':
      return 24 * HOUR_MS;
    // Kept so older saved settings do not suddenly refresh hourly after the UI removes Weekly.
    case 'weekly':
      return 7 * 24 * HOUR_MS;
    default:
      return 24 * HOUR_MS;
  }
}

export async function getLlmPlaylistSettings(userId: string): Promise<{
  llmGenreCohesion: number;
  llmDiscoveryBias: number;
  llmArtistSpread: number;
  genrePenaltyCurve: number;
  llmRecoveryStrength: number;
  llmAdjacentReach: number;
  llmTracksPerPlaylist: number;
  llmPlaylistDiversity: number;
  llmVetoMode: LlmVetoMode;
}> {
  const genreCohesionRaw = await getUserSetting(userId, 'llmGenreCohesion');
  const legacyGenreBlendRaw = genreCohesionRaw === null ? await getUserSetting(userId, 'genreBlendWeight') : null;
  const discoveryBiasRaw = await getUserSetting(userId, 'llmDiscoveryBias');
  const artistSpreadRaw = await getUserSetting(userId, 'llmArtistSpread');
  const penaltyCurveRaw = await getUserSetting(userId, 'genrePenaltyCurve');
  const recoveryStrengthRaw = await getUserSetting(userId, 'llmRecoveryStrength');
  const adjacentReachRaw = await getUserSetting(userId, 'llmAdjacentReach');
  const tracksPerRaw = await getUserSetting(userId, 'llmTracksPerPlaylist');
  const diversityRaw = await getUserSetting(userId, 'llmPlaylistDiversity');
  const vetoModeRaw = await getUserSetting(userId, 'llmVetoMode');

  return {
    llmGenreCohesion: genreCohesionRaw !== null ? Number(genreCohesionRaw) : (legacyGenreBlendRaw !== null ? Number(legacyGenreBlendRaw) : 50),
    llmDiscoveryBias: discoveryBiasRaw !== null ? Number(discoveryBiasRaw) : 45,
    llmArtistSpread: artistSpreadRaw !== null ? Number(artistSpreadRaw) : 70,
    genrePenaltyCurve: penaltyCurveRaw !== null ? Number(penaltyCurveRaw) : 50,
    llmRecoveryStrength: recoveryStrengthRaw !== null ? Number(recoveryStrengthRaw) : 50,
    llmAdjacentReach: adjacentReachRaw !== null ? Number(adjacentReachRaw) : 50,
    llmTracksPerPlaylist: tracksPerRaw !== null ? Number(tracksPerRaw) : 10,
    llmPlaylistDiversity: diversityRaw !== null ? Number(diversityRaw) : 50,
    llmVetoMode: vetoModeRaw === 'adaptive' ? 'adaptive' : 'hard',
  };
}

function getHubPlaylistStats(playlists: any[]): { count: number; latestCreatedAt: number | null } {
  const hubPlaylists = playlists
    .filter((playlist: any) => playlist.isLlmGenerated && (playlist.generationSource || 'hub') === 'hub');
  const hubCreatedAt = hubPlaylists
    .map((playlist: any) => Number(playlist.createdAt || 0))
    .filter((createdAt: number) => Number.isFinite(createdAt) && createdAt > 0);

  return {
    count: hubPlaylists.length,
    latestCreatedAt: hubCreatedAt.length > 0 ? Math.max(...hubCreatedAt) : null,
  };
}

export async function runLlmHubRegeneration(
  userId: string,
  opts: { force?: boolean; source?: HubGenerationSource } = {}
) {
  if (runningRefreshes.has(userId)) {
    return { skipped: true, reason: 'Refresh already running' };
  }

  runningRefreshes.add(userId);
  try {
    const llmBaseUrl = (await getSystemSetting('llmBaseUrl')) || process.env.LLM_BASE_URL || '';
    if (!llmBaseUrl) {
      return { skipped: true, reason: 'No LLM base URL configured' };
    }

    const schedule = (await getSystemSetting('hubGenerationSchedule')) || 'Daily';
    const intervalMs = getHubGenerationIntervalMs(schedule);
    if (!opts.force && intervalMs === null) {
      return { skipped: true, reason: 'Hub generation schedule is Manual Only' };
    }

    const llmPlaylistCountRaw = await getUserSetting(userId, 'llmPlaylistCount');
    const llmPlaylistCount = llmPlaylistCountRaw ? Number(llmPlaylistCountRaw) : 3;

    if (!opts.force && intervalMs !== null) {
      const hubStats = getHubPlaylistStats(await getPlaylists(userId));
      const isStale =
        !hubStats.latestCreatedAt ||
        hubStats.count < llmPlaylistCount ||
        (Date.now() - hubStats.latestCreatedAt) >= intervalMs;
      if (!isStale) {
        return { skipped: true, reason: `Hub playlists are fresh for ${schedule}` };
      }
    }

    const cleanupAgeMs = opts.force ? 0 : (intervalMs ?? 0);
    const deletedCount = await deleteOldLlmPlaylists(cleanupAgeMs, userId);
    if (deletedCount && deletedCount > 0) {
      console.log(`[LLM Hub] ${opts.force ? 'Reset' : 'Cleaned up'} ${deletedCount} transient hub playlist(s) for user ${userId}`);
    }

    const recentTracks = await getUserRecentTracks(userId, 10);
    const historySummary = recentTracks.map((track: any) => `${track.title} by ${track.artist}`).join(', ');
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const hubSettings = await getLlmPlaylistSettings(userId);

    let validConcepts: HubCollection[] = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (validConcepts.length < llmPlaylistCount && attempts < maxAttempts) {
      const needed = llmPlaylistCount - validConcepts.length;
      const concepts: HubCollection[] = await generateHubConcepts({ timeOfDay, historySummary, count: needed });

      if (concepts.length > 0) {
        await getHubCollections(concepts, userId, {
          ...hubSettings,
          llmGenerationSource: 'hub',
        });
        const kept = concepts.filter((concept) => !(concept as any).dropped);
        validConcepts.push(...kept);

        if (kept.length < concepts.length) {
          console.warn(`[LLM Hub] (Attempt ${attempts + 1}/${maxAttempts}) ${concepts.length - kept.length} concepts dropped. Retrying...`);
          if (attempts < maxAttempts - 1) await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      attempts++;
    }

    console.log(`[LLM Hub] Generated and saved ${validConcepts.length} playlist(s) for user ${userId} (${opts.source || 'manual'}, ${schedule})`);
    if (validConcepts.length > 0 || (deletedCount || 0) > 0) {
      publishApiV1Event(userId, 'playlist.changed', { action: 'hubRegenerated', source: opts.source || 'manual' });
    }
    return { generated: validConcepts.length, schedule };
  } finally {
    runningRefreshes.delete(userId);
  }
}

export function queueLlmHubRefreshForUser(userId: string, source: HubGenerationSource = 'login') {
  setTimeout(() => {
    runLlmHubRegeneration(userId, { source }).catch((error) => {
      console.error(`[LLM Hub] ${source} refresh failed for user ${userId}:`, error);
    });
  }, 0);
}
