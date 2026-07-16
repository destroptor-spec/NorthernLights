import { create, StateCreator } from 'zustand';
import { persist, PersistOptions } from 'zustand/middleware';
import type { TrackInfo } from '../utils/fileSystem';
import { EMPTY_FILTER_STATE } from '../utils/filterState';
import { extractMetadata } from '../utils/fileSystem';
import { playbackManager, PlaybackState } from '../utils/PlaybackManager';
import { castManager } from '../utils/CastManager';
import { cloneTrackForQueue, ensureQueueEntryIds } from '../utils/queue';
import { preloadManager } from '../utils/PreloadManager';
import { setPlaybackDebugLogging } from '../utils/playbackDebug';
import { savePlaybackContinuitySnapshot } from '../utils/playbackContinuity';
import { audioOutputManager, type AudioOutputDevice, type AudioOutputPermission } from '../utils/AudioOutputManager';
import {
  getPlaybackTimeSnapshot,
  setPlaybackCurrentTime,
  setPlaybackDuration,
  setPlaybackTimeState,
} from './playbackTime';

import { clearExternalCache } from '../utils/externalImagery';
import { readSessionAuth, writeSessionAuth, clearSessionAuth } from '../utils/sessionAuth';
import { computeLoudnessGainDb, type LoudnessData } from '../utils/loudness';
import { getCachedLoudness, fetchLoudness, invalidateLoudness, type TrackLoudnessEntry } from '../utils/loudnessCache';
import type { ToastType } from '../components/Toast';

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
}

export type SetupStep = 'account' | 'analysis' | 'library';

export type StoreActionResult =
  | { success: true }
  | { success: false; error: string };

// Outcome of a credential submission (login/register). `code` mirrors the
// server's error code ('captcha_required' | 'captcha_failed' |
// 'captcha_unavailable') or is client-assigned ('rate_limited' | 'network');
// undefined means plain bad credentials.
export type AuthAttemptResult =
  | { success: true }
  | { success: false; error: string; code?: string };

export interface AddLibraryFolderOptions {
  scan?: boolean;
}

// Re-entrancy guard: incremented on each playAtIndex call to discard stale callbacks
let playGeneration = 0;

// Compute + apply the loudness-normalization gain for a track becoming current.
// Applies what's cached immediately (unity if disabled/unmeasured), then fetches
// loudness for this track + a short lookahead and re-applies. If the server
// hasn't measured the track yet, one delayed retry gives the background
// measurement time to land. All async work is generation-guarded so a skip
// abandons stale updates.
function applyLoudnessForTrack(get: () => PlayerState, track: TrackInfo, generation: number): void {
  const s = get();
  if (!s.loudnessNormEnabled) { playbackManager.setLoudnessGainDb(null); return; }
  const settings = { enabled: true, targetLufs: s.loudnessTargetLufs, preampDb: s.loudnessPreampDb };
  const mode = s.loudnessMode;
  const pick = (entry: TrackLoudnessEntry | undefined | null): LoudnessData | null => {
    if (!entry) return null;
    // Album mode falls back to per-track when the album value isn't ready yet.
    return mode === 'album' ? (entry.album ?? entry.track) : entry.track;
  };

  playbackManager.setLoudnessGainDb(computeLoudnessGainDb(pick(getCachedLoudness(track.id)), settings));

  if (getCachedLoudness(track.id) !== undefined) return; // already fetched

  const authHeaders = (get() as any).getAuthHeader();
  const ids = [track.id];
  const here = s.playlist.findIndex((t) => t.id === track.id);
  if (here >= 0) for (const t of s.playlist.slice(here + 1, here + 3)) if (t?.id) ids.push(t.id);

  void fetchLoudness(ids, authHeaders).then(() => {
    if (generation !== playGeneration) return;
    const chosen = pick(getCachedLoudness(track.id));
    playbackManager.setLoudnessGainDb(computeLoudnessGainDb(chosen, settings));
    if (chosen === null) {
      // Not measured yet — give the background pass a moment, then retry once.
      setTimeout(() => {
        if (generation !== playGeneration) return;
        invalidateLoudness(track.id);
        void fetchLoudness([track.id], authHeaders).then(() => {
          if (generation !== playGeneration) return;
          playbackManager.setLoudnessGainDb(computeLoudnessGainDb(pick(getCachedLoudness(track.id)), settings));
        });
      }, 4000);
    }
  });
}

// In-flight dedup + cancellation for the library/playlist fetches. The init
// sequence and the 10s health poller both fire these unawaited; without dedup a
// second call (or a reconnect) duplicates the request, and without an
// AbortController an in-flight fetch can resolve after logout and overwrite
// state with another session's data. Mirrors the promise-cache in externalImagery.ts.
let inFlightLibraryFetch: Promise<void> | null = null;
let inFlightPlaylistsFetch: Promise<void> | null = null;
// Dedup the background full-track load: without this, every fetchLibraryFromServer
// caller (boot, health-reconnect, post-scan, StrictMode double-invoke) kicked off
// another /api/library/tracks fetch — each re-serializing ~26MB server-side and
// blocking the event loop, so interactive requests (album detail, art) piled up.
let inFlightTracksFetch: Promise<void> | null = null;
// The full track list is no longer loaded at boot. A couple of admin settings
// tools still need it; they call ensureFullLibraryLoaded(), guarded here so it
// loads at most once and only on demand.
let inFlightFullLibrary: Promise<void> | null = null;
let libraryFetchAbort: AbortController | null = null;
let playlistsFetchAbort: AbortController | null = null;

// Bumped on each optimistic playlist mutation so a slow in-flight mutation's
// rollback / server-refetch can't clobber a newer optimistic edit applied after it.
let playlistMutationGeneration = 0;

// Sleep timer: fade the audible volume to zero over the final SLEEP_FADE_MS, then
// pause and restore the volume for the next manual play. Timers live at module
// scope (not in the store) since they're imperative side-effects.
let sleepTimerTimeout: ReturnType<typeof setTimeout> | null = null;
let sleepFadeInterval: ReturnType<typeof setInterval> | null = null;
const SLEEP_FADE_MS = 20000;
function clearSleepTimers() {
  if (sleepTimerTimeout) { clearTimeout(sleepTimerTimeout); sleepTimerTimeout = null; }
  if (sleepFadeInterval) { clearInterval(sleepFadeInterval); sleepFadeInterval = null; }
}

// Throttle scrobble-failure toasts (per provider) so a backend outage during a
// long session doesn't spam one toast per finished track.
const lastScrobbleErrorAt: Record<string, number> = {};

function abortInFlightLibraryFetches() {
  libraryFetchAbort?.abort();
  playlistsFetchAbort?.abort();
  libraryFetchAbort = null;
  playlistsFetchAbort = null;
  inFlightLibraryFetch = null;
  inFlightPlaylistsFetch = null;
  inFlightTracksFetch = null;
  inFlightFullLibrary = null;
}

function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

async function getResponseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    if (typeof data?.error === 'string' && data.error.trim()) return data.error;
  } catch {
    // Preserve the operation-specific fallback for non-JSON responses.
  }
  return fallback;
}

const buildTrackUrls = (trackId: string, path: string, token: string, quality: string = '128k', artHash?: string) => {
  const base = `${window.location.protocol}//${window.location.host}`;
  const tokenParam = token ? `&token=${token}` : '';
  // path is already base64 from the DB — just URL-encode for safe transport
  const pathB64 = encodeURIComponent(path);
  // Prefer a content-hash art URL when the cover has been pre-encoded: it's
  // identical across every track of an album, so the service worker caches and
  // the browser decodes it ONCE per album instead of once per track. Tracks not
  // yet processed (no artHash) fall back to the path-addressed URL, which the
  // server resolves and serves (or live-extracts) transparently.
  const artUrl = artHash
    ? `${base}/api/art?hash=${artHash}${tokenParam}`
    : `${base}/api/art?pathB64=${pathB64}${tokenParam}`;
  return {
    url: `${base}/api/stream/${encodeURIComponent(trackId)}/playlist.m3u8?quality=${quality}${tokenParam}`,
    rawUrl: `${base}/api/stream?pathB64=${pathB64}${tokenParam}`,
    artUrl,
  };
};

const hydrateServerTrack = (track: TrackInfo, token: string, quality: string): TrackInfo => ({
  ...track,
  ...buildTrackUrls(track.id, track.path, token, quality, (track as any).artHash),
});

const dedupeTrackIds = (trackIds: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const trackId of trackIds) {
    if (!trackId || seen.has(trackId)) continue;
    seen.add(trackId);
    result.push(trackId);
  }

  return result;
};

const normalizeHubGenerationSchedule = (value: unknown): string => {
  const schedule = typeof value === 'string' ? value : '';
  return ['Manual Only', 'Hourly', 'Every 2 Hours', 'Every 4 Hours', 'Daily'].includes(schedule)
    ? schedule
    : 'Daily';
};

const defaultSystemPlaylistConfig = {
  upNext: true,
  vault: true,
  jumpBackIn: true,
  genreHeavyRotation: true,
  genreRediscovery: true,
  decadeMixes: true,
  decadeGenreMixes: true,
  // Personalized history-driven rails from the smart hub bundle, distinct from
  // the engine Discover playlists above. `uniquelyYours` gates the whole
  // on-repeat / repeat-rewind / daylist / artist-radio rail.
  smartJumpBackIn: true,
  uniquelyYours: true,
};

const normalizeSystemPlaylistConfig = (value: unknown): Record<string, boolean> => {
  const parsed = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(
    Object.entries(defaultSystemPlaylistConfig).map(([key, defaultValue]) => [
      key,
      typeof parsed[key] === 'boolean' ? parsed[key] : defaultValue,
    ])
  );
};

const normalizeMbdbLastImport = (value: unknown): PlayerState['mbdbLastImported'] => {
  if (!value) return null;

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const info = parsed as Partial<NonNullable<PlayerState['mbdbLastImported']>>;
  const counts = (info.counts || {}) as Partial<NonNullable<PlayerState['mbdbLastImported']>['counts']>;

  return {
    timestamp: Number(info.timestamp || 0),
    duration: Number(info.duration || 0),
    counts: {
      genres: Number(counts.genres || 0),
      aliases: Number(counts.aliases || 0),
      links: Number(counts.links || 0),
    },
  };
};

const hydratePlaylistTracks = (
  trackIds: string[],
  library: TrackInfo[],
  existingTracks: TrackInfo[],
  authToken: string,
  streamingQuality: PlayerState['streamingQuality']
): TrackInfo[] => {
  const quality = streamingQuality;
  const libraryById = new Map(library.map((track) => [track.id, track]));
  const existingById = new Map(existingTracks.map((track) => [track.id, track]));

  return trackIds
    .map((trackId) => {
      const existingTrack = existingById.get(trackId);
      const libraryTrack = libraryById.get(trackId);
      return libraryTrack ? { ...existingTrack, ...libraryTrack, playlistAddedAt: existingTrack?.playlistAddedAt } : existingTrack;
    })
    .filter((track): track is TrackInfo => Boolean(track?.id && track?.path))
    .map((track) => ({
      ...track,
      ...buildTrackUrls(track.id, track.path, authToken, quality, (track as any).artHash),
    }));
};

/** Where the current play queue was started from, for "playing from" navigation. */
export type QueueSourceKind = 'album' | 'playlist' | 'artist' | 'artist-top' | 'radio';
export interface QueueSource {
  kind: QueueSourceKind;
  id: string;
}

/** Minimal album identity for the Hub "jump back into browsing" fallback. */
export interface LastOpenedAlbum {
  id: string;
  title: string;
  artist?: string;
  artUrl?: string;
}

export interface Playlist {
  id: string;
  title: string;
  description: string | null;
  isLlmGenerated: boolean;
  isSystem?: boolean;
  generationSource?: 'manual' | 'hub' | 'custom' | 'system' | 'on-repeat' | 'repeat-rewind' | 'daylist' | 'artist-radio' | 'seasonal-rewind' | 'year-rewind' | 'wrapped';
  pinned?: boolean;
  createdAt?: number;
  /** Owner's user id (present on server-fetched playlists). */
  userId?: string | null;
  /** Owner's username, for the "Playlist by <owner>" byline on discovered playlists. */
  ownerUsername?: string | null;
  /** Owner has hidden this playlist from cross-user discovery. */
  isPrivate?: boolean;
  /** True when the current user owns this playlist (server-computed on single fetch). */
  isOwner?: boolean;
  tracks: TrackInfo[];
}

export interface EntityInfo {
  id: string;
  name?: string;
  title?: string;
  artist_name?: string;
}

export interface ArtistInfo extends EntityInfo {
  artist_type?: string;
  area?: string;
  genres?: string;
  community_tags?: string;
  image_url?: string;
  artwork_url?: string;
  listeners?: string;
  lifespan_begin?: string;
  lifespan_end?: string;
  disambiguation?: string;
  mbid?: string;
  bio?: string;
  links?: string;
  members?: string;
  created_at?: string;
  rolesInLibrary?: Array<{ role: string; credits: number }>;
}

export interface TrackCredit {
  artistId: string;
  artistName: string;
  role: string;
  position?: number;
  detail?: string;
  source?: string;
}

export interface AlbumInfo extends EntityInfo {
  image_url?: string;
  // Representative cover hash from getAllAlbums; used to build a local
  // /api/art?hash= URL so grids/tiles show embedded art without the track list.
  art_hash?: string | null;
  mbid?: string;
  description?: string;
  tags?: string;
  listeners?: string;
  playcount?: string;
  created_at?: string;
  release_group_id?: string;
  mb_release_group_id?: string;
  edition_label?: string | null;
  normalized_title?: string;
  release_year?: number | null;
  is_compilation?: boolean;
  manual_group_override?: boolean;
}

export interface AlbumEditionsResponse {
  canonical: AlbumInfo & { track_count?: number };
  editions: Array<AlbumInfo & { track_count?: number }>;
}

export type SortOption = 'name' | 'recentlyAdded' | 'year';

export interface FacetSelection {
  [facetKey: string]: string[];
}

export interface QueryCondition {
  metadataType: string;
  operator: string;
  value: string;
}

export interface QueryGroup {
  id: string;
  conditions: QueryCondition[];
}

export type SortDirection = 'asc' | 'desc';

export interface FilterState {
  facets: FacetSelection;
  sort: SortOption;
  sortDirection: SortDirection;
  queryGroups: QueryGroup[] | null;
  queryResultIds: string[] | null;
}

export type PlaybackLoadPath = 'none' | 'cast' | 'direct' | 'prepared-hls' | 'fallback-hls' | 'lossless-passthrough';
export type PlaybackPrepareStatus = 'idle' | 'preparing' | 'ready' | 'failed';
export type PlaybackRecoveryPath = 'none' | 'normal-hls-after-prepare-failure' | 'normal-hls-after-promotion-failure' | 'fixed-quality-after-adaptive-failure';
export type PrebufferPolicy = 'off' | 'conservative' | 'aggressive';
export type AdaptiveFallbackState = 'none' | 'fixed-64k' | 'fixed-128k';
const getPrewarmAheadCount = (policy: PrebufferPolicy): 1 | 2 => policy === 'aggressive' ? 2 : 1;
export type LlmVetoMode = 'hard' | 'adaptive';
export type QueueMutationOptions = {
  notify?: boolean;
  undo?: boolean;
  message?: string;
};
export type NextTrackOptions = {
  notifyUpNext?: boolean;
};

