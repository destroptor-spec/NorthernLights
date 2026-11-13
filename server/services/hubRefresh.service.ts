import {
  deleteOldLlmPlaylists,
  getPlaylists,
  getSystemSetting,
  getUserRecentTracks,
  getUserSetting,
  initDB,
  setUserSetting,
} from '../database';
import { generateCustomPlaylist, generateHubConcepts, generateSpecialPicks, HubCollection } from './llm.service';
import { buildThemeMenu, conceptForTheme, menuForAi } from './specialLists.service';
import { normalizeHubPlaylistCount, specialListCount } from '../../shared/hubPlaylists';
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
  const recoveryStrengthRaw = await getUserSetting(userId, 'llmRecoveryStrength');
  const adjacentReachRaw = await getUserSetting(userId, 'llmAdjacentReach');
  const tracksPerRaw = await getUserSetting(userId, 'llmTracksPerPlaylist');
  const diversityRaw = await getUserSetting(userId, 'llmPlaylistDiversity');
  const vetoModeRaw = await getUserSetting(userId, 'llmVetoMode');

  return {
    llmGenreCohesion: genreCohesionRaw !== null ? Number(genreCohesionRaw) : (legacyGenreBlendRaw !== null ? Number(legacyGenreBlendRaw) : 50),
    llmDiscoveryBias: discoveryBiasRaw !== null ? Number(discoveryBiasRaw) : 45,
    llmArtistSpread: artistSpreadRaw !== null ? Number(artistSpreadRaw) : 70,
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

    // 2, 3, 6 or 9 playlists, of which up to 1, 1, 2 or 3 are special lists.
    const llmPlaylistCount = normalizeHubPlaylistCount(await getUserSetting(userId, 'llmPlaylistCount') ?? 3);

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

    // The old Hub playlists go once new ones are made: when the AI does not
    // answer, the rail keeps what it had instead of going empty.
    const startedAt = Date.now();

    const recentTracks = await getUserRecentTracks(userId, 10);
    const historySummary = recentTracks.map((track: any) => `${track.title} by ${track.artist}`).join(', ');
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const hubSettings = await getLlmPlaylistSettings(userId);

    let validConcepts: HubCollection[] = [];
    let attempts = 0;
    const maxAttempts = 3;

    // Special lists first: themes this library can carry, picked and named by
    // the AI. A pick that fails its dry run gives way to a spare pick; slots
    // no special list fills go to general playlists.
    const specialsWanted = specialListCount(llmPlaylistCount);
    const specialConcepts = await pickSpecialConcepts(userId, specialsWanted, hubSettings.llmTracksPerPlaylist, { timeOfDay, historySummary });
    const generalWanted = llmPlaylistCount - Math.min(specialsWanted, specialConcepts.length);
    const generalFirst = generalWanted > 0 ? await generateHubConcepts({ timeOfDay, historySummary, count: generalWanted }) : [];
    // One rail: general and special lists alternate.
    const firstSpecials = specialConcepts.slice(0, specialsWanted);
    const spares = specialConcepts.slice(specialsWanted);
    const mixed: HubCollection[] = [];
    for (let i = 0; i < Math.max(generalFirst.length, firstSpecials.length); i++) {
      if (generalFirst[i]) mixed.push(generalFirst[i]);
      if (firstSpecials[i]) mixed.push(firstSpecials[i]);
    }
    if (mixed.length > 0) {
      await getHubCollections(mixed, userId, { ...hubSettings, llmGenerationSource: 'hub' });
      validConcepts.push(...mixed.filter((concept) => !(concept as any).dropped));
    }
    // Specials that were not made: spare picks, one at a time.
    let specialsMade = validConcepts.filter((c) => (c as any).special).length;
    for (const spare of spares) {
      if (specialsMade >= Math.min(specialsWanted, firstSpecials.length)) break;
      await getHubCollections([spare], userId, { ...hubSettings, llmGenerationSource: 'hub' });
      if (!(spare as any).dropped) { validConcepts.push(spare); specialsMade++; }
    }
    await rememberSpecialThemes(userId, validConcepts.map((c) => (c as any).special?.key).filter(Boolean));
    attempts = 1;

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
    let deletedCount = 0;
    if (validConcepts.length > 0) {
      // Forced: every Hub playlist from before this refresh; scheduled: the stale ones.
      const cleanupAgeMs = opts.force ? Date.now() - startedAt : (intervalMs ?? 0);
      deletedCount = (await deleteOldLlmPlaylists(cleanupAgeMs, userId)) || 0;
      if (deletedCount > 0) {
        console.log(`[LLM Hub] ${opts.force ? 'Reset' : 'Cleaned up'} ${deletedCount} transient hub playlist(s) for user ${userId}`);
      }
    } else {
      console.warn(`[LLM Hub] Nothing made; keeping the existing Hub playlists for user ${userId}.`);
    }
    if (validConcepts.length > 0 || deletedCount > 0) {
      publishApiV1Event(userId, 'playlist.changed', { action: 'hubRegenerated', source: opts.source || 'manual' });
    }
    return { generated: validConcepts.length, schedule };
  } finally {
    runningRefreshes.delete(userId);
  }
}

