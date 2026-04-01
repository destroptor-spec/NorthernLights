import { usePlayerStore } from '../store';

interface ArtistData {
    imageUrl?: string;
    bio?: string;
    disambiguation?: string;
    area?: string;
    type?: string;
    lifeSpan?: { begin?: string; end?: string };
    links?: { url: string; type: string }[];
    genres?: string[];
}

interface CacheEntry {
    imageUrl?: string | null;
    bio?: string;
    _ts: number;
    _miss?: boolean;
}

const CACHE_TTL_HIT = 30 * 24 * 60 * 60 * 1000;  // 30 days
const CACHE_TTL_MISS = 24 * 60 * 60 * 1000;       // 1 day

const getCache = (key: string): CacheEntry | null => {
    try {
        const item = localStorage.getItem(key);
        if (!item) return null;
        const parsed: CacheEntry = JSON.parse(item);
        if (!parsed._ts) return null;
        const ttl = parsed._miss ? CACHE_TTL_MISS : CACHE_TTL_HIT;
        if (Date.now() - parsed._ts > ttl) {
            localStorage.removeItem(key);
            return null;
        }
        return parsed;
    } catch (e) {
        return null;
    }
}

const setCache = (key: string, value: Omit<CacheEntry, '_ts'> & { _ts?: number }) => {
    try {
        const entry: CacheEntry = { ...value, _ts: Date.now() };
        localStorage.setItem(key, JSON.stringify(entry));
    } catch (e) { }
}

/** Clear all external imagery caches (call when API keys change) */
export const clearExternalCache = () => {
    try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith('ext_') || key.startsWith('ext_artist_') || key.startsWith('ext_album_') || key.startsWith('ext_genre_') || key.startsWith('ext_lyrics_'))) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) { }
}

const cleanHtml = (text: string) => {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return doc.body.textContent || "";
}

const fetchWithRetry = async (url: string, options?: RequestInit, retries = 1): Promise<Response> => {
    const res = await fetch(url, options);
    if (res.status === 429 && retries > 0) {
        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
        await new Promise(r => setTimeout(r, Math.min(delay, 5000)));
        return fetchWithRetry(url, options, retries - 1);
    }
    return res;
}

// Helper: call Genius via backend proxy (avoids CORS)
const geniusSearch = async (query: string): Promise<any> => {
    const state = usePlayerStore.getState();
    const authHeaders = (state as any).getAuthHeader?.() || {};
    const res = await fetchWithRetry('/api/providers/genius/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ query, apiKey: state.geniusApiKey })
    });
    if (!res.ok) return null;
    return res.json();
}

