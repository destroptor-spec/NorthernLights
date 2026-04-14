import React, { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { Play, Pin, PinOff, Disc3, Sparkles, Wand2, Compass } from 'lucide-react';
import type { TrackInfo } from '../utils/fileSystem';
import type { Playlist } from '../store';
import { useDominantColor } from '../hooks/useDominantColor';
import { useExternalImage } from '../hooks/useExternalImage';
import { useInView } from '../hooks/useInView';
import { fetchGenreImage } from '../utils/externalImagery';

type HubCollection = Partial<Playlist> & { tracks: TrackInfo[] };

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

interface HubCardProps {
  collection: HubCollection;
  onPlay: () => void;
  onPinToggle?: () => void;
}

const HubCard: React.FC<HubCardProps> = ({ collection, onPlay, onPinToggle }) => {
  const { artUrls, bgColor } = useDominantColor(collection.tracks);
  const hasCovers = artUrls.length > 0;

  return (
    <div
      className="relative p-4 sm:p-5 cursor-pointer group rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98] hub-card-animate"
      onClick={onPlay}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay();
        }
      }}
      aria-label={`Play ${collection.title || 'Untitled playlist'}`}
    >
      <div
        className="absolute inset-0 rounded-[inherit] opacity-[0.04] group-hover:opacity-[0.08] transition-opacity pointer-events-none"
        style={{ background: `linear-gradient(135deg, ${bgColor}, transparent 60%)` }}
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
            {collection.title || 'Untitled Playlist'}
          </h3>
          {onPinToggle && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onPinToggle();
              }}
              className="min-w-11 min-h-11 flex items-center justify-center rounded-lg p-2 -m-2 hover:bg-white/10 dark:hover:bg-white/5 transition-colors"
              aria-label={collection.pinned ? 'Unpin playlist' : 'Pin playlist'}
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

        <p className="text-xs text-[var(--color-text-muted)] mt-2">
          {collection.tracks.length} {collection.tracks.length === 1 ? 'track' : 'tracks'}
        </p>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
        className="absolute bottom-4 right-4 w-11 h-11 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-all duration-200 hover:bg-[var(--color-primary-dark)] hover:scale-110 active:scale-95"
        aria-label="Play"
      >
        <Play className="w-5 h-5 ml-0.5" fill="currentColor" />
      </button>
    </div>
  );
};

interface DiscoverCardProps {
  collection: HubCollection;
  onPlay: () => void;
}

const DiscoverCard: React.FC<DiscoverCardProps> = ({ collection, onPlay }) => {
  const { artUrls } = useDominantColor(collection.tracks);
  const covers = artUrls.slice(0, 4);
  const hasCovers = covers.length > 0;

  return (
    <div
      className="relative flex flex-col sm:flex-row gap-4 p-4 cursor-pointer group rounded-[var(--radius)] bg-[var(--glass-bg)] border border-[var(--glass-border)] backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98] hub-card-animate"
      onClick={onPlay}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay();
        }
      }}
      aria-label={`Play ${collection.title || 'Untitled playlist'}`}
    >
      {/* Left: 2x2 Cover Grid */}
      <div className="grid grid-cols-2 gap-1.5 shrink-0 w-full sm:w-36 lg:w-40">
        {hasCovers ? (
          covers.map((url, i) => (
            <img
              key={i}
              src={url}
              alt=""
              className="aspect-square rounded-lg object-cover shadow-sm"
            />
          ))
        ) : (
          <div className="col-span-2 aspect-square rounded-lg bg-[var(--color-surface-variant)] flex items-center justify-center">
            <Disc3 className="w-8 h-8 text-[var(--color-text-muted)] opacity-40" />
          </div>
        )}
      </div>

      {/* Right: Content */}
      <div className="flex flex-col justify-center min-w-0">
        <h3 className="font-semibold text-base sm:text-lg text-[var(--color-text-primary)] line-clamp-1 group-hover:text-[var(--color-primary)] transition-colors">
          {collection.title || 'Untitled Playlist'}
        </h3>
        {collection.description && (
          <p className="text-sm text-[var(--color-text-secondary)] line-clamp-2 mt-1">
            {collection.description}
          </p>
        )}
        <p className="text-xs text-[var(--color-text-muted)] mt-2">
          {collection.tracks.length} {collection.tracks.length === 1 ? 'track' : 'tracks'}
        </p>
      </div>

      {/* Floating Play Button (hover reveal) */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
        className="absolute bottom-4 right-4 w-11 h-11 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-all duration-200 hover:bg-[var(--color-primary-dark)] hover:scale-110 active:scale-95"
        aria-label="Play"
      >
        <Play className="w-5 h-5 ml-0.5" fill="currentColor" />
      </button>
    </div>
  );
};

