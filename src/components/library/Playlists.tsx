import React, { useEffect, useRef, useState, useCallback } from 'react';
import { playlistPermissions } from '../../../shared/playlistPermissions';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store';
import {
  Play, Plus, Sparkles, X, Loader2,
  Disc3, MoreHorizontal, Pin,
} from 'lucide-react';
import { useDominantColor } from '../../hooks/useDominantColor';
import type { Playlist } from '../../store';
import {
  PlaylistContextMenu,
  type PlaylistMenuTrigger,
} from './PlaylistContextMenu';
import { prefetchPlaylistDetail } from '../../utils/routePrefetch';
import { AuroraCover, wrappedCoverLabel, type AuroraCoverVariant } from './AuroraCover';
import type { PlaylistHeroState } from '../../utils/heroState';
import { HorizontalScrollRail } from '../HorizontalScrollRail';
import CreatePlaylistModal from './CreatePlaylistModal';

// ─── Playlist Card ────────────────────────────────────────────────────────────

const PlaylistCard: React.FC<{
  playlist: Playlist;
  onOpen: () => void;
  onMenuOpen: (x: number, y: number) => void;
  onPlay: () => void;
  /** Owner's username — when set, the card shows a "by <owner>" byline. */
  ownerName?: string;
  /** Hide the kebab menu for playlists the current user can't manage. */
  showMenu?: boolean;
  /** Render a procedural AuroraCover instead of the track-art collage. */
  coverVariant?: AuroraCoverVariant;
  /** Render a single full-bleed image (e.g. artist image for radios) instead of the collage. */
  coverImageUrl?: string;
}> = ({ playlist, onOpen, onMenuOpen, onPlay, ownerName, showMenu = true, coverVariant, coverImageUrl }) => {
  // Skip art extraction when a generated/explicit cover replaces the collage.
  const { artUrls } = useDominantColor(coverVariant || coverImageUrl ? [] : playlist.tracks);
  const covers = artUrls.slice(0, 4);
  // Collage thumbnails render small, so request the smallest pre-encoded art
  // bucket (256) instead of the server default (640).
  const sizeArt = (url: string) =>
    url.includes('/api/art') && !/[?&]size=/.test(url) ? `${url}&size=256` : url;

  const subtitle = ownerName
    ? `by ${ownerName}`
    : `${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'track' : 'tracks'}`;

  return (
    <div
      className="group flex flex-col relative cursor-pointer"
      onClick={onOpen}
      onPointerEnter={prefetchPlaylistDetail}
      onPointerDown={prefetchPlaylistDetail}
      onFocus={prefetchPlaylistDetail}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      aria-label={`Open ${playlist.title}`}
    >
      {/* Square cover — AuroraCover (wrapped/discover), full-bleed image (radios),
          or the default 2×2 collage of track covers */}
      <div className="relative aspect-square w-full mb-3 rounded-2xl border border-black/5 dark:border-white/5 bg-white/5 dark:bg-black/20 shadow-md overflow-hidden transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100">
        {coverVariant ? (
          <AuroraCover
            variant={coverVariant}
            seed={playlist.id || playlist.title}
            title={playlist.title}
            label={coverVariant === 'wrapped' ? (wrappedCoverLabel(playlist.title) || undefined) : undefined}
          />
        ) : coverImageUrl ? (
          <img src={coverImageUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : covers.length > 1 ? (
          <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px">
            {[0, 1, 2, 3].map((i) => {
              const url = covers[i];
              return url ? (
                <img key={i} src={sizeArt(url)} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
              ) : (
                <div key={i} className="flex items-center justify-center bg-[var(--color-surface-variant)]">
                  <Disc3 className="w-5 h-5 text-[var(--color-text-muted)] opacity-30" />
                </div>
              );
            })}
          </div>
        ) : covers.length === 1 ? (
          <img src={sizeArt(covers[0])} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[var(--color-surface-variant)]">
            <Disc3 className="w-10 h-10 text-[var(--color-text-muted)] opacity-40" />
          </div>
        )}

        {/* Badges — top-left pill (matches AlbumCard edition pill) */}
        {(playlist.isLlmGenerated || playlist.pinned) && (
          <div className="absolute top-2.5 left-2.5 z-20 flex items-center gap-1 pointer-events-none">
            {playlist.isLlmGenerated && (
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/95 bg-black/35 backdrop-blur-sm px-2 py-0.5 rounded-full">
                AI
              </span>
            )}
            {playlist.pinned && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.15em] text-white/95 bg-black/35 backdrop-blur-sm px-2 py-0.5 rounded-full">
                <Pin className="h-2.5 w-2.5" /> Pinned
              </span>
            )}
          </div>
        )}

        {/* Kebab — top-right, hover-reveal */}
        {showMenu && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMenuOpen(e.clientX, e.clientY); }}
            aria-label="More options"
            className="absolute top-2 right-2 z-20 w-8 h-8 rounded-full flex items-center justify-center text-white/95 bg-black/35 backdrop-blur-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-black/55"
          >
            <MoreHorizontal size={16} />
          </button>
        )}

        {/* Hover overlay + centered play */}
        <div className="absolute inset-0 bg-transparent group-hover:bg-black/40 transition-colors duration-300 flex items-center justify-center z-10 pointer-events-none rounded-2xl">
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPlay(); }}
            aria-label={`Play ${playlist.title}`}
            className="
              z-20 pointer-events-auto w-14 h-14 rounded-full flex items-center justify-center
              opacity-0 md:scale-75 md:group-hover:opacity-100 md:group-hover:scale-100
              transition-ui duration-300 ease-out hover:scale-110 active:scale-95 motion-reduce:transition-none
              bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white backdrop-blur-sm
              shadow-[0_4px_24px_rgba(16,185,129,0.3)] hover:shadow-[0_8px_32px_rgba(16,185,129,0.5)]
              focus-visible:opacity-100 focus-visible:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white
            "
          >
            <Play size={22} fill="currentColor" className="text-white ml-0.5" />
          </button>
        </div>
      </div>

      {/* Text */}
      <div className="flex flex-col px-1 relative z-10 pointer-events-none">
        <div className="font-semibold text-sm md:text-base tracking-wide truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors motion-reduce:transition-none">
          {playlist.title}
        </div>
        <div className="text-xs md:text-sm text-[var(--color-text-secondary)] truncate mt-0.5">{subtitle}</div>
      </div>
    </div>
  );
};