export interface PlaybackTelemetry {
  lastUpdatedAt: number | null;
  loadPath: PlaybackLoadPath;
  preparedAudioUsed: boolean;
  fallbackHlsLoadUsed: boolean;
  lastTransitionLatencyMs: number | null;
  lastAudibleAt: number | null;
  currentTrackTitle: string | null;
  currentTrackArtist: string | null;
  preparedTrackTitle: string | null;
  preparedTrackArtist: string | null;
  prepareStatus: PlaybackPrepareStatus;
  prepareStartedAt: number | null;
  prepareReadyAt: number | null;
  prepareError: string | null;
  lastFallbackReason: string | null;
  recoveredFromPrepareFailure: boolean;
  recoveryPath: PlaybackRecoveryPath;
  recoveryError: string | null;
  prebufferPolicy: PrebufferPolicy;
  prebufferSkippedReason: string | null;
  adaptiveActiveBitrateKbps: number | null;
  adaptiveBandwidthEstimateKbps: number | null;
  adaptiveLevelCount: number;
  adaptiveSwitchCount: number;
  adaptiveFallbackState: AdaptiveFallbackState;
  adaptiveNativePlayback: boolean;
}

export interface PlayerState {
  // Library State
  library: TrackInfo[];
  libraryFolders: string[];
  isLibraryLoading: boolean;
  /**
   * Optimistic loved-state overrides keyed by track id. Tracks rendered from
   * per-entity/search fetches live in component state (not the store), so
   * toggleTrackLove can't mutate them directly — this overlay lets those views
   * reflect a toggle immediately, and decouples loved-state from `library`.
   */
  lovedOverlay: Record<string, boolean>;
  // Non-null when the last library/playlist fetch failed (network error or
  // non-OK status). Lets the UI distinguish "genuinely empty" from "load failed"
  // and offer a Retry instead of a blank screen.
  libraryError: string | null;
  playlists: Playlist[];
  isPlaylistsLoading: boolean;
  playlistsError: string | null;
  /** Manual playlists owned by other users, surfaced in the discovery rail. */
  discoverPlaylists: Playlist[];

  // Entity State (for navigation)
  artists: ArtistInfo[];
  albums: AlbumInfo[];
  genres: EntityInfo[];

  // Filter State (per view)
  artistFilters: FilterState;
  albumFilters: FilterState;
  setArtistFilters: (filters: FilterState) => void;
  setAlbumFilters: (filters: FilterState) => void;
  clearArtistFilters: () => void;
  clearAlbumFilters: () => void;
  setArtistQueryResultIds: (ids: string[] | null) => void;
  setAlbumQueryResultIds: (ids: string[] | null) => void;

  // Playlist State (Current Play Queue)
  playlist: TrackInfo[];
  // Which collection the current queue was started from (for "playing from"
  // navigation). null for ad-hoc/search queues or queues predating this field.
  queueSource: QueueSource | null;
  // Resume-freshness preference: days of inactivity after which "resume where
  // you left off" stops offering the stale queue. 0 = Always (never expire).
  resumeStalenessDays: number;
  // Timestamp of the last real playback activity (track start), for the gate above.
  lastPlaybackActivityAt: number | null;
  // Most recently opened album, surfaced on the Hub as a "jump back into
  // browsing" fallback when there's no fresh resumable queue.
  lastOpenedAlbum: LastOpenedAlbum | null;
  setLastOpenedAlbum: (album: LastOpenedAlbum | null) => void;

  // Scanning State
  isScanning: boolean;
  scanPhase: 'idle' | 'walk' | 'metadata' | 'analysis' | 'loudness';
  scannedFiles: number;
  totalFiles: number;
  activeWorkers: number;
  activeFiles: string[];
  scanningFile: string | null; // legacy fallback

  // Setup State
  needsSetup: boolean | null;
  setupAdminCreated: boolean | null;
  setupOnboardingCompleted: boolean | null;
  setupStep: SetupStep | null;
  setupStatusError: string | null;
  checkSetupStatus: () => Promise<void>;
  createSetupAdmin: (username: string, password: string) => Promise<StoreActionResult>;
  updateSetupProgress: (nextStep: Exclude<SetupStep, 'account'>) => Promise<StoreActionResult>;
  finalizeSetup: () => Promise<StoreActionResult>;

  // Playback State (Transient)
  currentIndex: number | null;
  playbackState: PlaybackState;
  isBuffering: boolean;
  castConnected: boolean;
  audioOutputSupported: boolean;
  audioOutputPickerSupported: boolean;
  audioOutputDevices: AudioOutputDevice[];
  audioOutputDeviceId: string;
  audioOutputDeviceLabel: string;
  audioOutputActive: boolean;
  audioOutputSelecting: boolean;
  audioOutputError: string | null;
  audioOutputPermission: AudioOutputPermission;
  audioOutputRequestingAccess: boolean;
  playbackTelemetry: PlaybackTelemetry;

  // Settings State (Persisted)
  volume: number;
  shuffle: boolean;
  repeat: "none" | "one" | "all";
  theme: 'light' | 'dark' | 'system';
  // Effective theme after resolving 'system' against the OS preference.
  // Not persisted; consumers that branch on dark/light should read this.
  resolvedTheme: 'light' | 'dark';
  reducedMotion: boolean;
  mobileVideoBackgrounds: boolean;
  lastFmApiKey: string;
  lastFmSharedSecret: string;
  lastFmScrobbleEnabled: boolean;
  lastFmConnected: boolean;
  lastFmUsername: string;
  listenBrainzScrobbleEnabled: boolean;
  listenBrainzConnected: boolean;
  listenBrainzUsername: string;
  subsonicProviderScrobbleEnabled: boolean;
  geniusApiKey: string;
  musicBrainzEnabled: boolean;
  musicBrainzClientId: string;
  musicBrainzClientSecret: string;
  musicBrainzConnected: boolean;
  musicBrainzRedirectUri: string;
  providerArtistImage: 'lastfm' | 'genius' | 'musicbrainz';
  providerArtistArtwork: 'genius' | 'none';
  providerArtistBio: 'lastfm' | 'genius';
  providerAlbumArt: 'lastfm' | 'genius' | 'musicbrainz';
  authToken: string | null; // Account JWT token
  mediaAccessToken: string | null; // Scoped token for HLS/art/Cast URLs
  sseAccessToken: string | null; // Scoped token for EventSource URLs
  // When false, auth tokens stay out of localStorage (session-only sign-in)
  // and the server issues short-lived tokens.
  rememberDevice: boolean;
  authExpired: boolean;
  authExpiredMessage: string | null;
  authExpiredUsername: string;
  streamingQuality: 'auto' | '64k' | '128k' | '160k' | '320k' | 'source';
  playbackDebugLogging: boolean;
  prebufferPolicy: PrebufferPolicy;

  // Current User State
  currentUser: { id: string; username: string; role: string } | null;

  // Last.fm scrobble tracking (internal, not persisted)
  _scrobbleStartAt: number | null;
  _scrobbleEligible: boolean;

  // Global Engine Settings
  discoveryLevel: number;
  genreStrictness: number;
  artistAmnesiaLimit: number;
  // Fraction of a track (percent, 1-100) that must be listened to before it is
  // marked as played — gates both the server play-count and scrobbling.
  playedThresholdPercent: number;
  llmPlaylistDiversity: number;
  llmVetoMode: LlmVetoMode;
  llmGenreCohesion: number;
  llmDiscoveryBias: number;
  llmArtistSpread: number;
  genrePenaltyCurve: number;
  llmRecoveryStrength: number;
  llmAdjacentReach: number;
  llmTracksPerPlaylist: number;
  llmPlaylistCount: number;
  audioAnalysisCpu: string;
  scannerConcurrency: string;
  // Loudness computation strategy (system-wide): 'lazy' measures on play only,
  // 'full' backfills the library after a scan, 'both' does both.
  loudnessComputeMode: 'lazy' | 'full' | 'both';
  hubGenerationSchedule: string;
  systemPlaylistConfig: Record<string, boolean>;
  hlsLoggingEnabled: boolean;
  ffmpegLoggingEnabled: boolean;
  openSubsonicEnabled: boolean;
  // Loudness normalization (EBU R128). User-scoped so the server can gate
  // background measurement on the user's opt-in.
  loudnessNormEnabled: boolean;
  loudnessTargetLufs: number;
  loudnessPreampDb: number;
  loudnessMode: 'track' | 'album';
  llmBaseUrl: string;
  llmApiKey: string;
  llmModelName: string;
  llmConnected: boolean; // Live connection status
  mbdbLastImported: { timestamp: number; duration: number; counts: { genres: number; aliases: number; links: number } } | null;
  genreMatrixLastRun: number | null;
  genreMatrixLastResult: string | null;
  genreMatrixProgress: string | null;
  autoFolderWalk: boolean;

  // Sign-in captcha (Cloudflare Turnstile, system-level, admin)
  turnstileEnabled: boolean;
  turnstileSiteKey: string;
  turnstileSecretKey: string;

  // Concerts / Jambase (system-level, admin)
  jambaseEnabled: boolean;
  jambaseMaxSubscriptionsPerUser: number;
  jambaseCacheTtlDays: number;
  jambaseMonthlyCap: number;
  jambaseHardStop: boolean;

  // YouTube music videos (system-level, admin)
  youtubeEnabled: boolean;
  youtubeApiKey: string;
  youtubeCacheTtlDays: number;
  youtubeDailyQuotaCap: number;
  youtubeHardStop: boolean;

  // Concerts (per-user)
  concertsEnabled: boolean;
  concertsLat: number | null;
  concertsLng: number | null;
  concertsLocationLabel: string;
  concertsRadiusKm: number;
  concertsAutoAddEnabled: boolean;

  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: (collapsed: boolean) => void;

  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;

  setSettings: (settings: Partial<PlayerState>) => void;
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
  
  isInfinityMode: boolean;
  isFetchingInfinity: boolean;
  toggleInfinityMode: () => void;
  ensureInfinityQueue: () => Promise<void>;
  fetchNextInfinityTrack: (isPrefetch?: boolean) => Promise<void>;

  fetchLibraryFromServer: () => Promise<void>;
  /** On-demand full track list load (admin tools only); no-op once loaded. */
  ensureFullLibraryLoaded: () => Promise<void>;
  fetchPlaylistsFromServer: () => Promise<void>;
  fetchDiscoverPlaylists: () => Promise<void>;
  fetchPlaylistFromServer: (playlistId: string) => Promise<boolean>;
  createPlaylist: (title: string, description?: string) => Promise<Playlist | null>;
  deletePlaylist: (playlistId: string) => Promise<void>;
  togglePin: (playlistId: string, pinned: boolean) => Promise<void>;
  updatePlaylistMeta: (playlistId: string, updates: { title?: string; description?: string }) => Promise<void>;
  togglePlaylistPrivacy: (playlistId: string, isPrivate: boolean) => Promise<void>;
  replaceTracksInUserPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>;
  addTracksToUserPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>;
  setAuthToken: (token: string, mediaAccessToken?: string | null, sseAccessToken?: string | null) => void;
  clearAuthToken: () => void;
  expireAuthSession: (message?: string) => void;
  login: (username: string, password: string, rememberDevice?: boolean, turnstileToken?: string) => Promise<AuthAttemptResult>;
  register: (inviteToken: string, username: string, password: string, turnstileToken?: string) => Promise<AuthAttemptResult>;
  getAuthHeader: () => Record<string, string>;
  /** Build stream/art URLs onto server-fetched tracks using the current token + quality. */
  hydrateTracks: (tracks: TrackInfo[]) => TrackInfo[];
  addLibraryFolder: (folderPath: string, options?: AddLibraryFolderOptions) => Promise<StoreActionResult>;
  removeLibraryFolder: (folderName: string) => Promise<void>;
  rescanLibrary: (specificFolder?: string) => Promise<void>;
  addTracksToLibrary: (newTracks: TrackInfo[]) => void;
  setIsScanning: (
    isScanning: boolean,
    phase?: 'idle' | 'walk' | 'metadata' | 'analysis' | 'loudness',
    scanned?: number,
    total?: number,
    workers?: number,
    activeFiles?: string[],
    fileName?: string | null
  ) => void;

  // Library Actions
  toggleTrackLove: (track: TrackInfo) => Promise<void>;

  // Play Queue Actions
  setPlaylist: (tracks: TrackInfo[], startIndex?: number, source?: QueueSource | null) => Promise<void>;
  addTrackToPlaylist: (track: TrackInfo, options?: QueueMutationOptions) => void;
  playNext: (track: TrackInfo, options?: QueueMutationOptions) => void;
  removeFromPlaylist: (index: number) => void;
  moveInPlaylist: (fromIndex: number, toIndex: number) => void;
  clearPlaylist: () => void;
  restoreQueueSnapshot: (playlist: TrackInfo[], currentIndex: number | null) => void;

  // Global Track Context Menu
  contextMenu: { track: TrackInfo; x: number; y: number; playlistId?: string; playlistTrackIndex?: number } | null;
  openContextMenu: (track: TrackInfo, x: number, y: number, playlistId?: string, playlistTrackIndex?: number) => void;
  closeContextMenu: () => void;

  // Playback Actions
  playAtIndex: (index: number) => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  stop: () => void;
  nextTrack: (options?: NextTrackOptions) => Promise<void>;
  prevTrack: () => Promise<void>;
  setVolume: (v: number) => void;
  // Sleep timer. sleepTimerEndsAt is the epoch-ms fire time (null = inactive);
  // it's transient (not persisted). startSleepTimer(0) cancels.
  sleepTimerEndsAt: number | null;
  startSleepTimer: (minutes: number) => void;
  cancelSleepTimer: () => void;
  selectAudioOutput: () => Promise<void>;
  setAudioOutputDevice: (deviceId: string) => Promise<void>;
  ensureAudioOutputAccess: () => Promise<void>;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setCastConnected: (connected: boolean) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setReducedMotion: (enabled: boolean) => void;
  setMobileVideoBackgrounds: (enabled: boolean) => void;
  setLastFmApiKey: (key: string) => void;
  setLastFmSharedSecret: (secret: string) => void;
  setLastFmScrobbleEnabled: (enabled: boolean) => void;
  setLastFmConnected: (connected: boolean) => void;
  setLastFmUsername: (username: string) => void;
  setListenBrainzScrobbleEnabled: (enabled: boolean) => void;
  setListenBrainzConnected: (connected: boolean) => void;
  setListenBrainzUsername: (username: string) => void;
  setSubsonicProviderScrobbleEnabled: (enabled: boolean) => void;
  setGeniusApiKey: (key: string) => void;
  setMusicBrainzEnabled: (enabled: boolean) => void;
  setMusicBrainzClientId: (id: string) => void;
  setMusicBrainzClientSecret: (secret: string) => void;
  setMusicBrainzConnected: (connected: boolean) => void;
  setMusicBrainzRedirectUri: (uri: string) => void;
  setProviderArtistImage: (provider: 'lastfm' | 'genius' | 'musicbrainz') => void;
  setProviderArtistArtwork: (provider: 'genius' | 'none') => void;
  setProviderArtistBio: (provider: 'lastfm' | 'genius') => void;
  setProviderAlbumArt: (provider: 'lastfm' | 'genius' | 'musicbrainz') => void;
  setLlmConnected: (connected: boolean) => void;

