import { useState, useEffect } from 'react';

interface ExternalImageState {
  imageUrl: string | undefined;
  isLoading: boolean;
  error: string | undefined;
}

export const useExternalImage = (
  fetcher: () => Promise<string | undefined | null>,
  deps: unknown[],
  options?: { enabled?: boolean; debounceMs?: number }
): ExternalImageState => {
  const enabled = options?.enabled !== false;
  const debounceMs = options?.debounceMs ?? 0;
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    let mounted = true;
    let timer: NodeJS.Timeout | null = null;

    const startFetch = () => {
      setImageUrl(undefined);
      setError(undefined);
      setIsLoading(true);
      fetcher()
        .then(url => {
          if (mounted && url) setImageUrl(url);
        })
        .catch(err => {
          if (mounted) setError(err?.message || 'Failed to load image');
        })
        .finally(() => {
          if (mounted) setIsLoading(false);
        });
    };

    if (debounceMs > 0) {
      timer = setTimeout(startFetch, debounceMs);
    } else {
      startFetch();
    }

    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, debounceMs]);

  return { imageUrl, isLoading, error };
};
