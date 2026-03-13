import { usePlayerStore } from '../store';

interface ArtistData {
    imageUrl?: string;
    bio?: string;
}

const getCache = (key: string) => {
    try {
        const item = localStorage.getItem(key);
        if (item) return JSON.parse(item);
    } catch (e) { }
    return null;
}

const setCache = (key: string, value: any) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { }
}

const cleanHtml = (text: string) => {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return doc.body.textContent || "";
}

export const fetchArtistData = async (artistName: string): Promise<ArtistData> => {
    if (!artistName) return {};
    
    const cacheKey = `ext_artist_${artistName}`;
    const cached = getCache(cacheKey);
    // Return cache if it has what we need, even if partially empty.
    if (cached) return cached;

    const state = usePlayerStore.getState();
    const { lastFmApiKey, geniusApiKey, preferredProvider } = state;

    let data: ArtistData = {};

    const apisToTry = [];
    if (preferredProvider === 'genius' && geniusApiKey) {
        apisToTry.push('genius');
        if (lastFmApiKey) apisToTry.push('lastfm');
    } else if (preferredProvider === 'lastfm' && lastFmApiKey) {
        apisToTry.push('lastfm');
        if (geniusApiKey) apisToTry.push('genius');
    } else {
        if (geniusApiKey) apisToTry.push('genius');
        if (lastFmApiKey) apisToTry.push('lastfm');
    }

    for (const api of apisToTry) {
        try {
            if (api === 'genius' && geniusApiKey) {
                const res = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(artistName)}`, {
                    headers: { 'Authorization': `Bearer ${geniusApiKey}` }
                });
                if (res.ok) {
                    const json = await res.json();
                    const hits = json.response.hits;
                    const hit = hits.find((h: any) => h.type === 'song' && h.result.primary_artist.name.toLowerCase() === artistName.toLowerCase());
                    const artistId = hit ? hit.result.primary_artist.id : (hits[0]?.result.primary_artist.id);
                    const imageUrl = hit ? hit.result.primary_artist.image_url : (hits[0]?.result.primary_artist.image_url);
                    
                    if (imageUrl && !data.imageUrl) {
                        data.imageUrl = imageUrl;
                    }

                    if (artistId && !data.bio) {
                        const artistRes = await fetch(`https://api.genius.com/artists/${artistId}`, {
                            headers: { 'Authorization': `Bearer ${geniusApiKey}` }
                        });
                        if (artistRes.ok) {
                            const artistJson = await artistRes.json();
                            const bioPlain = artistJson.response.artist.description?.plain;
                            if (typeof bioPlain === 'string' && bioPlain.trim().length > 0 && bioPlain !== '?') {
                                data.bio = bioPlain;
                            }
                        }
                    }
                }
            } else if (api === 'lastfm' && lastFmApiKey) {
                // Must use http if Last.fm blocks https for some keys, but https is safer
                const res = await fetch(`https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(artistName)}&api_key=${lastFmApiKey}&format=json`);
                if (res.ok) {
                    const json = await res.json();
                    if (json.artist) {
                        if (!data.bio && json.artist.bio?.summary) {
                            const rawBio = json.artist.bio.summary;
                            data.bio = cleanHtml(rawBio.split('<a href')[0].trim());
                        }
                        if (!data.imageUrl && json.artist.image) {
                            const images = json.artist.image;
                            const largeImg = images.find((i: any) => i.size === 'mega' || i.size === 'extralarge' || i.size === 'large');
                            // Exclude default star image
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

    setCache(cacheKey, data);
    return data;
};

export const fetchAlbumImage = async (albumName: string, artistName: string): Promise<string | undefined> => {
    if (!albumName || !artistName) return undefined;

    const cacheKey = `ext_album_${albumName}_${artistName}`;
    const cached = getCache(cacheKey);
    // Explicit null check to avoid re-fetching failures
    if (cached) return cached.imageUrl || undefined;

    const { lastFmApiKey } = usePlayerStore.getState();
    if (!lastFmApiKey) return undefined;

    try {
        const res = await fetch(`https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${lastFmApiKey}&artist=${encodeURIComponent(artistName)}&album=${encodeURIComponent(albumName)}&format=json`);
        if (res.ok) {
            const json = await res.json();
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
    } catch (e) {
        console.warn('Failed fetching album image from Last.fm:', e);
    }
    
    setCache(cacheKey, { imageUrl: null });
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
        const res = await fetch(`https://ws.audioscrobbler.com/2.0/?method=tag.gettopalbums&tag=${encodeURIComponent(genreName)}&api_key=${lastFmApiKey}&format=json&limit=1`);
        if (res.ok) {
            const json = await res.json();
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

    setCache(cacheKey, { imageUrl: null });
    return undefined;
};
