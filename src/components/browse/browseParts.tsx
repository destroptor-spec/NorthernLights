import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Shuffle } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { auroraApiRequest, type Track } from '../../api/auroraApi';
import {
  fetchBrowseAlbums,
  fetchBrowseArtists,
  fetchBrowseMix,
  type BrowseFilter,
} from '../../api/browse';
import { toPlayableTracks } from '../../utils/playableTracks';
import { AlbumCard, AlbumCardSkeleton } from '../library/AlbumCard';
import { ArtistInitial } from '../library/ArtistInitial';
import type { BrowseAlbum, BrowseArtist, BrowseDecade } from '../../../shared/api/v1';

/**
 * Starts playback from Browse. Shuffle plays a mix the server picks: a
 * handful of a genre's or style's strongest tracks (15 to 30, or all of a
 * small one), spread over artists; Infinity mode, when on, carries on from
 * there. An album plays in order. `busy` names the control that is loading,
 * so only its button shows a spinner.
 */
export function useBrowsePlayer() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, load: () => Promise<Track[]>, source?: { kind: 'album'; id: string }) => {
    const { setPlaylist, addToast } = usePlayerStore.getState();
    setBusy(key);
    try {
      const tracks = toPlayableTracks(await load());
      if (tracks.length === 0) { addToast('No tracks to play here yet.', 'info'); return; }
      await setPlaylist(tracks, 0, source ?? null);
    } catch {
      addToast('Could not load these tracks. Try again.', 'error');
    } finally {
      setBusy(current => (current === key ? null : current));
    }
  }, []);

  const playFilter = useCallback((key: string, filter: BrowseFilter) => run(key, () =>
    fetchBrowseMix(usePlayerStore.getState().getAuthHeader(), filter)), [run]);

  const playAlbum = useCallback((albumId: string) => run(`album:${albumId}`, async () =>
    (await auroraApiRequest<{ tracks: Track[] }>(`/albums/${encodeURIComponent(albumId)}`, usePlayerStore.getState().getAuthHeader())).tracks,
  { kind: 'album', id: albumId }), [run]);

  return { busy, playFilter, playAlbum };
}

/** The primary action of a genre or style page. */
export const ShuffleButton: React.FC<{ busy: boolean; onClick: () => void; label: string }> = ({ busy, onClick, label }) => (
  <button type="button" className="btn btn-primary" onClick={onClick} disabled={busy} aria-label={label}>
    {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Shuffle size={16} aria-hidden="true" />}
    Shuffle
  </button>
);

