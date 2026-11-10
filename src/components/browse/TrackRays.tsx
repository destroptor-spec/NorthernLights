import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2, Play, X } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { fetchTaxonomy, fetchTrackRays, genrePath, setTrackStyle, stylePath } from '../../api/browse';
import { toPlayableTracks } from '../../utils/playableTracks';
import { BackButton } from '../library/BackButton';
import { StylePicker, type GenreTaxonomy } from '../settings/StylePicker';
import { BrowseError } from './browseParts';
import type { StyleProfileEntry, TrackRays as Rays } from '../../../shared/api/v1';
import type { GenreTarget } from '../../../shared/genreReview';

type StyleRow = Rays['styles'][number];

const ROLE_LABEL: Record<string, string> = { 'dj-mixer': 'DJ mixer', 'original-artist': 'Original artist' };
const roleLabel = (role: string) => ROLE_LABEL[role] || role.charAt(0).toUpperCase() + role.slice(1).replace(/-/g, ' ');

const styleLabel = (row: { genre: string; style: string | null }) => row.style ? `${row.genre} › ${row.style}` : row.genre;
const linkFor = (row: { genre: string; styleId: number | null }) => row.styleId === null ? genrePath(row.genre) : stylePath(row.styleId);

/** Where a genre or style came from, in words. */
function sourceText(row: StyleRow): string {
  switch (row.source) {
    case 'tag': return row.fromTags.length
      ? `From the file tag ${row.fromTags.map(t => `“${t}”`).join(', ')}`
      : 'From the file tags';
    case 'audio': return 'From the sound';
    case 'artist': return "From the artist's tags on Last.fm and MusicBrainz";
    case 'override': return 'Set by hand';
  }
}

/** One person per row in a role, with every instrument or detail they're credited for. */
function groupCredits(credits: Rays['credits']) {
  const roles = new Map<string, Map<string, { artistId: string; name: string; details: string[] }>>();
  for (const c of credits) {
    const people = roles.get(c.role) || new Map();
    const person = people.get(c.artistId) || { artistId: c.artistId, name: c.name, details: [] };
    if (c.detail && !person.details.includes(c.detail)) person.details.push(c.detail);
    people.set(c.artistId, person);
    roles.set(c.role, people);
  }
  return [...roles.entries()].map(([role, people]) => ({ role, people: [...people.values()] }));
}

/**
 * The track's strongest style against its album's: "Ballad, like 47 % of
 * Autobiography" or "Glitch, where Downtempo leads Taking Up Your Precious
 * Time (60 %)". Exact shares, never "most" for less than half.
 */
function contextLine(rays: Rays): string | null {
  const own = rays.styles.find(s => s.styleId !== null);
  const albumTop = rays.album?.entries.find(e => e.styleId !== null);
  if (!own || !albumTop || !rays.album) return null;
  const share = `${Math.round(albumTop.share * 100)} %`;
  if (own.styleId === albumTop.styleId) return `${own.style}, like ${share} of ${rays.album.title}.`;
  return `${own.style}, where ${albumTop.style} leads ${rays.album.title} (${share}).`;
}

const ProfileChips: React.FC<{ entries: StyleProfileEntry[] }> = ({ entries }) => (
  <ul className="rays-chips">
    {entries.map(e => (
      <li key={`${e.genre}|${e.styleId}`}>
        <Link to={linkFor(e)} className="rays-chip">
          {e.style ?? e.genre}
          <span className="rays-chip__share">{Math.round(e.share * 100)} %</span>
        </Link>
      </li>
    ))}
  </ul>
);

/** A 0–1 value between two words, e.g. Acoustic ↔ Electronic. */
const SoundMeter: React.FC<{ label: string; low: string; high: string; value: number }> = ({ label, low, high, value }) => (
  <div className="rays-meter">
    <span className="rays-meter__label">{label}</span>
    <div className="rays-meter__bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)} aria-valuetext={`${Math.round(value * 100)} % ${high.toLowerCase()}`}>
      <span style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
    <span className="rays-meter__ends"><span>{low}</span><span>{high}</span></span>
  </div>
);

/**
 * "Aurora rays from {title}": everything Aurora knows about one track:
 * credits, its genres and styles and where each came from, how it sounds,
 * how it sits in its album and artist, and other albums with the recording.
 */
