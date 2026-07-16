import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Disc3, MoreHorizontal, Music2, Play, RefreshCw, Search, UserRound } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { TrackInfo } from '../utils/fileSystem';
import { prefetchAlbumDetail, prefetchArtistDetail } from '../utils/routePrefetch';
import { AlbumArt } from './AlbumArt';
import { ArtistInitial } from './library/ArtistInitial';
import { useKnownArtistKeys } from '../hooks/useKnownArtistKeys';
import { buildArtistLinkMap, getTrackArtistDisplayNames, resolveArtistLink, resolveTrackArtistLink } from '../utils/artistLinks';

type RankedResultType = 'artist' | 'album' | 'track';

interface RankedApiResult {
    type: RankedResultType;
    relevance: number;
    item: Record<string, unknown>;
}

interface RankedApiResponse {
    results: RankedApiResult[];
    nextCursor: string | null;
}

interface ArtistResultItem {
    id: string;
    name: string;
    image_url?: string | null;
}

interface AlbumResultItem {
    id: string;
    title?: string | null;
    artist_name?: string | null;
    image_url?: string | null;
}

type RankedResult =
    | { type: 'artist'; relevance: number; item: ArtistResultItem }
    | { type: 'album'; relevance: number; item: AlbumResultItem }
    | { type: 'track'; relevance: number; item: TrackInfo };

const SEARCH_BATCH_SIZE = 30;

function getResultKey(result: RankedResult): string {
    return `${result.type}:${result.item.id}`;
}

function hydrateRankedResults(
    rows: RankedApiResult[],
    hydrateTracks: (tracks: TrackInfo[]) => TrackInfo[],
): RankedResult[] {
    const results: RankedResult[] = [];

    for (const row of rows) {
        if (!row || !row.item || typeof row.item.id !== 'string') continue;
        if (row.type === 'track') {
            const track = hydrateTracks([row.item as unknown as TrackInfo])[0];
            if (track) results.push({ type: 'track', relevance: row.relevance, item: track });
            continue;
        }
        if (row.type === 'artist' && typeof row.item.name === 'string') {
            results.push({ type: 'artist', relevance: row.relevance, item: row.item as unknown as ArtistResultItem });
            continue;
        }
        if (row.type === 'album') {
            results.push({ type: 'album', relevance: row.relevance, item: row.item as unknown as AlbumResultItem });
        }
    }

    return results;
}

const ResultKind = memo(({ type }: { type: RankedResultType }) => {
    const Icon = type === 'artist' ? UserRound : type === 'album' ? Disc3 : Music2;
    return (
        <span className="search-page-result-kind">
            <Icon size={12} aria-hidden="true" />
            {type}
        </span>
    );
});

ResultKind.displayName = 'ResultKind';