  // Manager sync callbacks
  syncTimeUpdate: (time: number) => void;
  syncDuration: (duration: number) => void;
  syncPlaybackState: (state: PlaybackState) => void;
  recordPlaybackTelemetry: (telemetry: Partial<PlaybackTelemetry>) => void;

  // Engine session state
  sessionHistoryTrackIds: string[];
  recordPlay: (trackId: string) => void;
  recordSkip: (trackId: string) => void;

  // Toast state
  toasts: ToastItem[];
  addToast: (message: string, type: ToastType, options?: { actionLabel?: string; onAction?: () => void; duration?: number }) => void;
  removeToast: (id: number) => void;

  // PWA update state
  pendingUpdate: boolean;
  setPendingUpdate: (val: boolean) => void;

  // True when the browser blocked playback for lack of a user gesture
  // (autoplay policy). UI can show a "tap to play" affordance.
  autoplayBlocked: boolean;
  setAutoplayBlocked: (val: boolean) => void;
}

// Remove `PlayerPersist` hack as it was unnecessary and broke inference further

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => {
      // Setup PlaybackManager callbacks to update store state
      playbackManager.setCallbacks({
        onTimeUpdate: (time) => {
          setPlaybackCurrentTime(time);
          persistContinuitySnapshot(false);
          // Mark the track as "played" once the user has listened to the
          // configured fraction of it (capped at 4 minutes, min track length
          // 30s). This single threshold gates BOTH the server play-count and
          // scrobble eligibility, so they stay in lockstep.
          const state = get();
          const { duration } = getPlaybackTimeSnapshot();
          if (!state._scrobbleEligible && state._scrobbleStartAt && duration > 30) {
            const pct = Math.min(Math.max(state.playedThresholdPercent || 50, 1), 100) / 100;
            const threshold = Math.min(duration * pct, 240); // 4 minutes = 240s cap
            if (time >= threshold) {
              set({ _scrobbleEligible: true });
              // Record the play (server telemetry) exactly once, at the moment
              // the threshold is crossed — not on track start.
              const playedTrack = state.currentIndex !== null ? state.playlist[state.currentIndex] : null;
              if (playedTrack) get().recordPlay(playedTrack.id);
            }
          }
        },
        onDuration: (duration) => {
          // Only accept the player-reported duration if it's valid AND at least
          // as large as what we currently have. This prevents the early HLS
          // loadedmetadata (~10s = one segment) from overwriting the DB duration
          // that was set in playAtIndex. Once hls.js parses the full VOD playlist,
          // durationchange fires with the real total and we accept it.
          if (isFinite(duration) && duration > 0) {
            const current = getPlaybackTimeSnapshot().duration;
            if (duration >= current || current === 0) {
              setPlaybackDuration(duration);
              persistContinuitySnapshot(true);
            }
          }
        },
        onPlayStateChange: (state) => {
          set({ playbackState: state });
          persistContinuitySnapshot(true);
        },
        onEnded: () => {
          // Scrobble the completed track if eligible
          const state = get();
          const {
            lastFmConnected, lastFmScrobbleEnabled,
            listenBrainzConnected, listenBrainzScrobbleEnabled,
            _scrobbleEligible, _scrobbleStartAt,
          } = state;
          const currentTrack = state.currentIndex !== null ? state.playlist[state.currentIndex] : null;
          if (_scrobbleEligible && _scrobbleStartAt && currentTrack?.artist && currentTrack?.title) {
            const authHeaders = (get() as any).getAuthHeader();
            const { duration } = getPlaybackTimeSnapshot();
            const payload = {
              tracks: [{
                artist: currentTrack.artist,
                track: currentTrack.title,
                album: currentTrack.album || '',
                albumArtist: currentTrack.albumArtist || '',
                duration: Math.round(duration),
                timestamp: Math.floor(_scrobbleStartAt / 1000),
                mbid: currentTrack.mbTrackId || '',
              }],
            };
            // Surface scrobble failures (throttled per provider) so users notice
            // when this otherwise-invisible feature silently breaks. Success stays
            // quiet to avoid a toast on every finished track.
            const scrobbleTo = (provider: string, url: string) => {
              fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify(payload),
              })
                .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); })
                .catch(() => {
                  const now = Date.now();
                  if (now - (lastScrobbleErrorAt[provider] || 0) > 60000) {
                    lastScrobbleErrorAt[provider] = now;
                    get().addToast(`Couldn't scrobble to ${provider}.`, 'error', { duration: 4000 });
                  }
                });
            };
            if (lastFmConnected && lastFmScrobbleEnabled) scrobbleTo('Last.fm', '/api/providers/lastfm/scrobble');
            if (listenBrainzConnected && listenBrainzScrobbleEnabled) scrobbleTo('ListenBrainz', '/api/providers/listenbrainz/scrobble');
          }
          set({ _scrobbleStartAt: null, _scrobbleEligible: false });

          // Auto-play next track based on repeat and shuffle rules
          const { repeat, nextTrack, stop, fetchNextInfinityTrack } = get();
          if (repeat === 'one') {
            // Let the audio element handle loop if we implemented it, or manually replay
            get().playAtIndex(get().currentIndex!);
          } else if (repeat === 'none') {
            // Stop at end of list
            const currentIdx = get().currentIndex!;
            if (currentIdx < get().playlist.length - 1 || get().shuffle) {
              void nextTrack({ notifyUpNext: true });
            } else if (get().isInfinityMode) {
              // Infinity Mode bounds reached! Fetch the next track natively
              fetchNextInfinityTrack(false);
            } else {
              stop();
            }
          } else {
            // repeat === 'all'
            void nextTrack({ notifyUpNext: true });
          }
        },
        onVolumeChange: (volume) => {
          // Sync volume from cast device → store (e.g., changed via Google Home)
          set({ volume });
        },
        onMuteChange: (_muted) => {
          // When muted, show volume as 0; volume will restore via VOLUME_LEVEL_CHANGED
          if (_muted) {
            set({ volume: 0 });
          }
          // When unmuted, VOLUME_LEVEL_CHANGED fires with the restored value
        },
        onTrackChange: (index) => {
          // Receiver auto-advanced to next track in the queue — sync sender UI
          const state = get();
          if (index !== state.currentIndex && index >= 0 && index < state.playlist.length) {
            setPlaybackTimeState({ currentTime: 0, duration: state.playlist[index].duration || 0 });
            set({
              currentIndex: index,
              _scrobbleStartAt: Date.now(),
              _scrobbleEligible: false,
            });
            persistContinuitySnapshot(true);
          }
        },
        onBufferingChange: (isBuffering) => {
          set({ isBuffering });
        }
      });

      // Wire up CastManager state changes to the store
      setTimeout(() => {
        castManager.addStateChangeListener((castState) => {
          set({ castConnected: castState === 'CONNECTED' });
          const state = get();
          if (state.prebufferPolicy !== 'off') {
            preloadManager.prewarmNext(state.playlist, state.currentIndex, state.streamingQuality, {
              castConnected: castState === 'CONNECTED',
              aheadCount: getPrewarmAheadCount(state.prebufferPolicy),
            });
          }
        });
      }, 0);

      setTimeout(() => {
        const persisted = get();
        const initialAudioOutput = audioOutputManager.initialize(
          persisted.audioOutputDeviceId,
          persisted.audioOutputDeviceLabel
        );
        set({
          audioOutputSupported: initialAudioOutput.supported,
          audioOutputPickerSupported: initialAudioOutput.pickerSupported,
          audioOutputDevices: initialAudioOutput.devices,
          audioOutputDeviceId: initialAudioOutput.deviceId,
          audioOutputDeviceLabel: initialAudioOutput.label,
          audioOutputActive: initialAudioOutput.active,
          audioOutputSelecting: initialAudioOutput.selecting,
          audioOutputError: initialAudioOutput.error,
          audioOutputPermission: initialAudioOutput.permission,
          audioOutputRequestingAccess: initialAudioOutput.requestingAccess,
        });

        audioOutputManager.subscribe((audioOutput) => {
          set({
            audioOutputSupported: audioOutput.supported,
            audioOutputPickerSupported: audioOutput.pickerSupported,
            audioOutputDevices: audioOutput.devices,
            audioOutputDeviceId: audioOutput.deviceId,
            audioOutputDeviceLabel: audioOutput.label,
            audioOutputActive: audioOutput.active,
            audioOutputSelecting: audioOutput.selecting,
            audioOutputError: audioOutput.error,
            audioOutputPermission: audioOutput.permission,
            audioOutputRequestingAccess: audioOutput.requestingAccess,
          });
        });
      }, 0);

      const prewarmNextFromState = (state: PlayerState, currentIndex: number | null = state.currentIndex) => {
        const nextIndex = currentIndex !== null ? currentIndex + 1 : null;
        const nextTrack = nextIndex !== null ? state.playlist[nextIndex] : null;
        const isActuallyCasting = castManager.isConnected();
        if (state.prebufferPolicy === 'off') {
          playbackManager.clearPreparedAudio();
          get().recordPlaybackTelemetry({
            prepareStatus: 'idle',
            preparedTrackTitle: null,
            preparedTrackArtist: null,
            prebufferPolicy: state.prebufferPolicy,
            prebufferSkippedReason: 'policy-off',
          });
          return;
        }
        preloadManager.prewarmNext(state.playlist, currentIndex, state.streamingQuality, {
          castConnected: isActuallyCasting,
          aheadCount: getPrewarmAheadCount(state.prebufferPolicy),
        });
        if (!isActuallyCasting && nextTrack?.url) {
          playbackManager.prepareNextUrl(
            nextTrack.url,
            nextTrack.rawUrl || '',
            nextTrack.title,
            nextTrack.artist || ((nextTrack.artists as string[])?.join(', ')),
            nextTrack.artUrl,
            nextTrack.album,
            nextTrack.format
          );
        }
      };

      let lastContinuitySnapshotAt = 0;
      const persistContinuitySnapshot = (force = false) => {
        const now = Date.now();
        if (!force && now - lastContinuitySnapshotAt < 5000) return;
        lastContinuitySnapshotAt = now;
        const state = get();
        const { currentTime, duration } = getPlaybackTimeSnapshot();
        savePlaybackContinuitySnapshot({
          playlist: state.playlist,
          currentIndex: state.currentIndex,
          currentTime,
          duration,
          playbackState: state.playbackState,
          wasPlaying: state.playbackState === 'playing',
          repeat: state.repeat,
          shuffle: state.shuffle,
          streamingQuality: state.streamingQuality,
        });
      };

      return {
        // Initial State
        library: [] as TrackInfo[],
        libraryFolders: [] as string[],
        isLibraryLoading: false as boolean,
        lovedOverlay: {} as Record<string, boolean>,
        libraryError: null as string | null,
        playlists: [] as Playlist[],
        isPlaylistsLoading: false as boolean,
        playlistsError: null as string | null,
        discoverPlaylists: [] as Playlist[],
        artists: [] as ArtistInfo[],
        albums: [] as AlbumInfo[],
        genres: [] as EntityInfo[],
        artistFilters: { ...EMPTY_FILTER_STATE } as FilterState,
        albumFilters: { ...EMPTY_FILTER_STATE } as FilterState,
        setArtistFilters: (filters: FilterState) => { set({ artistFilters: filters }); },
        setAlbumFilters: (filters: FilterState) => { set({ albumFilters: filters }); },
        clearArtistFilters: () => { set({ artistFilters: { ...EMPTY_FILTER_STATE } }); },
        clearAlbumFilters: () => { set({ albumFilters: { ...EMPTY_FILTER_STATE } }); },
        setArtistQueryResultIds: (ids: string[] | null) => { set({ artistFilters: { ...get().artistFilters, queryResultIds: ids } }); },
        setAlbumQueryResultIds: (ids: string[] | null) => { set({ albumFilters: { ...get().albumFilters, queryResultIds: ids } }); },
        playlist: [] as TrackInfo[],
        queueSource: null as QueueSource | null,
        resumeStalenessDays: 0,
        lastPlaybackActivityAt: null as number | null,
        lastOpenedAlbum: null as LastOpenedAlbum | null,

        isScanning: false as boolean,
        scanPhase: 'idle' as 'idle' | 'walk' | 'metadata' | 'analysis' | 'loudness',
        scannedFiles: 0,
        totalFiles: 0,
        activeWorkers: 0,
        activeFiles: [] as string[],
        scanningFile: null as string | null,

        needsSetup: null as boolean | null,
        setupAdminCreated: null as boolean | null,
        setupOnboardingCompleted: null as boolean | null,
        setupStep: null as SetupStep | null,
        setupStatusError: null as string | null,

        currentIndex: null as number | null,
        playbackState: 'stopped' as PlaybackState,
        isBuffering: false as boolean,
        castConnected: false as boolean,
        audioOutputSupported: false,
        audioOutputPickerSupported: false,
        audioOutputDevices: [{ deviceId: '', label: 'System default', isDefault: true }],
        audioOutputDeviceId: '',
        audioOutputDeviceLabel: '',
        audioOutputActive: false,
        audioOutputSelecting: false,
        audioOutputError: null,
        audioOutputPermission: 'unknown' as AudioOutputPermission,
        audioOutputRequestingAccess: false,
        playbackTelemetry: {
          lastUpdatedAt: null,
          loadPath: 'none',
          preparedAudioUsed: false,
          fallbackHlsLoadUsed: false,
          lastTransitionLatencyMs: null,
          lastAudibleAt: null,
          currentTrackTitle: null,
          currentTrackArtist: null,
          preparedTrackTitle: null,
          preparedTrackArtist: null,
          prepareStatus: 'idle',
          prepareStartedAt: null,
          prepareReadyAt: null,
          prepareError: null,
          lastFallbackReason: null,
          recoveredFromPrepareFailure: false,
          recoveryPath: 'none',
          recoveryError: null,
          prebufferPolicy: 'conservative',
          prebufferSkippedReason: null,
          adaptiveActiveBitrateKbps: null,
          adaptiveBandwidthEstimateKbps: null,
          adaptiveLevelCount: 0,
          adaptiveSwitchCount: 0,
          adaptiveFallbackState: 'none',
          adaptiveNativePlayback: false,
        } as PlaybackTelemetry,
        volume: 1,
        shuffle: false as boolean,
        repeat: "none" as "none" | "one" | "all",
        theme: 'system' as 'light' | 'dark' | 'system',
        resolvedTheme: ((typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light') as 'light' | 'dark',
        reducedMotion: (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) || false,
        mobileVideoBackgrounds: true,
        lastFmApiKey: '',
        lastFmSharedSecret: '',
        lastFmScrobbleEnabled: false as boolean,
        lastFmConnected: false as boolean,
        lastFmUsername: '',
        listenBrainzScrobbleEnabled: false as boolean,
        listenBrainzConnected: false as boolean,
        listenBrainzUsername: '',
        subsonicProviderScrobbleEnabled: false as boolean,
        geniusApiKey: '',
        musicBrainzEnabled: false as boolean,
        musicBrainzClientId: '',
        musicBrainzClientSecret: '',
        musicBrainzConnected: false as boolean,
        musicBrainzRedirectUri: '',
        providerArtistImage: 'lastfm' as 'lastfm' | 'genius' | 'musicbrainz',
        providerArtistArtwork: 'genius' as 'genius' | 'none',
        providerArtistBio: 'lastfm' as 'lastfm' | 'genius',
        providerAlbumArt: 'lastfm' as 'lastfm' | 'genius' | 'musicbrainz',
        jambaseEnabled: false as boolean,
        jambaseMaxSubscriptionsPerUser: 10,
        jambaseCacheTtlDays: 7,
        jambaseMonthlyCap: 1000,
        jambaseHardStop: true as boolean,
        youtubeEnabled: false as boolean,
        youtubeApiKey: '',
        youtubeCacheTtlDays: 14,
        youtubeDailyQuotaCap: 9000,
        youtubeHardStop: true as boolean,
        concertsEnabled: false as boolean,
        concertsLat: null as number | null,
        concertsLng: null as number | null,
        concertsLocationLabel: '',
        concertsRadiusKm: 50,
        concertsAutoAddEnabled: false as boolean,
        authToken: null as string | null,
        mediaAccessToken: null as string | null,
        sseAccessToken: null as string | null,
        rememberDevice: true as boolean,
        authExpired: false,
        authExpiredMessage: null as string | null,
        authExpiredUsername: '',
        streamingQuality: 'auto' as 'auto' | '64k' | '128k' | '160k' | '320k' | 'source',
        playbackDebugLogging: false as boolean,
        prebufferPolicy: 'conservative' as PrebufferPolicy,
        currentUser: null as { id: string; username: string; role: string } | null,

        // Last.fm scrobble state
        _scrobbleStartAt: null as number | null,
        _scrobbleEligible: false as boolean,

        isInfinityMode: true as boolean,
        isFetchingInfinity: false as boolean,


        discoveryLevel: 50,
        genreStrictness: 50,
        artistAmnesiaLimit: 50,
        // Standard scrobble threshold (Last.fm/ListenBrainz): ~half a track (or
        // 4 min). 95% was effectively "finish the song", so casual listening
        // recorded no plays and the history-driven Hub sections never populated.
        playedThresholdPercent: 50,
        llmPlaylistDiversity: 50,
        llmVetoMode: 'hard' as LlmVetoMode,
        llmGenreCohesion: 50,
        llmDiscoveryBias: 45,
        llmArtistSpread: 70,
        genrePenaltyCurve: 50,
        llmRecoveryStrength: 50,
        llmAdjacentReach: 50,
        llmTracksPerPlaylist: 10,
        llmPlaylistCount: 3,
        audioAnalysisCpu: 'Balanced',
        scannerConcurrency: 'SSD',
        loudnessComputeMode: 'both' as 'lazy' | 'full' | 'both',
        hubGenerationSchedule: 'Daily',
        systemPlaylistConfig: { ...defaultSystemPlaylistConfig },
        hlsLoggingEnabled: false,
        ffmpegLoggingEnabled: false,
        openSubsonicEnabled: true,
        loudnessNormEnabled: false as boolean,
        loudnessTargetLufs: -18,
        loudnessPreampDb: 0,
        loudnessMode: 'track' as 'track' | 'album',
        llmBaseUrl: '',
        llmApiKey: '',
        llmModelName: '',
        llmConnected: false,
        mbdbLastImported: null,
        genreMatrixLastRun: null as number | null,
        genreMatrixLastResult: null as string | null,
        turnstileEnabled: false as boolean,
        turnstileSiteKey: '',
        turnstileSecretKey: '',
        genreMatrixProgress: null as string | null,
        autoFolderWalk: false as boolean,

        isSidebarCollapsed: false as boolean,
        setIsSidebarCollapsed: (collapsed: boolean) => set({ isSidebarCollapsed: collapsed }),

        isSidebarOpen: false as boolean,
        setIsSidebarOpen: (open: boolean) => set({ isSidebarOpen: open }),

        sessionHistoryTrackIds: [] as string[],

        // Actions
        checkSetupStatus: async () => {
          try {
            const res = await fetch('/api/setup/status');
            if (!res.ok) throw new Error(await getResponseError(res, 'Could not check setup status.'));
            const data = await res.json();
            if (typeof data.needsSetup !== 'boolean') {
              throw new Error(typeof data.error === 'string' ? data.error : 'Setup status was unavailable.');
            }
            const nextStep = data.nextStep === 'account' || data.nextStep === 'analysis' || data.nextStep === 'library'
              ? data.nextStep as SetupStep
              : null;
            set({
              needsSetup: data.needsSetup,
              setupAdminCreated: typeof data.adminCreated === 'boolean' ? data.adminCreated : null,
              setupOnboardingCompleted: typeof data.onboardingCompleted === 'boolean' ? data.onboardingCompleted : null,
              setupStep: nextStep,
              setupStatusError: null,
            });
          } catch (error) {
            console.error('Failed to check setup status', error);
            const message = error instanceof Error ? error.message : 'Could not check setup status.';
            set({ setupStatusError: message });
          }
        },

        createSetupAdmin: async (username: string, password: string) => {
          try {
            const res = await fetch('/api/setup/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: username.trim(), password }),
            });
            if (!res.ok) {
              return { success: false, error: await getResponseError(res, 'Failed to create the admin account.') };
            }

            const data = await res.json();
            // Setup always starts a remembered session.
            clearSessionAuth();
            set({
              authToken: data.token,
              mediaAccessToken: data.mediaToken || data.token,
              sseAccessToken: data.sseToken || data.token,
              currentUser: data.user || null,
              rememberDevice: true,
              needsSetup: true,
              setupAdminCreated: true,
              setupOnboardingCompleted: false,
              setupStep: 'analysis',
              setupStatusError: null,
              authExpired: false,
              authExpiredMessage: null,
            });
            return { success: true };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Network error while creating the admin account.',
            };
          }
        },

        updateSetupProgress: async (nextStep: Exclude<SetupStep, 'account'>) => {
          try {
            const res = await fetch('/api/setup/progress', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', ...get().getAuthHeader() },
              body: JSON.stringify({ nextStep }),
            });
            if (!res.ok) {
              return { success: false, error: await getResponseError(res, 'Failed to save setup progress.') };
            }
            set({ setupStep: nextStep, setupStatusError: null });
            return { success: true };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Network error while saving setup progress.',
            };
          }
        },

        finalizeSetup: async () => {
          try {
            const res = await fetch('/api/setup/finalize', {
              method: 'POST',
              headers: get().getAuthHeader(),
            });
            if (!res.ok) {
              return { success: false, error: await getResponseError(res, 'Failed to finish setup.') };
            }
            set({ setupOnboardingCompleted: true, setupStatusError: null });
            return { success: true };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Network error while finishing setup.',
            };
          }
        },

        setIsScanning: (isScanning, phase = 'idle', scanned = 0, total = 0, workers = 0, activeFiles = [], fileName = null) => 
          set({ 
            isScanning, 
            scanPhase: phase, 
            scannedFiles: scanned, 
            totalFiles: total, 
            activeWorkers: workers, 
            activeFiles,
            scanningFile: fileName 
          }),

        setTheme: (theme: 'light' | 'dark' | 'system') => {
          const prefersDark = typeof window !== 'undefined'
            && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
          const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
          set({ theme, resolvedTheme: resolved });
          document.documentElement.classList.toggle('dark', resolved === 'dark');
        },

        setReducedMotion: (enabled: boolean) => {
          set({ reducedMotion: enabled });
          if (enabled) {
            document.documentElement.classList.add('reduced-motion');
          } else {
            document.documentElement.classList.remove('reduced-motion');
          }
        },

        setMobileVideoBackgrounds: (enabled: boolean) => {
          set({ mobileVideoBackgrounds: enabled });
        },

        setAuthToken: (token: string, mediaAccessToken: string | null = null, sseAccessToken: string | null = null) => {
          set({
            authToken: token,
            mediaAccessToken: mediaAccessToken || token,
            sseAccessToken: sseAccessToken || token,
            authExpired: false,
            authExpiredMessage: null,
          });
          if (!get().rememberDevice) {
            writeSessionAuth({
              authToken: token,
              mediaAccessToken: mediaAccessToken || token,
              sseAccessToken: sseAccessToken || token,
              currentUser: get().currentUser,
            });
          }
        },

        clearAuthToken: () => {
          clearSessionAuth();
          set({
            authToken: null,
            mediaAccessToken: null,
            sseAccessToken: null,
            currentUser: null,
            authExpired: false,
            authExpiredMessage: null,
            authExpiredUsername: '',
          });
        },

        expireAuthSession: (message = 'Your session expired. Log in again to continue.') => {
          // Cancel any in-flight library/playlist fetch so it can't resolve after
          // logout and repopulate state with the previous session's data.
          abortInFlightLibraryFetches();
          clearSessionAuth();
          return set((state: PlayerState) => ({
          authToken: null,
          mediaAccessToken: null,
          sseAccessToken: null,
          currentUser: null,
          authExpired: true,
          authExpiredMessage: message,
          authExpiredUsername: state.currentUser?.username || state.authExpiredUsername || '',
          isLibraryLoading: false,
          isPlaylistsLoading: false,
          isFetchingInfinity: false,
          isScanning: false,
          scanPhase: 'idle',
          scannedFiles: 0,
          totalFiles: 0,
          activeWorkers: 0,
          activeFiles: [],
          scanningFile: null,
        }));
        },

        login: async (username: string, password: string, rememberDevice = true, turnstileToken?: string) => {
          try {
            const res = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                username,
                password,
                rememberMe: rememberDevice,
                ...(turnstileToken ? { turnstileToken } : {}),
              })
            });
            if (res.ok) {
              const data = await res.json();
              // rememberDevice must land in the same set() as the tokens: the
              // persist partialize reads it to decide whether auth fields are
              // written to localStorage.
              set({
                authToken: data.token,
                mediaAccessToken: data.mediaToken || data.token,
                sseAccessToken: data.sseToken || data.token,
                currentUser: data.user,
                rememberDevice,
                authExpired: false,
                authExpiredMessage: null,
                authExpiredUsername: '',
              });
              if (rememberDevice) {
                clearSessionAuth();
              } else {
                writeSessionAuth({
                  authToken: data.token,
                  mediaAccessToken: data.mediaToken || data.token,
                  sseAccessToken: data.sseToken || data.token,
                  currentUser: data.user,
                });
              }
              return { success: true } as const;
            }
            const data = await res.json().catch(() => null);
            if (res.status === 429) {
              return { success: false, error: data?.error || 'Too many attempts. Try again later.', code: 'rate_limited' } as const;
            }
            return { success: false, error: data?.error || 'Invalid credentials', code: data?.code } as const;
          } catch {
            return { success: false, error: 'Could not reach the server. Check your connection and try again.', code: 'network' } as const;
          }
        },

        register: async (inviteToken: string, username: string, password: string, turnstileToken?: string) => {
          try {
            const res = await fetch('/api/auth/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                inviteToken,
                username,
                password,
                ...(turnstileToken ? { turnstileToken } : {}),
              })
            });
            if (res.ok) {
              const data = await res.json();
              // Registration always starts a remembered session.
              clearSessionAuth();
              set({
                authToken: data.token,
                mediaAccessToken: data.mediaToken || data.token,
                sseAccessToken: data.sseToken || data.token,
                currentUser: data.user,
                rememberDevice: true,
                authExpired: false,
                authExpiredMessage: null,
                authExpiredUsername: '',
              });
              return { success: true } as const;
            }
            const data = await res.json().catch(() => null);
            if (res.status === 429) {
              return { success: false, error: data?.error || 'Too many attempts. Try again later.', code: 'rate_limited' } as const;
            }
            return { success: false, error: data?.error || 'Registration failed', code: data?.code } as const;
          } catch {
            return { success: false, error: 'Could not reach the server. Check your connection and try again.', code: 'network' } as const;
          }
        },

        // Helper for Auth Header (JWT Bearer)
        getAuthHeader: () => {
          const { authToken } = get();
          if (authToken) {
            return { 'Authorization': 'Bearer ' + authToken };
          }
          return {} as Record<string, string>;
        },

        hydrateTracks: (tracks: TrackInfo[]) => {
          const { mediaAccessToken, authToken, streamingQuality } = get();
          const token = mediaAccessToken || authToken || '';
          const quality = streamingQuality;
          return tracks.map((t) => hydrateServerTrack(t, token, quality));
        },

        setSettings: (settings: Partial<PlayerState>) => {
          const previousStreamingQuality = get().streamingQuality;
          const previousPrebufferPolicy = get().prebufferPolicy;
          set((state: PlayerState) => ({ ...state, ...settings }));
          if (settings.playbackDebugLogging !== undefined) {
            setPlaybackDebugLogging(settings.playbackDebugLogging);
            castManager.setDiagnosticsVerbose(settings.playbackDebugLogging);
          }
          if (settings.prebufferPolicy && settings.prebufferPolicy !== previousPrebufferPolicy) {
            playbackManager.clearPreparedAudio();
            get().recordPlaybackTelemetry({
              prepareStatus: 'idle',
              preparedTrackTitle: null,
              preparedTrackArtist: null,
              prebufferPolicy: settings.prebufferPolicy,
              prebufferSkippedReason: settings.prebufferPolicy === 'off' ? 'policy-off' : null,
            });
            if (settings.prebufferPolicy !== 'off') {
              prewarmNextFromState(get());
            }
          }
          if (settings.streamingQuality && settings.streamingQuality !== previousStreamingQuality) {
            playbackManager.clearPreparedAudio();
            prewarmNextFromState(get());
          }
          // Live-apply loudness changes to the current track (no track change needed).
          if (settings.loudnessNormEnabled !== undefined || settings.loudnessTargetLufs !== undefined
              || settings.loudnessPreampDb !== undefined || settings.loudnessMode !== undefined) {
            const st = get();
            const cur = st.currentIndex != null ? st.playlist[st.currentIndex] : null;
            if (cur) applyLoudnessForTrack(get, cur, playGeneration);
            else playbackManager.setLoudnessGainDb(null);
          }
        },

        loadSettings: async () => {
          try {
            const authHeaders = (get() as any).getAuthHeader();
            const res = await fetch('/api/settings', { headers: authHeaders });
            if (res.ok) {
              const data = await res.json();
              set({
                discoveryLevel: data.discoveryLevel !== undefined ? data.discoveryLevel : 50,
                genreStrictness: data.genreStrictness !== undefined ? data.genreStrictness : 50,
                artistAmnesiaLimit: data.artistAmnesiaLimit !== undefined ? data.artistAmnesiaLimit : 50,
                playedThresholdPercent: data.playedThresholdPercent !== undefined ? Number(data.playedThresholdPercent) : 50,
                llmPlaylistDiversity: data.llmPlaylistDiversity !== undefined ? data.llmPlaylistDiversity : 50,
                llmVetoMode: data.llmVetoMode === 'adaptive' ? 'adaptive' : 'hard',
                llmGenreCohesion: data.llmGenreCohesion !== undefined ? data.llmGenreCohesion : (data.genreBlendWeight !== undefined ? data.genreBlendWeight : 50),
                llmDiscoveryBias: data.llmDiscoveryBias !== undefined ? data.llmDiscoveryBias : 45,
                llmArtistSpread: data.llmArtistSpread !== undefined ? data.llmArtistSpread : 70,
                genrePenaltyCurve: data.genrePenaltyCurve !== undefined ? data.genrePenaltyCurve : 50,
                llmRecoveryStrength: data.llmRecoveryStrength !== undefined ? data.llmRecoveryStrength : 50,
                llmAdjacentReach: data.llmAdjacentReach !== undefined ? data.llmAdjacentReach : 50,
                llmTracksPerPlaylist: data.llmTracksPerPlaylist !== undefined ? data.llmTracksPerPlaylist : 10,
                llmPlaylistCount: data.llmPlaylistCount !== undefined ? data.llmPlaylistCount : 3,
                audioAnalysisCpu: data.audioAnalysisCpu || 'Balanced',
                scannerConcurrency: data.scannerConcurrency || 'SSD',
                loudnessComputeMode: (data.loudnessComputeMode === 'lazy' || data.loudnessComputeMode === 'full') ? data.loudnessComputeMode : 'both',
                hubGenerationSchedule: normalizeHubGenerationSchedule(data.hubGenerationSchedule),
                systemPlaylistConfig: normalizeSystemPlaylistConfig(data.systemPlaylistConfig),
                hlsLoggingEnabled: data.hlsLoggingEnabled === true,
                ffmpegLoggingEnabled: data.ffmpegLoggingEnabled === true,
                openSubsonicEnabled: data.openSubsonicEnabled !== false,
                loudnessNormEnabled: data.loudnessNormEnabled === true,
                loudnessTargetLufs: typeof data.loudnessTargetLufs === 'number' ? data.loudnessTargetLufs : -18,
                loudnessPreampDb: typeof data.loudnessPreampDb === 'number' ? data.loudnessPreampDb : 0,
                loudnessMode: data.loudnessMode === 'album' ? 'album' : 'track',
                llmBaseUrl: data.llmBaseUrl || '',
                llmApiKey: data.llmApiKey || '',
                llmModelName: data.llmModelName || '',
                mbdbLastImported: normalizeMbdbLastImport(data.mbdbLastImport),
                genreMatrixLastRun: data.genreMatrixLastRun || null,
                genreMatrixLastResult: data.genreMatrixLastResult || null,
                genreMatrixProgress: data.genreMatrixProgress || null,
                lastFmApiKey: data.lastFmApiKey || '',
                lastFmSharedSecret: data.lastFmSharedSecret || '',
                lastFmScrobbleEnabled: data.lastFmScrobbleEnabled ?? false,
                lastFmConnected: data.lastFmConnected ?? false,
                lastFmUsername: data.lastFmUsername || '',
                listenBrainzScrobbleEnabled: data.listenBrainzScrobbleEnabled ?? false,
                listenBrainzConnected: data.listenBrainzConnected ?? false,
                listenBrainzUsername: data.listenBrainzUsername || '',
                subsonicProviderScrobbleEnabled: data.subsonicProviderScrobbleEnabled === true,
                geniusApiKey: data.geniusApiKey || '',
                musicBrainzEnabled: data.musicBrainzEnabled ?? false,
                musicBrainzClientId: data.musicBrainzClientId || '',
                musicBrainzClientSecret: data.musicBrainzClientSecret || '',
                musicBrainzConnected: data.musicBrainzConnected ?? false,
                musicBrainzRedirectUri: data.musicBrainzRedirectUri || '',
                providerArtistImage: data.providerArtistImage || 'lastfm',
                providerArtistArtwork: data.providerArtistArtwork || 'genius',
                providerArtistBio: data.providerArtistBio || 'lastfm',
                providerAlbumArt: data.providerAlbumArt || 'lastfm',
                autoFolderWalk: data.autoFolderWalk === 'true' || data.autoFolderWalk === true,
                turnstileEnabled: data.turnstileEnabled === true,
                turnstileSiteKey: data.turnstileSiteKey || '',
                turnstileSecretKey: data.turnstileSecretKey || '',
                jambaseEnabled: data.jambaseEnabled ?? false,
                jambaseMaxSubscriptionsPerUser: typeof data.jambaseMaxSubscriptionsPerUser === 'number' ? data.jambaseMaxSubscriptionsPerUser : 10,
                jambaseCacheTtlDays: typeof data.jambaseCacheTtlDays === 'number' ? data.jambaseCacheTtlDays : 7,
                jambaseMonthlyCap: typeof data.jambaseMonthlyCap === 'number' ? data.jambaseMonthlyCap : 1000,
                jambaseHardStop: data.jambaseHardStop ?? true,
                youtubeEnabled: data.youtubeEnabled ?? false,
                youtubeApiKey: data.youtubeApiKey || '',
                youtubeCacheTtlDays: typeof data.youtubeCacheTtlDays === 'number' ? data.youtubeCacheTtlDays : 14,
                youtubeDailyQuotaCap: typeof data.youtubeDailyQuotaCap === 'number' ? data.youtubeDailyQuotaCap : 9000,
                youtubeHardStop: data.youtubeHardStop ?? true,
                concertsEnabled: data.concertsEnabled ?? false,
                concertsLat: typeof data.concertsLat === 'number' ? data.concertsLat : null,
                concertsLng: typeof data.concertsLng === 'number' ? data.concertsLng : null,
                concertsLocationLabel: data.concertsLocationLabel || '',
                concertsRadiusKm: typeof data.concertsRadiusKm === 'number' ? data.concertsRadiusKm : 50,
                concertsAutoAddEnabled: data.concertsAutoAddEnabled ?? false
              });

              // Auto-validate LLM connection if credentials exist
              if (data.llmBaseUrl && data.llmModelName) {
                try {
                  const healthRes = await fetch('/api/health/llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify({ llmBaseUrl: data.llmBaseUrl, llmApiKey: data.llmApiKey || '' })
                  });
                  const healthData = await healthRes.json();
                  set({ llmConnected: healthRes.ok && healthData.status === 'ok' });
                } catch {
                  set({ llmConnected: false });
                }
              }
            }
          } catch (e) {
            console.error('Failed to load DB settings', e);
          }
        },

        saveSettings: async () => {
           try {
              const state = get();
              const authHeaders = (state as any).getAuthHeader();
              const payload = {
                discoveryLevel: state.discoveryLevel,
                genreStrictness: state.genreStrictness,
                artistAmnesiaLimit: state.artistAmnesiaLimit,
                playedThresholdPercent: state.playedThresholdPercent,
                llmPlaylistDiversity: state.llmPlaylistDiversity,
                llmVetoMode: state.llmVetoMode,
                llmGenreCohesion: state.llmGenreCohesion,
                llmDiscoveryBias: state.llmDiscoveryBias,
                llmArtistSpread: state.llmArtistSpread,
                genrePenaltyCurve: state.genrePenaltyCurve,
                llmRecoveryStrength: state.llmRecoveryStrength,
                llmAdjacentReach: state.llmAdjacentReach,
                llmTracksPerPlaylist: state.llmTracksPerPlaylist,
                llmPlaylistCount: state.llmPlaylistCount,
                audioAnalysisCpu: state.audioAnalysisCpu,
                scannerConcurrency: state.scannerConcurrency,
                loudnessComputeMode: state.loudnessComputeMode,
                hubGenerationSchedule: state.hubGenerationSchedule,
                systemPlaylistConfig: state.systemPlaylistConfig,
                hlsLoggingEnabled: state.hlsLoggingEnabled,
                ffmpegLoggingEnabled: state.ffmpegLoggingEnabled,
                openSubsonicEnabled: state.openSubsonicEnabled,
                loudnessNormEnabled: state.loudnessNormEnabled,
                loudnessTargetLufs: state.loudnessTargetLufs,
                loudnessPreampDb: state.loudnessPreampDb,
                loudnessMode: state.loudnessMode,
                llmBaseUrl: state.llmBaseUrl,
                llmApiKey: state.llmApiKey,
                llmModelName: state.llmModelName,
                lastFmApiKey: state.lastFmApiKey,
                lastFmSharedSecret: state.lastFmSharedSecret,
                lastFmScrobbleEnabled: state.lastFmScrobbleEnabled,
                listenBrainzScrobbleEnabled: state.listenBrainzScrobbleEnabled,
                subsonicProviderScrobbleEnabled: state.subsonicProviderScrobbleEnabled,
                geniusApiKey: state.geniusApiKey,
                musicBrainzEnabled: state.musicBrainzEnabled,
                musicBrainzClientId: state.musicBrainzClientId,
                musicBrainzClientSecret: state.musicBrainzClientSecret,
                musicBrainzRedirectUri: state.musicBrainzRedirectUri,
                providerArtistImage: state.providerArtistImage,
                providerArtistArtwork: state.providerArtistArtwork,
                providerArtistBio: state.providerArtistBio,
                providerAlbumArt: state.providerAlbumArt,
                autoFolderWalk: state.autoFolderWalk,
                turnstileEnabled: state.turnstileEnabled,
                turnstileSiteKey: state.turnstileSiteKey,
                turnstileSecretKey: state.turnstileSecretKey,
                jambaseEnabled: state.jambaseEnabled,
                jambaseMaxSubscriptionsPerUser: state.jambaseMaxSubscriptionsPerUser,
                jambaseCacheTtlDays: state.jambaseCacheTtlDays,
                jambaseMonthlyCap: state.jambaseMonthlyCap,
                jambaseHardStop: state.jambaseHardStop,
                youtubeEnabled: state.youtubeEnabled,
                youtubeApiKey: state.youtubeApiKey,
                youtubeCacheTtlDays: state.youtubeCacheTtlDays,
                youtubeDailyQuotaCap: state.youtubeDailyQuotaCap,
                youtubeHardStop: state.youtubeHardStop,
                concertsEnabled: state.concertsEnabled,
                concertsLat: state.concertsLat,
                concertsLng: state.concertsLng,
                concertsLocationLabel: state.concertsLocationLabel,
                concertsRadiusKm: state.concertsRadiusKm,
                concertsAutoAddEnabled: state.concertsAutoAddEnabled
              };
              await fetch('/api/settings', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', ...authHeaders },
                 body: JSON.stringify(payload)
              });
              // Clear cached external imagery when provider settings change
              clearExternalCache();
           } catch(e) {
              console.error('Failed to save settings', e);
           }
        },
        toggleInfinityMode: () => {
          const state = get();
          const newMode = !state.isInfinityMode;
          set({ isInfinityMode: newMode });
          if (newMode) {
            get().ensureInfinityQueue();
          }
        },

        ensureInfinityQueue: async () => {
          const state = get();
          if (!state.isInfinityMode || state.isFetchingInfinity) return;

          const currentIndex = state.currentIndex !== null ? state.currentIndex : 0;
          const remaining = Math.max(0, state.playlist.length - 1 - currentIndex);
          
          // Prefetch if there are no upcoming tracks in the queue
          if (remaining < 1 && state.playlist.length > 0) {
            await get().fetchNextInfinityTrack(true);
          }
        },

        fetchNextInfinityTrack: async (isPrefetch = false) => {
          const state = get();
          if (state.isFetchingInfinity) return;
          
          set({ isFetchingInfinity: true });
          try {
            const authHeaders = (state as any).getAuthHeader();
            const payload = {
              sessionHistoryTrackIds: state.sessionHistoryTrackIds,
              settings: {
                discoveryLevel: state.discoveryLevel,
                genreStrictness: state.genreStrictness,
                artistAmnesiaLimit: state.artistAmnesiaLimit,
              }
            };
            const res = await fetch('/api/recommend', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify(payload)
            });
            if (res.ok) {
              const data = await res.json();
              if (data.track) {
                const { mediaAccessToken, authToken, streamingQuality } = state;
                const token = mediaAccessToken || authToken || '';
                const quality = streamingQuality;

                const track = {
                  ...data.track,
                  isInfinity: true,
                  ...hydrateServerTrack(data.track, token, quality),
                };
                get().addTrackToPlaylist(track);
                if (!isPrefetch) {
                  get().playAtIndex(state.playlist.length); // Play the newly appended track
                }
              } else if (!isPrefetch) {
                get().stop();
              }
            } else if (!isPrefetch) {
               get().stop();
            }
          } catch (e) {
            console.error("Failed to fetch infinity track", e);
            if (!isPrefetch) get().stop();
          } finally {
            set({ isFetchingInfinity: false });
          }
        },

        fetchLibraryFromServer: async () => {
          // Dedup: a second caller (init + health poller) joins the in-flight request.
          if (inFlightLibraryFetch) return inFlightLibraryFetch;
          libraryFetchAbort?.abort();
          const ac = new AbortController();
          libraryFetchAbort = ac;
          set({ isLibraryLoading: true, libraryError: null });

          // Queue rehydration (replaces the old full-library load + reconcile):
          // the restored play queue may contain tracks deleted since last
          // session, and its stream URLs were built with a possibly-stale
          // token. Prune missing ids via a tiny existence check and rebuild
          // URLs from each track's path — no full track list needed.
          const reconcileQueue = (): Promise<void> => {
            if (inFlightTracksFetch) return inFlightTracksFetch;
            const p = (async () => {
            try {
              const queue = get().playlist;
              if (queue.length === 0) return;
              const ids = queue.map((t) => t.id);
              let existing = new Set<string>(ids);
              try {
                const authHeaders = (get() as any).getAuthHeader();
                const res = await fetch('/api/library/tracks/exists', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({ ids }),
                  signal: ac.signal,
                });
                if (res.ok) {
                  const data = await res.json();
                  if (Array.isArray(data.ids)) existing = new Set<string>(data.ids);
                }
              } catch (e) {
                if (isAbortError(e) || ac.signal.aborted) return;
                // On a network hiccup, keep the queue as-is rather than pruning.
              }

              const { mediaAccessToken, authToken, streamingQuality } = get();
              const token = mediaAccessToken || authToken || '';
              const quality = streamingQuality;

              set((state: PlayerState): Partial<PlayerState> => {
                const currentTrack = state.currentIndex !== null ? state.playlist[state.currentIndex] : null;
                const nextQueue = state.playlist
                  .filter((t) => existing.has(t.id))
                  .map((t) => (t.path ? { ...t, ...buildTrackUrls(t.id, t.path, token, quality, (t as any).artHash) } : t));
                let nextIndex = state.currentIndex;
                if (currentTrack) {
                  if (!existing.has(currentTrack.id)) {
                    playbackManager.stop();
                    nextIndex = null;
                  } else {
                    const remapped = nextQueue.findIndex((t) => t.id === currentTrack.id);
                    nextIndex = remapped >= 0 ? remapped : null;
                  }
                }
                return { playlist: nextQueue, currentIndex: nextIndex };
              });
            } catch (e) {
              if (isAbortError(e) || ac.signal.aborted) return;
              console.error('Failed to reconcile queue', e);
            } finally {
              inFlightTracksFetch = null;
            }
            })();
            inFlightTracksFetch = p;
            return p;
          };

          const run = (async () => {
          try {
            const authHeaders = (get() as any).getAuthHeader();
            // Entity-first: these lightweight lists make the library views
            // interactive immediately, instead of waiting on the full track set.
            const [artistsRes, albumsRes, genresRes, dirsRes] = await Promise.all([
              fetch('/api/artists', { headers: authHeaders, signal: ac.signal }),
              fetch('/api/albums', { headers: authHeaders, signal: ac.signal }),
              fetch('/api/genres', { headers: authHeaders, signal: ac.signal }),
              fetch('/api/library/directories', { headers: authHeaders, signal: ac.signal }),
            ]);
            if (artistsRes.ok && albumsRes.ok && genresRes.ok) {
              const [artists, albums, genres, dirsData] = await Promise.all([
                artistsRes.json(),
                albumsRes.json(),
                genresRes.json(),
                dirsRes.ok ? dirsRes.json() : Promise.resolve({ directories: [] }),
              ]);
              set({
                artists: (artists || []) as ArtistInfo[],
                albums: (albums || []) as AlbumInfo[],
                genres: genres || [],
                libraryFolders: dirsData.directories || [],
                isLibraryLoading: false,
              });
              // Reconcile the restored play queue against the server (prune
              // deleted tracks, refresh stream URLs). Lightweight — no full
              // track list is loaded.
              void reconcileQueue();
            } else {
              const status = [artistsRes, albumsRes, genresRes].find(r => !r.ok)?.status;
              const msg = `Couldn't load your library (server returned ${status}).`;
              set({ isLibraryLoading: false, libraryError: msg });
              get().addToast(msg, 'error', { actionLabel: 'Retry', onAction: () => { void get().fetchLibraryFromServer(); } });
            }
          } catch (e) {
            // Aborted on logout — drop silently; don't surface an error or clear loading.
            if (isAbortError(e) || ac.signal.aborted) return;
            console.error("Failed to fetch library from server", e);
            const msg = "Couldn't reach the server to load your library.";
            set({ isLibraryLoading: false, libraryError: msg });
            get().addToast(msg, 'error', { actionLabel: 'Retry', onAction: () => { void get().fetchLibraryFromServer(); } });
          } finally {
            if (libraryFetchAbort === ac) libraryFetchAbort = null;
            inFlightLibraryFetch = null;
          }
          })();
          inFlightLibraryFetch = run;
          return run;
        },

        // On-demand: load the full track list into `library` for the admin
        // tools that still need per-track data (Genre Matrix, Library Entities).
        // The main app no longer loads this at boot. Deduped; no-op once present.
        ensureFullLibraryLoaded: async () => {
          if (get().library.length > 0) return;
          if (inFlightFullLibrary) return inFlightFullLibrary;
          const p = (async () => {
            try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch('/api/library/tracks', { headers: authHeaders });
              if (!res.ok) return;
              const data = await res.json();
              const { mediaAccessToken, authToken, streamingQuality } = get();
              const token = mediaAccessToken || authToken || '';
              const quality = streamingQuality;
              set({ library: (data.tracks || []).map((t: TrackInfo) => hydrateServerTrack(t, token, quality)) });
            } catch (e) {
              console.error('Failed to load full library on demand', e);
            } finally {
              inFlightFullLibrary = null;
            }
          })();
          inFlightFullLibrary = p;
          return p;
        },

        fetchPlaylistsFromServer: async () => {
           if (inFlightPlaylistsFetch) return inFlightPlaylistsFetch;
           playlistsFetchAbort?.abort();
           const ac = new AbortController();
           playlistsFetchAbort = ac;
           set({ isPlaylistsLoading: true, playlistsError: null });
           const run = (async () => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch('/api/playlists', { headers: authHeaders, signal: ac.signal });
              if (res.ok) {
                 const data = await res.json();

                 const { mediaAccessToken, authToken, library } = get();
                 const token = mediaAccessToken || authToken || '';

                 // Map track objects inside playlists to have full stream URLs
                 const populatedPlaylists = data.playlists.map((pl: any) => {
                    const mappedTracks = pl.tracks.map((t: any) => {
                       // Prefer library track (up-to-date art, etc.), fall back to API data
                       const fullTrack = library.find((lt: TrackInfo) => lt.id === t.id);
                       const track = fullTrack ? { ...t, ...fullTrack, playlistAddedAt: t.playlistAddedAt } : t;
                       if (!track.path) return null;
                       const quality = get().streamingQuality;
                       return {
                         ...track,
                         ...buildTrackUrls(track.id, track.path, token, quality, (track as any).artHash),
                       };
                    }).filter(Boolean);
                    return { ...pl, tracks: mappedTracks };
                 });

                 set({ playlists: populatedPlaylists });
              } else {
                 set({ playlistsError: `Couldn't load playlists (server returned ${res.status}).` });
              }
           } catch (e) {
              if (isAbortError(e) || ac.signal.aborted) return; // aborted on logout
              console.error("Failed to fetch playlists from server", e);
              set({ playlistsError: "Couldn't reach the server to load playlists." });
           } finally {
              if (!ac.signal.aborted) set({ isPlaylistsLoading: false });
              if (playlistsFetchAbort === ac) playlistsFetchAbort = null;
              inFlightPlaylistsFetch = null;
           }
           })();
           inFlightPlaylistsFetch = run;
           return run;
        },

        // Manual playlists owned by other users, for the discovery rail. Tracks
        // are hydrated with stream URLs the same way as own playlists so the
        // discovered playlists are immediately playable.
        fetchDiscoverPlaylists: async () => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch('/api/playlists/discover', { headers: authHeaders });
              if (!res.ok) return;
              const data = await res.json();

              const { mediaAccessToken, authToken, library } = get();
              const token = mediaAccessToken || authToken || '';

              const populated = (data.playlists || []).map((pl: any) => {
                 const mappedTracks = (pl.tracks || []).map((t: any) => {
                    const fullTrack = library.find((lt: TrackInfo) => lt.id === t.id);
                    const track = fullTrack ? { ...t, ...fullTrack, playlistAddedAt: t.playlistAddedAt } : t;
                    if (!track.path) return null;
                    const quality = get().streamingQuality;
                    return {
                      ...track,
                      ...buildTrackUrls(track.id, track.path, token, quality, (track as any).artHash),
                    };
                 }).filter(Boolean);
                 return { ...pl, tracks: mappedTracks };
              });

              set({ discoverPlaylists: populated });
           } catch (e) {
              console.error('Failed to fetch discoverable playlists', e);
           }
        },

        // Fetch a single playlist with its tracks and upsert it into the
        // playlists array. Avoids the cost of refetching every playlist when
        // the user opens just one. Returns false when the playlist is not
        // accessible (404 / unauthenticated / network failure).
        fetchPlaylistFromServer: async (playlistId: string) => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}`, { headers: authHeaders });
              if (!res.ok) return false;

              const data = await res.json();
              const pl = data.playlist;
              if (!pl) return false;

              const { mediaAccessToken, authToken, library, streamingQuality } = get();
              const token = mediaAccessToken || authToken || '';
              const quality = streamingQuality;

              const mappedTracks = (pl.tracks || []).map((t: any) => {
                 const fullTrack = library.find((lt: TrackInfo) => lt.id === t.id);
                 const track = fullTrack ? { ...t, ...fullTrack, playlistAddedAt: t.playlistAddedAt } : t;
                 if (!track.path) return null;
                 return {
                   ...track,
                   ...buildTrackUrls(track.id, track.path, token, quality, (track as any).artHash),
                 };
              }).filter(Boolean);

              const populated = { ...pl, tracks: mappedTracks };

              set((state) => {
                 const idx = state.playlists.findIndex((p) => p.id === pl.id);
                 if (idx === -1) return { playlists: [populated, ...state.playlists] };
                 const next = state.playlists.slice();
                 next[idx] = populated;
                 return { playlists: next };
              });
              return true;
           } catch (e) {
              console.error('Failed to fetch single playlist from server', e);
              return false;
           }
        },

        createPlaylist: async (title: string, description?: string) => {
           try {
              const authHeaders = (get() as any).getAuthHeader();
              const res = await fetch('/api/playlists', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json', ...authHeaders },
                 body: JSON.stringify({ title, description })
              });
              if (res.ok) {
                 // Server returns the created playlist ({ id, title, description,
                 // isLlmGenerated, tracks: [] }). Capture it before refetching so
                 // callers can navigate straight into the new (empty) playlist.
                 const created = await res.json().catch(() => null);
                 await get().fetchPlaylistsFromServer();
                 return created as Playlist | null;
              }
           } catch (e) {
               console.error("Failed to create playlist", e);
            }
            return null;
         },

         deletePlaylist: async (playlistId: string) => {
            try {
               const authHeaders = (get() as any).getAuthHeader();
               const res = await fetch(`/api/playlists/${playlistId}`, {
                  method: 'DELETE',
                  headers: authHeaders,
               });
               if (res.ok) {
                  set({ playlists: get().playlists.filter((p: Playlist) => p.id !== playlistId) });
               }
            } catch (e) {
               console.error("Failed to delete playlist", e);
            }
         },

         togglePin: async (playlistId: string, pinned: boolean) => {
            try {
               const authHeaders = (get() as any).getAuthHeader();
               const res = await fetch(`/api/playlists/${playlistId}/pin`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({ pinned })
               });
               if (res.ok) {
                  set({
                     playlists: get().playlists.map((p: Playlist) =>
                        p.id === playlistId ? { ...p, pinned } : p
                     )
                  });
               }
            } catch (e) {
               console.error("Failed to toggle pin", e);
            }
         },

         togglePlaylistPrivacy: async (playlistId: string, isPrivate: boolean) => {
            const previousPlaylists = get().playlists;
            set({
               playlists: previousPlaylists.map((p: Playlist) =>
                  p.id === playlistId ? { ...p, isPrivate } : p
               ),
            });
            try {
               const authHeaders = (get() as any).getAuthHeader();
               const res = await fetch(`/api/playlists/${playlistId}/privacy`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({ isPrivate }),
               });
               if (!res.ok) throw new Error(`Privacy update failed with status ${res.status}`);
            } catch (e) {
               set({ playlists: previousPlaylists });
               console.error('Failed to update playlist privacy', e);
               throw e;
            }
         },

         updatePlaylistMeta: async (playlistId: string, updates: { title?: string; description?: string }) => {
            const previousPlaylists = get().playlists;
            const target = previousPlaylists.find((p: Playlist) => p.id === playlistId);
            if (!target) return;

            // Optimistic local update; reverted if the server rejects.
            set({
               playlists: previousPlaylists.map((p: Playlist) =>
                  p.id === playlistId ? { ...p, ...updates } : p
               ),
            });

            try {
               const authHeaders = (get() as any).getAuthHeader();
               const res = await fetch(`/api/playlists/${playlistId}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify(updates),
               });
               if (!res.ok) throw new Error(`Playlist update failed with status ${res.status}`);
            } catch (e) {
               set({ playlists: previousPlaylists });
               console.error(`Failed to update playlist ${playlistId}`, e);
               throw e;
            }
         },

         replaceTracksInUserPlaylist: async (playlistId: string, trackIds: string[]) => {
           const nextTrackIds = dedupeTrackIds(trackIds);
           const previousPlaylists = get().playlists;
           const targetPlaylist = previousPlaylists.find((playlist) => playlist.id === playlistId);
           if (!targetPlaylist) return;

           const myGen = ++playlistMutationGeneration;

           const optimisticTracks = hydratePlaylistTracks(
             nextTrackIds,
             get().library,
             targetPlaylist.tracks,
             get().mediaAccessToken || get().authToken || '',
             get().streamingQuality
           );

           set({
             playlists: previousPlaylists.map((playlist) =>
               playlist.id === playlistId
                 ? { ...playlist, tracks: optimisticTracks }
                 : playlist
             ),
           });

           try {
             const authHeaders = (get() as any).getAuthHeader();
             const res = await fetch(`/api/playlists/${playlistId}/tracks`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json', ...authHeaders },
               body: JSON.stringify({ trackIds: nextTrackIds }),
             });

             if (!res.ok) {
               throw new Error(`Playlist update failed with status ${res.status}`);
             }

             // Only reconcile with the server if a newer optimistic mutation hasn't
             // superseded this one — otherwise the refetch would clobber it.
             if (myGen === playlistMutationGeneration) {
               await get().fetchPlaylistsFromServer();
             }
           } catch (e) {
             // Same guard for rollback: don't revert over a newer edit's state.
             if (myGen === playlistMutationGeneration) {
               set({ playlists: previousPlaylists });
             }
             console.error(`Failed to replace tracks in playlist ${playlistId}`, e);
             throw e;
           }
         },

         addTracksToUserPlaylist: async (playlistId: string, trackIds: string[]) => {
           const existingTrackIds = get().playlists
             .find((playlist) => playlist.id === playlistId)
             ?.tracks
             .map((track) => track.id) || [];

           const mergedTrackIds = dedupeTrackIds([...existingTrackIds, ...trackIds]);
           try {
             await get().replaceTracksInUserPlaylist(playlistId, mergedTrackIds);
           } catch (e) {
             console.error(`Failed to add tracks to playlist ${playlistId}`, e);
             throw e;
           }
        },

        addTracksToLibrary: (newTracks: TrackInfo[]) => set((state: PlayerState) => {
          const existingIds = new Set(state.library.map(t => t.id));
          const uniqueNew = newTracks.filter(t => !existingIds.has(t.id));
          if (uniqueNew.length === 0) return state;
          return { library: [...state.library, ...uniqueNew] };
        }),

        toggleTrackLove: async (track: TrackInfo) => {
          if (!track?.id) return;
          const nextLoved = !track.isLoved;
          const applyLoved = (isLoved: boolean) => set((state: PlayerState) => {
            const updateTrack = (candidate: TrackInfo) =>
              candidate.id === track.id ? { ...candidate, isLoved } : candidate;
            return {
              library: state.library.map(updateTrack),
              playlist: state.playlist.map(updateTrack),
              playlists: state.playlists.map((playlist) => ({
                ...playlist,
                tracks: playlist.tracks.map(updateTrack),
              })),
              contextMenu: state.contextMenu && state.contextMenu.track.id === track.id
                ? { ...state.contextMenu, track: { ...state.contextMenu.track, isLoved } }
                : state.contextMenu,
              // Lets server-fetched tracks (detail/search views, held in
              // component state) reflect the toggle immediately.
              lovedOverlay: { ...state.lovedOverlay, [track.id]: isLoved },
            };
          });

          applyLoved(nextLoved);

          try {
            const authHeaders = (get() as any).getAuthHeader();
            const res = await fetch('/api/library/love', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify({ trackId: track.id, loved: nextLoved }),
            });
            if (!res.ok) throw new Error(`Love update failed with status ${res.status}`);

            const data = await res.json().catch(() => null);
            const failedProviders = Array.isArray(data?.providers)
              ? data.providers.filter((provider: any) => provider.status === 'failed')
              : [];
            if (failedProviders.length > 0) {
              get().addToast('Saved locally; one provider sync failed', 'info');
            }
          } catch (error) {
            applyLoved(!!track.isLoved);
            get().addToast('Failed to update like', 'error');
            console.error('Failed to update loved track', error);
            throw error;
          }
        },

        addLibraryFolder: async (folderPath: string, options: AddLibraryFolderOptions = {}) => {
          const normalizedPath = folderPath.trim();
          if (!normalizedPath) {
            return { success: false, error: 'Enter an absolute directory path.' };
          }

          if (get().libraryFolders.includes(normalizedPath)) {
            if (options.scan !== false) await get().rescanLibrary(normalizedPath);
            return { success: true };
          }

          try {
            const authHeaders = get().getAuthHeader();
            const response = await fetch('/api/library/add', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify({ path: normalizedPath })
            });
            if (!response.ok) {
              return {
                success: false,
                error: await getResponseError(response, 'Failed to add the directory.'),
              };
            }

            set((state: PlayerState) => ({
              libraryFolders: state.libraryFolders.includes(normalizedPath)
                ? state.libraryFolders
                : [...state.libraryFolders, normalizedPath],
            }));

            if (options.scan !== false) await get().rescanLibrary(normalizedPath);
            return { success: true };
          } catch (error) {
            console.error('Failed to add and scan folder', error);
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Network error while adding the directory.',
            };
          }
        },

        removeLibraryFolder: async (folderPath: string) => {
          set((state: PlayerState) => ({
            libraryFolders: state.libraryFolders.filter((f: string) => f !== folderPath)
          }));
          
          try {
            const authHeaders = (get() as any).getAuthHeader();
            await fetch('/api/library/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders },
              body: JSON.stringify({ path: folderPath })
            });
            await get().fetchLibraryFromServer();
          } catch (e) {
            console.error('Failed to remove folder from backend', e);
          }
        },

        rescanLibrary: async (specificFolder?: string) => {
          const state = get();

          const foldersToScan = specificFolder ? [specificFolder] : state.libraryFolders;

          // Trigger scans sequentially with backoff
          for (const folderPath of foldersToScan) {
            let scanStarted = false;
            while (!scanStarted) {
              try {
                const authHeaders = (get() as any).getAuthHeader();
                const res = await fetch('/api/library/scan', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: JSON.stringify({ path: folderPath })
                });
                
                if (res.status === 400) {
                  const errorData = await res.json();
                  if (errorData.error === 'Scan already in progress') {
                    // Wait if the backend is busy with another directory's scan
                    await new Promise(r => setTimeout(r, 1000));
                  } else {
                    console.error('Scan error:', errorData.error);
                    scanStarted = true; // other 400 error, skip
                  }
                } else if (!res.ok) {
                  console.error('Scan error:', res.statusText);
                  scanStarted = true; // other error, skip
                } else {
                  scanStarted = true; // Success
                }
              } catch (e) {
                console.error(`Failed to trigger scan for ${folderPath}`, e);
                scanStarted = true;
              }
            }
          }

          // Fetch the final library to reflect the new tracks
          try {
            const authHeaders = (get() as any).getAuthHeader();
            const fetchRes = await fetch('/api/library', { headers: authHeaders });
            if (fetchRes.ok) {
              const data = await fetchRes.json();
              
              const { mediaAccessToken, authToken, streamingQuality } = get();
              const token = mediaAccessToken || authToken || '';
              const quality = streamingQuality;

              const latestLibrary = data.tracks.map((t: TrackInfo) => hydrateServerTrack(t, token, quality));
              set({
                library: latestLibrary,
                 artists: data.artists || [] as ArtistInfo[],
                 albums: data.albums || [] as AlbumInfo[],
                genres: data.genres || []
              });
            }
          } catch (e) {
            console.error('Failed to fetch updated library', e);
          }
        },

        setPlaylist: async (playlist: TrackInfo[], startIndex: number = 0, source: QueueSource | null = null) => {
          const queuePlaylist = playlist.map((track) => cloneTrackForQueue(track));
          set({ playlist: queuePlaylist, currentIndex: startIndex, queueSource: source });
          persistContinuitySnapshot(true);
          if (queuePlaylist.length > 0 && startIndex < queuePlaylist.length) {
            await get().playAtIndex(startIndex);
          } else {
            get().stop();
          }
        },

        setLastOpenedAlbum: (album: LastOpenedAlbum | null) => set({ lastOpenedAlbum: album }),

        addTrackToPlaylist: (track: TrackInfo, options?: QueueMutationOptions) => set((state: PlayerState) => {
          const snapshot = options?.undo ? state.playlist.map((item) => ({ ...item })) : null;
          const snapshotIndex = state.currentIndex;
          const queueTrack = cloneTrackForQueue(track);
          const nextPlaylist = [...state.playlist, queueTrack];
          if (castManager.isConnected()) {
            void castManager.appendToQueue(queueTrack);
          }
          prewarmNextFromState({ ...state, playlist: nextPlaylist });
          queueMicrotask(() => {
            persistContinuitySnapshot(true);
            if (options?.notify) {
              const title = queueTrack.title || queueTrack.path.split(/[\\/]/).pop() || 'track';
              get().addToast(options.message || `Added "${title}" to queue.`, 'success', options.undo && snapshot ? {
                actionLabel: 'Undo',
                onAction: () => get().restoreQueueSnapshot(snapshot, snapshotIndex),
                duration: 6500,
              } : undefined);
            }
          });
          return { playlist: nextPlaylist };
        }),

        playNext: (track: TrackInfo, options?: QueueMutationOptions) => set((state: PlayerState) => {
          const snapshot = options?.undo ? state.playlist.map((item) => ({ ...item })) : null;
          const snapshotIndex = state.currentIndex;
          const newPlaylist = [...state.playlist];
          const insertAt = state.currentIndex !== null ? state.currentIndex + 1 : newPlaylist.length;
          const queueTrack = cloneTrackForQueue(track);
          newPlaylist.splice(insertAt, 0, queueTrack);
          if (castManager.isConnected()) {
            void castManager.insertNextInQueue(queueTrack);
          }
          prewarmNextFromState({ ...state, playlist: newPlaylist });
          queueMicrotask(() => {
            persistContinuitySnapshot(true);
            if (options?.notify) {
              const title = queueTrack.title || queueTrack.path.split(/[\\/]/).pop() || 'track';
              get().addToast(options.message || `Will play "${title}" next.`, 'success', options.undo && snapshot ? {
                actionLabel: 'Undo',
                onAction: () => get().restoreQueueSnapshot(snapshot, snapshotIndex),
                duration: 6500,
              } : undefined);
            }
          });
          return { playlist: newPlaylist };
        }),

        // Global context menu
        contextMenu: null as { track: TrackInfo; x: number; y: number; playlistId?: string; playlistTrackIndex?: number } | null,
        openContextMenu: (track: TrackInfo, x: number, y: number, playlistId?: string, playlistTrackIndex?: number) => set({ contextMenu: { track, x, y, playlistId, playlistTrackIndex } }),
        closeContextMenu: () => set({ contextMenu: null }),

        removeFromPlaylist: (index: number) => set((state: PlayerState) => {
          const newPlaylist = [...state.playlist];
          const [removed] = newPlaylist.splice(index, 1);

          let newIndex = state.currentIndex;
          if (state.currentIndex === index) {
            if (castManager.isConnected()) {
              newIndex = state.currentIndex;
            } else {
              playbackManager.stop();
              newIndex = null;
            }
          } else if (state.currentIndex !== null && index < state.currentIndex) {
            newIndex = state.currentIndex - 1;
          }
          if (castManager.isConnected() && removed?.queueEntryId) {
            void castManager.removeFromQueue(removed.queueEntryId);
          }
          prewarmNextFromState({ ...state, playlist: newPlaylist, currentIndex: newIndex }, newIndex);
          queueMicrotask(() => persistContinuitySnapshot(true));
          return { playlist: newPlaylist, currentIndex: newIndex };
        }),

        moveInPlaylist: (fromIndex: number, toIndex: number) => set((state: PlayerState) => {
          const newPlaylist = [...state.playlist];
          const [moved] = newPlaylist.splice(fromIndex, 1);
          if (!moved) return state;
          newPlaylist.splice(toIndex, 0, moved);

          let newIndex = state.currentIndex;
          if (state.currentIndex !== null) {
            if (state.currentIndex === fromIndex) {
              newIndex = toIndex;
            } else {
              if (fromIndex < state.currentIndex && toIndex >= state.currentIndex) newIndex = state.currentIndex - 1;
              if (fromIndex > state.currentIndex && toIndex <= state.currentIndex) newIndex = state.currentIndex + 1;
            }
          }
          if (castManager.isConnected() && moved?.queueEntryId) {
            void castManager.moveQueueItem(moved.queueEntryId, toIndex);
          }

          prewarmNextFromState({ ...state, playlist: newPlaylist, currentIndex: newIndex }, newIndex);
          queueMicrotask(() => persistContinuitySnapshot(true));
          return { playlist: newPlaylist, currentIndex: newIndex };
        }),

        clearPlaylist: () => {
          playbackManager.stop();
          if (castManager.isConnected()) {
            castManager.stop();
          }
          setPlaybackTimeState({ currentTime: 0, duration: 0 });
          set({
            playlist: [],
            currentIndex: null,
            queueSource: null,
            playbackState: 'stopped',
            isBuffering: false,
          });
          persistContinuitySnapshot(true);
        },

        restoreQueueSnapshot: (playlist: TrackInfo[], currentIndex: number | null) => {
          const restored = ensureQueueEntryIds(playlist.map((track) => ({ ...track }))).tracks;
          const boundedIndex = currentIndex !== null && restored[currentIndex] ? currentIndex : (restored.length ? 0 : null);
          set({
            playlist: restored,
            currentIndex: boundedIndex,
          });
          prewarmNextFromState({ ...get(), playlist: restored, currentIndex: boundedIndex }, boundedIndex);
          persistContinuitySnapshot(true);

          if (castManager.isConnected() && boundedIndex !== null) {
            const { repeat } = get();
            void castManager.ensureQueuePlayback(
              restored.map((item) => ({
                queueEntryId: item.queueEntryId,
                url: item.url || '',
                rawUrl: item.rawUrl || '',
                title: item.title || 'Unknown Title',
                artist: item.artist || ((item.artists as string[])?.join(', ')) || 'Unknown Artist',
                artUrl: item.artUrl,
                album: item.album,
                format: item.format,
                duration: item.duration,
              })),
              boundedIndex,
              repeat
            );
          }
        },

        // Playback Actions
        playAtIndex: async (index: number) => {
          const { volume, repeat } = get();
          const normalized = ensureQueueEntryIds(get().playlist);
          const playlist = normalized.tracks;
          if (normalized.changed) {
            set({ playlist });
          }
          const track = playlist[index];
          if (!track) return;

          // Rebuild stream/raw/art URLs from the CURRENT media token rather than
          // trusting the persisted URL: the token may have rotated since the track
          // was queued (most visibly across an offline reload), in which case the
          // baked-in token fails auth — and because `url` is non-empty, the
          // fileHandle fallback below is skipped, so the track dies silently.
          // For server tracks (those with a base64 `path`) this also keeps the SW
          // cache key stable within a session. Local-only tracks (fileHandle, no
          // path) are left untouched.
          const { mediaAccessToken, authToken, streamingQuality } = get();
          const freshToken = mediaAccessToken || authToken || '';
          const freshQuality = streamingQuality;
          const playable: TrackInfo = track.path && freshToken
            ? { ...track, ...buildTrackUrls(track.id, track.path, freshToken, freshQuality, (track as any).artHash) }
            : track;

          const generation = ++playGeneration;

          // Immediately set the DB-known duration so the UI doesn't flash "0:10"
          // while waiting for hls.js to parse the full manifest.
          setPlaybackTimeState({ currentTime: 0, duration: track.duration || 0 });
          set({ isBuffering: true });

          try {
            // Set volume before playing
            playbackManager.setVolume(volume);

            if (castManager.isConnected()) {
              await castManager.ensureQueuePlayback(
                playlist.map((item) => {
                  // Rebuild stream/art URLs from the CURRENT token, exactly like
                  // the local `playable` above. The cast path previously used
                  // item.url verbatim, so a queue built without hydration (e.g.
                  // artist radio when the in-memory library is empty) or with a
                  // since-rotated token cast empty/stale URLs — the device then
                  // couldn't load the new queue and kept playing the old one,
                  // while local playback self-healed. Keep them symmetric.
                  const rebuilt = item.path && freshToken
                    ? { ...item, ...buildTrackUrls(item.id, item.path, freshToken, freshQuality, (item as any).artHash) }
                    : item;
                  return {
                    queueEntryId: item.queueEntryId,
                    url: rebuilt.url || '',
                    rawUrl: rebuilt.rawUrl || '',
                    title: item.title || 'Unknown Title',
                    artist: item.artist || ((item.artists as string[])?.join(', ')) || 'Unknown Artist',
                    artUrl: rebuilt.artUrl,
                    album: item.album,
                    format: item.format,
                    duration: item.duration,
                  };
                }),
                index,
                repeat
              );
            } else if (playable.url) {
              // Not casting: play locally — pass both HLS and raw URLs (rebuilt
              // with the current token above). Set loudness gain before playUrl so
              // a freshly-wired gain node initializes at the right value (no click).
              applyLoudnessForTrack(get, playable, generation);
              await playbackManager.playUrl(playable.url, playable.rawUrl || '', playable.title, playable.artist || ((playable.artists as string[])?.join(', ')), playable.artUrl, playable.album, playable.format);
            } else if (track.fileHandle) {
               // Fallback for local file handles
               await playbackManager.playFile(track.fileHandle);
            }
            // A newer playAtIndex call has taken over — discard this result
            if (generation !== playGeneration) return;
            set({ currentIndex: index, isBuffering: false, lastPlaybackActivityAt: Date.now(), _scrobbleStartAt: Date.now(), _scrobbleEligible: false });
            persistContinuitySnapshot(true);

            // Push to the rolling session history immediately so Infinity-mode
            // dedup (sent to /api/recommend) sees the track as soon as it starts.
            // The actual play-count is recorded later, once the listened
            // threshold is crossed (see onTimeUpdate → recordPlay).
            set((s: PlayerState) => ({ sessionHistoryTrackIds: [...s.sessionHistoryTrackIds, track.id].slice(-50) }));

            // Send "now playing" to scrobble providers if connected
            const state = get();
            if (track.artist && track.title) {
              const authHeaders = (get() as any).getAuthHeader();
              const nowPlayingBody = JSON.stringify({
                artist: track.artist,
                track: track.title,
                album: track.album || '',
                albumArtist: track.albumArtist || '',
                duration: track.duration ? Math.round(track.duration) : undefined,
                mbid: track.mbTrackId || '',
              });
              if (state.lastFmConnected && state.lastFmScrobbleEnabled) {
                fetch('/api/providers/lastfm/now-playing', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: nowPlayingBody,
                }).catch(() => {});
              }
              if (state.listenBrainzConnected && state.listenBrainzScrobbleEnabled) {
                fetch('/api/providers/listenbrainz/now-playing', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...authHeaders },
                  body: nowPlayingBody,
                }).catch(() => {});
              }
            }

            // Pre-fetch infinite track if bounds are reached
            get().ensureInfinityQueue();
            prewarmNextFromState(get(), index);
          } catch (e) {
            // A newer playAtIndex call has taken over — don't chain into nextTrack
            if (generation !== playGeneration) return;
            set({ isBuffering: false });
            console.error("Error playing track", e);
            get().nextTrack();
          }
        },

        pause: () => {
          playbackManager.pause();
          persistContinuitySnapshot(true);
        },

        resume: async () => {
          await playbackManager.resume();
          persistContinuitySnapshot(true);
        },

        stop: () => {
          playbackManager.stop();
          setPlaybackTimeState({ currentTime: 0, duration: 0 });
          set({ currentIndex: null, playbackState: 'stopped' });
          persistContinuitySnapshot(true);
        },

        nextTrack: async (options?: NextTrackOptions) => {
          const { playlist, currentIndex, shuffle } = get();
          if (playlist.length === 0) return;

          // Telemetry: record a skip for the track we are leaving — but only if
          // we left before it crossed the "played" threshold. Past that point
          // the track is already counted as a play, so a skip would contradict it.
          if (currentIndex !== null && playlist[currentIndex] && !get()._scrobbleEligible) {
            get().recordSkip(playlist[currentIndex].id);
          }

          let nextIndex = 0;
          if (shuffle) {
            nextIndex = Math.floor(Math.random() * playlist.length);
          } else if (currentIndex !== null) {
            nextIndex = (currentIndex + 1) % playlist.length;
          }

          if (options?.notifyUpNext && playlist.length > 1) {
            const upcoming = playlist[nextIndex];
            if (upcoming) {
              const title = upcoming.title || upcoming.path.split(/[\\/]/).pop() || 'track';
              get().addToast(`Up next: ${title}`, 'info', { duration: 3200 });
            }
          }

          await get().playAtIndex(nextIndex);
        },

        prevTrack: async () => {
          const { playlist, currentIndex } = get();
          const { currentTime } = getPlaybackTimeSnapshot();
          if (playlist.length === 0) return;

          // If we are more than 3 seconds in, just restart the track
          if (currentTime > 3 && currentIndex !== null) {
            playbackManager.seek(0);
            setPlaybackCurrentTime(0);
            persistContinuitySnapshot(true);
            return;
          }

          let prevIndex = playlist.length - 1;
          if (currentIndex !== null) {
            prevIndex = (currentIndex - 1 + playlist.length) % playlist.length;
          }

          await get().playAtIndex(prevIndex);
        },

        setVolume: (v: number) => {
          playbackManager.setVolume(v);
          set({ volume: v });
        },

        sleepTimerEndsAt: null,
        startSleepTimer: (minutes: number) => {
          clearSleepTimers();
          if (!minutes || minutes <= 0) {
            playbackManager.setVolume(get().volume); // undo any in-progress fade
            set({ sleepTimerEndsAt: null });
            return;
          }
          const totalMs = minutes * 60000;
          set({ sleepTimerEndsAt: Date.now() + totalMs });
          const fadeStartDelay = Math.max(0, totalMs - SLEEP_FADE_MS);
          sleepTimerTimeout = setTimeout(() => {
            const startVol = get().volume;
            const fadeStart = Date.now();
            sleepFadeInterval = setInterval(() => {
              const frac = Math.min(1, (Date.now() - fadeStart) / SLEEP_FADE_MS);
              playbackManager.setVolume(startVol * (1 - frac));
              if (frac >= 1) {
                clearSleepTimers();
                get().pause();
                playbackManager.setVolume(startVol); // restore for the next manual play
                set({ sleepTimerEndsAt: null });
                get().addToast('Sleep timer ended playback.', 'info');
              }
            }, 250);
          }, fadeStartDelay);
        },
        cancelSleepTimer: () => {
          clearSleepTimers();
          playbackManager.setVolume(get().volume); // restore if cancelled mid-fade
          set({ sleepTimerEndsAt: null });
        },

        selectAudioOutput: async () => {
          const state = get();
          if (state.castConnected) {
            state.addToast('Disconnect Cast before choosing a local output.', 'info');
            return;
          }

          const output = await playbackManager.selectAudioOutputDevice(undefined);
          if (output.error) {
            state.addToast(output.error, 'error');
          } else if (output.active) {
            state.addToast(`Playing on ${output.label || 'selected output'}.`, 'success');
          } else {
            state.addToast('Using system default audio output.', 'info');
          }
        },

        setAudioOutputDevice: async (deviceId: string) => {
          const state = get();
          if (state.castConnected) {
            state.addToast('Disconnect Cast before choosing a local output.', 'info');
            return;
          }

          const output = deviceId
            ? await playbackManager.selectAudioOutputDevice(deviceId)
            : await playbackManager.clearAudioOutputDevice();
          if (output.error) {
            state.addToast(output.error, 'error');
          } else if (output.active) {
            state.addToast(`Playing on ${output.label || 'selected output'}.`, 'success');
          } else {
            state.addToast('Using system default audio output.', 'info');
          }
        },

        ensureAudioOutputAccess: async () => {
          // Denials/errors render inline in the Output settings tab — no toasts.
          await audioOutputManager.ensureDeviceAccess();
        },

        toggleShuffle: () => set((state: PlayerState) => ({ shuffle: !state.shuffle })),

        cycleRepeat: () => set((state: PlayerState) => {
          const nextMode = state.repeat === 'none' ? 'all' : state.repeat === 'all' ? 'one' : 'none';
          if (castManager.isConnected()) {
            void castManager.setRepeatMode(nextMode);
          }
          return { repeat: nextMode };
        }),

        setCastConnected: (connected: boolean) => set({ castConnected: connected }),

        syncTimeUpdate: (time: number) => setPlaybackCurrentTime(time),
        syncDuration: (duration: number) => setPlaybackDuration(duration),
        syncPlaybackState: (state: PlaybackState) => set({ playbackState: state }),
        recordPlaybackTelemetry: (telemetry: Partial<PlaybackTelemetry>) => set((state: PlayerState) => ({
          playbackTelemetry: {
            ...state.playbackTelemetry,
            ...telemetry,
            lastUpdatedAt: Date.now(),
          },
        })),
        
        setLastFmApiKey: (key: string) => set({ lastFmApiKey: key }),
        setLastFmSharedSecret: (secret: string) => set({ lastFmSharedSecret: secret }),
        setLastFmScrobbleEnabled: (enabled: boolean) => set({ lastFmScrobbleEnabled: enabled }),
        setLastFmConnected: (connected: boolean) => set({ lastFmConnected: connected }),
        setLastFmUsername: (username: string) => set({ lastFmUsername: username }),
        setListenBrainzScrobbleEnabled: (enabled: boolean) => set({ listenBrainzScrobbleEnabled: enabled }),
        setListenBrainzConnected: (connected: boolean) => set({ listenBrainzConnected: connected }),
        setListenBrainzUsername: (username: string) => set({ listenBrainzUsername: username }),
        setSubsonicProviderScrobbleEnabled: (enabled: boolean) => set({ subsonicProviderScrobbleEnabled: enabled }),
        setGeniusApiKey: (key: string) => set({ geniusApiKey: key }),
        setMusicBrainzEnabled: (enabled: boolean) => set({ musicBrainzEnabled: enabled }),
        setMusicBrainzClientId: (id: string) => set({ musicBrainzClientId: id }),
        setMusicBrainzClientSecret: (secret: string) => set({ musicBrainzClientSecret: secret }),
        setMusicBrainzConnected: (connected: boolean) => set({ musicBrainzConnected: connected }),
        setMusicBrainzRedirectUri: (uri: string) => set({ musicBrainzRedirectUri: uri }),
        setProviderArtistImage: (provider: 'lastfm' | 'genius' | 'musicbrainz') => set({ providerArtistImage: provider }),
        setProviderArtistArtwork: (provider: 'genius' | 'none') => set({ providerArtistArtwork: provider }),
        setProviderArtistBio: (provider: 'lastfm' | 'genius') => set({ providerArtistBio: provider }),
        setProviderAlbumArt: (provider: 'lastfm' | 'genius' | 'musicbrainz') => set({ providerAlbumArt: provider }),
        setLlmConnected: (connected: boolean) => set({ llmConnected: connected }),

        recordPlay: (trackId: string) => {
          // Backend play-count telemetry. Fired once a track crosses the
          // configured "played" threshold (see onTimeUpdate). The rolling
          // session history is pushed separately at playback start so
          // Infinity-mode dedup doesn't have to wait for the threshold.
          const authHeaders = (get() as any).getAuthHeader();
          fetch('/api/playback/record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ trackId })
          }).catch((e: Error) => console.warn('Telemetry record failed:', e));
        },

        recordSkip: (trackId: string) => {
          // Fire-and-forget telemetry to backend
          const authHeaders = (get() as any).getAuthHeader();
          fetch('/api/playback/skip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({ trackId })
          }).catch((e: Error) => console.warn('Telemetry skip failed:', e));
        },

        toasts: [],
        addToast: (message: string, type: ToastType, options?: { actionLabel?: string; onAction?: () => void; duration?: number }) => {
          const id = Date.now();
          set((state: PlayerState) => ({
            toasts: [...state.toasts, {
              id,
              message,
              type,
              duration: options?.duration,
              actionLabel: options?.actionLabel,
              onAction: options?.onAction,
            }]
          }));
        },
        removeToast: (id: number) => {
          set((state: PlayerState) => ({
            toasts: state.toasts.filter(t => t.id !== id)
          }));
        },

        pendingUpdate: false,
        setPendingUpdate: (val: boolean) => {
          set({ pendingUpdate: val } as Partial<PlayerState>);
        },

        autoplayBlocked: false,
        setAutoplayBlocked: (val: boolean) => {
          set({ autoplayBlocked: val } as Partial<PlayerState>);
        },
      };
    },
    {
      name: "player-store",
      // Only persist lightweight user settings, NOT the library.
      // The library is always fetched fresh from the server on boot.
      partialize: (state: PlayerState) => ({
        volume: state.volume,
        shuffle: state.shuffle,
        repeat: state.repeat,
        theme: state.theme,
        reducedMotion: state.reducedMotion,
        mobileVideoBackgrounds: state.mobileVideoBackgrounds,
        lastFmApiKey: state.lastFmApiKey,
        lastFmScrobbleEnabled: state.lastFmScrobbleEnabled,
        lastFmConnected: state.lastFmConnected,
        lastFmUsername: state.lastFmUsername,
        listenBrainzScrobbleEnabled: state.listenBrainzScrobbleEnabled,
        listenBrainzConnected: state.listenBrainzConnected,
        listenBrainzUsername: state.listenBrainzUsername,
        subsonicProviderScrobbleEnabled: state.subsonicProviderScrobbleEnabled,
        geniusApiKey: state.geniusApiKey,
        musicBrainzEnabled: state.musicBrainzEnabled,
        musicBrainzClientId: state.musicBrainzClientId,
        musicBrainzClientSecret: state.musicBrainzClientSecret,
        musicBrainzConnected: state.musicBrainzConnected,
        musicBrainzRedirectUri: state.musicBrainzRedirectUri,
        llmConnected: state.llmConnected,
        providerArtistImage: state.providerArtistImage,
        providerArtistArtwork: state.providerArtistArtwork,
        providerArtistBio: state.providerArtistBio,
        providerAlbumArt: state.providerAlbumArt,
        rememberDevice: state.rememberDevice,
        // Without "Remember me on this device", auth stays out of localStorage —
        // the session lives in sessionStorage instead (see utils/sessionAuth.ts).
        ...(state.rememberDevice ? {
          authToken: state.authToken,
          mediaAccessToken: state.mediaAccessToken,
          sseAccessToken: state.sseAccessToken,
          currentUser: state.currentUser,
        } : {}),
        streamingQuality: state.streamingQuality,
        playbackDebugLogging: state.playbackDebugLogging,
        prebufferPolicy: state.prebufferPolicy,
        // Persisted locally too (though server-synced) so normalization applies
        // instantly on reload, before loadSettings round-trips.
        loudnessNormEnabled: state.loudnessNormEnabled,
        loudnessTargetLufs: state.loudnessTargetLufs,
        loudnessPreampDb: state.loudnessPreampDb,
        loudnessMode: state.loudnessMode,
        audioOutputDeviceId: state.audioOutputDeviceId,
        audioOutputDeviceLabel: state.audioOutputDeviceLabel,
        // Persist playlist and stable playback state; resume position is handled by the throttled continuity snapshot.
        playlist: state.playlist ? state.playlist.map((t: TrackInfo) => {
          const { fileHandle, ...rest } = t;
          return rest;
        }) : [],
        currentIndex: state.currentIndex,
        queueSource: state.queueSource,
        resumeStalenessDays: state.resumeStalenessDays,
        lastPlaybackActivityAt: state.lastPlaybackActivityAt,
        lastOpenedAlbum: state.lastOpenedAlbum,
        playbackState: state.playbackState,
      }),
      onRehydrateStorage: () => (state) => {
        setPlaybackDebugLogging(state?.playbackDebugLogging === true);
        castManager.setDiagnosticsVerbose(state?.playbackDebugLogging === true);
        // A freshly-loaded page has no audio playing — the persisted 'playing'
        // state would otherwise show a zombie play/pause UI and make
        // restoreFromContinuitySnapshot() bail (it skips when state is already
        // 'playing'). Coerce to 'paused'; restore then loads + seeks the track
        // so the next gesture resumes from the saved position, not 0:00.
        if (state && state.playbackState === 'playing') {
          state.playbackState = 'paused';
        }
        // Session-only sign-in: localStorage holds no tokens, but a same-tab
        // refresh should keep the session — restore it from sessionStorage.
        if (state && !state.authToken) {
          const sessionAuth = readSessionAuth();
          if (sessionAuth) {
            state.authToken = sessionAuth.authToken;
            state.mediaAccessToken = sessionAuth.mediaAccessToken;
            state.sseAccessToken = sessionAuth.sseAccessToken;
            state.currentUser = sessionAuth.currentUser;
          }
        }
      },
    }
  )
);

// Follow OS light/dark changes live while the theme preference is 'system'.
// Attached once at module scope; setTheme re-resolves against matchMedia.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const state = usePlayerStore.getState();
    if (state.theme === 'system') {
      state.setTheme('system');
    }
  });
}
