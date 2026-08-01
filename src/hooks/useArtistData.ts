import { useState, useEffect, useRef } from 'react';
import { fetchArtistData } from '../utils/externalImagery';

interface ArtistDataState {
  imageUrl: string | undefined;
  artworkUrl: string | undefined;
  bio: string | undefined;
  disambiguation: string | undefined;
  area: string | undefined;
  type: string | undefined;
  lifeSpan: { begin?: string; end?: string } | undefined;
  links: { url: string; type: string }[] | undefined;
  genres: string[] | undefined;
  communityTags: { name: string; count: number; providers: Array<'lastfm' | 'musicbrainz'> }[] | undefined;
  listeners: string | undefined;
  members: string[] | undefined;
  isLoading: boolean;
  error: string | undefined;
}

export const useArtistData = (artistName: string, mbArtistId?: string | null, options?: { enabled?: boolean; debounceMs?: number }): ArtistDataState => {
  const enabled = options?.enabled !== false;
  const debounceMs = options?.debounceMs ?? 200;
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [artworkUrl, setArtworkUrl] = useState<string | undefined>();
  const [bio, setBio] = useState<string | undefined>();
  const [disambiguation, setDisambiguation] = useState<string | undefined>();
  const [area, setArea] = useState<string | undefined>();
  const [type, setType] = useState<string | undefined>();
  const [lifeSpan, setLifeSpan] = useState<{ begin?: string; end?: string } | undefined>();
  const [links, setLinks] = useState<{ url: string; type: string }[] | undefined>();
  const [genres, setGenres] = useState<string[] | undefined>();
  const [communityTags, setCommunityTags] = useState<{ name: string; count: number; providers: Array<'lastfm' | 'musicbrainz'> }[] | undefined>();
  const [listeners, setListeners] = useState<string | undefined>();
  const [members, setMembers] = useState<string[] | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const lastFetchedNameRef = useRef<string | undefined>(undefined);
  const lastSuccessfulFetchKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!artistName || !enabled || artistName === 'Unknown Artist') {
      setIsLoading(false);
      return;
    }

    let mounted = true;
    let timer: NodeJS.Timeout | null = null;
    const fetchKey = `${artistName}\n${mbArtistId ?? ''}`;

    if (lastSuccessfulFetchKeyRef.current === fetchKey) {
      setIsLoading(false);
      return;
    }

    // Reset metadata only if the artist name has changed (not just scrolling in view)
    if (lastFetchedNameRef.current !== artistName) {
      setImageUrl(undefined);
      setArtworkUrl(undefined);
      setBio(undefined);
      setDisambiguation(undefined);
      setArea(undefined);
      setType(undefined);
      setLifeSpan(undefined);
      setLinks(undefined);
      setGenres(undefined);
      setCommunityTags(undefined);
      setListeners(undefined);
      setMembers(undefined);
      setError(undefined);
    }

    const startFetch = () => {
      setIsLoading(true);
      fetchArtistData(artistName, mbArtistId)
        .then(data => {
          if (mounted) {
            lastFetchedNameRef.current = artistName;
            lastSuccessfulFetchKeyRef.current = fetchKey;
            setImageUrl(data.imageUrl);
            setArtworkUrl(data.artworkUrl);
            setBio(data.bio);
            setDisambiguation(data.disambiguation);
            setArea(data.area);
            setType(data.type);
            setLifeSpan(data.lifeSpan);
            setLinks(data.links);
            setGenres(data.genres);
            setCommunityTags(data.communityTags);
            setListeners(data.listeners);
            setMembers(data.members);
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
  }, [artistName, mbArtistId, enabled, debounceMs]);

  return { imageUrl, artworkUrl, bio, disambiguation, area, type, lifeSpan, links, genres, communityTags, listeners, members, isLoading, error };
};
