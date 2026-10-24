import { initDB } from '../../database';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

function isCacheFresh(lastUpdated: number, ttlMs: number = CACHE_TTL): boolean {
  if (!lastUpdated) return false;
  return Date.now() - lastUpdated * 1000 < ttlMs;
}

export async function getCachedArtist(name: string): Promise<any | null> {
  const db = await initDB();
  const res = await db.query('SELECT * FROM artists WHERE name = $1', [name]);
  return res.rows[0] || null;
}

export interface ArtistCacheExtras {
  artworkUrl?: string | null;
  disambiguation?: string | null;
  area?: string | null;
  artistType?: string | null;
  lifespanBegin?: string | null;
  lifespanEnd?: string | null;
  links?: string | null; // JSON
  genres?: string | null; // JSON
  communityTags?: string | null; // JSON
  listeners?: string | null;
  members?: string | null; // JSON
}

// An artist's MusicBrainz id comes from the files (the scanner). Provider
// lookups only fill an empty one: an artist page used to send the id of one of
// the artist's tracks, and on a joint album that was a co-artist's (Tony
// Bennett got Diana Krall's id from her solo song on their album).
export async function upsertArtistCache(
  name: string,
  imageUrl: string | null,
  bio: string | null,
  mbid: string | null,
  updateLastUpdated = true,
  extras: ArtistCacheExtras = {}
): Promise<void> {
  const db = await initDB();
  const now = Math.floor(Date.now() / 1000);
  if (updateLastUpdated) {
    await db.query(
      `INSERT INTO artists (id, name, image_url, artwork_url, bio, mbid, last_updated, disambiguation, area, artist_type, lifespan_begin, lifespan_end, links, genres, community_tags, listeners, members)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (name) DO UPDATE SET
         image_url = COALESCE($2, artists.image_url),
         artwork_url = COALESCE($3, artists.artwork_url),
         bio = COALESCE($4, artists.bio),
         mbid = COALESCE(artists.mbid, $5),
         last_updated = $6,
         disambiguation = COALESCE($7, artists.disambiguation),
         area = COALESCE($8, artists.area),
         artist_type = COALESCE($9, artists.artist_type),
         lifespan_begin = COALESCE($10, artists.lifespan_begin),
         lifespan_end = COALESCE($11, artists.lifespan_end),
         links = COALESCE($12, artists.links),
         genres = COALESCE($13, artists.genres),
         community_tags = COALESCE($14, artists.community_tags),
         listeners = COALESCE($15, artists.listeners),
         members = COALESCE($16, artists.members)`,
      [name, imageUrl, extras.artworkUrl ?? null, bio, mbid, now,
       extras.disambiguation ?? null,
       extras.area ?? null,
       extras.artistType ?? null,
       extras.lifespanBegin ?? null,
       extras.lifespanEnd ?? null,
       extras.links ?? null,
       extras.genres ?? null,
       extras.communityTags ?? null,
       extras.listeners ?? null,
       extras.members ?? null]
    );
  } else {
    await db.query(
      `INSERT INTO artists (id, name, image_url, artwork_url, bio, mbid, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 0)
       ON CONFLICT (name) DO UPDATE SET
         image_url = COALESCE($2, artists.image_url),
         artwork_url = COALESCE($3, artists.artwork_url),
         bio = COALESCE($4, artists.bio),
         mbid = COALESCE(artists.mbid, $5)`,
      [name, imageUrl, extras.artworkUrl ?? null, bio, mbid]
    );
  }
}

export async function getCachedAlbum(
  title: string,
  artistName: string
): Promise<any | null> {
  const db = await initDB();
  const res = await db.query(
    'SELECT * FROM albums WHERE title = $1 AND artist_name = $2',
    [title, artistName]
  );
  return res.rows[0] || null;
}

export interface AlbumCacheExtras {
  description?: string | null;
  tags?: string | null; // JSON
  listeners?: string | null;
  playcount?: string | null;
}

export async function upsertAlbumCache(
  title: string,
  artistName: string,
  imageUrl: string | null,
  mbid: string | null,
  updateLastUpdated = true,
  extras: AlbumCacheExtras = {}
): Promise<void> {
  const db = await initDB();
  const now = Math.floor(Date.now() / 1000);
  if (updateLastUpdated) {
    await db.query(
      `INSERT INTO albums (id, title, artist_name, image_url, mbid, last_updated, description, tags, listeners, playcount)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (title, artist_name) DO UPDATE SET
         image_url = COALESCE($3, albums.image_url),
         mbid = COALESCE($4, albums.mbid),
         last_updated = $5,
         description = COALESCE($6, albums.description),
         tags = COALESCE($7, albums.tags),
         listeners = COALESCE($8, albums.listeners),
         playcount = COALESCE($9, albums.playcount)`,
      [title, artistName, imageUrl, mbid, now,
       extras.description ?? null,
       extras.tags ?? null,
       extras.listeners ?? null,
       extras.playcount ?? null]
    );
  } else {
    await db.query(
      `INSERT INTO albums (id, title, artist_name, image_url, mbid, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 0)
       ON CONFLICT (title, artist_name) DO UPDATE SET
         image_url = COALESCE($3, albums.image_url),
         mbid = COALESCE($4, albums.mbid)`,
      [title, artistName, imageUrl, mbid]
    );
  }
}

export async function getCachedGenre(name: string): Promise<any | null> {
  const db = await initDB();
  const res = await db.query('SELECT * FROM genres WHERE name = $1', [name]);
  return res.rows[0] || null;
}

export async function upsertGenreCache(
  name: string,
  imageUrl: string | null,
  description: string | null,
  updateLastUpdated = true
): Promise<void> {
  const db = await initDB();
  const now = Math.floor(Date.now() / 1000);
  if (updateLastUpdated) {
    await db.query(
      `INSERT INTO genres (id, name, image_url, description, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET
         image_url = COALESCE($2, genres.image_url),
         description = COALESCE($3, genres.description),
         last_updated = $4`,
      [name, imageUrl, description, now]
    );
  } else {
    await db.query(
      `INSERT INTO genres (id, name, image_url, description, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, 0)
       ON CONFLICT (name) DO UPDATE SET
         image_url = COALESCE($2, genres.image_url),
         description = COALESCE($3, genres.description)`,
      [name, imageUrl, description]
    );
  }
}

export async function clearExternalCache(): Promise<void> {
  const db = await initDB();
  await db.query('UPDATE artists SET last_updated = 0, image_url = NULL, artwork_url = NULL, bio = NULL WHERE last_updated > 0 OR image_url IS NOT NULL OR artwork_url IS NOT NULL OR bio IS NOT NULL');
  await db.query('UPDATE albums SET last_updated = 0, image_url = NULL WHERE last_updated > 0 OR image_url IS NOT NULL');
  await db.query('UPDATE genres SET last_updated = 0, image_url = NULL, description = NULL WHERE last_updated > 0 OR image_url IS NOT NULL OR description IS NOT NULL');
}

export { isCacheFresh, CACHE_TTL };