/** Themes made for a user recently are left off the menu, so special lists rotate. */
const SPECIAL_THEME_ROTATION_DAYS = 14;
const SPECIAL_HISTORY_SETTING = 'specialListHistory';
/** Spare picks asked for beyond the special lists wanted, for picks that fail their dry run. */
const SPECIAL_SPARES = 2;

async function recentSpecialThemes(userId: string): Promise<Array<{ theme: string; at: number }>> {
  const raw = await getUserSetting(userId, SPECIAL_HISTORY_SETTING);
  let list: unknown = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { list = []; } }
  const cutoff = Date.now() - SPECIAL_THEME_ROTATION_DAYS * 86400000;
  return (Array.isArray(list) ? list : [])
    .filter((e: any) => e && typeof e.theme === 'string' && Number(e.at) > cutoff)
    .map((e: any) => ({ theme: e.theme, at: Number(e.at) }));
}

async function rememberSpecialThemes(userId: string, themes: string[]) {
  if (!themes.length) return;
  const history = await recentSpecialThemes(userId);
  const now = Date.now();
  await setUserSetting(userId, SPECIAL_HISTORY_SETTING, JSON.stringify([...history, ...themes.map((theme) => ({ theme, at: now }))]));
}

/**
 * Special-list concepts for the Hub: the menu of themes this library can
 * carry (without those made in the last 14 days), the AI's picks from it
 * (the ones wanted plus spares), each as a concept the engine builds only
 * from the theme's tracks. Empty without themes or an AI answer.
 */
async function pickSpecialConcepts(
  userId: string,
  wanted: number,
  playlistLength: number,
  context: { timeOfDay: string; historySummary: string },
) {
  if (wanted <= 0) return [] as HubCollection[];
  try {
    const db = await initDB();
    const recent = await recentSpecialThemes(userId);
    // Recent themes stay off the menu while enough others remain; newest first.
    const recentKeys = [...recent].sort((a, b) => b.at - a.at).map((e) => e.theme);
    const menu = await buildThemeMenu(db, { userId, playlistLength, recentKeys, keepAtLeast: wanted });
    if (!menu.length) {
      console.log(`[LLM Hub] No special lists: no theme in this library has ${playlistLength * 2} strong songs from ${Math.ceil(playlistLength / 2)} artists (or all were made recently).`);
      return [] as HubCollection[];
    }
    const picks = await generateSpecialPicks(menuForAi(menu), Math.min(menu.length, wanted + SPECIAL_SPARES), context);
    // generateSpecialPicks keeps only picks with 8 numbers in target_vector.
    return picks.map((pick) => conceptForTheme(menu.find((t) => t.key === pick.theme)!, pick) as unknown as HubCollection);
  } catch (error: any) {
    console.warn(`[LLM Hub] Special lists skipped: ${error?.message || error}`);
    return [] as HubCollection[];
  }
}

const CUSTOM_PLAYLIST_ATTEMPTS = 3;

/**
 * Turn a listener's prompt into a saved custom playlist. The LLM's concept can
 * fail outright or name genres the library can't match (the matcher marks it
 * `dropped`), so this retries up to three times with a short backoff. Returns
 * the newly saved collection, or null when every attempt failed.
 */
export async function generateCustomHubPlaylist(
  userId: string,
  prompt: string,
  opts: { tracksPerPlaylist?: number; retryDelayMs?: number } = {},
): Promise<any | null> {
  const retryDelayMs = opts.retryDelayMs ?? 2000;
  const hubSettings = await getLlmPlaylistSettings(userId);
  const existingIds = new Set((await getPlaylists(userId)).map((playlist: any) => playlist.id));

  for (let attempt = 1; attempt <= CUSTOM_PLAYLIST_ATTEMPTS; attempt++) {
    const concept = await generateCustomPlaylist(prompt);
    if (concept) {
      const saved = await getHubCollections([concept], userId, {
        ...hubSettings,
        ...(opts.tracksPerPlaylist ? { llmTracksPerPlaylist: opts.tracksPerPlaylist } : {}),
        llmGenerationSource: 'custom',
      });
      const playlist = saved.find((candidate: any) => candidate.isLlmGenerated && candidate.id && !existingIds.has(candidate.id));
      if (playlist && !(concept as any).dropped) return playlist;
      console.warn(`[LLM Hub] Custom concept failed/dropped on attempt ${attempt}. Retrying...`);
      if (attempt < CUSTOM_PLAYLIST_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return null;
}

export function queueLlmHubRefreshForUser(userId: string, source: HubGenerationSource = 'login') {
  setTimeout(() => {
    runLlmHubRegeneration(userId, { source }).catch((error) => {
      console.error(`[LLM Hub] ${source} refresh failed for user ${userId}:`, error);
    });
  }, 0);
}
