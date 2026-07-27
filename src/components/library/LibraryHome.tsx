import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { AlbumCard, AlbumCardSkeleton } from './AlbumCard';
import { ArtistInitial } from './ArtistInitial';
import { useExternalImage } from '../../hooks/useExternalImage';
import { fetchGenreImage } from '../../utils/externalImagery';
import { useInView } from '../../hooks/useInView';
import { FilterBar } from './FilterBar';
import { QueryBuilderModal } from './QueryBuilderModal';
import {
  hasActiveFilters,
  QueryGroup,
} from '../../utils/filterState';
import type { ArtistInfo, EntityInfo } from '../../store/index';
import { prefetchArtistDetail } from '../../utils/routePrefetch';
import type { ArtistHeroState } from '../../utils/heroState';
import { VirtualizedCardGrid } from './VirtualizedCardGrid';
import { HorizontalScrollRail } from '../HorizontalScrollRail';
import { useGenreTaxonomy } from '../../hooks/useGenreTaxonomy';
import {
  getTracksByAlbumAndGenres,
  getEnrichedAlbums,
  getArtistFacetValues,
  getAlbumFacetValues,
  getFilteredArtists,
  getFilteredAlbums,
} from '../../utils/libraryDerivations';

const ArtistCardSkeleton: React.FC = () => (
    <div className="flex flex-col items-center animate-pulse">
        <div className="w-full aspect-square rounded-full bg-[var(--color-surface-variant)] mb-4" />
        <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
    </div>
);

const GenreCardSkeleton: React.FC = () => (
    <div className="flex flex-col gap-2.5 animate-pulse">
        <div className="aspect-square rounded-[var(--radius)] bg-[var(--color-surface-variant)]" />
        <div className="h-3.5 w-3/4 rounded bg-[var(--color-surface-variant)]" />
    </div>
);

// Mirrors the eventual rail shape (and the Hub's loading style) so the genres
// view doesn't jump once the taxonomy resolves.
const GenreRailSkeleton: React.FC = () => (
    <div className="genre-rails" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, r) => (
            <section key={r}>
                <div className="h-7 w-32 sm:w-40 rounded bg-[var(--color-surface-variant)] animate-pulse mb-4" />
                <div className="flex gap-3 sm:gap-5 overflow-hidden py-1">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="shrink-0 w-[min(52vw,200px)] sm:w-[190px] flex flex-col gap-2.5 animate-pulse">
                            <div className="aspect-square rounded-[var(--radius)] bg-[var(--color-surface-variant)]" />
                            <div className="h-3.5 w-3/4 rounded bg-[var(--color-surface-variant)]" />
                        </div>
                    ))}
                </div>
            </section>
        ))}
    </div>
);

// A genre owns no cover of its own, so each is given a deterministic aurora
// signature derived from its name: two hues drawn only from the brand spectrum,
// a bloom angle, and a bloom origin. Same genre always glows the same way, so it
// becomes recognizable across visits; no two genres read alike, so the wall of
// genres stops being an identical card grid. ~1 in 11 earns the rare red-shift.
const AURORA_HUES = [
    'var(--aurora-green)',
    'var(--aurora-teal)',
    'var(--aurora-blue)',
    'var(--aurora-extra-glow)',
];

function genreAurora(name: string): React.CSSProperties {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
        h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
    }
    return {
        '--g-1': AURORA_HUES[h % AURORA_HUES.length],
        '--g-2': h % 11 === 0
            ? 'var(--aurora-pink)'
            : AURORA_HUES[(h >> 4) % AURORA_HUES.length],
        '--g-angle': `${h % 360}deg`,
        '--g-ox': `${22 + ((h >> 9) % 56)}%`,
        '--g-oy': `${18 + ((h >> 16) % 50)}%`,
    } as React.CSSProperties;
}