interface ExploreCardProps {
  genre: string;
  trackCount: number;
  entity?: { id: string; name?: string };
}

const ExploreCard: React.FC<ExploreCardProps> = ({ genre, trackCount, entity }) => {
  const [ref, inView] = useInView();
  const { imageUrl } = useExternalImage(() => fetchGenreImage(genre), [genre], { enabled: inView });

  const CardContent = (
    <div
      ref={ref}
      className="relative overflow-hidden rounded-[var(--radius)] cursor-pointer group aspect-[2/1] sm:aspect-[3/2] hub-card-animate"
    >
      {imageUrl ? (
        <div className="absolute inset-0 z-0">
          <img
            src={imageUrl}
            alt={genre}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/10" />
        </div>
      ) : (
        <div className="absolute inset-0 z-0 bg-[var(--color-surface)]">
          <div className="absolute inset-0 bg-gradient-to-br from-[var(--color-primary)]/[0.15] to-transparent" />
        </div>
      )}

      <div className="relative z-10 h-full flex flex-col justify-end p-4 sm:p-5">
        <h3
          className={`font-bold text-xl sm:text-2xl tracking-tight leading-tight transition-colors duration-200 ${
            imageUrl
              ? 'text-white drop-shadow-lg'
              : 'text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)]'
          }`}
        >
          {genre}
        </h3>
        <p
          className={`text-xs mt-1 ${
            imageUrl
              ? 'text-white/70'
              : 'text-[var(--color-text-muted)]'
          }`}
        >
          {trackCount} {trackCount === 1 ? 'track' : 'tracks'}
        </p>
      </div>
    </div>
  );

  if (entity) {
    return (
      <Link to={`/library/genre/${entity.id}`} className="no-underline">
        {CardContent}
      </Link>
    );
  }

  return CardContent;
};

