import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Play } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { auroraApiRequest, type Track } from '../../api/auroraApi';
import { fetchDisputedStyles, raysPath, setTrackStyle } from '../../api/browse';
import { toPlayableTracks } from '../../utils/playableTracks';
import { BrowseError, CoverThumb } from './browseParts';
import type { DisputedTrack } from '../../../shared/genreReview';

const PAGE = 50;

/** "Trance", "Trance and Progressive Trance", "Trance, House and Techno". */
const listOf = (names: string[]) => names.length < 2 ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * Admin, on the Unsorted page: tracks with tagged styles the sound disputes
 * ("trust, then verify"), one row per track. Nothing changes until an admin
 * answers: Keep writes add overrides, so those tags are never disputed again;
 * Remove takes the styles off the track. Both can be undone from the toast.
 * Play is there to listen first.
 */
export const DisputedTags: React.FC = () => {
  const [items, setItems] = useState<DisputedTrack[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (count = PAGE) => {
    setError(null);
    try {
      const page = await fetchDisputedStyles(usePlayerStore.getState().getAuthHeader(), 0, Math.min(200, Math.max(PAGE, count)));
      setItems(page.items);
      setTotal(page.total);
    } catch {
      setError('Could not load disputed tags.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const more = async () => {
    if (!items) return;
    setLoadingMore(true);
    try {
      const page = await fetchDisputedStyles(usePlayerStore.getState().getAuthHeader(), items.length, PAGE);
      setItems(current => [...(current || []), ...page.items]);
      setTotal(page.total);
    } catch {
      usePlayerStore.getState().addToast('Could not load more disputed tags.', 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const play = async (d: DisputedTrack) => {
    const { getAuthHeader, setPlaylist, addToast } = usePlayerStore.getState();
    setPlaying(d.trackId);
    try {
      const track = await auroraApiRequest<Track>(`/tracks/${encodeURIComponent(d.trackId)}`, getAuthHeader());
      await setPlaylist(toPlayableTracks([track]), 0, null);
    } catch {
      addToast('Could not play this track.', 'error');
    } finally {
      setPlaying(null);
    }
  };

  // Keep: add overrides. Remove: exclude overrides. One per disputed style.
  const apply = async (d: DisputedTrack, action: 'add' | 'remove') => {
    const auth = usePlayerStore.getState().getAuthHeader();
    for (const s of d.styles) await setTrackStyle(auth, d.trackId, { genre: s.genre, styleId: s.styleId, action });
  };

  const answer = async (d: DisputedTrack, keep: boolean) => {
    const { addToast } = usePlayerStore.getState();
    const styles = listOf(d.styles.map(s => s.style));
    setSaving(`${d.trackId}:${keep ? 'keep' : 'remove'}`);
    try {
      await apply(d, keep ? 'add' : 'remove');
      setItems(current => (current || []).filter(i => i.trackId !== d.trackId));
      setTotal(n => Math.max(0, n - 1));
      addToast(keep ? `Kept ${styles} on ${d.title}` : `Removed ${styles} from ${d.title}`, 'success', {
        actionLabel: 'Undo',
        onAction: () => {
          // Undo takes the overrides back; the track is fused again and the dispute returns.
          void apply(d, keep ? 'remove' : 'add')
            .then(() => load(items?.length || PAGE))
            .catch(() => addToast('Could not undo.', 'error'));
        },
      });
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not save the change.', 'error');
      void load(items?.length || PAGE);
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="browse-section" aria-label="Disputed tags">
      <h2 className="browse-section__title">Disputed tags</h2>
      <p className="browse-section__lede">
        Tagged styles the sound disagrees with: the track scores almost nothing for the style and sounds unlike the
        style's other tracks. Nothing changes until you answer. Keep the tags, or remove those styles from the track.
      </p>
      {error && <BrowseError message={error} onRetry={() => void load()} />}
      {!items && !error && <div className="h-24 rounded-xl bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" aria-hidden="true" />}
      {items && (items.length === 0
        ? <p className="browse-empty">No disputed tags. The sound agrees with every tag it can check.</p>
        : (
          <>
            <p className="disputed__count">{total.toLocaleString()} {total === 1 ? 'track' : 'tracks'} to review</p>
            <ul className="disputed">
              {items.map(d => {
                const styles = listOf(d.styles.map(s => s.style));
                const busy = (action: 'keep' | 'remove') => saving === `${d.trackId}:${action}`;
                const tags = [...new Set(d.styles.flatMap(s => s.fromTags))];
                return (
                  <li key={d.trackId} className="disputed__row">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm disputed__play"
                      onClick={() => void play(d)}
                      disabled={playing === d.trackId}
                      aria-label={`Play ${d.title}`}
                    >
                      {playing === d.trackId ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                    </button>
                    <CoverThumb artworkId={d.artworkId} title={d.album || d.title} artist={d.artist} />
                    <span className="disputed__what">
                      <Link to={raysPath(d.trackId)} className="disputed__title">{d.title}</Link>
                      <span className="disputed__meta">{[d.artist, d.album].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="disputed__answer">
                      <span className="disputed__style" title={tags.length ? `From the file tag ${tags.join(', ')}` : undefined}>
                        Tagged <strong>{styles}</strong>
                      </span>
                      <span className="disputed__actions">
                        <button type="button" className="btn btn-ghost btn-sm" disabled={saving !== null} onClick={() => void answer(d, true)}
                          aria-label={`Keep ${styles} on ${d.title}`}>
                          {busy('keep') && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}Keep
                        </button>
                        <button type="button" className="btn btn-danger btn-sm" disabled={saving !== null} onClick={() => void answer(d, false)}
                          aria-label={`Remove ${styles} from ${d.title}`}>
                          {busy('remove') && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}Remove
                        </button>
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
            {items.length < total && (
              <button type="button" className="btn btn-ghost btn-sm disputed__more" onClick={() => void more()} disabled={loadingMore}>
                {loadingMore && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                Show more ({(total - items.length).toLocaleString()})
              </button>
            )}
          </>
        ))}
    </section>
  );
};