const GenreCard: React.FC<{ genre: string }> = ({ genre }) => {
    const [ref, inView] = useInView();
    const { imageUrl } = useExternalImage(() => fetchGenreImage(genre), [genre], { enabled: inView });
    const aurora = useMemo(() => genreAurora(genre), [genre]);

    // The bloom follows the pointer over the cover. Writing CSS custom properties
    // (never layout properties) keeps this off the main-thread layout path.
    // Skipped on touch, where there is no hover and the move only fires mid-scroll.
    const trackPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (e.pointerType === 'touch') return;
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--gx', `${((e.clientX - r.left) / r.width) * 100}%`);
        el.style.setProperty('--gy', `${((e.clientY - r.top) / r.height) * 100}%`);
    }, []);

    const resetPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.style.removeProperty('--gx');
        e.currentTarget.style.removeProperty('--gy');
    }, []);

    return (
        <div ref={ref} className="genre-card">
            <div
                className="genre-card__cover"
                style={aurora}
                onPointerMove={trackPointer}
                onPointerLeave={resetPointer}
            >
                {imageUrl && <img src={imageUrl} alt="" aria-hidden="true" className="genre-card__art" />}
                <span className="genre-card__aurora" aria-hidden="true" />
                <span className="genre-card__ribbon" aria-hidden="true" />
            </div>
            <p className="genre-card__label">{genre}</p>
        </div>
    );
};

const ArtistLink: React.FC<{ to: string; state: ArtistHeroState; children: React.ReactNode }> = ({ to, state, children }) => {
    return (
        <Link
            to={to}
            state={state}
            className="no-underline"
            onPointerEnter={prefetchArtistDetail}
            onPointerDown={prefetchArtistDetail}
            onFocus={prefetchArtistDetail}
        >
            {children}
        </Link>
    );
};

// Presentational + memoized: renders the already-loaded cached artist image
// (from the entity row) or a letter placeholder. It does NOT fetch per card —
// previously each visible card fired a full `useArtistData` request (image +
// bio + tags, 200ms-debounced) on scroll, flooding the rate-limited provider
// proxy and re-rendering constantly, which made the mobile grid janky. The
// external image is fetched/cached lazily when the artist's detail page is
// opened; the grid just shows whatever's already cached, plus initials.
const ArtistCard = React.memo(function ArtistCard({ artist, imageUrl }: { artist: string; imageUrl?: string }) {
    return (
        <div className="artist-card group flex flex-col items-center cursor-pointer transition-transform duration-300 hover:scale-105">
            <div className="w-full aspect-square rounded-full overflow-hidden shadow-[var(--shadow-sm)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] mb-4 flex items-center justify-center transition-ui duration-300 group-hover:border-[var(--color-primary)] group-hover:shadow-[var(--shadow-md)]">
                {imageUrl ? (
                    <img src={imageUrl} alt={artist} loading="lazy" decoding="async" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
                ) : (
                    <ArtistInitial name={artist} className="text-4xl md:text-5xl text-[var(--color-primary)] opacity-50 group-hover:opacity-100 transition-opacity" />
                )}
            </div>
            <div className="font-bold text-base md:text-lg text-center text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors truncate w-full px-2">{artist}</div>
        </div>
    );
});

const GRID_SKELETON_COUNT = 12;

interface GenreRailMember {
    name: string;
    /** Depth in the MBDB tree (1 = the root genre itself). */
    depth: number;
}

interface GenreRail {
    root: string;
    rootEntity?: EntityInfo;
    members: GenreRailMember[];
}