const SearchResultRow = memo(({
    result,
    onPlay,
    onContextMenu,
    artistLinkMap,
    knownArtistKeys,
}: {
    result: RankedResult;
    onPlay: (track: TrackInfo) => void;
    onContextMenu: (track: TrackInfo, x: number, y: number) => void;
    artistLinkMap: ReadonlyMap<string, string>;
    knownArtistKeys: Set<string>;
}) => {
    const navigate = useNavigate();

    if (result.type === 'artist') {
        const artist = result.item;
        return (
            <button
                type="button"
                onClick={() => navigate(`/library/artist/${encodeURIComponent(artist.id)}`, { state: { backLabel: 'Back to Search' } })}
                onPointerEnter={prefetchArtistDetail}
                onPointerDown={prefetchArtistDetail}
                onFocus={prefetchArtistDetail}
                className="search-page-result-row"
            >
                <span className="search-page-result-art search-page-result-art--artist">
                    <ArtistInitial name={artist.name} className="text-lg" />
                </span>
                <span className="search-page-result-copy">
                    <span className="search-page-result-title">{artist.name}</span>
                    <span className="search-page-result-meta">Artist in your library</span>
                </span>
                <ResultKind type="artist" />
            </button>
        );
    }

    if (result.type === 'album') {
        const album = result.item;
        const title = album.title || 'Unknown Album';
        const artist = album.artist_name || 'Unknown Artist';
        const artistLink = resolveArtistLink(artist, artistLinkMap);
        return (
            <div className="search-page-result-row">
                <button
                    type="button"
                    aria-label={`Open album ${title}`}
                    onClick={() => navigate(`/library/album/${encodeURIComponent(album.id)}`, { state: { backLabel: 'Back to Search' } })}
                    onPointerEnter={prefetchAlbumDetail}
                    onPointerDown={prefetchAlbumDetail}
                    onFocus={prefetchAlbumDetail}
                    className="search-page-album-art-button"
                >
                    <AlbumArt
                        artUrl={album.image_url || undefined}
                        artist={artist}
                        album={title}
                        size={56}
                        className="search-page-result-art"
                    />
                </button>
                <span className="search-page-result-copy">
                    <button
                        type="button"
                        onClick={() => navigate(`/library/album/${encodeURIComponent(album.id)}`, { state: { backLabel: 'Back to Search' } })}
                        onPointerEnter={prefetchAlbumDetail}
                        onPointerDown={prefetchAlbumDetail}
                        onFocus={prefetchAlbumDetail}
                        className="search-page-result-title search-page-track-title"
                    >
                        {title}
                    </button>
                    <span className="search-page-result-meta">
                        {artistLink ? (
                            <Link
                                to={artistLink}
                                state={{ backLabel: 'Back to Search' }}
                                onPointerEnter={prefetchArtistDetail}
                                onPointerDown={prefetchArtistDetail}
                                onFocus={prefetchArtistDetail}
                                className="search-result-artist-link"
                            >
                                {artist}
                            </Link>
                        ) : artist}
                    </span>
                </span>
                <ResultKind type="album" />
            </div>
        );
    }

    const track = result.item;
    const title = track.title || track.path.split(/[\\/]/).pop() || 'Unknown Track';
    const artistNames = getTrackArtistDisplayNames(track, knownArtistKeys);
    const canOpenAlbum = Boolean(track.albumId);

    return (
        <div className="search-page-result-row search-page-result-row--track group">
            <button
                type="button"
                aria-label={`Play ${title}`}
                onClick={() => onPlay(track)}
                className="search-page-track-play"
            >
                <AlbumArt
                    artUrl={track.artUrl}
                    artist={track.artist}
                    album={track.album}
                    size={56}
                    className="search-page-result-art"
                />
                <span className="search-page-track-play-overlay" aria-hidden="true">
                    <Play size={18} fill="currentColor" />
                </span>
            </button>
            <div className="search-page-result-copy search-page-track-link">
                <button
                    type="button"
                    disabled={!canOpenAlbum}
                    onClick={() => {
                        if (!track.albumId) return;
                        navigate(`/library/album/${encodeURIComponent(track.albumId)}?track=${encodeURIComponent(track.id)}`, {
                            state: { backLabel: 'Back to Search' },
                        });
                    }}
                    onPointerEnter={canOpenAlbum ? prefetchAlbumDetail : undefined}
                    onPointerDown={canOpenAlbum ? prefetchAlbumDetail : undefined}
                    onFocus={canOpenAlbum ? prefetchAlbumDetail : undefined}
                    className="search-page-result-title search-page-track-title"
                    aria-label={canOpenAlbum ? `Open ${track.album || 'album'} and highlight ${title}` : undefined}
                >
                    {title}
                </button>
                <span className="search-page-result-meta">
                    {artistNames.length > 0 ? artistNames.map((artistName, artistIndex) => {
                        const artistLink = resolveTrackArtistLink(artistName, artistIndex, track, artistLinkMap);
                        return (
                            <React.Fragment key={`${artistName}-${artistIndex}`}>
                                {artistIndex > 0 && ' · '}
                                {artistLink ? (
                                    <Link
                                        to={artistLink}
                                        state={{ backLabel: 'Back to Search' }}
                                        onPointerEnter={prefetchArtistDetail}
                                        onPointerDown={prefetchArtistDetail}
                                        onFocus={prefetchArtistDetail}
                                        className="search-result-artist-link"
                                    >
                                        {artistName}
                                    </Link>
                                ) : artistName}
                            </React.Fragment>
                        );
                    }) : 'Unknown Artist'}
                    {track.album ? ` · ${track.album}` : ''}
                </span>
            </div>
            <ResultKind type="track" />
            <button
                type="button"
                aria-label={`More options for ${title}`}
                onClick={event => onContextMenu(track, event.clientX, event.clientY)}
                className="search-page-row-action search-result-context-action"
            >
                <MoreHorizontal size={18} />
            </button>
        </div>
    );
});

SearchResultRow.displayName = 'SearchResultRow';

const SearchPageSkeleton = () => (
    <div className="search-page-results" aria-hidden="true">
        {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="search-page-result-row search-page-result-skeleton">
                <span className="search-page-result-art" />
                <span className="search-page-result-copy">
                    <span className="search-page-skeleton-line search-page-skeleton-line--title" />
                    <span className="search-page-skeleton-line search-page-skeleton-line--meta" />
                </span>
            </div>
        ))}
    </div>
);

