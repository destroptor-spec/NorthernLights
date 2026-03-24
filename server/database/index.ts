import { Pool } from 'pg';
import path from 'path';

let pool: Pool | null = null;
let initPromise: Promise<Pool> | null = null;

export async function initDB(): Promise<Pool> {
  if (pool) return pool;
  if (initPromise) return initPromise;
  
  initPromise = (async () => {
    const instance = new Pool({
      user: process.env.DB_USER || 'musicuser',
      password: process.env.DB_PASSWORD || 'musicpass',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'musicdb',
    });

    // Test connection and initialize schema
    const client = await instance.connect();

  await client.query(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      title TEXT,
      artist TEXT,
      albumArtist TEXT,
      artists TEXT,
      album TEXT,
      genre TEXT,
      duration REAL,
      trackNumber INTEGER,
      year INTEGER,
      releaseType TEXT,
      isCompilation INTEGER,
      path TEXT UNIQUE,
      playCount INTEGER DEFAULT 0,
      lastPlayedAt BIGINT DEFAULT 0,
      rating INTEGER DEFAULT 0,
      bitrate INTEGER,
      format TEXT
    );

    DO $$ 
    BEGIN 
      ALTER TABLE tracks ADD COLUMN IF NOT EXISTS playCount INTEGER DEFAULT 0;
      ALTER TABLE tracks ADD COLUMN IF NOT EXISTS lastPlayedAt BIGINT DEFAULT 0;
      ALTER TABLE tracks ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0;
    EXCEPTION 
      WHEN OTHERS THEN null; 
    END $$;

    DO $$ 
    BEGIN 
      ALTER TABLE tracks ADD COLUMN IF NOT EXISTS bitrate INTEGER;
      ALTER TABLE tracks ADD COLUMN IF NOT EXISTS format TEXT;
    EXCEPTION 
      WHEN OTHERS THEN null; 
    END $$;

    CREATE TABLE IF NOT EXISTS track_features (
      track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE PRIMARY KEY,
      bpm NUMERIC,
      acoustic_vector VECTOR(7)
    );

    CREATE TABLE IF NOT EXISTS directories (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS genre_matrix_cache (
      id TEXT PRIMARY KEY,
      matrix TEXT
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Ensure index exists for fast vector search
    CREATE INDEX IF NOT EXISTS track_features_vector_idx ON track_features USING hnsw (acoustic_vector vector_l2_ops);

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      createdAt BIGINT NOT NULL,
      isLlmGenerated INTEGER NOT NULL DEFAULT 0
    );

    DO $$ 
    BEGIN 
      ALTER TABLE playlists ALTER COLUMN createdAt TYPE BIGINT; 
    EXCEPTION 
      WHEN OTHERS THEN null; 
    END $$;

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlistId TEXT REFERENCES playlists(id) ON DELETE CASCADE,
      trackId TEXT REFERENCES tracks(id) ON DELETE CASCADE,
      sortOrder INTEGER NOT NULL,
      PRIMARY KEY (playlistId, trackId)
    );

    CREATE TABLE IF NOT EXISTS subgenre_mappings (
      sub_genre TEXT PRIMARY KEY,
      macro_genre TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS macro_matrix_cache (
      id TEXT PRIMARY KEY,
      matrix TEXT NOT NULL
    );

    -- Entity tables for UUID-based navigation
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    CREATE TABLE IF NOT EXISTS artists (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    CREATE TABLE IF NOT EXISTS albums (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      artist_name TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE(title, artist_name)
    );

    CREATE TABLE IF NOT EXISTS genres (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- Add FK columns to tracks (nullable, backfilled by migration)
    DO $$
    BEGIN
      ALTER TABLE tracks ADD COLUMN IF NOT EXISTS artist_id UUID REFERENCES artists(id);
      ALTER TABLE tracks ADD COLUMN IF NOT EXISTS album_id UUID REFERENCES albums(id);
      ALTER TABLE tracks ADD COLUMN IF NOT EXISTS genre_id UUID REFERENCES genres(id);
    EXCEPTION WHEN OTHERS THEN null;
    END $$;

    -- Indexes for FK lookups
    CREATE INDEX IF NOT EXISTS tracks_artist_id_idx ON tracks(artist_id);
    CREATE INDEX IF NOT EXISTS tracks_album_id_idx ON tracks(album_id);
    CREATE INDEX IF NOT EXISTS tracks_genre_id_idx ON tracks(genre_id);
  `);
  
    client.release();
    pool = instance;
    return instance;
  })();

  return initPromise;
}

// Graceful shutdown
async function closeDB() {
  if (pool) {
    try {
      console.log('Shutting down PostgreSQL pool gracefully...');
      await pool.end();
    } catch (e) {
      console.error('Error closing pool:', e);
    }
  }
}

// Ensure the local dev server gracefully cleans up the database lock on restarts or exits.
let isShuttingDown = false;
async function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[PGlite] Received ${signal}, shutting down...`);
  await closeDB();
  if (signal === 'SIGUSR2') {
    process.kill(process.pid, 'SIGUSR2');
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.once('SIGUSR2', () => handleShutdown('SIGUSR2'));

function mapTrackRow(row: any) {
  return {
    ...row,
    albumArtist: row.albumartist,
    trackNumber: row.tracknumber,
    releaseType: row.releasetype,
    isCompilation: !!row.iscompilation,
    playCount: row.playcount,
    lastPlayedAt: row.lastplayedat,
    bitrate: row.bitrate,
    format: row.format,
    artistId: row.artist_id,
    albumId: row.album_id,
    genreId: row.genre_id
  };
}

export async function getAllTracks() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM tracks');
  return res.rows.map(mapTrackRow);
}

// Returns all known track paths as a Set for O(1) existence checks during scanning.
export async function getExistingPaths(): Promise<Set<string>> {
  const db = await initDB();
  const res = await db.query('SELECT path FROM tracks');
  return new Set(res.rows.map((r: any) => r.path));
}

export async function addTrack(track: any) {
  const db = await initDB();
  const id = Buffer.from(track.path).toString('base64');
  
  // Sanitize strings to remove null bytes which crash Postgres
  const sanitize = (str: any) => typeof str === 'string' ? str.replace(/\x00/g, '') : str;
  const sanitizeArray = (arr: any) => Array.isArray(arr) ? arr.map(sanitize) : arr;

  await db.query(`
    INSERT INTO tracks (id, title, artist, albumArtist, artists, album, genre, duration, trackNumber, year, releaseType, isCompilation, path, bitrate, format, artist_id, album_id, genre_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      artist = EXCLUDED.artist,
      albumArtist = EXCLUDED.albumArtist,
      artists = EXCLUDED.artists,
      album = EXCLUDED.album,
      genre = EXCLUDED.genre,
      duration = EXCLUDED.duration,
      trackNumber = EXCLUDED.trackNumber,
      year = EXCLUDED.year,
      releaseType = EXCLUDED.releaseType,
      isCompilation = EXCLUDED.isCompilation,
      path = EXCLUDED.path,
      bitrate = EXCLUDED.bitrate,
      format = EXCLUDED.format,
      artist_id = EXCLUDED.artist_id,
      album_id = EXCLUDED.album_id,
      genre_id = EXCLUDED.genre_id
  `, [
    id,
    sanitize(track.title) || path.basename(track.path),
    sanitize(track.artist) || null,
    sanitize(track.albumArtist) || null,
    track.artists ? JSON.stringify(sanitizeArray(track.artists)) : null,
    sanitize(track.album) || null,
    sanitize(track.genre) || null,
    track.duration || 0,
    track.trackNumber || null,
    track.year || null,
    track.releaseType || null,
    track.isCompilation ? 1 : 0,
    track.path,
    track.bitrate || null,
    track.format || null,
    track.artistId || null,
    track.albumId || null,
    track.genreId || null
  ]);

  if (track.audioFeatures) {
    const vectorStr = `[${track.audioFeatures.acoustic_vector.join(',')}]`;
    await db.query(`
      INSERT INTO track_features (track_id, bpm, acoustic_vector)
      VALUES ($1, $2, $3)
      ON CONFLICT (track_id) DO UPDATE SET
        bpm = EXCLUDED.bpm,
        acoustic_vector = EXCLUDED.acoustic_vector
    `, [id, track.audioFeatures.bpm, vectorStr]);
  }
}

export async function clearTracks() {
  const db = await initDB();
  await db.query('DELETE FROM tracks');
}

export async function addDirectory(dirPath: string) {
  const db = await initDB();
  const id = Buffer.from(dirPath).toString('base64');
  await db.query('INSERT INTO directories (id, path) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, dirPath]);
  return { id, path: dirPath };
}

export async function getDirectories() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM directories');
  return res.rows.map((d: any) => d.path);
}

export async function removeDirectory(dirPath: string) {
  const db = await initDB();
  const id = Buffer.from(dirPath).toString('base64');
  await db.query('DELETE FROM directories WHERE id = $1', [id]);
}

export async function removeTracksByDirectory(dirPath: string) {
  const db = await initDB();
  
  // Since tracks are stored natively as Base64 Buffers to avoid UTF-8 mangling,
  // we must decode and match the directory recursively at the byte level.
  const res = await db.query('SELECT id, path FROM tracks');
  const dirBuf = Buffer.from(dirPath, 'utf8');
  const idsToDelete: string[] = [];
  
  for (const row of res.rows) {
    const fileBuf = Buffer.from(row.path, 'base64');
    if (fileBuf.length >= dirBuf.length && fileBuf.slice(0, dirBuf.length).equals(dirBuf)) {
      idsToDelete.push(row.id);
    }
  }

  if (idsToDelete.length > 0) {
    for (let i = 0; i < idsToDelete.length; i += 100) {
      const chunk = idsToDelete.slice(i, i + 100);
      const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
      await db.query(`DELETE FROM tracks WHERE id IN (${placeholders})`, chunk);
    }
  }
}

export async function recordPlayback(trackId: string) {
  const db = await initDB();
  // Increment playCount, update lastPlayedAt, and passively give a small rating bump
  await db.query(`
    UPDATE tracks 
    SET playCount = playCount + 1,
        lastPlayedAt = $1,
        rating = LEAST(rating + 1, 5)
    WHERE id = $2
  `, [Date.now(), trackId]);
}

export async function recordSkip(trackId: string) {
  const db = await initDB();
  // Penalize rating slightly for skips
  await db.query(`
    UPDATE tracks 
    SET rating = GREATEST(rating - 1, 0)
    WHERE id = $1
  `, [trackId]);
}

// ==========================================
// ENTITY HELPERS (Artists, Albums, Genres)
// ==========================================

// In-memory caches to reduce DB round-trips during scanning
const artistCache = new Map<string, string>();   // name -> UUID
const albumCache = new Map<string, string>();     // "title::::artist" -> UUID
const genreCache = new Map<string, string>();     // name -> UUID

function clearEntityCaches() {
  artistCache.clear();
  albumCache.clear();
  genreCache.clear();
}

export async function getOrCreateArtist(name: string): Promise<string> {
  if (!name) throw new Error('Artist name required');
  const cached = artistCache.get(name);
  if (cached) return cached;

  const db = await initDB();
  const res = await db.query(
    `INSERT INTO artists (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [name]
  );
  const id = (res.rows[0] as any).id as string;
  artistCache.set(name, id);
  return id;
}

export async function getOrCreateAlbum(title: string, artistName: string | null): Promise<string> {
  const key = `${title}::::${artistName || ''}`;
  const cached = albumCache.get(key);
  if (cached) return cached;

  const db = await initDB();
  const res = await db.query(
    `INSERT INTO albums (title, artist_name) VALUES ($1, $2) ON CONFLICT (title, artist_name) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
    [title, artistName || null]
  );
  const id = (res.rows[0] as any).id as string;
  albumCache.set(key, id);
  return id;
}

export async function getOrCreateGenre(name: string): Promise<string> {
  if (!name) throw new Error('Genre name required');
  const cached = genreCache.get(name);
  if (cached) return cached;

  const db = await initDB();
  const res = await db.query(
    `INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [name]
  );
  const id = (res.rows[0] as any).id as string;
  genreCache.set(name, id);
  return id;
}

export async function getArtistById(id: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM artists WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function getAlbumById(id: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM albums WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function getGenreById(id: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM genres WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function getAllArtists() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM artists ORDER BY name ASC');
  return res.rows;
}

export async function getAllAlbums() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM albums ORDER BY title ASC');
  return res.rows;
}

export async function getAllGenres() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM genres ORDER BY name ASC');
  return res.rows;
}

export async function getTracksByArtist(artistId: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM tracks WHERE artist_id = $1', [artistId]);
  return res.rows.map(mapTrackRow);
}

export async function getTracksByAlbum(albumId: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM tracks WHERE album_id = $1 ORDER BY tracknumber ASC NULLS LAST', [albumId]);
  return res.rows.map(mapTrackRow);
}

export async function getTracksByGenre(genreId: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM tracks WHERE genre_id = $1', [genreId]);
  return res.rows.map(mapTrackRow);
}

// Backfill entity IDs for tracks that don't have them yet.
// Runs on startup; processes only tracks with NULL artist_id.
export async function migrateEntityIds() {
  const db = await initDB();
  const res = await db.query(
    'SELECT id, artist, albumartist, artists, album, genre FROM tracks WHERE artist_id IS NULL OR album_id IS NULL OR genre_id IS NULL'
  );

  if (res.rows.length === 0) return;

  console.log(`[DB Migration] Backfilling entity IDs for ${res.rows.length} tracks...`);
  let count = 0;

  for (const row of res.rows) {
    const trackId = (row as any).id;
    const albumArtistName = (row as any).albumartist || (row as any).artist;
    const albumTitle = (row as any).album;
    const genreName = (row as any).genre;
    const rawArtists = (row as any).artists;

    let artistId: string | null = null;
    let albumId: string | null = null;
    let genreId: string | null = null;

    try {
      if (albumArtistName) artistId = await getOrCreateArtist(albumArtistName);
    } catch {}

    // Also create entities for all individual artists (including featured)
    try {
      let individualArtists: string[] = [];
      if (rawArtists) {
        if (typeof rawArtists === 'string') {
          try { individualArtists = JSON.parse(rawArtists); } catch {}
        } else if (Array.isArray(rawArtists)) {
          individualArtists = rawArtists;
        }
      } else if ((row as any).artist) {
        // Fallback: split on feat./ft./etc.
        const parts = (row as any).artist.split(/\s+(?:feat\.?|ft\.?|featuring|&)\s+(?!$)/i).map((s: string) => s.trim()).filter(Boolean);
        if (parts.length > 0) individualArtists = parts;
      }
      for (const a of individualArtists) {
        try { await getOrCreateArtist(a); } catch {}
      }
    } catch {}

    try {
      if (albumTitle) albumId = await getOrCreateAlbum(albumTitle, albumArtistName || null);
    } catch {}

    try {
      if (genreName) genreId = await getOrCreateGenre(genreName);
    } catch {}

    await db.query(
      'UPDATE tracks SET artist_id = COALESCE($1, artist_id), album_id = COALESCE($2, album_id), genre_id = COALESCE($3, genre_id) WHERE id = $4',
      [artistId, albumId, genreId, trackId]
    );
    count++;
  }

  console.log(`[DB Migration] Backfilled entity IDs for ${count} tracks`);
}

// ==========================================
// PLAYLISTS API 
// ==========================================

export async function createPlaylist(id: string, title: string, description: string | null = null, isLlmGenerated: boolean = false) {
  const db = await initDB();
  await db.query(`
    INSERT INTO playlists (id, title, description, createdAt, isLlmGenerated)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description
  `, [id, title, description, Date.now(), isLlmGenerated ? 1 : 0]);
}

export async function addTracksToPlaylist(playlistId: string, trackIds: string[]) {
  const db = await initDB();
  // Clear existing tracks for a clean overwrite or handle deduplication depending on logic.
  // We'll wipe and re-insert for LLM generated ones, or append for user playlists.
  // For simplicity here, we clear and reinsert.
  await db.query(`DELETE FROM playlist_tracks WHERE playlistId = $1`, [playlistId]);
  
  for (let i = 0; i < trackIds.length; i++) {
    await db.query(`
      INSERT INTO playlist_tracks (playlistId, trackId, sortOrder)
      VALUES ($1, $2, $3)
    `, [playlistId, trackIds[i], i]);
  }
}

export async function deleteOldLlmPlaylists(maxAgeMs: number) {
  const db = await initDB();
  const threshold = Date.now() - maxAgeMs;
  // Delete the playlist_tracks first (CASCADE would also work but being explicit is safer with PGLite/PG)
  await db.query(`
    DELETE FROM playlist_tracks 
    WHERE playlistId IN (SELECT id FROM playlists WHERE isLlmGenerated = 1 AND createdAt < $1)
  `, [threshold]);
  
  const res = await db.query(`
    DELETE FROM playlists 
    WHERE isLlmGenerated = 1 AND createdAt < $1
  `, [threshold]);
  
  return res.rowCount;
}

export async function getPlaylists() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM playlists ORDER BY createdAt DESC');
  return res.rows.map((row: any) => ({
    ...row,
    isLlmGenerated: row.isllmgenerated === 1
  }));
}

export async function getPlaylistTracks(playlistId: string) {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.* FROM tracks t
    JOIN playlist_tracks pt ON t.id = pt.trackId
    WHERE pt.playlistId = $1
    ORDER BY pt.sortOrder ASC
  `, [playlistId]);
  return res.rows.map(mapTrackRow);
}

export async function deletePlaylist(playlistId: string) {
  const db = await initDB();
  await db.query('DELETE FROM playlist_tracks WHERE playlistId = $1', [playlistId]);
  await db.query('DELETE FROM playlists WHERE id = $1', [playlistId]);
}

export async function getVectorStats() {
  const db = await initDB();
  const res = await db.query('SELECT acoustic_vector FROM track_features');
  
  if (res.rows.length === 0) {
    return null;
  }

  const sums = [0,0,0,0,0,0,0];
  const sqSums = [0,0,0,0,0,0,0];
  const count = res.rows.length;

  for (const row of res.rows as any[]) {
    const vec = JSON.parse(row.acoustic_vector);
    for (let i = 0; i < 7; i++) {
       sums[i] += vec[i];
       sqSums[i] += vec[i] * vec[i];
    }
  }

  const means = sums.map(s => s / count);
  const stddevs = sums.map((_, i) => {
     const variance = (sqSums[i] / count) - (means[i] * means[i]);
     return Math.sqrt(Math.max(0, variance)) || 1; // prevent div by zero
  });

  return { means, stddevs };
}

// ==========================================
// SYSTEM SETTINGS & GENRE MATRIX
// ==========================================

export async function getGenreMatrixCache() {
  const db = await initDB();
  const res = await db.query('SELECT matrix FROM genre_matrix_cache WHERE id = $1', ['default']);
  if (res.rows.length === 0 || !(res.rows[0] as any).matrix) return {};
  const matrix = (res.rows[0] as any).matrix as string;
  try {
    return JSON.parse(matrix);
  } catch(e) {
    return {};
  }
}

export async function updateGenreMatrixCache(matrix: any) {
  const db = await initDB();
  const matrixStr = JSON.stringify(matrix);
  await db.query(`
    INSERT INTO genre_matrix_cache (id, matrix)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET matrix = EXCLUDED.matrix
  `, ['default', matrixStr]);
}

export async function getSystemSetting(key: string) {
  const db = await initDB();
  const res = await db.query('SELECT value FROM system_settings WHERE key = $1', [key]);
  if (res.rows.length === 0 || !(res.rows[0] as any).value) return null;
  const val = (res.rows[0] as any).value as string;
  try {
    return JSON.parse(val);
  } catch(e) {
    return null;
  }
}
export async function getMacroMatrix() {
  const db = await initDB();
  const res = await db.query('SELECT matrix FROM macro_matrix_cache WHERE id = $1', ['default']);
  if (res.rows.length === 0 || !(res.rows[0] as any).matrix) return null;
  const matrix = (res.rows[0] as any).matrix as string;
  try {
    return JSON.parse(matrix);
  } catch(e) {
    return null;
  }
}

export async function updateMacroMatrix(matrix: any) {
  const db = await initDB();
  const matrixStr = JSON.stringify(matrix);
  await db.query(`
    INSERT INTO macro_matrix_cache (id, matrix)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET matrix = EXCLUDED.matrix
  `, ['default', matrixStr]);
}

export async function upsertSubGenreMapping(subGenre: string, macroGenre: string) {
  const db = await initDB();
  const sanitized = subGenre.toLowerCase().trim().replace(/[^\w\s-]/g, '');
  if (!sanitized) return;
  await db.query(`
    INSERT INTO subgenre_mappings (sub_genre, macro_genre)
    VALUES ($1, $2)
    ON CONFLICT (sub_genre) DO UPDATE SET macro_genre = EXCLUDED.macro_genre
  `, [sanitized, macroGenre]);
}

export async function clearSubGenreMappings() {
  const db = await initDB();
  await db.query('DELETE FROM subgenre_mappings');
}

export async function getSubGenreMappings(): Promise<Record<string, string>> {
  const db = await initDB();
  const res = await db.query('SELECT * FROM subgenre_mappings');
  const mappings: Record<string, string> = {};
  res.rows.forEach((row: any) => {
    mappings[row.sub_genre] = row.macro_genre;
  });
  return mappings;
}

export async function getMacroGenreFromKNN(vector: number[]): Promise<string | null> {
  const db = await initDB();
  const vectorStr = `[${vector.join(',')}]`;
  
  // Find top 5 mathematically closest tracks that have a known sub-genre
  // and then look up their macro-genre.
  // We use Euclidean distance (L2) available via <-> in pgvector.
  const res = await db.query(`
    SELECT sm.macro_genre, COUNT(*) as frequency
    FROM tracks t
    JOIN track_features tf ON t.id = tf.track_id
    JOIN subgenre_mappings sm ON lower(trim(t.genre)) = sm.sub_genre
    WHERE tf.acoustic_vector <-> $1 < 0.5
    GROUP BY sm.macro_genre
    ORDER BY frequency DESC
    LIMIT 1
  `, [vectorStr]);

  if (res.rows.length > 0) {
    return (res.rows[0] as any).macro_genre;
  }
  return null;
}

export async function setSystemSetting(key: string, value: any) {
  const db = await initDB();
  const valStr = JSON.stringify(value);
  await db.query(`
    INSERT INTO system_settings (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [key, valStr]);
}
