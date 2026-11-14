import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/index';

export interface ReviewQueueEntryBase { key: string; signature: string }
export interface ReviewQueueDecisionBase { id: string; decidedAt: string }

async function readError(res: Response, fallback: string): Promise<Error> {
  const data = await res.json().catch(() => ({}));
  const error = new Error(typeof data?.error === 'string' ? data.error : fallback) as Error & { code?: string };
  if (typeof data?.code === 'string') error.code = data.code;
  return error;
}

/**
 * A review queue in Settings → Library entities (artists, genres): the open
 * entries, the decisions of the last 30 days, per-entry previews (cached per
 * signature), and the actions on them. `base` serves GET (the queue; extra
 * fields come back as `state`), GET /decisions, GET /preview?key=, POST /decide
 * and POST /decisions/:id/undo. Actions throw with the server's message.
 */
export function useReviewQueue<
  Entry extends ReviewQueueEntryBase,
  Decision extends ReviewQueueDecisionBase,
  Preview,
  State extends { entries?: Entry[] } = { entries?: Entry[] },
>(base: string) {
  const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
  const [state, setState] = useState<State | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previews = useRef(new Map<string, Promise<Preview>>());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [entriesRes, decisionsRes] = await Promise.all([
        fetch(base, { headers: getAuthHeader() }),
        fetch(`${base}/decisions`, { headers: getAuthHeader() }),
      ]);
      if (!entriesRes.ok) throw await readError(entriesRes, 'Failed to load the review queue');
      setState(await entriesRes.json() as State);
      if (decisionsRes.ok) setDecisions(((await decisionsRes.json()).decisions || []) as Decision[]);
      setError(null);
    } catch (e) {
      console.error('Failed to load the review queue', e);
      setError((e as Error).message || 'Failed to load the review queue');
    } finally {
      setLoading(false);
    }
  }, [base, getAuthHeader]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadPreview = useCallback((entry: Entry): Promise<Preview> => {
    const cacheKey = `${entry.key}\u0000${entry.signature}`;
    let pending = previews.current.get(cacheKey);
    if (!pending) {
      pending = fetch(`${base}/preview?key=${encodeURIComponent(entry.key)}`, { headers: getAuthHeader() })
        .then(async res => {
          if (!res.ok) throw await readError(res, 'Failed to preview this entry');
          return res.json() as Promise<Preview>;
        });
      pending.catch(() => previews.current.delete(cacheKey));
      previews.current.set(cacheKey, pending);
    }
    return pending;
  }, [base, getAuthHeader]);

  /** Posts a decision; `body` adds to key and signature. Resolves to the decision id. */
  const decide = useCallback(async (entry: Entry, body: Record<string, unknown>): Promise<string> => {
    const res = await fetch(`${base}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ key: entry.key, signature: entry.signature, ...body }),
    });
    if (!res.ok) throw await readError(res, 'Failed to apply the decision');
    return String((await res.json()).decisionId);
  }, [base, getAuthHeader]);

  const undo = useCallback(async (decisionId: string): Promise<void> => {
    const res = await fetch(`${base}/decisions/${encodeURIComponent(decisionId)}/undo`, {
      method: 'POST',
      headers: getAuthHeader(),
    });
    if (!res.ok) throw await readError(res, 'Failed to undo the decision');
  }, [base, getAuthHeader]);

  /** POST to another endpoint under `base`; resolves to the JSON body. */
  const post = useCallback(async <T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await readError(res, 'The request failed');
    return res.json() as Promise<T>;
  }, [base, getAuthHeader]);

  const get = useCallback(async <T = Record<string, unknown>>(path: string): Promise<T> => {
    const res = await fetch(`${base}${path}`, { headers: getAuthHeader() });
    if (!res.ok) throw await readError(res, 'The request failed');
    return res.json() as Promise<T>;
  }, [getAuthHeader, base]);

  const entries = state ? (state.entries || []) : null;
  return { state, entries, decisions, loading, error, refresh, loadPreview, decide, undo, post, get };
}

export type ReviewQueue<
  Entry extends ReviewQueueEntryBase,
  Decision extends ReviewQueueDecisionBase,
  Preview,
  State extends { entries?: Entry[] } = { entries?: Entry[] },
> = ReturnType<typeof useReviewQueue<Entry, Decision, Preview, State>>;
