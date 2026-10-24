import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/index';
import type { ArtistReviewDecision, ArtistReviewEntry, ArtistReviewPreview } from '../../shared/artistReview';

const BASE = '/api/library/artist-reviews';

async function readError(res: Response, fallback: string): Promise<Error> {
  const data = await res.json().catch(() => ({}));
  return new Error(typeof data?.error === 'string' ? data.error : fallback);
}

/**
 * The artist review queue (Settings → Library entities): open entries, the
 * decisions of the last 30 days, per-entry previews (cached per signature),
 * and the actions on them. Actions throw with the server's message.
 */
export function useArtistReviews() {
  const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
  const [entries, setEntries] = useState<ArtistReviewEntry[] | null>(null);
  const [decisions, setDecisions] = useState<ArtistReviewDecision[]>([]);
  const [loading, setLoading] = useState(false);
  const previews = useRef(new Map<string, Promise<ArtistReviewPreview>>());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [entriesRes, decisionsRes] = await Promise.all([
        fetch(BASE, { headers: getAuthHeader() }),
        fetch(`${BASE}/decisions`, { headers: getAuthHeader() }),
      ]);
      if (entriesRes.ok) setEntries(((await entriesRes.json()).entries || []) as ArtistReviewEntry[]);
      if (decisionsRes.ok) setDecisions(((await decisionsRes.json()).decisions || []) as ArtistReviewDecision[]);
    } catch (e) {
      console.error('Failed to load the artist review queue', e);
    } finally {
      setLoading(false);
    }
  }, [getAuthHeader]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadPreview = useCallback((entry: ArtistReviewEntry): Promise<ArtistReviewPreview> => {
    const cacheKey = `${entry.key}\u0000${entry.signature}`;
    let pending = previews.current.get(cacheKey);
    if (!pending) {
      pending = fetch(`${BASE}/preview?key=${encodeURIComponent(entry.key)}`, { headers: getAuthHeader() })
        .then(async res => {
          if (!res.ok) throw await readError(res, 'Failed to preview this entry');
          return res.json() as Promise<ArtistReviewPreview>;
        });
      pending.catch(() => previews.current.delete(cacheKey));
      previews.current.set(cacheKey, pending);
    }
    return pending;
  }, [getAuthHeader]);

  const decide = useCallback(async (entry: ArtistReviewEntry, outcomeId: string): Promise<string> => {
    const res = await fetch(`${BASE}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ key: entry.key, signature: entry.signature, outcomeId }),
    });
    if (!res.ok) throw await readError(res, 'Failed to apply the decision');
    return String((await res.json()).decisionId);
  }, [getAuthHeader]);

  const undo = useCallback(async (decisionId: string): Promise<void> => {
    const res = await fetch(`${BASE}/decisions/${encodeURIComponent(decisionId)}/undo`, {
      method: 'POST',
      headers: getAuthHeader(),
    });
    if (!res.ok) throw await readError(res, 'Failed to undo the decision');
  }, [getAuthHeader]);

  return { entries, decisions, loading, refresh, loadPreview, decide, undo };
}