export const LibraryHome: React.FC<{ section?: 'artists' | 'albums' | 'genres' }> = ({ section }) => {
    const library = usePlayerStore(state => state.library);
    const isLibraryLoading = usePlayerStore(state => state.isLibraryLoading);
    const libraryError = usePlayerStore(state => state.libraryError);
    const artistEntities = usePlayerStore(state => state.artists);
    const albumEntities = usePlayerStore(state => state.albums);
    const genreEntities = usePlayerStore(state => state.genres);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);
    const artistFilters = usePlayerStore(state => state.artistFilters);
    const albumFilters = usePlayerStore(state => state.albumFilters);
    const setArtistFilters = usePlayerStore(state => state.setArtistFilters);
    const setAlbumFilters = usePlayerStore(state => state.setAlbumFilters);
    const setArtistQueryResultIds = usePlayerStore(state => state.setArtistQueryResultIds);
    const setAlbumQueryResultIds = usePlayerStore(state => state.setAlbumQueryResultIds);
    const mediaAccessToken = usePlayerStore(state => state.mediaAccessToken);
    const authToken = usePlayerStore(state => state.authToken);

    // Build a LOCAL cover URL from the album's representative art_hash (from
    // getAllAlbums). Lets cards show embedded art without the full track list,
    // so they don't fall back to the rate-limited external art proxy.
    const artHashUrl = useCallback((album: { art_hash?: string | null }) => {
        if (!album.art_hash) return undefined;
        const token = mediaAccessToken || authToken || '';
        return `/api/art?hash=${album.art_hash}${token ? `&token=${token}` : ''}`;
    }, [mediaAccessToken, authToken]);

    const pageRef = useRef<HTMLDivElement>(null);
    const [queryBuilderOpen, setQueryBuilderOpen] = useState(false);
    const [queryBuilderView, setQueryBuilderView] = useState<'artists' | 'albums'>('artists');

    // These derivations are memoized at module scope (keyed by the underlying
    // store array references) so navigating away and back to the library
    // doesn't recompute whole-library passes. The useMemo here is just a
    // per-render guard; the real cache survives route unmount. See
    // utils/libraryDerivations.ts.
    const { tracksByAlbum } = useMemo(() => getTracksByAlbumAndGenres(library), [library]);
    // Genre entities are server-canonicalized. Never rebuild this list from raw
    // track tags or grouped spellings would reappear after the full library loads.
    const genres = useMemo(
        () => (genreEntities as EntityInfo[]).map(g => g.name).filter((n): n is string => !!n),
        [genreEntities],
    );

    const enrichedAlbums = useMemo(
        () => getEnrichedAlbums(albumEntities, library),
        [albumEntities, library]
    );

    const artistFacetValues = useMemo(
        () => getArtistFacetValues(artistEntities),
        [artistEntities]
    );

    const albumFacetValues = useMemo(
        () => getAlbumFacetValues(enrichedAlbums),
        [enrichedAlbums]
    );

    // Module-scope memos (see libraryDerivations) so the filter+sort pass
    // survives route unmount/remount instead of re-running on every navigation.
    const filteredArtists = useMemo(
        () => getFilteredArtists(artistEntities, artistFilters),
        [artistEntities, artistFilters]
    );

    const filteredAlbums = useMemo(
        () => getFilteredAlbums(enrichedAlbums, albumFilters),
        [enrichedAlbums, albumFilters]
    );

    const handleOpenQueryBuilder = useCallback((view: 'artists' | 'albums') => {
        setQueryBuilderView(view);
        setQueryBuilderOpen(true);
    }, []);

    const handleApplyQuery = useCallback(async (groups: QueryGroup[]) => {
        const view = queryBuilderView;
        const authHeaders = usePlayerStore.getState().getAuthHeader();
        try {
            const res = await fetch(`/api/filter/${view}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ groups }),
            });
            if (!res.ok) {
                let message = `Query filter failed (${res.status})`;
                try {
                    const err = await res.json();
                    if (err?.error) message = err.error;
                } catch { /* response wasn't JSON */ }
                usePlayerStore.getState().addToast?.(message, 'error');
                return;
            }
            const data = await res.json();
            if (view === 'artists') {
                usePlayerStore.getState().setArtistFilters({
                    ...artistFilters,
                    queryGroups: groups,
                    queryResultIds: data.ids,
                });
            } else {
                usePlayerStore.getState().setAlbumFilters({
                    ...albumFilters,
                    queryGroups: groups,
                    queryResultIds: data.ids,
                });
            }
        } catch {
            usePlayerStore.getState().addToast?.('Query filter failed', 'error');
        }
    }, [queryBuilderView, artistFilters, albumFilters]);

    const showAlbums = !section || section === 'albums';
    const showArtists = section === 'artists';
    const showGenres = section === 'genres';

    // MBDB taxonomy: only fetched while the genres view is open. When it isn't
    // available (never imported), the view falls back to the flat genre grid.
    const { available: taxonomyAvailable, paths: genrePaths, loading: taxonomyLoading } =
        useGenreTaxonomy(showGenres);

    const genreEntityByName = useMemo(() => {
        const map = new Map<string, EntityInfo>();
        (genreEntities as EntityInfo[]).forEach((g) => {
            if (g.name) map.set(g.name.toLowerCase(), g);
        });
        return map;
    }, [genreEntities]);

    // Group library genres under their MBDB root genre (e.g. "Rock" → "Alternative
    // Rock", "Blues Rock"). A root needs at least two members to earn a rail; lone
    // genres and anything the taxonomy doesn't recognize fall into "Other genres".
    const { genreRails, looseGenres } = useMemo(() => {
        if (!taxonomyAvailable) {
            return { genreRails: [] as GenreRail[], looseGenres: genres };
        }
        const groups = new Map<string, GenreRail>();
        const loose: string[] = [];

        for (const name of genres) {
            const path = genrePaths[name.toLowerCase()];
            if (!path) { loose.push(name); continue; }
            const segments = path.split('.');
            const root = segments[0];
            let rail = groups.get(root);
            if (!rail) { rail = { root, members: [] }; groups.set(root, rail); }
            rail.members.push({ name, depth: segments.length });
        }

        const rails: GenreRail[] = [];
        for (const rail of groups.values()) {
            rail.rootEntity = genreEntityByName.get(rail.root.toLowerCase());
            // Shallower (closer to the root) first, then alphabetical.
            rail.members.sort((a, b) => (a.depth - b.depth) || a.name.localeCompare(b.name));
            if (rail.members.length >= 2) rails.push(rail);
            else loose.push(...rail.members.map((m) => m.name));
        }
        // Richest families lead, the way an editorial shelf would order them.
        rails.sort((a, b) => (b.members.length - a.members.length) || a.root.localeCompare(b.root));
        loose.sort((a, b) => a.localeCompare(b));
        return { genreRails: rails, looseGenres: loose };
    }, [taxonomyAvailable, genres, genrePaths, genreEntityByName]);

    // One genre tile, optionally wrapped in a link to its detail view. Shared by
    // the rails and the flat fallback grid so both render identical cards.
    const renderGenreTile = useCallback((genreName: string, wrapperClass = '') => {
        const entity = genreEntityByName.get(genreName.toLowerCase());
        const card = <GenreCard genre={genreName} />;
        if (!entity) {
            return <div key={genreName} className={wrapperClass || undefined}>{card}</div>;
        }
        return (
            <Link
                key={genreName}
                to={`/library/genre/${entity.id}`}
                state={{ backLabel: 'Back to Library' }}
                className={`no-underline ${wrapperClass}`.trim()}
            >
                {card}
            </Link>
        );
    }, [genreEntityByName]);

    // The views render from the entity lists (artists/albums/genres), which load
    // first; the full track array arrives in the background. Gate the
    // skeleton/empty states on entity presence, not on `library` (tracks) —
    // otherwise the views stay blank for the whole background-load window.
    const hasEntities = artistEntities.length > 0 || albumEntities.length > 0 || genreEntities.length > 0;

    if (isLibraryLoading && !hasEntities) {
        return (
            <div className="library-home page-container" ref={pageRef}>
                <div className="library-sections">
                    {showAlbums && (
                        <section className="library-section mb-8 md:mb-12">
                            {/* Render the real FilterBar (empty facets while loading) so the
                                grid starts at its final Y — otherwise it appears on the real
                                view and shifts everything down (a CLS the user can see). */}
                            <FilterBar
                                view="albums"
                                filterState={albumFilters}
                                onFilterChange={setAlbumFilters}
                                onOpenQueryBuilder={() => handleOpenQueryBuilder('albums')}
                                facetValues={albumFacetValues}
                            />
                            <div className="album-grid">
                                {Array.from({ length: GRID_SKELETON_COUNT }).map((_, i) => (
                                    <AlbumCardSkeleton key={i} />
                                ))}
                            </div>
                        </section>
                    )}
                    {showArtists && (
                        <section className="library-section mb-8 md:mb-12">
                            <FilterBar
                                view="artists"
                                filterState={artistFilters}
                                onFilterChange={setArtistFilters}
                                onOpenQueryBuilder={() => handleOpenQueryBuilder('artists')}
                                facetValues={artistFacetValues}
                            />
                            <div className="artist-grid">
                                {Array.from({ length: GRID_SKELETON_COUNT }).map((_, i) => (
                                    <ArtistCardSkeleton key={i} />
                                ))}
                            </div>
                        </section>
                    )}
                    {showGenres && (
                        <section className="library-section">
                            <div className="genre-grid">
                                {Array.from({ length: GRID_SKELETON_COUNT }).map((_, i) => (
                                    <GenreCardSkeleton key={i} />
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            </div>
        );
    }

    // A failed load with an empty library must not look identical to a genuinely
    // empty library (which renders nothing). Show the error + a Retry instead.
    if (!hasEntities && libraryError) {
        return (
            <div className="library-home page-container">
                <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
                    <p className="text-[var(--color-text)] font-medium">{libraryError}</p>
                    <p className="text-[var(--color-text-muted)] text-sm max-w-sm">
                        Your library may still be there — this is usually a temporary connection issue.
                    </p>
                    <button
                        onClick={() => { void usePlayerStore.getState().fetchLibraryFromServer(); }}
                        className="btn btn-primary"
                    >
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    if (!hasEntities) {
        return null;
    }

    return (
        <div className="library-home page-container" ref={pageRef}>
            <div className="library-sections">
                {showAlbums && (
                    <section className="library-section mb-8 md:mb-12">
                        <FilterBar
                            view="albums"
                            filterState={albumFilters}
                            onFilterChange={setAlbumFilters}
                            onOpenQueryBuilder={() => handleOpenQueryBuilder('albums')}
                            facetValues={albumFacetValues}
                        />
                        {filteredAlbums.length === 0 && hasActiveFilters(albumFilters) ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <p className="text-[var(--color-text-muted)] text-sm mb-3">
                                    No albums match these filters
                                </p>
                                <button
                                    onClick={() => usePlayerStore.getState().clearAlbumFilters()}
                                    className="btn btn-ghost btn-sm"
                                >
                                    Clear filters
                                </button>
                            </div>
                        ) : (
                            <VirtualizedCardGrid
                                items={filteredAlbums as any[]}
                                getKey={(album: any) => album.id || `${album.title}::::${album.artist_name || ''}`}
                                estimatedRowHeight={(colWidth) => colWidth + 52}
                                scrollParentRef={pageRef}
                                renderItem={(album: any) => {
                                    const albumKey = `${album.title}::::${album.artist_name || ''}`;
                                    let explicitTracks = tracksByAlbum.get(albumKey) || [];
                                    if (explicitTracks.length === 0 && album.id) {
                                        explicitTracks = library.filter(t => t.albumId === album.id);
                                    }
                                    return (
                                        <AlbumCard
                                            title={album.title}
                                            artist={album.artist_name || ''}
                                            artUrl={album.image_url || artHashUrl(album) || (explicitTracks.find(t => t.artUrl)?.artUrl)}
                                            subtitle={album.artist_name || ''}
                                            onPlay={() => { if (explicitTracks.length) setPlaylist(explicitTracks, 0); }}
                                            linkTo={album.id ? `/library/album/${album.id}` : undefined}
                                            linkState={{ backLabel: 'Back to Library' }}
                                        />
                                    );
                                }}
                            />
                        )}
                    </section>
                )}

                {showArtists && (
                    <section className="library-section mb-8 md:mb-12">
                        <FilterBar
                            view="artists"
                            filterState={artistFilters}
                            onFilterChange={setArtistFilters}
                            onOpenQueryBuilder={() => handleOpenQueryBuilder('artists')}
                            facetValues={artistFacetValues}
                        />
                        {filteredArtists.length === 0 && hasActiveFilters(artistFilters) ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <p className="text-[var(--color-text-muted)] text-sm mb-3">
                                    No artists match these filters
                                </p>
                                <button
                                    onClick={() => usePlayerStore.getState().clearArtistFilters()}
                                    className="btn btn-ghost btn-sm"
                                >
                                    Clear filters
                                </button>
                            </div>
                        ) : (
                            <VirtualizedCardGrid
                                items={filteredArtists as any[]}
                                getKey={(entity: any) => entity.id || entity.name || ''}
                                estimatedRowHeight={(colWidth) => colWidth + 40}
                                scrollParentRef={pageRef}
                                renderItem={(entity: any) => {
                                    const artistName = entity.name || '';
                                    if (!entity.id) return <ArtistCard artist={artistName} />;
                                    const artistHref = `/library/artist/${entity.id}`;
                                    const artistHero: ArtistHeroState = {
                                        kind: 'artist',
                                        name: artistName,
                                        imageUrl: (entity as any).image_url || (entity as any).artwork_url || undefined,
                                        backLabel: 'Back to Library',
                                    };
                                    return (
                                        <ArtistLink
                                            to={artistHref}
                                            state={artistHero}
                                        >
                                            <ArtistCard artist={artistName} imageUrl={(entity as any).image_url || (entity as any).artwork_url || undefined} />
                                        </ArtistLink>
                                    );
                                }}
                            />
                        )}
                    </section>
                )}

                {showGenres && (
                    <section className="library-section">
                        {taxonomyLoading ? (
                            <GenreRailSkeleton />
                        ) : genres.length === 0 ? (
                           <p style={{ color: 'var(--color-text-muted)' }}>No genres found in your library.</p>
                        ) : genreRails.length > 0 ? (
                            <div className="genre-rails">
                                {genreRails.map((rail) => (
                                    <section key={rail.root}>
                                        <h2 className="genre-rail__title">
                                            {rail.rootEntity ? (
                                                <Link
                                                    to={`/library/genre/${rail.rootEntity.id}`}
                                                    state={{ backLabel: 'Back to Library' }}
                                                    className="genre-rail__title-link"
                                                >
                                                    {rail.root}
                                                </Link>
                                            ) : rail.root}
                                        </h2>
                                        <HorizontalScrollRail
                                            ariaLabel={`${rail.root} genres`}
                                            viewportClassName="genre-rail__track"
                                        >
                                            {rail.members.map((member) =>
                                                renderGenreTile(member.name, 'genre-rail__item')
                                            )}
                                        </HorizontalScrollRail>
                                    </section>
                                ))}
                                {looseGenres.length > 0 && (
                                    <section>
                                        <h2 className="genre-rail__title">Other genres</h2>
                                        <div className="genre-grid">
                                            {looseGenres.map((genreName) => renderGenreTile(genreName))}
                                        </div>
                                    </section>
                                )}
                            </div>
                        ) : (
                            <div className="genre-grid">
                                {genres.map((genreName) => renderGenreTile(genreName))}
                            </div>
                        )}
                    </section>
                )}
            </div>

            <QueryBuilderModal
                view={queryBuilderView}
                isOpen={queryBuilderOpen}
                onClose={() => setQueryBuilderOpen(false)}
                onApply={handleApplyQuery}
                initialGroups={queryBuilderView === 'artists' ? artistFilters.queryGroups : albumFilters.queryGroups}
            />
        </div>
    );
};
