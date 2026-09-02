import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { Play, Pin, PinOff, Disc3, Sparkles, Wand2, Radio, Repeat, Rewind, Sunrise, Sun, Moon, Sunset, User2, ListMusic, Loader2 } from 'lucide-react';
import type { TrackInfo } from '../utils/fileSystem';
import type { Playlist, LastOpenedAlbum } from '../store';
import { useDominantColor } from '../hooks/useDominantColor';
import { buildRolledCoverGradient } from '../utils/coverGradient';
import { AuroraCover, wrappedCoverLabel, systemGenreCoverLabel, systemDecadeCoverLabel } from './library/AuroraCover';
import { LiveConcertsHubSection } from './LiveConcertsHubSection';
import { HorizontalScrollRail } from './HorizontalScrollRail';
import { NowPlayingBadge } from './now-playing/NowPlayingBadge';
import { useResumeContext, useNowPlayingState } from '../hooks/useNowPlaying';
import { prefetchAlbumDetail, prefetchArtistDetail, prefetchPlaylistDetail } from '../utils/routePrefetch';
import type { AlbumHeroState, ArtistHeroState, PlaylistHeroState } from '../utils/heroState';

function getTimeAwareWordmark(now: Date = new Date()): string {
  const hour = now.getHours();
  const day = now.toLocaleDateString(undefined, { weekday: 'long' }).toLowerCase();
  if (hour < 5) return 'late night';
  if (hour < 11) return `${day} morning`;
  if (hour < 14) return `${day} midday`;
  if (hour < 18) return `${day} afternoon`;
  if (hour < 22) return `${day} evening`;
  return `${day} night`;
}

type HubCollection = Partial<Playlist> & { tracks: TrackInfo[] };

const HUB_REFRESH_POLL_MS = 30_000;
const HUB_REFRESH_POLL_DURATION_MS = 2 * 60_000;
const HUB_SWAP_DURATION_MS = 180;

interface JumpTile {
  type: 'album' | 'playlist' | 'artist';
  id: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  lastPlayedAt: number;
}

interface ArtistRadioCandidate {
  artistId: string;
  artistName: string;
  imageUrl: string | null;
  recentPlays: number;
  withArtists: string[];
}

interface SmartBundle {
  jumpBackIn: JumpTile[];
  onRepeat: HubCollection | null;
  repeatRewind: HubCollection | null;
  daylist: HubCollection | null;
  artistRadios: ArtistRadioCandidate[];
  // Newest completed Wrapped snapshots (most recent finished year + season).
  // Surfaced as "uniquely yours" cards; older ones live in the Playlists
  // "Wrapped" rail. Frozen server-side once the period ends.
  wrappedYear: HubCollection | null;
  wrappedSeason: HubCollection | null;
  // Generated server-side; not rendered on the Hub today. The Time capsules
  // section is queued for redesign — see TASKS.md "Hub Distill Follow-Up".
  // Kept on the type so the data path is intact when the feature returns.
  seasonalRewind: HubCollection | null;
  yearRewind: HubCollection | null;
}

let hasPlayedHubCardIntro = false;

function getCollectionSignature(collection: HubCollection | null | undefined): string {
  if (!collection) return 'none';
  const trackIds = (collection.tracks || []).map((track) => track.id).join(',');
  return [
    collection.id || '',
    collection.title || '',
    collection.description || '',
    collection.createdAt || '',
    trackIds,
  ].join('|');
}

function getCollectionsSignature(collections: HubCollection[]): string {
  return collections.map(getCollectionSignature).join('||');
}

function getSmartBundleSignature(bundle: SmartBundle | null): string {
  if (!bundle) return 'none';
  const jumpBackIn = bundle.jumpBackIn
    .map((tile) => `${tile.type}:${tile.id}:${tile.title}:${tile.lastPlayedAt}`)
    .join(',');
  const radios = bundle.artistRadios
    .map((radio) => `${radio.artistId}:${radio.artistName}:${radio.imageUrl || ''}:${radio.withArtists.join('+')}`)
    .join(',');
  return [
    jumpBackIn,
    getCollectionSignature(bundle.daylist),
    getCollectionSignature(bundle.onRepeat),
    getCollectionSignature(bundle.repeatRewind),
    getCollectionSignature(bundle.seasonalRewind),
    getCollectionSignature(bundle.yearRewind),
    getCollectionSignature(bundle.wrappedYear),
    getCollectionSignature(bundle.wrappedSeason),
    radios,
  ].join('||');
}

const isCollectionListEmpty = (value: HubCollection[]) => value.length === 0;
const isSmartBundleEmpty = (value: SmartBundle | null) => !value;
type TileSwapPhase = 'idle' | 'out' | 'in';

function useCrossfadedValue<T>(
  value: T,
  signature: string,
  isEmpty: (value: T) => boolean
): { value: T; className: string } {
  const [displayValue, setDisplayValue] = useState(value);
  const [phase, setPhase] = useState<'idle' | 'out' | 'in'>('idle');
  const signatureRef = useRef(signature);
  const displayValueRef = useRef(value);
  const timeoutRef = useRef<number | null>(null);
  const setNextDisplayValue = (nextValue: T) => {
    displayValueRef.current = nextValue;
    setDisplayValue(nextValue);
  };

  useEffect(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (signatureRef.current === signature) {
      setNextDisplayValue(value);
      setPhase('idle');
      return;
    }

    if (isEmpty(displayValueRef.current)) {
      signatureRef.current = signature;
      setNextDisplayValue(value);
      setPhase('idle');
      return;
    }

    setPhase('out');
    timeoutRef.current = window.setTimeout(() => {
      signatureRef.current = signature;
      setNextDisplayValue(value);
      setPhase('in');
      timeoutRef.current = window.setTimeout(() => {
        setPhase('idle');
        timeoutRef.current = null;
      }, HUB_SWAP_DURATION_MS);
    }, HUB_SWAP_DURATION_MS);

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isEmpty, signature, value]);

  return {
    value: displayValue,
    className: phase === 'out' ? 'hub-swap-out' : phase === 'in' ? 'hub-swap-in' : '',
  };
}

function getTileMotionClassName(phase: TileSwapPhase): string {
  if (phase === 'out') return 'hub-tile-flip-out';
  if (phase === 'in') return 'hub-tile-flip-in';
  return '';
}

function getTileTextMotionClassName(phase: TileSwapPhase): string {
  if (phase === 'out') return 'hub-tile-text-out';
  if (phase === 'in') return 'hub-tile-text-in';
  return '';
}

interface AnimatedTileSlotProps<T> {
  value: T;
  signature: string;
  children: (value: T, phase: TileSwapPhase) => React.ReactNode;
}

function AnimatedTileSlot<T>({ value, signature, children }: AnimatedTileSlotProps<T>) {
  const [displayValue, setDisplayValue] = useState(value);
  const [phase, setPhase] = useState<TileSwapPhase>('idle');
  const signatureRef = useRef(signature);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (signatureRef.current === signature) {
      setDisplayValue(value);
      return;
    }

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    setPhase('out');
    timeoutRef.current = window.setTimeout(() => {
      signatureRef.current = signature;
      setDisplayValue(value);
      setPhase('in');
      timeoutRef.current = window.setTimeout(() => {
        setPhase('idle');
        timeoutRef.current = null;
      }, HUB_SWAP_DURATION_MS);
    }, HUB_SWAP_DURATION_MS);

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [signature, value]);

  return <>{children(displayValue, phase)}</>;
}

