import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Shuffle } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { auroraApiRequest, type Track } from '../../api/auroraApi';
import {
  fetchBrowseAlbums,
  fetchBrowseArtists,
  fetchBrowseMix,
  stylePath,
  type BrowseFilter,
} from '../../api/browse';
import { toPlayableTracks } from '../../utils/playableTracks';
import { AlbumCard, AlbumCardSkeleton } from '../library/AlbumCard';
import { AlbumArt } from '../AlbumArt';
import { ArtistInitial } from '../library/ArtistInitial';
import { AuroraCard } from './AuroraCard';
import type { BrowseAlbum, BrowseArtist, BrowseCountry, BrowseDecade, BrowseStyleRef } from '../../../shared/api/v1';
import { countryName } from '../../../shared/places';

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

/**
 * Shuffle, narrowed by decade and country: each row is a set of toggles (one
 * pick per row, again to clear), and the one Shuffle plays what's picked:
 * "Hip Hop · Denmark · 1990s". A row with fewer than two choices is hidden.
 */
export const ShuffleFilters: React.FC<{
  name: string;
  decades: BrowseDecade[];
  countries: BrowseCountry[];
  busy: boolean;
  onShuffle: (narrow: { decade?: number; country?: string }) => void;
}> = ({ name, decades, countries, busy, onShuffle }) => {
  const [decade, setDecade] = useState<number | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const shownDecades = decades.filter(d => d.trackCount > 0);
  const parts = [country ? countryName(country) : null, decade !== null ? `${decade}s` : null].filter(Boolean);
  const label = `Shuffle ${[name, ...parts].join(' · ')}`;
  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => onShuffle({ decade: decade ?? undefined, country: country ?? undefined })}
        disabled={busy}
        aria-label={label}
      >
        {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Shuffle size={16} aria-hidden="true" />}
        Shuffle{parts.length > 0 && <span className="browse-shuffle__narrow">· {parts.join(' · ')}</span>}
      </button>
      {(shownDecades.length > 1 || countries.length > 1) && (
        <div className="browse-filters">
          {shownDecades.length > 1 && (
            <div className="browse-decades" role="group" aria-label={`Narrow Shuffle ${name} to a decade`}>
              <span className="browse-decades__label">Decade</span>
              {shownDecades.map(d => (
                <button
                  key={d.decade}
                  type="button"
                  className={`btn btn-tab btn-sm${decade === d.decade ? ' active' : ''}`}
                  aria-pressed={decade === d.decade}
                  onClick={() => setDecade(current => (current === d.decade ? null : d.decade))}
                  title={`${d.trackCount.toLocaleString()} ${d.trackCount === 1 ? 'track' : 'tracks'}`}
                >
                  {d.decade}s
                </button>
              ))}
            </div>
          )}
          {countries.length > 1 && (
            <div className="browse-decades" role="group" aria-label={`Narrow Shuffle ${name} to a country`}>
              <span className="browse-decades__label">Country</span>
              {countries.map(c => (
                <button
                  key={c.country}
                  type="button"
                  className={`btn btn-tab btn-sm${country === c.country ? ' active' : ''}`}
                  aria-pressed={country === c.country}
                  onClick={() => setCountry(current => (current === c.country ? null : c.country))}
                  title={`${c.trackCount.toLocaleString()} ${c.trackCount === 1 ? 'track' : 'tracks'}`}
                >
                  {countryName(c.country)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
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

/**
 * "Sounds close to": nearby styles as Browse cards. The line under each name
 * is its genre, since the nearest styles often sit in another one; Play
 * shuffles the style. Compact: one row of smaller cards, for a page where
 * the styles support something else (a track's rays).
 */
export const NearStyleCards: React.FC<{
  styles: BrowseStyleRef[]; backLabel: string; busy: string | null;
  onPlay: (style: BrowseStyleRef) => void; compact?: boolean;
}> = ({ styles, backLabel, busy, onPlay, compact = false }) => (
  <div className={compact ? 'browse-card-grid browse-card-grid--compact' : 'browse-card-grid'}>
    {styles.map(style => (
      <AuroraCard
        key={style.id}
        name={style.name}
        meta={style.genre}
        to={stylePath(style.id)}
        backLabel={backLabel}
        onPlay={() => onPlay(style)}
        busy={busy === `style:${style.id}`}
      />
    ))}
  </div>
);

/** A small album cover, as everywhere else: rounded and clipped. */
export const CoverThumb: React.FC<{ artworkId: string | null; title: string; artist?: string }> = ({ artworkId, title, artist }) => (
  <span className="rays-cover" aria-hidden="true">
    <AlbumArt artUrl={coverUrlFor(artworkId)} album={title} artist={artist} size={96} className="w-full h-full object-cover" />
  </span>
);