const geniusArtist = async (artistId: number): Promise<any> => {
    const state = usePlayerStore.getState();
    const authHeaders = (state as any).getAuthHeader?.() || {};
    const res = await fetchWithRetry(`/api/providers/genius/artist/${artistId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ apiKey: state.geniusApiKey })
    });
    if (!res.ok) return null;
    return res.json();
}

// Helper: call MusicBrainz via backend proxy (rate-limited, no auth needed)
const musicBrainzSearchArtist = async (query: string): Promise<any> => {
    try {
        const res = await fetchWithRetry(`/api/providers/musicbrainz/search/artist?q=${encodeURIComponent(query)}&limit=5`);
        if (!res.ok) return null;
        return res.json();
    } catch { return null; }
}

const musicBrainzGetArtist = async (mbid: string): Promise<any> => {
    try {
        const res = await fetchWithRetry(`/api/providers/musicbrainz/artist/${mbid}?inc=url-rels+tags+genres+ratings`);
        if (!res.ok) return null;
        return res.json();
    } catch { return null; }
}

const musicBrainzSearchReleaseGroup = async (query: string): Promise<any> => {
    try {
        const res = await fetchWithRetry(`/api/providers/musicbrainz/search/release-group?q=${encodeURIComponent(query)}&limit=5`);
        if (!res.ok) return null;
        return res.json();
    } catch { return null; }
}

const extractMbLinks = (relations: any[]): { url: string; type: string }[] => {
    if (!Array.isArray(relations)) return [];
    return relations
        .filter((r: any) => r.target_type === 'url' && r.url?.resource)
        .map((r: any) => ({
            url: r.url.resource,
            type: r.type || 'other'
        }));
}

export const fetchArtistData = async (artistName: string, mbArtistId?: string | null): Promise<ArtistData> => {
    if (!artistName) return {};
    
    const cacheKey = `ext_artist_${artistName}`;
    const cached = getCache(cacheKey);
    if (cached) return { imageUrl: cached.imageUrl ?? undefined, bio: cached.bio };

    const state = usePlayerStore.getState();
    const { lastFmApiKey, geniusApiKey, musicBrainzEnabled, providerArtistImage, providerArtistBio } = state;

    let data: ArtistData = {};

    // If we have a MusicBrainz artist ID, do structured lookup first (exact match)
    if (musicBrainzEnabled && mbArtistId) {
        try {
            const mbArtist = await musicBrainzGetArtist(mbArtistId);
            if (mbArtist) {
                data.disambiguation = mbArtist.disambiguation || undefined;
                data.area = mbArtist.area?.name || undefined;
                data.type = mbArtist.type || undefined;
                if (mbArtist['life-span']) {
                    data.lifeSpan = {
                        begin: mbArtist['life-span'].begin || undefined,
                        end: mbArtist['life-span'].ended ? mbArtist['life-span'].end || undefined : undefined
                    };
                }
                data.links = extractMbLinks(mbArtist.relations);
                if (Array.isArray(mbArtist.genres) && mbArtist.genres.length > 0) {
                    data.genres = mbArtist.genres.map((g: any) => g.name);
                }
            }
        } catch (e) {
            console.warn('MusicBrainz artist lookup failed:', e);
        }
    }

    // Build API order for image + bio: prioritize configured providers, then fallbacks
    const seen = new Set<string>();
    const apisToTry: string[] = [];
    const pushApi = (api: string) => {
        if (!seen.has(api)) { seen.add(api); apisToTry.push(api); }
    };
    if (providerArtistImage === 'genius' && geniusApiKey) pushApi('genius');
    if (providerArtistBio === 'genius' && geniusApiKey) pushApi('genius');
    if (providerArtistImage === 'lastfm' && lastFmApiKey) pushApi('lastfm');
    if (providerArtistBio === 'lastfm' && lastFmApiKey) pushApi('lastfm');
    // Fallbacks
    if (geniusApiKey) pushApi('genius');
    if (lastFmApiKey) pushApi('lastfm');

    for (const api of apisToTry) {
        try {
            if (api === 'genius' && geniusApiKey) {
                const json = await geniusSearch(artistName);
                if (json) {
                    const hits = json.response?.hits;
                    if (hits && hits.length > 0) {
                        const hit = hits.find((h: any) => h.type === 'song' && h.result.primary_artist.name.toLowerCase() === artistName.toLowerCase());
                        const artistId = hit ? hit.result.primary_artist.id : hits[0]?.result?.primary_artist?.id;
                        const imageUrl = hit ? hit.result.primary_artist.image_url : hits[0]?.result?.primary_artist?.image_url;
                        
                        if (imageUrl && !data.imageUrl) {
                            data.imageUrl = imageUrl;
                        }

                        if (artistId && !data.bio) {
                            const artistJson = await geniusArtist(artistId);
                            if (artistJson) {
                                const bioPlain = artistJson.response?.artist?.description?.plain;
                                if (typeof bioPlain === 'string' && bioPlain.trim().length > 0 && bioPlain !== '?') {
                                    data.bio = bioPlain;
                                }
                            }
                        }
                    }
                }
            } else if (api === 'lastfm' && lastFmApiKey) {
                const res = await fetchWithRetry(`https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(artistName)}&api_key=${lastFmApiKey}&format=json`);
                if (res.ok) {
                    const json = await res.json();
                    if (json.error) {
                        console.warn(`Last.fm artist.getinfo error ${json.error}: ${json.message}`);
                        continue;
                    }
                    if (json.artist) {
                        if (!data.bio && json.artist.bio?.summary) {
                            const rawBio = json.artist.bio.summary;
                            data.bio = cleanHtml(rawBio.split('<a href')[0].trim());
                        }
                        if (!data.imageUrl && json.artist.image) {
                            const images = json.artist.image;
                            const largeImg = images.find((i: any) => i.size === 'mega' || i.size === 'extralarge' || i.size === 'large');
                            if (largeImg && largeImg['#text'] && !largeImg['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) {
                                data.imageUrl = largeImg['#text'];
                            }
                        }
                    }
                }
            }
            if (data.imageUrl && data.bio) {
                break;
            }
        } catch (e) {
            console.warn(`Failed fetching from ${api}:`, e);
        }
    }

    // Cache successful results only (30 days). Don't cache misses to avoid
    // poisoning the cache when API keys are missing or APIs are temporarily down.
    if (data.imageUrl || data.bio) {
      setCache(cacheKey, { imageUrl: data.imageUrl || null, bio: data.bio });
    }
    return data;
};

export const fetchAlbumImage = async (albumName: string, artistName: string, mbAlbumId?: string | null): Promise<string | undefined> => {
    if (!albumName || !artistName) return undefined;

    const cacheKey = `ext_album_${albumName}_${artistName}`;
    const cached = getCache(cacheKey);
    if (cached) return cached.imageUrl || undefined;

    const state = usePlayerStore.getState();
    const { lastFmApiKey, geniusApiKey, musicBrainzEnabled, providerAlbumArt } = state;

    // Try Cover Art Archive via MusicBrainz if we have an MBID
    if (musicBrainzEnabled && mbAlbumId) {
        try {
            const coverUrl = `https://coverartarchive.org/release/${mbAlbumId}/front-500`;
            const coverRes = await fetchWithRetry(coverUrl, { method: 'HEAD' });
            if (coverRes.ok) {
                setCache(cacheKey, { imageUrl: coverUrl });
                return coverUrl;
            }
        } catch { /* no cover art, fall through */ }
    }

    // Try Cover Art Archive via text search if MusicBrainz is the configured provider
    if (musicBrainzEnabled && providerAlbumArt === 'musicbrainz' && !mbAlbumId) {
        try {
            const searchQuery = `${artistName} ${albumName}`;
            const mbResult = await musicBrainzSearchReleaseGroup(searchQuery);
            const hits = mbResult?.['release-groups'];
            if (hits && hits.length > 0) {
                // Find the best match
                const match = hits.find((h: any) =>
                    h.title?.toLowerCase() === albumName.toLowerCase() &&
                    h['artist-credit']?.some((ac: any) => ac.name?.toLowerCase() === artistName.toLowerCase())
                ) || hits[0];
                if (match?.id) {
                    // Get releases for this release-group to find one with cover art
                    const rgRes = await fetchWithRetry(`/api/providers/musicbrainz/release-group/${match.id}?inc=releases`);
                    if (rgRes.ok) {
                        const rgJson = await rgRes.json();
                        const releases = rgJson.releases || [];
                        for (const release of releases.slice(0, 3)) {
                            try {
                                const coverUrl = `https://coverartarchive.org/release/${release.id}/front-500`;
                                const headRes = await fetchWithRetry(coverUrl, { method: 'HEAD' });
                                if (headRes.ok) {
                                    setCache(cacheKey, { imageUrl: coverUrl });
                                    return coverUrl;
                                }
                            } catch { /* continue to next release */ }
                        }
                    }
                }
            }
        } catch { /* fall through to other providers */ }
    }

    const apisToTry: string[] = [];
    if (providerAlbumArt === 'genius' && geniusApiKey) {
        apisToTry.push('genius');
        if (lastFmApiKey) apisToTry.push('lastfm');
    } else {
        if (lastFmApiKey) apisToTry.push('lastfm');
        if (geniusApiKey) apisToTry.push('genius');
    }

    for (const api of apisToTry) {
        try {
            if (api === 'lastfm' && lastFmApiKey) {
                const res = await fetchWithRetry(`https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${lastFmApiKey}&artist=${encodeURIComponent(artistName)}&album=${encodeURIComponent(albumName)}&format=json`);
                if (res.ok) {
                    const json = await res.json();
                    if (json.error) {
                        console.warn(`Last.fm album.getinfo error ${json.error}: ${json.message}`);
                        continue;
                    }
                    if (json.album && json.album.image) {
                        const images = json.album.image;
                        const largeImg = images.find((i: any) => i.size === 'mega' || i.size === 'extralarge' || i.size === 'large');
                        if (largeImg && largeImg['#text']) {
                            const imageUrl = largeImg['#text'];
                            setCache(cacheKey, { imageUrl });
                            return imageUrl;
                        }
                    }
                }
            } else if (api === 'genius' && geniusApiKey) {
                const query = `${artistName} ${albumName}`;
                const json = await geniusSearch(query);
                if (json) {
                    const hits = json.response?.hits;
                    if (hits && hits.length > 0) {
                        const songHit = hits.find((h: any) => h.type === 'song');
                        const imageUrl = songHit?.result?.song_art_image_url || songHit?.result?.header_image_url;
                        if (imageUrl) {
                            setCache(cacheKey, { imageUrl });
                            return imageUrl;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(`Failed fetching album image from ${api}:`, e);
        }
    }
    
    setCache(cacheKey, { imageUrl: null, _miss: true });
    return undefined;
};

export const fetchGenreImage = async (genreName: string): Promise<string | undefined> => {
    if (!genreName) return undefined;
    const cacheKey = `ext_genre_${genreName}`;
    const cached = getCache(cacheKey);
    if (cached) return cached.imageUrl || undefined;

    const { lastFmApiKey } = usePlayerStore.getState();
    if (!lastFmApiKey) return undefined;

    try {
        const res = await fetchWithRetry(`https://ws.audioscrobbler.com/2.0/?method=tag.gettopalbums&tag=${encodeURIComponent(genreName)}&api_key=${lastFmApiKey}&format=json&limit=1`);
        if (res.ok) {
            const json = await res.json();
            if (json.error) {
                console.warn(`Last.fm tag.gettopalbums error ${json.error}: ${json.message}`);
                setCache(cacheKey, { imageUrl: null, _miss: true });
                return undefined;
            }
            if (json.albums && json.albums.album && json.albums.album.length > 0) {
                const images = json.albums.album[0].image;
                const largeImg = images.find((i: any) => i.size === 'mega' || i.size === 'extralarge' || i.size === 'large');
                if (largeImg && largeImg['#text']) {
                    const imageUrl = largeImg['#text'];
                    setCache(cacheKey, { imageUrl });
                    return imageUrl;
                }
            }
        }
    } catch (e) {
        console.warn('Failed fetching genre image from Last.fm:', e);
    }

    setCache(cacheKey, { imageUrl: null, _miss: true });
    return undefined;
};

export const fetchGenreInfo = async (genreName: string): Promise<{ imageUrl?: string, summary?: string } | undefined> => {
    if (!genreName) return undefined;
    const cacheKey = `ext_genreinfo_${genreName}`;
    const cached = getCache(cacheKey);
    if (cached) {
        if (cached._miss) return undefined;
        return { imageUrl: cached.imageUrl ?? undefined, summary: cached.bio };
    }

    const { lastFmApiKey } = usePlayerStore.getState();
    if (!lastFmApiKey) return undefined;

    try {
        const res = await fetchWithRetry(`https://ws.audioscrobbler.com/2.0/?method=tag.getinfo&tag=${encodeURIComponent(genreName)}&api_key=${lastFmApiKey}&format=json`);
        if (res.ok) {
            const json = await res.json();
            if (json.error) {
                console.warn(`Last.fm tag.getinfo error ${json.error}: ${json.message}`);
                setCache(cacheKey, { imageUrl: null, bio: '', _miss: true });
                return undefined;
            }
            const tag = json.tag;
            const summary = tag?.wiki?.summary ? cleanHtml(tag.wiki.summary.split('<a href')[0].trim()) : undefined;
            const result: { imageUrl?: string, summary?: string } = {};
            if (summary && summary.length > 0) result.summary = summary;
            setCache(cacheKey, { imageUrl: null, bio: result.summary, _miss: !result.summary });
            return result.summary ? result : undefined;
        }
    } catch (e) {
        console.warn('Failed fetching genre info from Last.fm:', e);
    }

    setCache(cacheKey, { imageUrl: null, bio: '', _miss: true });
    return undefined;
};

export interface LyricsData {
    songUrl: string;
    title: string;
    artist: string;
    thumbnailUrl?: string;
}

export const fetchLyrics = async (trackName: string, artistName: string): Promise<LyricsData | undefined> => {
    if (!trackName || !artistName) return undefined;

    const { geniusApiKey } = usePlayerStore.getState();
    if (!geniusApiKey) return undefined;

    const cacheKey = `ext_lyrics_${trackName}_${artistName}`;
    const cached = getCache(cacheKey);
    if (cached) {
        if (cached._miss) return undefined;
        return { songUrl: cached.imageUrl!, title: cached.bio || trackName, artist: artistName, thumbnailUrl: undefined };
    }

    try {
        const query = `${artistName} ${trackName}`;
        const json = await geniusSearch(query);
        if (!json) {
            setCache(cacheKey, { imageUrl: null, bio: '', _miss: true });
            return undefined;
        }

        const hits = json.response?.hits;
        if (!hits || hits.length === 0) {
            setCache(cacheKey, { imageUrl: null, bio: '', _miss: true });
            return undefined;
        }

        const artistLower = artistName.toLowerCase();
        const titleLower = trackName.toLowerCase();
        const exactHit = hits.find((h: any) =>
            h.type === 'song' &&
            h.result.primary_artist?.name?.toLowerCase().includes(artistLower) &&
            h.result.title?.toLowerCase().includes(titleLower)
        );
        const songHit = exactHit || hits.find((h: any) => h.type === 'song');

        if (!songHit) {
            setCache(cacheKey, { imageUrl: null, bio: '', _miss: true });
            return undefined;
        }

        const song = songHit.result;
        const result: LyricsData = {
            songUrl: song.url,
            title: song.title || trackName,
            artist: song.primary_artist?.name || artistName,
            thumbnailUrl: song.song_art_image_thumbnail_url,
        };

        setCache(cacheKey, { imageUrl: result.songUrl, bio: result.title });
        return result;
    } catch (e) {
        console.warn('Failed fetching lyrics from Genius:', e);
        setCache(cacheKey, { imageUrl: null, bio: '', _miss: true });
        return undefined;
    }
};
