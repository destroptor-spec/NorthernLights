import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Loader2, Play, User2, X } from 'lucide-react';
import { HorizontalScrollRail } from '../HorizontalScrollRail';
import { usePlayerStore } from '../../store/index';
import { fetchTaxonomy, fetchTrackRays, genrePath, setTrackStyle, stylePath } from '../../api/browse';
import { toPlayableTracks } from '../../utils/playableTracks';
import { useArtistData } from '../../hooks/useArtistData';
import { AlbumArt } from '../AlbumArt';
import { BackButton } from '../library/BackButton';
import { ArtistInitial } from '../library/ArtistInitial';
import { FadedHeroImage } from '../library/FadedHeroImage';
import { StylePicker, type GenreTaxonomy } from '../settings/StylePicker';
import { BrowseError, coverUrlFor } from './browseParts';
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

/**
 * One card per person (or group), with every role they're credited for on
 * the track in role order, and every instrument or detail. A producer who
 * also wrote, mixed and played is one card, not five rows.
 */
function creditsByPerson(credits: Rays['credits']) {
  const people = new Map<string, { key: string; artistId: string | null; name: string; imageUrl: string | null; roles: string[]; details: string[] }>();
  for (const c of credits) {
    // A billed name without a library artist groups by its name.
    const key = c.artistId ?? `name:${c.name.toLowerCase()}`;
    const person = people.get(key) || { key, artistId: c.artistId, name: c.name, imageUrl: c.imageUrl, roles: [], details: [] };
    if (!person.roles.includes(c.role)) person.roles.push(c.role);
    if (c.detail && !person.details.includes(c.detail)) person.details.push(c.detail);
    if (!person.imageUrl && c.imageUrl) person.imageUrl = c.imageUrl;
    people.set(key, person);
  }
  return [...people.values()];
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

/**
 * A credited person as a card in a rail, like the radio cards in the Hub's
 * "uniquely yours" rail: a square cover (their image, or the radio cover
 * gradient with a person icon), their first role as the badge, the name and
 * every role and instrument below.
 */
const CreditCard: React.FC<{ person: ReturnType<typeof creditsByPerson>[number] }> = ({ person }) => {
  const [failed, setFailed] = useState(false);
  const roles = person.roles.map(roleLabel).join(' · ');
  const label = `${person.name}: ${roles}${person.details.length ? `, ${person.details.join(', ')}` : ''}`;
  const className = 'group relative flex w-[min(52vw,200px)] shrink-0 snap-start flex-col gap-2.5 no-underline transition-ui duration-200 hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 sm:w-[190px] sm:gap-3';
  const body = (
    <>
      <div className="relative w-full aspect-square rounded-[var(--radius)] overflow-hidden shadow-md ring-1 ring-black/10" aria-hidden="true">
        {person.imageUrl && !failed ? (
          <img src={person.imageUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <>
            <div className="absolute inset-0" style={{ background: 'var(--gradient-cover-artist-radio)' }} />
            <User2 className="absolute right-4 bottom-4 w-12 h-12 text-white/70 drop-shadow" strokeWidth={1.5} />
          </>
        )}
        <span className="absolute top-2.5 left-2.5 text-[10px] font-bold uppercase tracking-[0.15em] text-white/95 bg-black/35 backdrop-blur-sm px-2 py-0.5 rounded-full">
          {roleLabel(person.roles[0]).toLowerCase()}
        </span>
      </div>
      <div className="px-0.5">
        <p className="font-semibold text-sm text-[var(--color-text-primary)] line-clamp-2 leading-tight group-hover:text-[var(--color-primary)] transition-colors">
          {person.name}
        </p>
        <p className="mt-1 line-clamp-3 text-xs leading-snug text-[var(--color-text-muted)]" title={roles}>
          {roles}{person.details.length > 0 && <span className="block">{person.details.join(', ')}</span>}
        </p>
      </div>
    </>
  );
  return person.artistId
    ? <Link to={`/library/artist/${person.artistId}`} className={className} aria-label={label}>{body}</Link>
    : <div className={className} role="group" aria-label={label}>{body}</div>;
};

/** A round artist image, or the initial when there is none or it fails to load. */
const PersonAvatar: React.FC<{ name: string; imageUrl?: string | null; size?: 'sm' | 'md' | 'lg' }> = ({ name, imageUrl, size = 'sm' }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [imageUrl]);
  return (
    <span className={`rays-avatar rays-avatar--${size}`} aria-hidden="true">
      {imageUrl && !failed
        ? <img src={imageUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : <ArtistInitial name={name} className="rays-avatar__initial" />}
    </span>
  );
};

/** A small album cover, as everywhere else: rounded and clipped. */
const CoverThumb: React.FC<{ artworkId: string | null; title: string; artist?: string; size?: 'sm' | 'md' }> = ({ artworkId, title, artist, size = 'sm' }) => (
  <span className={`rays-cover rays-cover--${size}`} aria-hidden="true">
    <AlbumArt artUrl={coverUrlFor(artworkId)} album={title} artist={artist} size={size === 'md' ? 128 : 96} className="w-full h-full object-cover" />
  </span>
);

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

/** A nice upper bound for a 0–1 axis: the next tenth above the largest value. */
const niceMax = (values: number[]) => Math.min(1, Math.max(0.1, Math.ceil(Math.max(0, ...values) * 10) / 10));

/**
 * The audio model's raw style scores (0–1 each, independent: a track can
 * score high on several), ranked. Emphasis form: the styles the track is in
 * are emerald and carry a check, the rest grey; every bar is labelled.
 */
const StyleScoreChart: React.FC<{ scores: NonNullable<Rays['sound']>['closestStyles']; memberIds: Set<number> }> = ({ scores, memberIds }) => {
  const max = niceMax(scores.map(s => s.score));
  return (
    <figure className="rays-chart">
      <figcaption className="rays-chart__head">
        <span className="rays-chart__title">Styles the audio model hears</span>
        <span className="rays-chart__note">Each style scored 0 to 1 on its own; a track can score high on several.</span>
        <span className="rays-chart__legend">
          <span><span className="rays-swatch rays-swatch--emphasis" aria-hidden="true" />This track's styles</span>
          <span><span className="rays-swatch rays-swatch--context" aria-hidden="true" />Other styles it is close to</span>
        </span>
      </figcaption>
      <ul className="rays-bars">
        {scores.map(s => {
          const member = memberIds.has(s.styleId);
          return (
            <li key={s.styleId}>
              <Link
                to={stylePath(s.styleId)}
                className="rays-bar"
                data-member={member ? 'true' : undefined}
                title={`${s.style} (${s.genre}): ${s.score.toFixed(2)}${member ? ', one of this track\'s styles' : ''}`}
              >
                <span className="rays-bar__label">
                  {member && <Check size={13} className="rays-bar__check" aria-label="One of this track's styles" />}
                  <span className="rays-bar__name">{s.style}</span>
                  <span className="rays-bar__genre">{s.genre}</span>
                </span>
                <span className="rays-bar__track" aria-hidden="true">
                  <span className="rays-bar__fill" style={{ width: `${(s.score / max) * 100}%` }} />
                </span>
                <span className="rays-bar__value">{s.score.toFixed(2)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <span className="rays-chart__axis" aria-hidden="true"><span className="rays-chart__scale"><span>0</span><span>{max.toFixed(1)}</span></span></span>
    </figure>
  );
};

/** How the model's scores split across genres: ranked bars, one hue, the tail folded into Other. */
const GenreMixChart: React.FC<{ mix: NonNullable<Rays['sound']>['genreMix'] }> = ({ mix }) => {
  const shown = mix.slice(0, 6);
  const rest = mix.slice(6).reduce((sum, g) => sum + g.share, 0);
  const rows = rest >= 0.005 ? [...shown, { genre: 'Other genres', share: rest }] : shown;
  const max = niceMax(rows.map(r => r.share));
  return (
    <figure className="rays-chart">
      <figcaption className="rays-chart__head">
        <span className="rays-chart__title">Where those scores fall, by genre</span>
        <span className="rays-chart__note">Each genre's share of the scores over all 400 styles.</span>
      </figcaption>
      <ul className="rays-bars">
        {rows.map(r => (
          <li key={r.genre}>
            <span className="rays-bar rays-bar--static" title={`${r.genre}: ${Math.round(r.share * 100)} % of the scores`}>
              <span className="rays-bar__label"><span className="rays-bar__name">{r.genre}</span></span>
              <span className="rays-bar__track" aria-hidden="true">
                <span className="rays-bar__fill rays-bar__fill--single" style={{ width: `${(r.share / max) * 100}%` }} />
              </span>
              <span className="rays-bar__value">{Math.round(r.share * 100)} %</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
};

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

  // The artist's portrait and wide banner come through the same cached
  // provider lookup as the artist page; stored ones are the fallback.
  const artistData = useArtistData(rays?.artist?.name || '', rays?.artist?.musicBrainzId, { enabled: !!rays?.artist });
  const portrait = artistData.imageUrl || rays?.artist?.imageUrl || null;
  const banner = artistData.artworkUrl || rays?.artist?.artworkUrl || null;
  const cover = useMemo(() => (rays ? toPlayableTracks([rays.track])[0]?.artUrl : undefined), [rays]);

  const credits = useMemo(() => (rays ? creditsByPerson(rays.credits) : []), [rays]);
  const memberStyleIds = useMemo(() => new Set((rays?.styles || []).filter(r => r.styleId !== null).map(r => r.styleId as number)), [rays]);
  const context = rays ? contextLine(rays) : null;
  const track = rays?.track;
  const artistName = track?.artist;

  return (
    <div className="genre-detail page-container browse rays relative">
      {rays && (banner || cover) && <FadedHeroImage src={(banner || cover)!} variant={banner ? 'wide' : 'standard'} />}
      <div className="relative z-10">
      <BackButton onClick={() => navigate(-1)} />

      {error && (error.missing ? <p className="browse-empty">{error.message}</p> : <BrowseError message={error.message} onRetry={load} />)}
      {!rays && !error && (
        <div className="rays-hero" aria-hidden="true">
          <div className="rays-hero__cover bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
          <div className="h-16 w-2/3 max-w-xl rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
        </div>
      )}

      {rays && track && (
        <>
          <header className="rays-hero">
            <div className="rays-hero__cover">
              <AlbumArt artUrl={cover} album={rays.album?.title || track.album} artist={track.artist} size={400} className="w-full h-full object-cover" />
            </div>
            <div className="rays-hero__text">
              <h1 className="rays-title">
                <span className="rays-title__lead">Aurora rays from </span>{track.title}
              </h1>
              <p className="rays-hero__meta">
                {rays.artist ? (
                  <Link to={`/library/artist/${rays.artist.id}`} className="rays-hero__artist rays-link">
                    <PersonAvatar name={rays.artist.name} imageUrl={portrait} />
                    {artistName}
                  </Link>
                ) : <span>{artistName}</span>}
                {rays.album && <><span aria-hidden="true">·</span><Link to={`/library/album/${rays.album.id}`} className="rays-link">{rays.album.title}</Link></>}
                {track.year ? <><span aria-hidden="true">·</span><span>{track.year}</span></> : null}
              </p>
              <div className="browse-hero__actions">
                <button type="button" className="btn btn-primary" onClick={() => void play()}>
                  <Play size={16} fill="currentColor" aria-hidden="true" /> Play
                </button>
              </div>
            </div>
          </header>

          {credits.length > 0 && (
            <section className="browse-section" aria-label="Credits">
              <h2 className="browse-section__title">Credits</h2>
              <HorizontalScrollRail
                ariaLabel="credits"
                viewportClassName="flex overflow-x-auto snap-x snap-mandatory gap-3 hub-scroll-mobile hub-scroll-unique pb-1 sm:gap-5 sm:pb-2"
              >
                {credits.map(p => <CreditCard key={p.key} person={p} />)}
              </HorizontalScrollRail>
            </section>
          )}

          {(rays.album || rays.artist) && (
            <section className="browse-section" aria-label="In context">
              <h2 className="browse-section__title">In context</h2>
              {context && <p className="rays-context">{context}</p>}
              <div className="rays-context-grid">
                {rays.album && rays.album.entries.length > 0 && (
                  <div className="rays-profile">
                    <Link to={`/library/album/${rays.album.id}`} className="rays-profile__head">
                      <CoverThumb artworkId={rays.album.artworkId} title={rays.album.title} artist={track.artist} size="md" />
                      <span>
                        <span className="rays-profile__name">{rays.album.title}</span>
                        <span className="rays-muted">The album</span>
                      </span>
                    </Link>
                    <ProfileChips entries={rays.album.entries} />
                  </div>
                )}
                {rays.artist && (rays.artist.entries.length > 0 || rays.artist.listenerTags.length > 0) && (
                  <div className="rays-profile">
                    <Link to={`/library/artist/${rays.artist.id}`} className="rays-profile__head">
                      <PersonAvatar name={rays.artist.name} imageUrl={portrait} size="lg" />
                      <span>
                        <span className="rays-profile__name">{rays.artist.name}</span>
                        <span className="rays-muted">Each album counted once</span>
                      </span>
                    </Link>
                    {rays.artist.entries.length > 0 && <ProfileChips entries={rays.artist.entries} />}
                    {rays.artist.listenerTags.length > 0 && (
                      <>
                        <span className="rays-muted">Listeners tag them on Last.fm and MusicBrainz</span>
                        <ul className="rays-chips">
                          {rays.artist.listenerTags.map(t => <li key={t}><span className="rays-chip rays-chip--plain">{t}</span></li>)}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          <section className="browse-section" aria-label="Sound and style">
            <h2 className="browse-section__title">Sound and style</h2>

            <h3 className="rays-subtitle">Genres and styles</h3>
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

            {rays.sound && (
              <>
                <h3 className="rays-subtitle">Sound</h3>
                <p className="browse-section__lede">From Aurora's analysis of the audio file.</p>
                <div className="rays-sound">
                  <SoundMeter label="Energy" low="Calm" high="Energetic" value={rays.sound.energy} />
                  <SoundMeter label="Danceability" low="Still" high="Danceable" value={rays.sound.danceability} />
                  <SoundMeter label="Character" low="Acoustic" high="Electronic" value={1 - rays.sound.acousticness} />
                  <SoundMeter label="Voice" low="Vocal" high="Instrumental" value={rays.sound.instrumentalness} />
                  <SoundMeter label="Brightness" low="Dark" high="Bright" value={rays.sound.brightness} />
                  <SoundMeter label="Percussion" low="Smooth" high="Percussive" value={rays.sound.percussiveness} />
                </div>
                {rays.sound.bpm && <p className="rays-fact">Tempo <strong>{rays.sound.bpm} BPM</strong></p>}
                {(rays.sound.closestStyles.length > 0 || rays.sound.genreMix.length > 0) && (
                  <div className="rays-charts">
                    {rays.sound.closestStyles.length > 0 && <StyleScoreChart scores={rays.sound.closestStyles} memberIds={memberStyleIds} />}
                    {rays.sound.genreMix.length > 0 && <GenreMixChart mix={rays.sound.genreMix} />}
                  </div>
                )}
              </>
            )}
          </section>

          {rays.otherAlbums.length > 0 && (
            <section className="browse-section" aria-label="Also on">
              <h2 className="browse-section__title">Also on</h2>
              <ul className="browse-index browse-index--single">
                {rays.otherAlbums.map(o => (
                  <li key={o.trackId}>
                    {(() => {
                      const content = (
                        <>
                          <span className="browse-index__name">
                            <CoverThumb artworkId={o.artworkId} title={o.albumTitle} artist={o.artistName} />
                            {o.albumTitle}
                          </span>
                          <span className="browse-index__count">{[o.artistName, o.year].filter(Boolean).join(' · ')}</span>
                        </>
                      );
                      return o.albumId
                        ? <Link to={`/library/album/${o.albumId}`} className="browse-index__row rays-album-row">{content}</Link>
                        : <span className="browse-index__row rays-album-row">{content}</span>;
                    })()}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      </div>
    </div>
  );
};