const HubCardSkeleton: React.FC = () => (
  <div className="p-4 sm:p-5 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-[var(--radius)] animate-pulse">
    <div className="flex items-center gap-2 mb-3">
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)]" />
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)] -ml-2" />
      <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)] -ml-2" />
    </div>
    <div className="h-5 w-3/4 rounded bg-[var(--color-surface-variant)] mb-2" />
    <div className="h-4 w-1/2 rounded bg-[var(--color-surface-variant)]" />
  </div>
);

const HubLoadingSkeleton: React.FC = () => (
  <div className="page-container space-y-8">
    <header>
      <div className="h-8 w-24 rounded bg-[var(--color-surface-variant)] animate-pulse" />
      <div className="h-4 w-48 rounded bg-[var(--color-surface-variant)] animate-pulse mt-2" />
    </header>

    <section>
      <div className="h-5 w-32 rounded bg-[var(--color-surface-variant)] animate-pulse mb-4" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-[64px] rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] overflow-hidden animate-pulse sm:h-[80px]"
          >
            <div className="h-full w-[56px] bg-[var(--color-surface-variant)] sm:w-[80px]" />
          </div>
        ))}
      </div>
    </section>

    <section>
      <div className="h-7 w-28 rounded bg-[var(--color-surface-variant)] animate-pulse mb-5" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5 lg:gap-6">
        {[1, 2, 3].map((i) => (
          <HubCardSkeleton key={i} />
        ))}
      </div>
    </section>

    <section>
      <div className="h-7 w-40 rounded bg-[var(--color-surface-variant)] animate-pulse mb-5" />
      <div className="flex gap-3 hide-scrollbar overflow-hidden sm:gap-5">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="w-[min(52vw,200px)] shrink-0 sm:w-[190px]">
            <div className="aspect-square rounded-[var(--radius)] bg-[var(--color-surface-variant)] animate-pulse" />
            <div className="h-4 w-4/5 rounded bg-[var(--color-surface-variant)] animate-pulse mt-3" />
            <div className="h-3 w-2/3 rounded bg-[var(--color-surface-variant)] animate-pulse mt-2" />
          </div>
        ))}
      </div>
    </section>
  </div>
);

const JumpBackInSectionSkeleton: React.FC = () => (
  <section aria-hidden="true">
    <div className="h-5 w-32 rounded bg-[var(--color-surface-variant)] animate-pulse mb-4" />
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-[64px] rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] overflow-hidden animate-pulse sm:h-[80px]"
        >
          <div className="h-full w-[56px] bg-[var(--color-surface-variant)] sm:w-[80px]" />
        </div>
      ))}
    </div>
  </section>
);

const UniqueYoursSectionSkeleton: React.FC = () => (
  <section aria-hidden="true">
    <div className="h-7 w-40 rounded bg-[var(--color-surface-variant)] animate-pulse mb-5" />
    <div className="flex overflow-x-auto snap-x snap-mandatory gap-3 hub-scroll-mobile hub-scroll-unique pb-1 sm:gap-5 sm:pb-2 hide-scrollbar">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="w-[min(52vw,200px)] shrink-0 snap-start sm:w-[190px]">
          <div className="aspect-square rounded-[var(--radius)] bg-[var(--color-surface-variant)] animate-pulse" />
          <div className="h-4 w-4/5 rounded bg-[var(--color-surface-variant)] animate-pulse mt-3" />
          <div className="h-3 w-2/3 rounded bg-[var(--color-surface-variant)] animate-pulse mt-2" />
        </div>
      ))}
    </div>
  </section>
);

const DiscoverSectionSkeleton: React.FC = () => (
  <section aria-hidden="true">
    <div className="h-7 w-32 rounded bg-[var(--color-surface-variant)] animate-pulse mb-5" />
    <div className="flex overflow-x-auto snap-x snap-mandatory gap-3 hub-scroll-mobile hub-scroll-unique pb-1 sm:gap-5 sm:pb-2 hide-scrollbar">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="w-[min(52vw,200px)] shrink-0 snap-start sm:w-[190px]">
          <div className="aspect-square rounded-[var(--radius)] bg-[var(--color-surface-variant)] animate-pulse" />
          <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)] animate-pulse mt-3" />
        </div>
      ))}
    </div>
  </section>
);

const ForYouSectionSkeleton: React.FC = () => (
  <section aria-hidden="true">
    <div className="h-7 w-28 rounded bg-[var(--color-surface-variant)] animate-pulse mb-5" />
    <div className="flex sm:grid sm:grid-cols-2 lg:grid-cols-3 overflow-x-auto snap-x snap-mandatory gap-4 sm:gap-5 lg:gap-6 hub-scroll-mobile hide-scrollbar">
      {[1, 2, 3].map((i) => (
        <HubCardSkeleton key={i} />
      ))}
    </div>
  </section>
);

interface HubCardProps {
  collection: HubCollection;
  onOpen: () => void;
  onPlay: () => void;
  onPinToggle?: () => void;
  animate?: boolean;
}

const HubCard: React.FC<HubCardProps> = ({ collection, onOpen, onPlay, onPinToggle, animate = false }) => {
  const { artUrls, bgColor, palette } = useDominantColor(collection.tracks);
  const hasCovers = artUrls.length > 0;
  const gradientSeed = `${collection.id || collection.title || 'hub'}:${collection.tracks.map((track) => track.id).join(',')}`;
  const rolledGradient = useMemo(
    () => buildRolledCoverGradient(gradientSeed, palette, bgColor),
    [bgColor, gradientSeed, palette]
  );

  return (
    <div
      className={`relative overflow-hidden p-4 sm:p-5 cursor-pointer group rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] backdrop-blur-sm transition-ui duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98] ${animate ? 'hub-card-animate' : ''}`}
      onClick={onOpen}
      onPointerEnter={prefetchPlaylistDetail}
      onPointerDown={prefetchPlaylistDetail}
      onFocus={prefetchPlaylistDetail}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`play ${collection.title || 'untitled playlist'}`}
    >
      {/* Single decorative layer: the rolled aurora gradient. The earlier
          stack of (gradient + white/65 wash + diagonal shimmer) was three
          decorative layers behind the content — see design.md §4: glass max
          two deep, never opaque-fill. The card root carries the glass
          surface; this layer is the colour signal. */}
      <div
        className="absolute inset-0 rounded-[inherit] opacity-[0.55] transition-opacity duration-300 group-hover:opacity-75 pointer-events-none"
        style={{ background: rolledGradient }}
      />

      <div className="relative flex items-center mb-3">
        <div className="flex items-center">
          {hasCovers ? (
            artUrls.slice(0, 4).map((url, i) => (
              <img
                key={i}
                src={url}
                alt=""
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg shadow-sm object-cover transition-transform duration-200 group-hover:translate-x-1"
                style={{
                  marginLeft: i > 0 ? '-8px' : 0,
                  zIndex: 10 - i,
                }}
              />
            ))
          ) : (
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-surface-variant)] flex items-center justify-center">
              <Disc3 className="w-6 h-6 text-[var(--color-text-muted)] opacity-40" />
            </div>
          )}
        </div>
      </div>

      <div className="relative z-10">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-base sm:text-lg text-[var(--color-text-primary)] line-clamp-1 group-hover:text-[var(--color-primary)] transition-colors">
            {collection.title || 'untitled playlist'}
          </h3>
          {onPinToggle && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPinToggle();
              }}
              className="min-w-11 min-h-11 flex items-center justify-center rounded-lg p-2 -m-2 hover:bg-white/10 dark:hover:bg-white/5 transition-colors"
              aria-label={collection.pinned ? 'unpin playlist' : 'pin playlist'}
            >
              {collection.pinned ? (
                <Pin className="w-4 h-4 text-[var(--color-primary)]" />
              ) : (
                <PinOff className="w-4 h-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
              )}
            </button>
          )}
        </div>

        {collection.description && (
          <p className="text-sm text-[var(--color-text-secondary)] line-clamp-2 mt-1">
            {collection.description}
          </p>
        )}

        <p className="text-xs font-medium text-[var(--color-text-secondary)] mt-2">
          {collection.tracks.length} {collection.tracks.length === 1 ? 'track' : 'tracks'}
        </p>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
        className="btn-fab absolute bottom-4 right-4 w-11 h-11 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 z-20"
        aria-label="play"
      >
        <Play className="w-5 h-5 ml-0.5" fill="currentColor" />
      </button>
    </div>
  );
};