// ─── Card skeleton ────────────────────────────────────────────────────────────

const PlaylistCardSkeleton: React.FC = () => (
  <div className="flex flex-col animate-pulse">
    <div className="aspect-square w-full mb-3 rounded-2xl bg-[var(--color-surface-variant)]" />
    <div className="px-1 space-y-1.5">
      <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
      <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)]" />
    </div>
  </div>
);

// ─── Generate Playlist Modal ──────────────────────────────────────────────────

const GeneratePlaylistModal: React.FC<{ onClose: () => void; onGenerated: () => void }> = ({
  onClose,
  onGenerated,
}) => {
  const { getAuthHeader, fetchPlaylistsFromServer } = usePlayerStore();
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const examples = [
    'Late night rainy drive through the city',
    'Energetic workout, heavy beats, no vocals',
    'Sunday morning coffee and jazz vibes',
    'Focus music for deep work, minimal and ambient',
  ];

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsGenerating(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch('/api/hub/generate-custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Generation failed. Check your LLM configuration in Settings.');
        return;
      }
      setSuccess(`✓ "${data.playlist?.title || 'Your new playlist'}" has been created!`);
      await fetchPlaylistsFromServer();
      setTimeout(() => { onGenerated(); onClose(); }, 1500);
    } catch {
      setError('Network error. Is the server running?');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-lg bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-3xl p-8 shadow-2xl backdrop-blur-2xl space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <X size={20} />
        </button>

        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-[var(--color-primary)]" />
            </div>
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Generate a Playlist</h2>
          </div>
          <p className="text-sm text-[var(--color-text-secondary)] ml-12">
            Describe the vibe — the AI will pick the tracks.
          </p>
        </div>

        <div className="space-y-3">
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
            placeholder="e.g. Late night coding session, lo-fi and focused…"
            rows={3}
            className="w-full px-4 py-3 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition-colors resize-none text-sm"
          />
          <div className="flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => setPrompt(ex)}
                className="text-xs px-3 py-1.5 rounded-full bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text-primary)] transition-ui"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        {error   && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2">{error}</p>}
        {success && <p className="text-sm text-green-400 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-2">{success}</p>}

        <div className="flex gap-3">
          <button
            onClick={handleGenerate}
            disabled={!prompt.trim() || isGenerating}
            className="flex-1 py-3 rounded-xl bg-aurora-gradient hover:brightness-110 text-white font-semibold shadow-lg transition-ui active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isGenerating
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
              : <><Sparkles className="w-4 h-4" /> Generate Playlist</>
            }
          </button>
          <button
            onClick={onClose}
            className="px-4 py-3 rounded-xl bg-[var(--color-surface)] border border-[var(--glass-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            Cancel
          </button>
        </div>
        <p className="text-xs text-center text-[var(--color-text-muted)]">Tip: ⌘ Enter to generate</p>
      </div>
    </div>
  );
};