export const Hub: React.FC = () => {
  const { library, setPlaylist, getAuthHeader, togglePin, currentUser, genres: genreEntities } = usePlayerStore();
  const [collections, setCollections] = useState<HubCollection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);

  const fetchHubData = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/hub', { headers: getAuthHeader() });

      if (res.ok) {
        const data = await res.json();
        const mappedCollections = data.collections
          .map((col: any) => ({
            ...col,
            tracks: col.tracks
              .map((t: any) => {
                const libTrack = library.find((lt) => lt.id === t.id);
                return libTrack || (col.isLlmGenerated ? t : null);
              })
              .filter(Boolean),
          }))
          .filter((col: any) => col.tracks.length > 0);

        setCollections(mappedCollections);
      }
    } catch (e) {
      console.error('Failed to load hub data', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (library.length > 0) {
      fetchHubData();
    }
  }, [library]);

  const handleGeneratePlaylists = async () => {
    setIsGenerating(true);
    try {
      const authHeaders = getAuthHeader();
      await fetch('/api/hub/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ force: true }),
      });
      await fetchHubData();
    } catch (e) {
      console.error('Failed to generate playlists', e);
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

  const aiPlaylists = collections.filter((c) => c.isLlmGenerated);
  const otherCollections = collections.filter((c) => !c.isLlmGenerated);

  // Derive top 6 genres by track count
  const topGenres = useMemo(() => {
    const genreCounts = new Map<string, number>();
    library.forEach((track) => {
      const genre = (track as any).genre;
      if (genre) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    });

    return Array.from(genreCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([genre, count]) => ({
        genre,
        count,
        entity: genreEntities.find((g: any) => g.name?.toLowerCase() === genre.toLowerCase()),
      }));
  }, [library, genreEntities]);

  if (isLoading) {
    return (
      <div className="page-container space-y-8">
        <header>
          <div className="h-8 w-24 rounded bg-[var(--color-surface-variant)] animate-pulse" />
          <div className="h-4 w-48 rounded bg-[var(--color-surface-variant)] animate-pulse mt-2" />
        </header>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5 lg:gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <HubCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="page-container space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[var(--color-text-primary)]">
            Home
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Your personalized music experience
          </p>
        </div>
        {aiPlaylists.length > 0 && (
          <button
            onClick={handleGeneratePlaylists}
            disabled={isGenerating}
            className="btn btn-ghost btn-sm"
            aria-label="Refresh AI playlists"
          >
            <Wand2 className="w-4 h-4" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        )}
      </header>

      {aiPlaylists.length > 0 && (
        <section>
          <h2 className="text-xl sm:text-2xl font-bold text-[var(--color-text-primary)] mb-1">
            For you, {currentUser?.username || 'there'}
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-5">
            Curated intelligently for your current vibe
          </p>
          <div className="flex sm:grid sm:grid-cols-2 lg:grid-cols-3 overflow-x-auto snap-x snap-mandatory gap-4 sm:gap-5 lg:gap-6 hub-scroll-mobile">
            {aiPlaylists.map((collection) => (
              <HubCard
                key={collection.id}
                collection={collection}
                onPlay={() => handlePlayCollection(collection.tracks)}
                onPinToggle={() =>
                  collection.id && handleTogglePin(collection.id, !collection.pinned)
                }
              />
            ))}
          </div>
        </section>
      )}

      {otherCollections.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-[var(--color-text-secondary)] mb-4">
            Discover
          </h2>
          <div className="flex flex-col gap-4">
            {otherCollections.map((collection) => (
              <DiscoverCard
                key={collection.id}
                collection={collection}
                onPlay={() => handlePlayCollection(collection.tracks)}
              />
            ))}
          </div>
        </section>
      )}

      {topGenres.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Compass className="w-5 h-5 text-[var(--color-text-muted)]" />
            <h2 className="text-lg font-semibold text-[var(--color-text-secondary)]">
              Explore
            </h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
            {topGenres.map(({ genre, count, entity }) => (
              <ExploreCard
                key={genre}
                genre={genre}
                trackCount={count}
                entity={entity}
              />
            ))}
          </div>
        </section>
      )}

      {aiPlaylists.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--color-surface-variant)] flex items-center justify-center mb-4">
            <Sparkles className="w-8 h-8 text-[var(--color-primary)]" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
            No AI Playlists Yet
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-sm mb-6">
            Connect an LLM in{' '}
            <strong className="text-[var(--color-text-primary)]">Settings → Providers</strong>,
            then generate your first personalized playlists.
          </p>
          <button
            onClick={handleGeneratePlaylists}
            disabled={isGenerating || library.length === 0}
            className="btn btn-primary btn-lg"
            aria-label="Generate AI playlists"
          >
            {isGenerating ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Sparkles className="w-5 h-5" />
            )}
            <span>{isGenerating ? 'Generating...' : 'Generate Playlists'}</span>
          </button>
          {library.length === 0 && (
            <p className="text-xs text-[var(--color-error)] mt-4 font-medium">
              Scan music into your library first
            </p>
          )}
        </div>
      )}
    </div>
  );
};
