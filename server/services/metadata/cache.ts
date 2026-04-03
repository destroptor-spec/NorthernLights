import { initDB } from '../../database';

const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

function isCacheFresh(lastUpdated: number): boolean {
  if (!lastUpdated) return false;
  return Date.now() - lastUpdated * 1000 < CACHE_TTL;
}

export async function getCachedArtist(name: string): Promise<any | null> {
  const db = await initDB();
  const res = await db.query('SELECT * FROM artists WHERE name = $1', [name]);
  return res.rows[0] || null;
}

export async function upsertArtistCache(
  name: string,
  imageUrl: string | null,
  bio: string | null,
  mbid: string | null,
  updateLastUpdated = true
): Promise<void> {
  const db = await initDB();
  const now = Math.floor(Date.now() / 1000);
  if (updateLastUpdated) {
    await db.query(
      `INSERT INTO artists (id, name, image_url, bio, mbid, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         image_url = COALESCE($2, artists.image_url),
         bio = COALESCE($3, artists.bio),
         mbid = COALESCE($4, artists.mbid),
         last_updated = $5`,
      [name, imageUrl, bio, mbid, now]
    );
  } else {
    await db.query(
      `INSERT INTO artists (id, name, image_url, bio, mbid, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 0)
       ON CONFLICT (name) DO UPDATE SET
         image_url = COALESCE($2, artists.image_url),
         bio = COALESCE($3, artists.bio),
         mbid = COALESCE($4, artists.mbid)`,
      [name, imageUrl, bio, mbid]
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

export async function upsertAlbumCache(
  title: string,
  artistName: string,
  imageUrl: string | null,
  mbid: string | null,
  updateLastUpdated = true
): Promise<void> {
  const db = await initDB();
  const now = Math.floor(Date.now() / 1000);
  if (updateLastUpdated) {
    await db.query(
      `INSERT INTO albums (id, title, artist_name, image_url, mbid, last_updated)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
       ON CONFLICT (title, artist_name) DO UPDATE SET
         image_url = COALESCE($3, albums.image_url),
         mbid = COALESCE($4, albums.mbid),
         last_updated = $5`,
      [title, artistName, imageUrl, mbid, now]
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
  await db.query('UPDATE artists SET last_updated = 0 WHERE last_updated > 0');
  await db.query('UPDATE albums SET last_updated = 0 WHERE last_updated > 0');
  await db.query('UPDATE genres SET last_updated = 0 WHERE last_updated > 0');
}

export { isCacheFresh, CACHE_TTL };