// ─── Jump Back In: compact mixed tile ─────────────────────────────────
interface JumpTileCardProps {
  tile: JumpTile;
  onActivate: (tile: JumpTile) => void;
  onPlay: (tile: JumpTile) => void;
  motionClassName?: string;
  textMotionClassName?: string;
}

// Distinct fallback identity per tile type when no artwork is available.
function getJumpTileFallback(type: JumpTile['type']): { gradient: string; Icon: React.FC<any> } {
  if (type === 'artist') {
    return { gradient: 'var(--gradient-jump-tile-artist)', Icon: User2 };
  }
  if (type === 'playlist') {
    return { gradient: 'var(--gradient-jump-tile-playlist)', Icon: ListMusic };
  }
  return { gradient: 'var(--gradient-jump-tile-album)', Icon: Disc3 };
}

const prefetchForTileType = (type: JumpTile['type']) => {
  if (type === 'playlist') prefetchPlaylistDetail();
  else if (type === 'artist') prefetchArtistDetail();
  else if (type === 'album') prefetchAlbumDetail();
};

const JumpTileCard: React.FC<JumpTileCardProps> = ({
  tile,
  onActivate,
  onPlay,
  motionClassName = '',
  textMotionClassName = '',
}) => {
  const fallback = getJumpTileFallback(tile.type);
  const FallbackIcon = fallback.Icon;
  const handlePrefetch = useCallback(() => prefetchForTileType(tile.type), [tile.type]);
  return (
    <div
      onClick={() => onActivate(tile)}
      onPointerEnter={handlePrefetch}
      onPointerDown={handlePrefetch}
      onFocus={handlePrefetch}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(tile);
        }
      }}
      className={`group relative flex h-[64px] cursor-pointer items-center gap-2 overflow-hidden rounded-[var(--radius)] border border-[var(--glass-border)] bg-[var(--glass-bg)] text-left backdrop-blur-sm transition-colors hover:bg-[var(--glass-bg-hover)] sm:h-[80px] sm:gap-3 ${motionClassName}`}
      aria-label={`open ${tile.title}`}
    >
      <div
        className="relative h-[64px] w-[56px] shrink-0 overflow-hidden sm:h-[80px] sm:w-[80px]"
      >
        {tile.imageUrl ? (
          <img src={tile.imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <>
            <div className="absolute inset-0" style={{ background: fallback.gradient }} />
            <FallbackIcon
              className="absolute inset-0 m-auto w-7 h-7 text-white/85 drop-shadow"
              strokeWidth={1.5}
            />
          </>
        )}
      </div>
      <div className={`min-w-0 flex-1 py-1 pr-2 sm:pr-3 ${textMotionClassName}`}>
        <span className="line-clamp-2 block text-xs font-semibold leading-tight text-[var(--color-text-primary)] transition-colors group-hover:text-[var(--color-primary)] sm:text-base">
          {tile.title}
        </span>
        {tile.type !== 'playlist' && tile.subtitle && (
          <span className="block text-[11px] text-[var(--color-text-muted)] line-clamp-1 mt-0.5">
            {tile.subtitle}
          </span>
        )}
      </div>
      {/* Play button — hover-only on desktop, hidden entirely on touch.
          All Hub rails stay navigation-first on touch; the Hub header
          resume row owns one-tap play for touch users. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onPlay(tile);
        }}
        className="btn-fab hidden [@media(hover:hover)]:inline-flex absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 z-10"
        aria-label={`play ${tile.title}`}
      >
        <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
      </button>
    </div>
  );
};

// ─── Unique Card: unified square-cover tile for "Uniquely yours" ──────
// Single shape for daylist / on-repeat / repeat-rewind / artist-radio,
// matching Spotify's row in screenshot 2. The cover treatment varies by
// kind, but the wrapper geometry stays consistent so the row reads as a
// single grid.
type UniqueCardKind =
  | 'daylist'
  | 'on-repeat'
  | 'repeat-rewind'
  | 'artist-radio'
  | 'genre-most-played'
  | 'genre-rediscovery'
  | 'decade'
  | 'decade-genre'
  | 'wrapped';

function getDaylistCover(): { gradient: string; Icon: React.FC<any> } {
  const h = new Date().getHours();
  if (h < 6) return { gradient: 'var(--gradient-daylist-late-night)', Icon: Moon };
  if (h < 11) return { gradient: 'var(--gradient-daylist-morning)', Icon: Sunrise };
  if (h < 16) return { gradient: 'var(--gradient-daylist-midday)', Icon: Sun };
  if (h < 19) return { gradient: 'var(--gradient-daylist-evening)', Icon: Sunset };
  return { gradient: 'var(--gradient-daylist-night)', Icon: Moon };
}

interface UniqueCardProps {
  kind: UniqueCardKind;
  title: string;
  subtitle?: string;
  /**
   * AuroraCover seed — pass the playlist id for families that also render
   * elsewhere (Wrapped: the Playlists rail and the detail hero both seed from
   * the id), so the same playlist gets the same shape on every surface. Falls
   * back to the title for Hub-only families.
   */
  seed?: string;
  imageUrl?: string | null;
  onClick: () => void;
  onPlay?: () => void;
  loading?: boolean;
  coverMotionClassName?: string;
  textMotionClassName?: string;
}

const UniqueCard: React.FC<UniqueCardProps> = ({
  kind,
  title,
  subtitle,
  seed,
  imageUrl,
  onClick,
  onPlay,
  loading = false,
  coverMotionClassName = '',
  textMotionClassName = '',
}) => {
  let coverContent: React.ReactNode;
  let badgeLabel: string;

  if (kind === 'daylist') {
    const { gradient, Icon } = getDaylistCover();
    coverContent = (
      <>
        <div className="absolute inset-0" style={{ background: gradient }} />
        <Icon className="absolute right-4 bottom-4 w-12 h-12 text-white/85 drop-shadow" strokeWidth={1.5} />
      </>
    );
    badgeLabel = 'daylist';
  } else if (kind === 'on-repeat') {
    coverContent = (
      <>
        <div className="absolute inset-0" style={{ background: 'var(--gradient-cover-on-repeat)' }} />
        <Repeat className="absolute right-4 bottom-4 w-12 h-12 text-white/85 drop-shadow" strokeWidth={1.5} />
      </>
    );
    badgeLabel = 'on repeat';
  } else if (kind === 'repeat-rewind') {
    coverContent = (
      <>
        <div className="absolute inset-0" style={{ background: 'var(--gradient-cover-rewind)' }} />
        <Rewind className="absolute right-4 bottom-4 w-12 h-12 text-white/85 drop-shadow" strokeWidth={1.5} />
      </>
    );
    badgeLabel = 'rewind';
  } else if (kind === 'artist-radio') {
    coverContent = imageUrl ? (
      <img src={imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
    ) : (
      <>
        <div className="absolute inset-0" style={{ background: 'var(--gradient-cover-artist-radio)' }} />
        <Radio className="absolute right-4 bottom-4 w-12 h-12 text-white/70 drop-shadow" strokeWidth={1.5} />
      </>
    );
    badgeLabel = 'radio';
  } else if (kind === 'genre-most-played') {
    coverContent = <AuroraCover variant="favourites" seed={title} label={systemGenreCoverLabel(title)} />;
    badgeLabel = 'most played';
  } else if (kind === 'genre-rediscovery') {
    coverContent = <AuroraCover variant="rediscover" seed={title} label={systemGenreCoverLabel(title)} />;
    badgeLabel = 'rediscover';
  } else if (kind === 'decade') {
    coverContent = <AuroraCover variant="decade" seed={title} label={systemDecadeCoverLabel(title)} />;
    badgeLabel = 'decade';
  } else if (kind === 'wrapped') {
    coverContent = (
      <AuroraCover variant="wrapped" seed={seed || title} title={title} label={wrappedCoverLabel(title) || undefined} />
    );
    badgeLabel = 'wrapped';
  } else {
    coverContent = <AuroraCover variant="decade" seed={title} label={systemDecadeCoverLabel(title)} />;
    badgeLabel = 'decade';
  }

  return (
    <div
      onClick={onClick}
      onPointerEnter={prefetchPlaylistDetail}
      onPointerDown={prefetchPlaylistDetail}
      onFocus={prefetchPlaylistDetail}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-disabled={loading}
      className={`group relative flex w-[min(52vw,200px)] shrink-0 snap-start flex-col gap-2.5 cursor-pointer transition-ui duration-200 hover:-translate-y-0.5 sm:w-[190px] sm:gap-3 ${loading ? 'opacity-60 pointer-events-none' : ''}`}
      aria-label={`open ${title}`}
    >
      <div
        className={`relative w-full aspect-square rounded-[var(--radius)] overflow-hidden shadow-md ring-1 ring-black/10 ${coverMotionClassName}`}
      >
        {coverContent}
        <span className="absolute top-2.5 left-2.5 text-[10px] font-bold uppercase tracking-[0.15em] text-white/95 bg-black/35 backdrop-blur-sm px-2 py-0.5 rounded-full">
          {badgeLabel}
        </span>
        {loading && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
            <Loader2 className="h-7 w-7 animate-spin text-white drop-shadow" />
          </div>
        )}
        {onPlay && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
            className="btn-fab absolute bottom-3 left-3 w-10 h-10 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 z-20"
            aria-label="play"
          >
            <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
          </button>
        )}
      </div>
      <div className={`px-0.5 ${textMotionClassName}`}>
        <p className="font-semibold text-sm text-[var(--color-text-primary)] line-clamp-2 leading-tight group-hover:text-[var(--color-primary)] transition-colors">
          {title}
        </p>
        {subtitle && (
          <p className="mt-1 line-clamp-2 text-xs leading-snug text-[var(--color-text-muted)]">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
};

interface HubHeaderProps {
  wordmark: string;
  resumeContext: ReturnType<typeof useResumeContext>;
  playbackState: 'playing' | 'paused' | 'stopped';
  onResume: (index: number) => void;
  onNavigateToSource: (track: TrackInfo) => void;
  lastOpenedAlbum?: LastOpenedAlbum | null;
  onOpenLastAlbum?: () => void;
  onRefresh?: () => void;
  isRefreshing: boolean;
}

const HubHeader: React.FC<HubHeaderProps> = ({
  wordmark,
  resumeContext,
  playbackState,
  onResume,
  onNavigateToSource,
  lastOpenedAlbum,
  onOpenLastAlbum,
  onRefresh,
  isRefreshing,
}) => {
  const isCurrentlyPlaying = playbackState === 'playing' || playbackState === 'paused';
  const showResumeRow = resumeContext !== null;
  // No fresh resumable queue → offer the last album the user was browsing.
  const showFallback = !showResumeRow && !!lastOpenedAlbum;
  const headerActive = showResumeRow || showFallback;
  const ambientArt = showResumeRow
    ? resumeContext?.track.artUrl
    : (showFallback ? lastOpenedAlbum?.artUrl : undefined);

  const handleResumeClick = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation();
      if (resumeContext) onResume(resumeContext.index);
    },
    [resumeContext, onResume],
  );

  const handleRowClick = useCallback(() => {
    if (resumeContext) onNavigateToSource(resumeContext.track);
  }, [resumeContext, onNavigateToSource]);

  return (
    <header className={`hub-header ${headerActive ? 'hub-header--active' : 'hub-header--idle'}`}>
      <div className="hub-header-atmosphere" aria-hidden="true">
        {headerActive && ambientArt && (
          <img
            src={ambientArt}
            alt=""
            className="hub-header-ambient-art"
          />
        )}
      </div>

      <div className="hub-header-content">
        <div className="hub-header-topline">
          <div className="hub-header-copy">
            <h1 className="hub-header-title">
              {wordmark}
            </h1>
          </div>
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={isRefreshing}
              className="btn btn-ghost btn-sm hub-header-refresh"
              aria-label="refresh hub"
              title="refresh hub"
            >
              {isRefreshing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wand2 className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">refresh</span>
            </button>
          )}
        </div>

        {showResumeRow && resumeContext && (
          <HubResumeRow
            track={resumeContext.track}
            remaining={resumeContext.remaining}
            isPlaying={isCurrentlyPlaying}
            playbackState={playbackState}
            onPlay={handleResumeClick}
            onNavigate={handleRowClick}
          />
        )}
        {showFallback && lastOpenedAlbum && onOpenLastAlbum && (
          <HubLastAlbumRow album={lastOpenedAlbum} onOpen={onOpenLastAlbum} />
        )}
      </div>
    </header>
  );
};

