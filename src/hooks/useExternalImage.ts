import { useState, useEffect } from 'react';

export const useExternalImage = (
  fetcher: () => Promise<string | undefined | null>,
  deps: unknown[]
) => {
  const [imageUrl, setImageUrl] = useState<string | undefined>();

  useEffect(() => {
    let mounted = true;
    setImageUrl(undefined);
    fetcher().then(url => {
      if (mounted && url) setImageUrl(url);
    });
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return imageUrl;
};