export const SearchResultsPage: React.FC = () => {
    const [searchParams] = useSearchParams();
    const query = (searchParams.get('q') || '').trim();
    const hydrateTracks = usePlayerStore(state => state.hydrateTracks);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);
    const openContextMenu = usePlayerStore(state => state.openContextMenu);
    const artists = usePlayerStore(state => state.artists);
    const knownArtistKeys = useKnownArtistKeys();
    const [results, setResults] = useState<RankedResult[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const requestRef = useRef<AbortController | null>(null);
    const loadingRef = useRef(false);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const artistLinkMap = React.useMemo(() => buildArtistLinkMap(artists), [artists]);

    const loadPage = useCallback(async (cursor: string | null, replace: boolean) => {
        if (!query || loadingRef.current) return;

        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        loadingRef.current = true;
        setLoading(true);
        setError(null);

        const params = new URLSearchParams({
            mode: 'ranked',
            q: query,
            limit: String(SEARCH_BATCH_SIZE),
        });
        if (cursor) params.set('cursor', cursor);

        try {
            const response = await fetch(`/api/library/search?${params.toString()}`, {
                headers: getAuthHeader(),
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(response.status === 400 ? 'This search link is no longer valid.' : 'Search could not be loaded.');
            const data = await response.json() as RankedApiResponse;
            const incoming = hydrateRankedResults(Array.isArray(data.results) ? data.results : [], hydrateTracks);

            setResults(previous => {
                if (replace) return incoming;
                const seen = new Set(previous.map(getResultKey));
                return [...previous, ...incoming.filter(result => !seen.has(getResultKey(result)))];
            });
            setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
        } catch (requestError) {
            if (controller.signal.aborted) return;
            setError(requestError instanceof Error ? requestError.message : 'Search could not be loaded.');
        } finally {
            if (requestRef.current === controller) {
                requestRef.current = null;
                loadingRef.current = false;
                setLoading(false);
            }
        }
    }, [getAuthHeader, hydrateTracks, query]);

    useEffect(() => {
        requestRef.current?.abort();
        loadingRef.current = false;
        setResults([]);
        setNextCursor(null);
        setError(null);
        if (query) void loadPage(null, true);

        return () => requestRef.current?.abort();
    }, [loadPage, query]);

    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || !nextCursor || loading || error) return;

        const observer = new IntersectionObserver(entries => {
            if (entries[0]?.isIntersecting) void loadPage(nextCursor, false);
        }, { rootMargin: '480px 0px' });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [error, loadPage, loading, nextCursor]);

    const handlePlay = useCallback((track: TrackInfo) => {
        setPlaylist([track], 0);
    }, [setPlaylist]);

    const handleContextMenu = useCallback((track: TrackInfo, x: number, y: number) => {
        openContextMenu(track, x, y);
    }, [openContextMenu]);

    const initialLoading = loading && results.length === 0;
    const noResults = !loading && !error && query.length > 0 && results.length === 0;

    return (
        <main className="page-container search-page">
            <header className="search-page-header">
                <span className="search-page-header-icon" aria-hidden="true"><Search size={20} /></span>
                <div className="min-w-0">
                    <p className="search-page-eyebrow">Library search</p>
                    <h1 className="search-page-title">
                        {query ? <>Results for <span>&ldquo;{query}&rdquo;</span></> : 'Search your library'}
                    </h1>
                    {results.length > 0 ? (
                        <p className="search-page-count">{results.length} result{results.length === 1 ? '' : 's'} loaded</p>
                    ) : null}
                </div>
            </header>

            {!query ? (
                <div className="search-page-empty">
                    <Search size={36} strokeWidth={1.4} aria-hidden="true" />
                    <h2>Enter a search above</h2>
                    <p>Find artists, albums, and tracks from your library.</p>
                </div>
            ) : initialLoading ? (
                <SearchPageSkeleton />
            ) : noResults ? (
                <div className="search-page-empty" role="status">
                    <Search size={36} strokeWidth={1.4} aria-hidden="true" />
                    <h2>No results found</h2>
                    <p>Try a different artist, album, or track name.</p>
                </div>
            ) : (
                <div className="search-page-results" aria-live="polite">
                    {results.map(result => (
                        <SearchResultRow
                            key={getResultKey(result)}
                            result={result}
                            onPlay={handlePlay}
                            onContextMenu={handleContextMenu}
                            artistLinkMap={artistLinkMap}
                            knownArtistKeys={knownArtistKeys}
                        />
                    ))}

                    {error ? (
                        <div className="search-page-load-state" role="alert">
                            <p>{error}</p>
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => void loadPage(results.length > 0 ? nextCursor : null, results.length === 0)}
                            >
                                <RefreshCw size={15} />
                                Retry
                            </button>
                        </div>
                    ) : null}

                    {loading && results.length > 0 ? (
                        <div className="search-page-load-state" role="status">Loading more results…</div>
                    ) : null}

                    <div ref={sentinelRef} className="search-page-sentinel" aria-hidden="true" />
                    {!nextCursor && results.length > 0 && !error ? (
                        <p className="search-page-end">Showing all confident matches</p>
                    ) : null}
                </div>
            )}
        </main>
    );
};

export default SearchResultsPage;