interface HubLastAlbumRowProps {
  album: LastOpenedAlbum;
  onOpen: () => void;
}

const HubLastAlbumRow: React.FC<HubLastAlbumRowProps> = ({ album, onOpen }) => {
  const handleRowKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleRowKey}
      className="hub-resume-row group"
    >
      <div className="hub-resume-art">
        {album.artUrl ? (
          <img
            src={album.artUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Disc3 className="w-7 h-7 text-[var(--color-text-muted)] opacity-40" />
          </div>
        )}
      </div>

      <div className="hub-resume-copy">
        <div className="hub-resume-status">
          <span className="hub-resume-label">jump back in</span>
        </div>
        <div className="hub-resume-title">
          <span>{album.title}</span>
          {album.artist && <span className="hub-resume-artist">{album.artist}</span>}
        </div>
        <div className="hub-resume-meta">back to the album you were browsing</div>
      </div>
    </div>
  );
};

interface HubResumeRowProps {
  track: TrackInfo;
  remaining: number;
  isPlaying: boolean;
  playbackState: 'playing' | 'paused' | 'stopped';
  onPlay: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onNavigate: () => void;
}

const HubResumeRow: React.FC<HubResumeRowProps> = ({
  track,
  remaining,
  isPlaying,
  playbackState,
  onPlay,
  onNavigate,
}) => {
  const title = track.title || 'untitled';
  const artist = track.artist || 'unknown artist';
  const album = track.album;
  const remainingLabel =
    remaining === 0 ? 'last track in queue' : `${remaining} track${remaining === 1 ? '' : 's'} left`;

  const handleRowKey = (e: React.KeyboardEvent) => {
    // ARIA button pattern: both Enter and Space activate. Skip when the
    // event came from the nested play button (its own handler runs first
    // and stops propagation in handleResumeClick).
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onNavigate();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onNavigate}
      onKeyDown={handleRowKey}
      className="hub-resume-row group"
    >
      <div className="hub-resume-art">
        {track.artUrl ? (
          <img
            src={track.artUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Disc3 className="w-7 h-7 text-[var(--color-text-muted)] opacity-40" />
          </div>
        )}
      </div>

      <div className="hub-resume-copy">
        <div className="hub-resume-status">
          {isPlaying ? (
            <NowPlayingBadge
              state={playbackState === 'playing' ? 'playing' : 'paused'}
            />
          ) : (
            <span className="hub-resume-label">
              resume
            </span>
          )}
        </div>
        <div className="hub-resume-title">
          <span>{title}</span>
          <span className="hub-resume-artist">{artist}</span>
        </div>
        <div className="hub-resume-meta">
          {album ? `from ${album} · ` : ''}
          {remainingLabel}
        </div>
      </div>

      {!isPlaying && (
        <button
          onClick={onPlay}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              onPlay(e);
            }
          }}
          className="play-btn-main hub-resume-play"
          aria-label={`resume ${title} by ${artist}`}
          title="resume"
        >
          <Play className="w-5 h-5" fill="currentColor" />
        </button>
      )}
    </div>
  );
};