/** "Play the 1990s": one button per decade that has tracks. */
export const DecadeButtons: React.FC<{
  decades: BrowseDecade[]; busyKey: string | null; keyPrefix: string; name: string; onPlay: (decade: number) => void;
}> = ({ decades, busyKey, keyPrefix, name, onPlay }) => {
  const shown = decades.filter(d => d.trackCount > 0);
  if (shown.length < 2) return null;
  return (
    <div className="browse-decades" role="group" aria-label={`Shuffle ${name} by decade`}>
      <span className="browse-decades__label">By decade</span>
      {shown.map(d => {
        const busy = busyKey === `${keyPrefix}:${d.decade}`;
        return (
          <button
            key={d.decade}
            type="button"
            className="btn btn-tab btn-sm"
            onClick={() => onPlay(d.decade)}
            disabled={busy}
            aria-label={`Shuffle ${name} from the ${d.decade}s, ${d.trackCount} tracks`}
          >
            {busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {d.decade}s
          </button>
        );
      })}
    </div>
  );
};

/** A stored cover (by its art hash), with the media token the art route needs. */
export const coverUrlFor = (artworkId: string | null | undefined): string | undefined => {
  if (!artworkId) return undefined;
  const token = usePlayerStore.getState().mediaAccessToken || '';
  return `/api/art?hash=${encodeURIComponent(artworkId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
};

const albumArtUrl = (album: BrowseAlbum['album']) => coverUrlFor(album.artworkId) || album.imageUrl || undefined;

/** "12 of 29 tracks" when only part of the album is in the genre or style. */
const albumSubtitle = (item: BrowseAlbum) => {
  const { album, trackCount } = item;
  const part = trackCount < album.trackCount ? ` · ${trackCount} of ${album.trackCount} tracks` : '';
  return `${album.artistName}${part}`;
};

/** A section that shows its first page and loads more on request. */
function usePagedSection<T>(initial: T[], load: (count: number) => Promise<T[]>, pageSize = 24) {
  const [items, setItems] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [complete, setComplete] = useState(initial.length < pageSize);
  useEffect(() => { setItems(initial); setComplete(initial.length < pageSize); }, [initial, pageSize]);
  const more = async () => {
    setLoading(true);
    try {
      const next = await load(items.length + pageSize);
      setItems(next);
      setComplete(next.length < items.length + pageSize);
    } catch {
      usePlayerStore.getState().addToast('Could not load more. Try again.', 'error');
    } finally {
      setLoading(false);
    }
  };
  return { items, loading, complete, more };
}

const MoreButton: React.FC<{ loading: boolean; onClick: () => void; label: string }> = ({ loading, onClick, label }) => (
  <button type="button" className="btn btn-ghost btn-sm browse-more" onClick={onClick} disabled={loading}>
    {loading && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
    {label}
  </button>
);

export const BrowseAlbumGrid: React.FC<{
  filter: BrowseFilter; initial: BrowseAlbum[]; title: string; backLabel: string;
  onPlay: (albumId: string) => void;
}> = ({ filter, initial, title, backLabel, onPlay }) => {
  const load = useCallback(async (count: number) =>
    (await fetchBrowseAlbums(usePlayerStore.getState().getAuthHeader(), filter, null, count)).data, [filter]);
  const { items, loading, complete, more } = usePagedSection(initial, load);
  if (items.length === 0) return null;
  return (
    <section className="browse-section" aria-label={title}>
      <h2 className="browse-section__title">{title}</h2>
      <div className="album-grid">
        {items.map(item => (
          <AlbumCard
            key={item.album.id}
            title={item.album.title}
            artist={item.album.artistName}
            artUrl={albumArtUrl(item.album)}
            subtitle={albumSubtitle(item)}
            editionLabel={item.album.editionLabel}
            linkTo={`/library/album/${item.album.id}`}
            linkState={{ backLabel }}
            onPlay={() => onPlay(item.album.id)}
          />
        ))}
      </div>
      {!complete && <MoreButton loading={loading} onClick={more} label="Show more albums" />}
    </section>
  );
};

export const BrowseArtistGrid: React.FC<{ filter: BrowseFilter; initial: BrowseArtist[]; title: string; backLabel: string; name: string }> = ({
  filter, initial, title, backLabel, name,
}) => {
  const load = useCallback(async (count: number) =>
    (await fetchBrowseArtists(usePlayerStore.getState().getAuthHeader(), filter, null, count)).data, [filter]);
  const { items, loading, complete, more } = usePagedSection(initial, load);
  if (items.length === 0) return null;
  return (
    <section className="browse-section" aria-label={title}>
      <h2 className="browse-section__title">{title}</h2>
      <div className="artist-grid">
        {items.map(({ artist, share, albumCount }) => (
          <Link key={artist.id} to={`/library/artist/${artist.id}`} state={{ backLabel }} className="browse-artist no-underline">
            <span className="browse-artist__image" aria-hidden="true">
              {artist.imageUrl
                ? <img src={artist.imageUrl} alt="" loading="lazy" decoding="async" />
                : <ArtistInitial name={artist.name} className="text-3xl md:text-4xl text-[var(--color-primary)] opacity-60" />}
            </span>
            <span className="browse-artist__name">{artist.name}</span>
            <span className="browse-artist__meta">
              {share >= 0.995 ? `${albumCount} ${albumCount === 1 ? 'album' : 'albums'}` : `${Math.round(share * 100)} % ${name}`}
            </span>
          </Link>
        ))}
      </div>
      {!complete && <MoreButton loading={loading} onClick={more} label="Show more artists" />}
    </section>
  );
};

export const BrowseGridSkeleton: React.FC<{ count?: number }> = ({ count = 12 }) => (
  <div className="album-grid" aria-hidden="true">
    {Array.from({ length: count }).map((_, i) => <AlbumCardSkeleton key={i} />)}
  </div>
);

/** Loading failed: say so and offer Retry. */
export const BrowseError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="browse-error" role="alert">
    <p>{message}</p>
    <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Retry</button>
  </div>
);
