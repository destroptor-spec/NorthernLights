import { useState, useEffect } from 'react';
import { fetchArtistData } from '../utils/externalImagery';

interface ArtistDataState {
  imageUrl: string | undefined;
  bio: string | undefined;
  disambiguation: string | undefined;
  area: string | undefined;
  type: string | undefined;
  lifeSpan: { begin?: string; end?: string } | undefined;
  links: { url: string; type: string }[] | undefined;
  genres: string[] | undefined;
  isLoading: boolean;
  error: string | undefined;
}

export const useArtistData = (artistName: string, mbArtistId?: string | null, options?: { enabled?: boolean; debounceMs?: number }): ArtistDataState => {
  const enabled = options?.enabled !== false;
  const debounceMs = options?.debounceMs ?? 200;
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [bio, setBio] = useState<string | undefined>();
  const [disambiguation, setDisambiguation] = useState<string | undefined>();
  const [area, setArea] = useState<string | undefined>();
  const [type, setType] = useState<string | undefined>();
  const [lifeSpan, setLifeSpan] = useState<{ begin?: string; end?: string } | undefined>();
  const [links, setLinks] = useState<{ url: string; type: string }[] | undefined>();
  const [genres, setGenres] = useState<string[] | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const [lastFetchedName, setLastFetchedName] = useState<string | undefined>();

  useEffect(() => {
    if (!artistName || !enabled || artistName === 'Unknown Artist') {
      setIsLoading(false);
      return;
    }

    let mounted = true;
    let timer: NodeJS.Timeout | null = null;

    // Reset metadata only if the artist name has changed (not just scrolling in view)
    if (lastFetchedName !== artistName) {
      setImageUrl(undefined);
      setBio(undefined);
      setDisambiguation(undefined);
      setArea(undefined);
      setType(undefined);
      setLifeSpan(undefined);
      setLinks(undefined);
      setGenres(undefined);
      setError(undefined);
    }

    const startFetch = () => {
      setIsLoading(true);
      fetchArtistData(artistName, mbArtistId)
        .then(data => {
          if (mounted) {
            setLastFetchedName(artistName);
            setImageUrl(data.imageUrl);
            setBio(data.bio);
            setDisambiguation(data.disambiguation);
            setArea(data.area);
            setType(data.type);
            setLifeSpan(data.lifeSpan);
            setLinks(data.links);
            setGenres(data.genres);
            setError(undefined);
          }
        })
        .catch(err => {
          if (mounted) setError(err?.message || 'Failed to load artist data');
        })
        .finally(() => {
          if (mounted) setIsLoading(false);
        });
    };

    // Debounce the call to avoid hitting API rate limits during rapid scroll
    timer = setTimeout(startFetch, debounceMs);

    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [artistName, mbArtistId, enabled, debounceMs, lastFetchedName]);

  return { imageUrl, bio, disambiguation, area, type, lifeSpan, links, genres, isLoading, error };
};