function getSystemUniqueCardKind(collection: HubCollection): UniqueCardKind {
  const id = collection.id || '';
  if (id.startsWith('engine_genre-most')) return 'genre-most-played';
  if (id.startsWith('engine_genre-stale')) return 'genre-rediscovery';
  if (id.startsWith('engine_decade-genre')) return 'decade-genre';
  if (id.startsWith('engine_decade')) return 'decade';
  return 'genre-most-played';
}

export const Hub: React.FC = () => {
  // Per-field selectors instead of `usePlayerStore()` (whole-store subscription),
  // which re-rendered this 1600-LOC component on every store mutation —
  // including currentIndex/isBuffering/playbackState changes during playback.
  const library = usePlayerStore((s) => s.library);
  const albums = usePlayerStore((s) => s.albums);
  const albumCount = usePlayerStore((s) => s.albums.length);
  const authToken = usePlayerStore((s) => s.authToken);
  const mediaAccessToken = usePlayerStore((s) => s.mediaAccessToken);
  const hydrateTracks = usePlayerStore((s) => s.hydrateTracks);
  // The library is "present" once the entity lists load (entity-first); Hub's
  // own data is server-side, so it shouldn't wait for the full track array.
  const hasLibrary = library.length > 0 || albumCount > 0;
  const setPlaylist = usePlayerStore((s) => s.setPlaylist);
  const getAuthHeader = usePlayerStore((s) => s.getAuthHeader);
  const togglePin = usePlayerStore((s) => s.togglePin);
  const currentUser = usePlayerStore((s) => s.currentUser);
  const fetchPlaylistsFromServer = usePlayerStore((s) => s.fetchPlaylistsFromServer);
  const playlists = usePlayerStore((s) => s.playlists);
  const playAtIndex = usePlayerStore((s) => s.playAtIndex);
  const llmBaseUrl = usePlayerStore((s) => s.llmBaseUrl);
  const llmModelName = usePlayerStore((s) => s.llmModelName);
  const llmConfigured = Boolean(llmBaseUrl && llmModelName);
  const resumeContext = useResumeContext();
  const lastOpenedAlbum = usePlayerStore((s) => s.lastOpenedAlbum);
  const playbackStateValue = useNowPlayingState();
  const wordmark = useMemo(() => getTimeAwareWordmark(), []);
  const navigate = useNavigate();
  const [collections, setCollections] = useState<HubCollection[]>([]);
  const [smartBundle, setSmartBundle] = useState<SmartBundle | null>(null);
  const [radioLoadingId, setRadioLoadingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSmartLoading, setIsSmartLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [openingSmartPlaylistId, setOpeningSmartPlaylistId] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState('');
  const [hubFetchError, setHubFetchError] = useState('');
  const [smartBundleError, setSmartBundleError] = useState('');
  const [shouldAnimateCards] = useState(() => !hasPlayedHubCardIntro);
  const collectionsSignatureRef = useRef('');
  const smartBundleSignatureRef = useRef('');

  // Prefer the fully-hydrated library track when present; otherwise hydrate the
  // server-embedded track (build stream/art URLs) so Hub works and plays
  // correctly even before the background track list loads.
  const resolveTracks = useCallback((rawTracks: any[]): TrackInfo[] =>
    (rawTracks || [])
      .map((t: any) => library.find((lt) => lt.id === t.id) || hydrateTracks([t])[0])
      .filter(Boolean) as TrackInfo[], [library, hydrateTracks]);

  const fetchSmartBundle = useCallback(async (options: { background?: boolean } = {}) => {
    if (!options.background) setIsSmartLoading(true);
    try {
      const res = await fetch('/api/hub/smart', { headers: getAuthHeader() });
      if (!res.ok) return;
      const data = await res.json();
      const resolve = (raw: any) =>
        raw ? { ...raw, tracks: resolveTracks(raw.tracks) } : null;
      const orNull = (col: HubCollection | null) =>
        col && col.tracks.length > 0 ? col : null;
      const nextBundle = {
        jumpBackIn: data.jumpBackIn || [],
        onRepeat: orNull(resolve(data.onRepeat)),
        repeatRewind: orNull(resolve(data.repeatRewind)),
        daylist: orNull(resolve(data.daylist)),
        artistRadios: (data.artistRadios || []).map((c: any) => ({
          artistId: c.artistId,
          artistName: c.artistName,
          imageUrl: c.imageUrl ?? null,
          recentPlays: c.recentPlays ?? 0,
          withArtists: Array.isArray(c.withArtists) ? c.withArtists : [],
        })),
        seasonalRewind: orNull(resolve(data.seasonalRewind)),
        yearRewind: orNull(resolve(data.yearRewind)),
        wrappedYear: orNull(resolve(data.wrappedYear)),
        wrappedSeason: orNull(resolve(data.wrappedSeason)),
      };
      const nextSignature = getSmartBundleSignature(nextBundle);
      const didChange = smartBundleSignatureRef.current !== nextSignature;
      smartBundleSignatureRef.current = nextSignature;
      setSmartBundle((prev) => (getSmartBundleSignature(prev) === nextSignature ? prev : nextBundle));
      if (didChange) void fetchPlaylistsFromServer();
      setSmartBundleError('');
    } catch (e) {
      console.error('Failed to load smart hub', e);
      if (!options.background) setSmartBundleError('could not load your smart hub. check your connection and try again.');
    } finally {
      if (!options.background) setIsSmartLoading(false);
    }
  }, [fetchPlaylistsFromServer, getAuthHeader, resolveTracks]);

  const buildPlaylistHero = (collection: HubCollection | Playlist | null | undefined, backLabel = 'Back to Hub'): PlaylistHeroState | undefined => {
    if (!collection) return undefined;
    const tracks = collection.tracks || [];
    return {
      kind: 'playlist',
      title: collection.title || undefined,
      description: (collection as any).description || undefined,
      trackCount: tracks.length,
      artUrls: tracks.map((t) => t.artUrl).filter((u): u is string => !!u).slice(0, 4),
      isLlmGenerated: (collection as any).isLlmGenerated || false,
      isSystem: (collection as any).isSystem || false,
      pinned: (collection as any).pinned || false,
      backLabel,
    };
  };

  const handleJumpTile = (tile: JumpTile) => {
    const tileImage = resolveTileImage(tile);
    if (tile.type === 'playlist') {
      const pl = playlists.find((p) => p.id === tile.id);
      const artUrls = pl
        ? pl.tracks.map((t) => t.artUrl).filter((u): u is string => !!u).slice(0, 4)
        : (tileImage ? [tileImage] : []);
      const hero: PlaylistHeroState = {
        kind: 'playlist',
        title: tile.title,
        description: pl?.description || tile.subtitle || undefined,
        trackCount: pl?.tracks.length,
        artUrls,
        isLlmGenerated: pl?.isLlmGenerated || false,
        isSystem: pl?.isSystem || false,
        pinned: pl?.pinned || false,
        backLabel: 'Back to Hub',
      };
      navigate(`/playlists/${tile.id}`, { state: hero });
    } else if (tile.type === 'artist') {
      const hero: ArtistHeroState = {
        kind: 'artist',
        name: tile.title,
        imageUrl: tileImage || undefined,
        backLabel: 'Back to Hub',
      };
      navigate(`/library/artist/${tile.id}`, { state: hero });
    } else if (tile.type === 'album') {
      const hero: AlbumHeroState = {
        kind: 'album',
        title: tile.title,
        artist: tile.subtitle || undefined,
        artUrl: tileImage || undefined,
        backLabel: 'Back to Hub',
      };
      navigate(`/library/album/${encodeURIComponent(tile.id)}`, { state: hero });
    }
  };

  const handlePlayJumpTile = async (tile: JumpTile) => {
    let tracks: TrackInfo[] = [];
    if (tile.type === 'playlist') {
      const pl = playlists.find((p) => p.id === tile.id);
      tracks = pl?.tracks || [];
    } else if (tile.type === 'album' || tile.type === 'artist') {
      // Prefer the in-memory library; otherwise fetch the entity's tracks so
      // tiles play even before the background track list loads.
      tracks = library.filter((t: any) => (tile.type === 'album' ? t.albumId : t.artistId) === tile.id);
      if (tracks.length === 0) {
        try {
          const res = await fetch(`/api/${tile.type === 'album' ? 'albums' : 'artists'}/${encodeURIComponent(tile.id)}`, { headers: getAuthHeader() });
          if (res.ok) tracks = hydrateTracks((await res.json()).tracks || []);
        } catch { /* leave empty */ }
      }
      if (tile.type === 'album') {
        tracks = [...tracks].sort((a: any, b: any) => (a.discNumber || 0) - (b.discNumber || 0) || (a.trackNumber || 0) - (b.trackNumber || 0));
      }
    }
    if (tracks.length > 0) setPlaylist(tracks, 0);
  };

  // Server-side imageUrl is populated for artists (artists.image_url) but
  // null for albums/playlists. Fill in the gap from the local library /
  // playlist store, which carries embedded artwork from the audio files.
  const resolveTileImage = (tile: JumpTile): string | null => {
    if (tile.imageUrl) return tile.imageUrl;
    if (tile.type === 'album') {
      // The in-memory `library` track array is empty in the main app (loaded
      // on demand only), so resolve album art from the albums entity list via
      // its representative art_hash — the same local cover URL the Albums grid
      // uses. Fall back to a track's artUrl when the library happens to be loaded.
      const album = albums.find((a) => a.id === tile.id);
      if (album?.art_hash) {
        const token = mediaAccessToken || authToken || '';
        return `/api/art?hash=${album.art_hash}${token ? `&token=${token}` : ''}`;
      }
      const t = library.find((lt) => (lt as any).albumId === tile.id);
      return t?.artUrl ?? null;
    }
    if (tile.type === 'playlist') {
      const pl = playlists.find((p) => p.id === tile.id);
      const firstWithArt = pl?.tracks?.find((tr: any) => tr.artUrl);
      return firstWithArt?.artUrl ?? null;
    }
    if (tile.type === 'artist') {
      const t = library.find((lt) => (lt as any).artistId === tile.id);
      return t?.artUrl ?? null;
    }
    return null;
  };

  const handleOpenArtistRadio = async (candidate: ArtistRadioCandidate) => {
    if (radioLoadingId) return;
    setRadioLoadingId(candidate.artistId);
    try {
      const res = await fetch('/api/hub/artist-radio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ artistId: candidate.artistId }),
      });
      if (!res.ok) throw new Error('Failed to load artist radio');
      const { playlist } = await res.json();
      // Make the smart playlist visible to the playlist store before navigating
      await fetchPlaylistsFromServer();
      if (playlist?.id) {
        const fresh = usePlayerStore.getState().playlists.find((p) => p.id === playlist.id);
        navigate(`/playlists/${playlist.id}`, { state: buildPlaylistHero(fresh) });
      }
    } catch (e) {
      console.error('[Artist Radio] Failed', e);
    } finally {
      setRadioLoadingId(null);
    }
  };

  const fetchHubData = useCallback(async (options: { background?: boolean } = {}) => {
    if (!options.background) setIsLoading(true);
    try {
      const url = options.background ? '/api/hub?queueRefresh=false' : '/api/hub';
      const res = await fetch(url, { headers: getAuthHeader() });

      if (res.ok) {
        const data = await res.json();
        const mappedCollections = data.collections
          .map((col: any) => ({
            ...col,
            tracks: col.tracks
              .map((t: any) => library.find((lt) => lt.id === t.id) || hydrateTracks([t])[0])
              .filter(Boolean),
          }))
          .filter((col: any) => col.tracks.length > 0);

        const nextSignature = getCollectionsSignature(mappedCollections);
        const didChange = collectionsSignatureRef.current !== nextSignature;
        collectionsSignatureRef.current = nextSignature;
        setCollections((prev) => (getCollectionsSignature(prev) === nextSignature ? prev : mappedCollections));
        // System playlists are persisted server-side during the hub fetch.
        // Refresh the playlist store so PlaylistDetail can resolve them by ID.
        if (didChange) void fetchPlaylistsFromServer();
      }
      setHubFetchError('');
    } catch (e) {
      console.error('Failed to load hub data', e);
      if (!options.background) setHubFetchError('could not load hub. check your connection and try again.');
    } finally {
      if (!options.background) setIsLoading(false);
    }
  }, [fetchPlaylistsFromServer, getAuthHeader, library, hydrateTracks]);

  const handleOpenSmartPlaylist = async (collection: HubCollection | null | undefined) => {
    if (!collection?.id || openingSmartPlaylistId) return;

    setOpeningSmartPlaylistId(collection.id);
    try {
      const currentPlaylists = usePlayerStore.getState().playlists;
      if (!currentPlaylists.some((playlist) => playlist.id === collection.id)) {
        await fetchPlaylistsFromServer();
      }
      const fresh = usePlayerStore.getState().playlists.find((p) => p.id === collection.id) || collection;
      navigate(`/playlists/${collection.id}`, { state: buildPlaylistHero(fresh) });
    } finally {
      setOpeningSmartPlaylistId(null);
    }
  };

  const isInitialLoading = (isLoading || isSmartLoading) && collections.length === 0 && !smartBundle;

  useEffect(() => {
    if (hasLibrary) {
      fetchHubData();
      void fetchSmartBundle();
    } else {
      setIsLoading(false);
      setIsSmartLoading(false);
    }
  }, [fetchHubData, fetchSmartBundle, hasLibrary]);

  useEffect(() => {
    if (!hasLibrary || isInitialLoading) return;

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      if (Date.now() - startedAt > HUB_REFRESH_POLL_DURATION_MS) {
        window.clearInterval(interval);
        return;
      }
      void fetchHubData({ background: true });
      void fetchSmartBundle({ background: true });
    }, HUB_REFRESH_POLL_MS);

    return () => window.clearInterval(interval);
  }, [fetchHubData, fetchSmartBundle, hasLibrary, isInitialLoading]);

  useEffect(() => {
    if (shouldAnimateCards && !isLoading) hasPlayedHubCardIntro = true;
  }, [isLoading, shouldAnimateCards]);

  const handleGeneratePlaylists = async () => {
    setIsGenerating(true);
    setGenerationError('');
    try {
      const authHeaders = getAuthHeader();
      const res = await fetch('/api/hub/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate playlists.');
      }
      if (data.skipped) {
        throw new Error(data.reason || 'Playlist generation was skipped.');
      }
      if (typeof data.generated === 'number' && data.generated < 1) {
        throw new Error('No playlists were generated. Check your LLM configuration and genre mappings.');
      }
      await fetchHubData();
    } catch (e: any) {
      console.error('Failed to generate playlists', e);
      setGenerationError(e.message || 'Failed to generate playlists.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleTogglePin = (collectionId: string, pinned: boolean) => {
    togglePin(collectionId, pinned);
    setCollections((prev) =>
      prev.map((c) => (c.id === collectionId ? { ...c, pinned } : c))
    );
  };

  const handlePlayCollection = (tracks: TrackInfo[]) => {
    setPlaylist(tracks, 0);
  };

  const collectionSignature = useMemo(() => getCollectionsSignature(collections), [collections]);
  const smartBundleSignature = useMemo(() => getSmartBundleSignature(smartBundle), [smartBundle]);
  const { value: visibleCollections } = useCrossfadedValue(
    collections,
    collectionSignature,
    isCollectionListEmpty
  );
  const { value: visibleSmartBundle } = useCrossfadedValue(
    smartBundle,
    smartBundleSignature,
    isSmartBundleEmpty
  );
  const showSmartSkeletons = isSmartLoading && !visibleSmartBundle;

  const aiPlaylists = visibleCollections.filter((c) => c.isLlmGenerated);
  const systemCollections = visibleCollections.filter((c) => {
    if (c.isLlmGenerated) return false;
    const id = c.id || '';
    if (!c.isSystem && !id.startsWith('engine_')) return false;
    // Vault / Up Next / Jump Back are functional surfaces, not discovery —
    // they remain accessible via /playlists but no longer crowd the Hub.
    if (id.startsWith('engine_upnext')) return false;
    if (id.startsWith('engine_jumpback')) return false;
    if (id.startsWith('engine_vault')) return false;
    return true;
  });

  if (isInitialLoading) {
    return <HubLoadingSkeleton />;
  }

  return (
    <div className="page-container space-y-8">
      <HubHeader
        wordmark={wordmark}
        resumeContext={resumeContext}
        playbackState={playbackStateValue}
        onResume={(index) => { void playAtIndex(index); }}
        lastOpenedAlbum={lastOpenedAlbum}
        onOpenLastAlbum={lastOpenedAlbum ? () => {
          const hero: AlbumHeroState = {
            kind: 'album',
            title: lastOpenedAlbum.title,
            artist: lastOpenedAlbum.artist,
            artUrl: lastOpenedAlbum.artUrl,
            backLabel: 'Back to Hub',
          };
          navigate(`/library/album/${lastOpenedAlbum.id}`, { state: hero });
        } : undefined}
        onNavigateToSource={(track) => {
          if (track.albumId) {
            const hero: AlbumHeroState = {
              kind: 'album',
              title: track.album || undefined,
              artist: track.albumArtist || track.artist || undefined,
              artUrl: track.artUrl || undefined,
              backLabel: 'Back to Hub',
            };
            navigate(`/library/album/${track.albumId}`, { state: hero });
          } else if (track.artistId) {
            const hero: ArtistHeroState = {
              kind: 'artist',
              name: track.artist || undefined,
              imageUrl: track.artUrl || undefined,
              backLabel: 'Back to Hub',
            };
            navigate(`/library/artist/${track.artistId}`, { state: hero });
          }
        }}
        onRefresh={aiPlaylists.length > 0 ? handleGeneratePlaylists : undefined}
        isRefreshing={isGenerating}
      />

      {generationError && aiPlaylists.length > 0 && (
        <div className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm font-medium text-[var(--color-error)]">
          {generationError}
        </div>
      )}
      {(hubFetchError || smartBundleError) && (
        <div
          role="alert"
          className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm font-medium text-[var(--color-error)] flex items-center justify-between gap-3"
        >
          <span>{hubFetchError || smartBundleError}</span>
          <button
            onClick={() => {
              setHubFetchError('');
              setSmartBundleError('');
              if (hubFetchError) void fetchHubData();
              if (smartBundleError) void fetchSmartBundle();
            }}
            className="btn btn-ghost btn-sm shrink-0"
          >
            retry
          </button>
        </div>
      )}

      {showSmartSkeletons ? (
        <JumpBackInSectionSkeleton />
      ) : visibleSmartBundle && visibleSmartBundle.jumpBackIn.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-[var(--color-text-secondary)] mb-4">
            jump back in
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
            {visibleSmartBundle.jumpBackIn.slice(0, 8).map((tile, index) => (
              <AnimatedTileSlot
                key={`jump-back-in-${index}`}
                value={tile}
                signature={`${tile.type}:${tile.id}:${tile.title}:${tile.subtitle}:${tile.imageUrl || ''}:${tile.lastPlayedAt}`}
              >
                {(displayTile, phase) => (
                  <JumpTileCard
                    tile={{ ...displayTile, imageUrl: resolveTileImage(displayTile) }}
                    onActivate={handleJumpTile}
                    onPlay={handlePlayJumpTile}
                    motionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            ))}
          </div>
        </section>
      )}

      {/* For you / AI playlists. Three states:
          - loading (background refresh, no data yet) → skeleton
          - llm configured but no playlists → empty hero with "generate playlists" CTA
          - llm not configured → hide entirely; user gets the rest of the Hub
          - has playlists → rail */}
      {isLoading && aiPlaylists.length === 0 ? (
        <ForYouSectionSkeleton />
      ) : aiPlaylists.length === 0 && llmConfigured ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--color-surface-variant)] flex items-center justify-center mb-4">
            <Sparkles className="w-8 h-8 text-[var(--color-primary)]" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2 lowercase">
            no playlists yet
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-sm mb-6">
            generate your first set from your library using your configured AI model.
          </p>
          <button
            onClick={handleGeneratePlaylists}
            disabled={isGenerating || !hasLibrary}
            className="btn btn-primary btn-lg"
            aria-label="generate playlists"
          >
            {isGenerating ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Sparkles className="w-5 h-5" />
            )}
            <span>{isGenerating ? 'generating…' : 'generate playlists'}</span>
          </button>
          {generationError && (
            <p className="text-xs text-[var(--color-error)] mt-4 font-medium max-w-sm">
              {generationError}
            </p>
          )}
          {!hasLibrary && (
            <p className="text-xs text-[var(--color-error)] mt-4 font-medium">
              scan music into your library first
            </p>
          )}
        </div>
      ) : aiPlaylists.length > 0 ? (
        <section>
          <h2 className="text-xl sm:text-2xl font-bold text-[var(--color-text-primary)] mb-5 lowercase">
            for you
          </h2>
          <div className="flex sm:grid sm:grid-cols-2 lg:grid-cols-3 overflow-x-auto snap-x snap-mandatory gap-4 sm:gap-5 lg:gap-6 hub-scroll-mobile hide-scrollbar">
            {aiPlaylists.map((collection) => (
              <HubCard
                key={collection.id}
                collection={collection}
                onOpen={() => collection.id && navigate(`/playlists/${collection.id}`, { state: buildPlaylistHero(collection) })}
                onPlay={() => handlePlayCollection(collection.tracks)}
                onPinToggle={() =>
                  collection.id && handleTogglePin(collection.id, !collection.pinned)
                }
                animate={shouldAnimateCards}
              />
            ))}
          </div>
        </section>
      ) : null}

      {showSmartSkeletons ? (
        <UniqueYoursSectionSkeleton />
      ) : visibleSmartBundle && (visibleSmartBundle.wrappedYear || visibleSmartBundle.wrappedSeason || visibleSmartBundle.daylist || visibleSmartBundle.onRepeat || visibleSmartBundle.repeatRewind || visibleSmartBundle.artistRadios.length > 0) && (
        <section>
          <h2 className="text-xl sm:text-2xl font-bold text-[var(--color-text-primary)] mb-5 lowercase">
            uniquely yours
          </h2>
          <HorizontalScrollRail
            ariaLabel="uniquely yours"
            viewportClassName="flex overflow-x-auto snap-x snap-mandatory gap-3 hub-scroll-mobile hub-scroll-unique pb-1 sm:gap-5 sm:pb-2"
          >
            {visibleSmartBundle.wrappedYear && (
              <AnimatedTileSlot
                value={visibleSmartBundle.wrappedYear}
                signature={getCollectionSignature(visibleSmartBundle.wrappedYear)}
              >
                {(displayWrapped, phase) => (
                  <UniqueCard
                    kind="wrapped"
                    title={displayWrapped.title || 'Wrapped'}
                    subtitle={displayWrapped.description || undefined}
                    seed={displayWrapped.id || displayWrapped.title || undefined}
                    onClick={() => handleOpenSmartPlaylist(displayWrapped)}
                    onPlay={() => handlePlayCollection(displayWrapped.tracks)}
                    loading={openingSmartPlaylistId === displayWrapped.id}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            )}
            {visibleSmartBundle.wrappedSeason && (
              <AnimatedTileSlot
                value={visibleSmartBundle.wrappedSeason}
                signature={getCollectionSignature(visibleSmartBundle.wrappedSeason)}
              >
                {(displayWrapped, phase) => (
                  <UniqueCard
                    kind="wrapped"
                    title={displayWrapped.title || 'Wrapped'}
                    subtitle={displayWrapped.description || undefined}
                    seed={displayWrapped.id || displayWrapped.title || undefined}
                    onClick={() => handleOpenSmartPlaylist(displayWrapped)}
                    onPlay={() => handlePlayCollection(displayWrapped.tracks)}
                    loading={openingSmartPlaylistId === displayWrapped.id}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            )}
            {visibleSmartBundle.daylist && (
              <AnimatedTileSlot
                value={visibleSmartBundle.daylist}
                signature={getCollectionSignature(visibleSmartBundle.daylist)}
              >
                {(displayDaylist, phase) => (
                  <UniqueCard
                    kind="daylist"
                    title={displayDaylist.title || 'Daylist'}
                    subtitle={displayDaylist.description || undefined}
                    onClick={() => handleOpenSmartPlaylist(displayDaylist)}
                    onPlay={() => handlePlayCollection(displayDaylist.tracks)}
                    loading={openingSmartPlaylistId === displayDaylist.id}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            )}
            {visibleSmartBundle.onRepeat && (
              <AnimatedTileSlot
                value={visibleSmartBundle.onRepeat}
                signature={getCollectionSignature(visibleSmartBundle.onRepeat)}
              >
                {(displayOnRepeat, phase) => (
                  <UniqueCard
                    kind="on-repeat"
                    title="on repeat"
                    subtitle="songs you love right now"
                    onClick={() => handleOpenSmartPlaylist(displayOnRepeat)}
                    onPlay={() => handlePlayCollection(displayOnRepeat.tracks)}
                    loading={openingSmartPlaylistId === displayOnRepeat.id}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            )}
            {visibleSmartBundle.repeatRewind && (
              <AnimatedTileSlot
                value={visibleSmartBundle.repeatRewind}
                signature={getCollectionSignature(visibleSmartBundle.repeatRewind)}
              >
                {(displayRepeatRewind, phase) => (
                  <UniqueCard
                    kind="repeat-rewind"
                    title="repeat rewind"
                    subtitle="your past favourites"
                    onClick={() => handleOpenSmartPlaylist(displayRepeatRewind)}
                    onPlay={() => handlePlayCollection(displayRepeatRewind.tracks)}
                    loading={openingSmartPlaylistId === displayRepeatRewind.id}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            )}
            {visibleSmartBundle.artistRadios.map((candidate, index) => (
              <AnimatedTileSlot
                key={`artist-radio-${index}`}
                value={candidate}
                signature={`${candidate.artistId}:${candidate.artistName}:${candidate.imageUrl || ''}:${candidate.withArtists.join('|')}`}
              >
                {(displayCandidate, phase) => (
                  <UniqueCard
                    kind="artist-radio"
                    title={`${displayCandidate.artistName} radio`}
                    subtitle={
                      displayCandidate.withArtists && displayCandidate.withArtists.length > 0
                        ? `with ${displayCandidate.withArtists.join(', ')}`
                        : 'inspired by your top artist'
                    }
                    imageUrl={displayCandidate.imageUrl}
                    onClick={() => handleOpenArtistRadio(displayCandidate)}
                    loading={radioLoadingId === displayCandidate.artistId}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            ))}
          </HorizontalScrollRail>
        </section>
      )}

      <LiveConcertsHubSection />

      {isLoading && systemCollections.length === 0 ? (
        <DiscoverSectionSkeleton />
      ) : systemCollections.length > 0 ? (
        <section>
          <h2 className="text-xl sm:text-2xl font-bold text-[var(--color-text-primary)] mb-5 lowercase">
            discover
          </h2>
          <HorizontalScrollRail
            ariaLabel="discover"
            viewportClassName="flex overflow-x-auto snap-x snap-mandatory gap-3 hub-scroll-mobile hub-scroll-unique pb-1 sm:gap-5 sm:pb-2"
          >
            {systemCollections.map((collection) => (
              <AnimatedTileSlot
                key={collection.id}
                value={collection}
                signature={getCollectionSignature(collection)}
              >
                {(displayCollection, phase) => (
                  <UniqueCard
                    kind={getSystemUniqueCardKind(displayCollection)}
                    title={displayCollection.title || 'system mix'}
                    subtitle={displayCollection.description || undefined}
                    onClick={() => displayCollection.id && navigate(`/playlists/${displayCollection.id}`, { state: buildPlaylistHero(displayCollection) })}
                    onPlay={() => handlePlayCollection(displayCollection.tracks)}
                    coverMotionClassName={getTileMotionClassName(phase)}
                    textMotionClassName={getTileTextMotionClassName(phase)}
                  />
                )}
              </AnimatedTileSlot>
            ))}
          </HorizontalScrollRail>
        </section>
      ) : null}

    </div>
  );
};