export const TrackRays: React.FC = () => {
  const { trackId = '' } = useParams<{ trackId: string }>();
  const navigate = useNavigate();
  const isAdmin = usePlayerStore(s => s.currentUser?.role === 'admin');
  const [rays, setRays] = useState<Rays | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [taxonomy, setTaxonomy] = useState<GenreTaxonomy | null>(null);
  const [adding, setAdding] = useState<GenreTarget[]>([]);

  const load = useCallback(() => {
    setError(null);
    return fetchTrackRays(usePlayerStore.getState().getAuthHeader(), trackId)
      .then(setRays)
      .catch((e: { status?: number }) => setError(e?.status === 404
        ? { message: 'This track is no longer in the library.', missing: true }
        : { message: 'Could not load this track.', missing: false }));
  }, [trackId]);
  useEffect(() => { setRays(null); void load(); }, [load]);

  useEffect(() => {
    if (!isAdmin) return;
    fetchTaxonomy(usePlayerStore.getState().getAuthHeader()).then(setTaxonomy).catch(() => {});
  }, [isAdmin]);

  const change = async (target: { genre: string; styleId: number | null; style: string | null }, action: 'add' | 'remove', undoable = true) => {
    const { getAuthHeader, addToast } = usePlayerStore.getState();
    const key = `${action}:${target.genre}|${target.styleId}`;
    setSaving(key);
    try {
      await setTrackStyle(getAuthHeader(), trackId, { genre: target.genre, styleId: target.styleId, action });
      await load();
      const label = styleLabel(target);
      addToast(action === 'remove' ? `Removed ${label}` : `Added ${label}`, 'success', undoable ? {
        actionLabel: 'Undo',
        onAction: () => { void change(target, action === 'remove' ? 'add' : 'remove', false); },
      } : undefined);
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not save the change.', 'error');
    } finally {
      setSaving(null);
    }
  };

  const play = async () => {
    if (!rays) return;
    await usePlayerStore.getState().setPlaylist(toPlayableTracks([rays.track]), 0, null);
  };

  const credits = useMemo(() => (rays ? groupCredits(rays.credits) : []), [rays]);
  const context = rays ? contextLine(rays) : null;
  const track = rays?.track;
  const artistName = track?.artist;

  return (
    <div className="genre-detail page-container browse rays">
      <BackButton onClick={() => navigate(-1)} />

      {error && (error.missing ? <p className="browse-empty">{error.message}</p> : <BrowseError message={error.message} onRetry={load} />)}
      {!rays && !error && (
        <div className="h-24 w-2/3 max-w-xl rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" aria-hidden="true" />
      )}

      {rays && track && (
        <>
          <header className="browse-hero">
            <h1 className="rays-title">
              <span className="rays-title__lead">Aurora rays from</span>
              <span className="browse-hero__title">{track.title}</span>
            </h1>
            <p className="browse-hero__meta">
              {rays.artist ? <Link to={`/library/artist/${rays.artist.id}`} className="rays-link">{artistName}</Link> : artistName}
              {rays.album && <> · <Link to={`/library/album/${rays.album.id}`} className="rays-link">{rays.album.title}</Link></>}
              {track.year ? ` · ${track.year}` : ''}
            </p>
            <div className="browse-hero__actions">
              <button type="button" className="btn btn-primary" onClick={() => void play()}>
                <Play size={16} fill="currentColor" aria-hidden="true" /> Play
              </button>
            </div>
          </header>

          {credits.length > 0 && (
            <section className="browse-section" aria-label="Credits">
              <h2 className="browse-section__title">Credits</h2>
              <dl className="rays-credits">
                {credits.map(({ role, people }) => (
                  <div key={role} className="rays-credits__row">
                    <dt>{roleLabel(role)}</dt>
                    <dd>
                      {people.map((p, i) => (
                        <React.Fragment key={p.artistId}>
                          {i > 0 && ', '}
                          <Link to={`/library/artist/${p.artistId}`} className="rays-link">{p.name}</Link>
                          {p.details.length > 0 && <span className="rays-muted"> ({p.details.join(', ')})</span>}
                        </React.Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section className="browse-section" aria-label="Genres and styles">
            <h2 className="browse-section__title">Genres and styles</h2>
            {rays.styles.length === 0
              ? <p className="browse-empty">Aurora hasn't placed this track in a genre yet{rays.tags.length ? ` (its tags: ${rays.tags.join(', ')})` : ''}.</p>
              : (
                <ul className="browse-index browse-index--single">
                  {rays.styles.map(row => {
                    const key = `${row.genre}|${row.styleId}`;
                    return (
                      <li key={key} className="rays-style">
                        <Link to={linkFor(row)} className="browse-index__row rays-style__row">
                          <span className="rays-style__name">
                            <span>{styleLabel(row)}</span>
                            <span className="rays-muted">{sourceText(row)}</span>
                          </span>
                        </Link>
                        {isAdmin && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm btn-icon rays-style__remove"
                            onClick={() => void change(row, 'remove')}
                            disabled={saving !== null}
                            aria-label={`Remove ${styleLabel(row)} from this track`}
                          >
                            {saving === `remove:${key}` ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            {isAdmin && (
              <div className="rays-add">
                <StylePicker taxonomy={taxonomy} value={adding} onChange={setAdding} disabled={saving !== null} label="Add a genre or style to this track" />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={adding.length === 0 || saving !== null}
                  onClick={async () => { for (const t of adding) await change(t, 'add'); setAdding([]); }}
                >
                  Add
                </button>
              </div>
            )}
          </section>

          {rays.sound && (
            <section className="browse-section" aria-label="Sound">
              <h2 className="browse-section__title">Sound</h2>
              <p className="browse-section__lede">From Aurora's analysis of the audio file.</p>
              <div className="rays-sound">
                <SoundMeter label="Energy" low="Calm" high="Energetic" value={rays.sound.energy} />
                <SoundMeter label="Danceability" low="Still" high="Danceable" value={rays.sound.danceability} />
                <SoundMeter label="Character" low="Acoustic" high="Electronic" value={1 - rays.sound.acousticness} />
                <SoundMeter label="Voice" low="Vocal" high="Instrumental" value={rays.sound.instrumentalness} />
              </div>
              {rays.sound.bpm && <p className="rays-fact">Tempo <strong>{rays.sound.bpm} BPM</strong></p>}
              {rays.sound.closestStyles.length > 0 && (
                <div className="rays-closest">
                  <span className="rays-muted">Closest styles by sound</span>
                  <ul className="rays-chips">
                    {rays.sound.closestStyles.map(s => (
                      <li key={s.styleId}>
                        <Link to={stylePath(s.styleId)} className="rays-chip">{s.style}<span className="rays-chip__share">{s.genre}</span></Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {(rays.album || rays.artist) && (
            <section className="browse-section" aria-label="In context">
              <h2 className="browse-section__title">In context</h2>
              {context && <p className="rays-context">{context}</p>}
              {rays.album && rays.album.entries.length > 0 && (
                <div className="rays-profile">
                  <span className="rays-muted">The album, {rays.album.title}</span>
                  <ProfileChips entries={rays.album.entries} />
                </div>
              )}
              {rays.artist && rays.artist.entries.length > 0 && (
                <div className="rays-profile">
                  <span className="rays-muted">{rays.artist.name}, each album counted once</span>
                  <ProfileChips entries={rays.artist.entries} />
                </div>
              )}
              {rays.artist && rays.artist.listenerTags.length > 0 && (
                <div className="rays-profile">
                  <span className="rays-muted">What listeners tag {rays.artist.name} with on Last.fm and MusicBrainz</span>
                  <ul className="rays-chips">
                    {rays.artist.listenerTags.map(t => <li key={t}><span className="rays-chip rays-chip--plain">{t}</span></li>)}
                  </ul>
                </div>
              )}
            </section>
          )}

          {rays.otherAlbums.length > 0 && (
            <section className="browse-section" aria-label="Also on">
              <h2 className="browse-section__title">Also on</h2>
              <ul className="browse-index browse-index--single">
                {rays.otherAlbums.map(o => (
                  <li key={o.trackId}>
                    {o.albumId ? (
                      <Link to={`/library/album/${o.albumId}`} className="browse-index__row">
                        <span className="browse-index__name">{o.albumTitle}</span>
                        <span className="browse-index__count">{[o.artistName, o.year].filter(Boolean).join(' · ')}</span>
                      </Link>
                    ) : (
                      <span className="browse-index__row">
                        <span className="browse-index__name">{o.albumTitle}</span>
                        <span className="browse-index__count">{[o.artistName, o.year].filter(Boolean).join(' · ')}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
};
