import { useState, useEffect } from 'react';
import { fetchArtistData } from '../utils/externalImagery';

interface ArtistDataState {
  imageUrl: string | undefined;
  bio: string | undefined;
  isLoading: boolean;
  error: string | undefined;
}

export const useArtistData = (artistName: string): ArtistDataState => {
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [bio, setBio] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!artistName) return;
    let mounted = true;
    setImageUrl(undefined);
    setBio(undefined);
    setError(undefined);
    setIsLoading(true);
    fetchArtistData(artistName)
      .then(data => {
        if (mounted) {
          setImageUrl(data.imageUrl);
          setBio(data.bio);
        }
      })
      .catch(err => {
        if (mounted) setError(err?.message || 'Failed to load artist data');
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });
    return () => { mounted = false; };
  }, [artistName]);

  return { imageUrl, bio, isLoading, error };
};