// ─── Rail ─────────────────────────────────────────────────────────────────────

// A titled horizontal shelf of playlist cards, mirroring the Hub's rail layout.
const PlaylistRail: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({
  title,
  subtitle,
  children,
}) => (
  <section>
    <div className="mb-3">
      <h2 className="text-lg sm:text-xl font-bold text-[var(--color-text-primary)]">{title}</h2>
      {subtitle && <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">{subtitle}</p>}
    </div>
    <HorizontalScrollRail
      ariaLabel={title}
      viewportClassName="flex overflow-x-auto snap-x snap-mandatory gap-4 sm:gap-5 hide-scrollbar pb-1"
    >
      {children}
    </HorizontalScrollRail>
  </section>
);

// Order Wrapped recaps newest → oldest. Key = year*100 + period-end month, so
// a full-year "2025 Wrapped" (Dec) leads its seasons: "Autumn 2025" (Nov),
// "Summer 2025" (Aug)… Titles are "<Year> Wrapped" or "<Season> <Year>".
const WRAPPED_SEASON_END_MONTH: Record<string, number> = { winter: 2, spring: 5, summer: 8, autumn: 11 };
const wrappedSortKey = (p: Playlist): number => {
  const title = (p.title || '').trim();
  const year = /^(\d{4})\s+Wrapped$/i.exec(title);
  if (year) return Number(year[1]) * 100 + 12;
  const season = /^(Winter|Spring|Summer|Autumn)\s+(\d{4})$/i.exec(title);
  if (season) return Number(season[2]) * 100 + (WRAPPED_SEASON_END_MONTH[season[1].toLowerCase()] ?? 0);
  return 0;
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export const Playlists: React.FC = () => {
  const {
    playlists,
    discoverPlaylists,
    artists,
    setPlaylist,
    deletePlaylist,
    togglePin,
    fetchPlaylistsFromServer,
    fetchDiscoverPlaylists,
    isPlaylistsLoading,
  } = usePlayerStore();
  const navigate = useNavigate();
  const pageRef = useRef<HTMLDivElement>(null);

  const [isCreating,   setIsCreating]   = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeMenu,   setActiveMenu]   = useState<PlaylistMenuTrigger | null>(null);

  useEffect(() => {
    void fetchPlaylistsFromServer();
    void fetchDiscoverPlaylists();
  }, [fetchPlaylistsFromServer, fetchDiscoverPlaylists]);

  // Created via the modal; open the new (empty) playlist so the user can start
  // adding tracks right away.
  const handleCreated = (pl: Playlist) => {
    setIsCreating(false);
    if (!pl.id) return;
    const hero: PlaylistHeroState = {
      kind: 'playlist',
      title: pl.title,
      description: pl.description || undefined,
      trackCount: 0,
      artUrls: [],
      isLlmGenerated: false,
      isSystem: false,
      pinned: false,
      backLabel: 'Back to Playlists',
    };
    navigate(`/playlists/${pl.id}`, { state: hero });
  };

  const openMenu = useCallback((playlist: Playlist, x: number, y: number) => {
    setActiveMenu({ playlist, x, y });
  }, []);

  const closeMenu = useCallback(() => setActiveMenu(null), []);

  // Find the live playlist from store so pin state reflects toggle immediately
  const activePlaylist = activeMenu
    ? playlists.find((p) => p.id === activeMenu.playlist.id) ?? activeMenu.playlist
    : null;
  // The same rule the server enforces (shared/playlistPermissions.ts): pin works
  // on everything you own, delete on everything but system playlists.
  const activePermissions = activePlaylist
    ? playlistPermissions({
        isOwner: activePlaylist.isOwner !== false,
        isSystem: !!activePlaylist.isSystem,
        isLlmGenerated: !!activePlaylist.isLlmGenerated,
        generationSource: activePlaylist.generationSource,
      })
    : null;

  // `playlists` holds the current user's own playlists (from GET /api/v1/playlists);
  // a discovered playlist opened by URL also gets upserted there with isOwner:false
  // — exclude those so the own-playlist rails stay strictly the user's own.
  const ownPlaylists = playlists.filter((p) => p.isOwner !== false);

  // Pinned bubble to the front of whichever category rail they belong to.
  const pinnedFirst = (arr: Playlist[]) =>
    [...arr].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  // Partition own playlists by nature: manual (hand-built), AI (LLM-generated),
  // radios (artist-radio smart playlists), Wrapped year/season recaps, and the
  // remaining system/smart ones (daylist, on-repeat, rewinds…). These buckets
  // are disjoint and cover every own playlist.
  const isRadio = (p: Playlist) => p.generationSource === 'artist-radio';
  const isWrapped = (p: Playlist) => p.generationSource === 'wrapped';
  const userPlaylists = pinnedFirst(ownPlaylists.filter((p) => !p.isLlmGenerated && !p.isSystem));
  const llmPlaylists = pinnedFirst(ownPlaylists.filter((p) => p.isLlmGenerated));
  const radioPlaylists = pinnedFirst(ownPlaylists.filter((p) => p.isSystem && isRadio(p)));
  const curatedPlaylists = pinnedFirst(ownPlaylists.filter((p) => p.isSystem && !isRadio(p) && !isWrapped(p)));
  // Wrapped recaps sort newest → oldest by period end: a full-year recap
  // completes in December, so it leads its year's seasons.
  const wrappedPlaylists = pinnedFirst(
    [...ownPlaylists.filter((p) => p.isSystem && isWrapped(p))].sort(
      (a, b) => wrappedSortKey(b) - wrappedSortKey(a)
    )
  );

  const buildHero = (pl: Playlist): PlaylistHeroState => ({
    kind: 'playlist',
    title: pl.title,
    description: pl.description || undefined,
    trackCount: pl.tracks.length,
    artUrls: pl.tracks.map((t) => t.artUrl).filter((u): u is string => !!u).slice(0, 4),
    isLlmGenerated: pl.isLlmGenerated || false,
    isSystem: pl.isSystem || false,
    pinned: pl.pinned || false,
    backLabel: 'Back to Playlists',
  });

  // Artist images for the Radios rail (title "<Artist> Radio" → artists entity
  // image, same source the Artists grid uses). Falls back to the track collage.
  const artistImageByName = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const a of artists as any[]) {
      const img = a?.image_url || a?.artwork_url;
      if (a?.name && img && !map.has(a.name.toLowerCase())) map.set(a.name.toLowerCase(), img);
    }
    return map;
  }, [artists]);
  const radioArtistImage = (pl: Playlist): string | undefined =>
    artistImageByName.get(pl.title.replace(/\s+Radio$/i, '').trim().toLowerCase());

  const renderCard = (
    pl: Playlist,
    opts?: { ownerName?: string; showMenu?: boolean; coverVariant?: AuroraCoverVariant; coverImageUrl?: string }
  ) => (
    <div key={pl.id ?? pl.title} className="shrink-0 snap-start w-[min(52vw,200px)] sm:w-[190px]">
      <PlaylistCard
        playlist={pl}
        ownerName={opts?.ownerName}
        showMenu={opts?.showMenu ?? true}
        coverVariant={opts?.coverVariant}
        coverImageUrl={opts?.coverImageUrl}
        onOpen={() => navigate(`/playlists/${pl.id}`, { state: buildHero(pl) })}
        onPlay={() => { if (pl.tracks.length > 0) setPlaylist(pl.tracks, 0); }}
        onMenuOpen={(x, y) => openMenu(pl, x, y)}
      />
    </div>
  );

  const renderRail = (
    title: string,
    items: Playlist[],
    opts?: { subtitle?: string; discover?: boolean; coverVariant?: AuroraCoverVariant; radios?: boolean }
  ) =>
    items.length > 0 ? (
      <PlaylistRail key={title} title={title} subtitle={opts?.subtitle}>
        {items.map((pl) =>
          opts?.discover
            ? renderCard(pl, { ownerName: pl.ownerUsername || undefined, showMenu: false, coverVariant: opts?.coverVariant })
            : renderCard(pl, { coverVariant: opts?.coverVariant, coverImageUrl: opts?.radios ? radioArtistImage(pl) : undefined })
        )}
      </PlaylistRail>
    ) : null;

  const hasAnything = ownPlaylists.length > 0 || discoverPlaylists.length > 0;

  return (
    <div ref={pageRef} className="page-container space-y-8">
      {/* Generate modal */}
      {isGenerating && (
        <GeneratePlaylistModal
          onClose={() => setIsGenerating(false)}
          onGenerated={() => setIsGenerating(false)}
        />
      )}

      {/* Create modal — name + description, opens the new playlist on success */}
      {isCreating && (
        <CreatePlaylistModal
          onClose={() => setIsCreating(false)}
          onCreated={handleCreated}
        />
      )}

      {/* Playlist context menu — rendered at document root via portal */}
      <PlaylistContextMenu
        menu={activeMenu && activePlaylist ? { ...activeMenu, playlist: activePlaylist } : null}
        onClose={closeMenu}
        onPlay={() => {
          if (activePlaylist && activePlaylist.tracks.length > 0)
            setPlaylist(activePlaylist.tracks, 0);
        }}
        onPinToggle={activePlaylist && activePermissions?.pin
          ? () => togglePin(activePlaylist.id!, !activePlaylist.pinned)
          : undefined
        }
        onDelete={activePlaylist && activePermissions?.delete
          ? () => deletePlaylist(activePlaylist.id!)
          : undefined
        }
      />

      {/* ── Header ── */}
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[var(--color-text-primary)]">
            Your Playlists
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {ownPlaylists.length} {ownPlaylists.length === 1 ? 'playlist' : 'playlists'} in your library
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setIsGenerating(true)} className="btn btn-ghost btn-sm">
            <Sparkles className="w-4 h-4" />
            <span className="hidden sm:inline">Generate</span>
          </button>
          <button onClick={() => setIsCreating(true)} className="btn btn-primary btn-sm">
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New Playlist</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </header>

      {/* ── Rails ── */}
      {isPlaylistsLoading && !hasAnything ? (
        <div className="flex gap-4 sm:gap-5 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="shrink-0 w-[min(52vw,200px)] sm:w-[190px]">
              <PlaylistCardSkeleton />
            </div>
          ))}
        </div>
      ) : !hasAnything ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--color-surface-variant)] flex items-center justify-center mb-4">
            <Sparkles className="w-8 h-8 text-[var(--color-primary)]" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
            No playlists yet
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-sm mb-6">
            Create one manually, or hit{' '}
            <strong className="text-[var(--color-text-primary)]">Generate</strong>{' '}
            to let the AI curate your first playlist.
          </p>
          <div className="flex gap-3">
            <button onClick={() => setIsGenerating(true)} className="btn btn-ghost btn-sm">
              <Sparkles className="w-4 h-4" /> Generate with AI
            </button>
            <button onClick={() => setIsCreating(true)} className="btn btn-primary btn-sm">
              <Plus className="w-4 h-4" /> Create Playlist
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {renderRail('Your playlists', userPlaylists)}
          {renderRail('AI playlists', llmPlaylists)}
          {renderRail('Wrapped', wrappedPlaylists, { coverVariant: 'wrapped' })}
          {renderRail('Radios', radioPlaylists, { radios: true })}
          {renderRail('Curated for you', curatedPlaylists)}
          {renderRail('By other listeners', discoverPlaylists, {
            subtitle: 'Playlists shared across your household',
            discover: true,
          })}
        </div>
      )}
    </div>
  );
};
