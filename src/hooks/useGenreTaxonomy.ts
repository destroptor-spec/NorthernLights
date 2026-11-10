import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store';

export interface GenreTaxonomyState {
  /** Whether the server's genre and style taxonomy is seeded. */
  available: boolean;
  /** Lowercased genre name → "Genre.Style" path, e.g. "Rock.Alternative Rock". */
  paths: Record<string, string>;
  loading: boolean;
}

type TaxonomyResult = { available: boolean; paths: Record<string, string> };

// The taxonomy is a derived dataset that never changes within a session, so a
// single module-level request is shared across every mount of the genres view.
// Storing the Promise also dedupes concurrent callers.
let cache: Promise<TaxonomyResult> | null = null;

function load(): Promise<TaxonomyResult> {
  if (cache) return cache;
  const authHeader = usePlayerStore.getState().getAuthHeader();
  cache = fetch('/api/genres/taxonomy', { headers: { ...authHeader } })
    .then((r) => (r.ok ? (r.json() as Promise<TaxonomyResult>) : { available: false, paths: {} }))
    .catch(() => ({ available: false, paths: {} }));
  return cache;
}

/**
 * Loads the genre › style hierarchy (from the genre taxonomy) once per session. Pass `enabled: false`
 * to skip the request entirely (e.g. when the genres view is not visible).
 */
export function useGenreTaxonomy(enabled = true): GenreTaxonomyState {
  const [state, setState] = useState<GenreTaxonomyState>({
    available: false,
    paths: {},
    loading: enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    load().then((res) => {
      if (alive) setState({ available: res.available, paths: res.paths, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return state;
}
