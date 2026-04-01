import { useState, useEffect } from 'react';

interface ExternalImageState {
  imageUrl: string | undefined;
  isLoading: boolean;
  error: string | undefined;
}

export const useExternalImage = (
  fetcher: () => Promise<string | undefined | null>,
  deps: unknown[],
  options?: { enabled?: boolean }
): ExternalImageState => {
  const enabled = options?.enabled !== false;
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    let mounted = true;
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
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  return { imageUrl, isLoading, error };
};
