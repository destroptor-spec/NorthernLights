import { Pool } from 'pg';
import path from 'path';

let pool: Pool | null = null;
let initPromise: Promise<Pool> | null = null;

export async function initDB(): Promise<Pool> {
  if (pool) return pool;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    let client;
    try {
      const instance = new Pool({
        user: process.env.DB_USER || 'musicuser',
        password: process.env.DB_PASSWORD || 'musicpass',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'musicdb',
      });

      // Test connection and initialize schema
      client = await instance.connect();

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

        -- ==========================================
        -- MULTI-USER TABLES
        -- ==========================================

        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
          last_login_at BIGINT DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS invites (
          token TEXT PRIMARY KEY DEFAULT encode(gen_random_bytes(32), 'hex'),
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
          max_uses INTEGER DEFAULT 1,
          uses INTEGER DEFAULT 0,
          expires_at BIGINT,
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        );

        CREATE TABLE IF NOT EXISTS user_playback_stats (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
          play_count INTEGER NOT NULL DEFAULT 0,
          rating INTEGER NOT NULL DEFAULT 0,
          last_played_at BIGINT NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, track_id)
        );
        CREATE INDEX IF NOT EXISTS ups_user_id_idx ON user_playback_stats(user_id);
        CREATE INDEX IF NOT EXISTS ups_track_id_idx ON user_playback_stats(track_id);

        CREATE TABLE IF NOT EXISTS user_settings (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (user_id, key)
        );

        -- Add user_id to playlists (nullable for backward compat)
        DO $$
        BEGIN
          ALTER TABLE playlists ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;
        CREATE INDEX IF NOT EXISTS playlists_user_id_idx ON playlists(user_id);
      `);

      client.release();
      pool = instance;
      return pool;
    } catch (e) {
      if (client) {
        try { client.release(); } catch {}
      }
      initPromise = null;
      throw e;
    }
  })();

  return initPromise;
}

export async function getDatabaseStats() {
  try {
    const p = await initDB();
    const queries = {
      tables: "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
      indexes: "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'",
      tracks: "SELECT count(*) FROM tracks",
      artists: "SELECT count(*) FROM artists",
      albums: "SELECT count(*) FROM albums",
      genres: "SELECT count(*) FROM genres",
      playlists: "SELECT count(*) FROM playlists"
    };

    const results: any = {};
    for (const [key, query] of Object.entries(queries)) {
      try {
        const res = await p.query(query);
        results[key] = parseInt(res.rows[0].count || '0', 10);
      } catch (e) {
        results[key] = 0;
      }
    }
    return results;
  } catch (e) {
    console.error('[DB] Failed to get stats:', e);
    return null;
  }
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

export async function createPlaylist(id: string, title: string, description: string | null = null, isLlmGenerated: boolean = false, userId: string | null = null) {
  const db = await initDB();
  await db.query(`
    INSERT INTO playlists (id, title, description, createdAt, isLlmGenerated, user_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description
  `, [id, title, description, Date.now(), isLlmGenerated ? 1 : 0, userId]);
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

export async function deleteOldLlmPlaylists(maxAgeMs: number, userId: string | null = null) {
  const db = await initDB();
  const threshold = Date.now() - maxAgeMs;
  let query: string;
  let params: any[];

  if (userId) {
    // User-scoped cleanup
    await db.query(`
      DELETE FROM playlist_tracks
      WHERE playlistId IN (SELECT id FROM playlists WHERE isLlmGenerated = 1 AND createdAt < $1 AND user_id = $2)
    `, [threshold, userId]);

    const res = await db.query(`
      DELETE FROM playlists
      WHERE isLlmGenerated = 1 AND createdAt < $1 AND user_id = $2
    `, [threshold, userId]);
    return res.rowCount;
  } else {
    // Global cleanup (backward compat)
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
}

export async function getPlaylists(userId: string | null = null) {
  const db = await initDB();
  let res;
  if (userId) {
    res = await db.query('SELECT * FROM playlists WHERE user_id = $1 ORDER BY createdAt DESC', [userId]);
  } else {
    res = await db.query('SELECT * FROM playlists ORDER BY createdAt DESC');
  }
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

export async function deletePlaylist(playlistId: string, userId: string | null = null) {
  const db = await initDB();
  if (userId) {
    // Only delete if user owns the playlist
    await db.query('DELETE FROM playlist_tracks WHERE playlistId = $1', [playlistId]);
    await db.query('DELETE FROM playlists WHERE id = $1 AND user_id = $2', [playlistId, userId]);
  } else {
    // Admin/global delete
    await db.query('DELETE FROM playlist_tracks WHERE playlistId = $1', [playlistId]);
    await db.query('DELETE FROM playlists WHERE id = $1', [playlistId]);
  }
}

export async function getPlaylistOwner(playlistId: string): Promise<string | null> {
  const db = await initDB();
  const res = await db.query('SELECT user_id FROM playlists WHERE id = $1', [playlistId]);
  if (res.rows.length === 0) return null;
  return (res.rows[0] as any).user_id || null;
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

// ==========================================
// USER MANAGEMENT
// ==========================================

export async function createUser(username: string, passwordHash: string, role: string = 'user') {
  const db = await initDB();
  const res = await db.query(`
    INSERT INTO users (username, password_hash, role)
    VALUES ($1, $2, $3)
    RETURNING *
  `, [username, passwordHash, role]);
  return res.rows[0] as any;
}

export async function getUserById(id: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function getUserByUsername(username: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM users WHERE username = $1', [username]);
  return res.rows[0] || null;
}

export async function listUsers() {
  const db = await initDB();
  const res = await db.query('SELECT id, username, role, created_at, last_login_at FROM users ORDER BY created_at ASC');
  return res.rows;
}

export async function updateUser(id: string, fields: { username?: string; passwordHash?: string; role?: string }) {
  const db = await initDB();
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;

  if (fields.username) { sets.push(`username = $${idx++}`); vals.push(fields.username); }
  if (fields.passwordHash) { sets.push(`password_hash = $${idx++}`); vals.push(fields.passwordHash); }
  if (fields.role) { sets.push(`role = $${idx++}`); vals.push(fields.role); }

  if (sets.length === 0) return;
  vals.push(id);
  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
}

export async function updateLastLogin(id: string) {
  const db = await initDB();
  await db.query('UPDATE users SET last_login_at = $1 WHERE id = $2', [Date.now(), id]);
}

export async function deleteUser(id: string) {
  const db = await initDB();
  await db.query('DELETE FROM users WHERE id = $1', [id]);
}

export async function hasUsers(): Promise<boolean> {
  try {
    const db = await initDB();
    const res = await db.query('SELECT COUNT(*) as count FROM users');
    return parseInt((res.rows[0] as any).count, 10) > 0;
  } catch (error: any) {
    // If database is not reachable, we can't determine setup status
    if (error.code === 'ECONNREFUSED') {
      console.warn('[DB] Cannot determine setup status - connection refused.');
      throw error;
    }
    throw error;
  }
}

// ==========================================
// INVITE MANAGEMENT
// ==========================================

export async function createInvite(createdBy: string | null, role: string = 'user', maxUses: number = 1, expiresAt: number | null = null) {
  const db = await initDB();
  const res = await db.query(`
    INSERT INTO invites (created_by, role, max_uses, expires_at)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [createdBy, role, maxUses, expiresAt]);
  return res.rows[0] as any;
}

export async function getInvite(token: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM invites WHERE lower(trim(token)) = lower(trim($1))', [token]);
  return res.rows[0] || null;
}

export async function listInvites() {
  const db = await initDB();
  const res = await db.query('SELECT * FROM invites ORDER BY created_at DESC');
  return res.rows;
}

export async function deleteInvite(token: string) {
  const db = await initDB();
  await db.query('DELETE FROM invites WHERE token = $1', [token]);
}

export async function incrementInviteUses(token: string) {
  const db = await initDB();
  await db.query('UPDATE invites SET uses = uses + 1 WHERE token = $1', [token]);
}

export async function isInviteValid(token: string): Promise<boolean> {
  if (!token) return false;
  const invite = await getInvite(token);
  if (!invite) {
    console.warn(`[Invite] Validation failed: Token "${token}" not found in database.`);
    return false;
  }
  
  // Safe comparison for BIGINT (postgres returns as string) vs JS timestamp
  if (invite.expires_at) {
    const expiresAt = typeof invite.expires_at === 'string' ? parseInt(invite.expires_at, 10) : Number(invite.expires_at);
    if (Date.now() > expiresAt) {
      console.warn(`[Invite] Validation failed: Token "${token}" has expired (expired at ${expiresAt}, now ${Date.now()}).`);
      return false;
    }
  }
  
  if (Number(invite.uses) >= Number(invite.max_uses)) {
    console.warn(`[Invite] Validation failed: Token "${token}" use limit reached (${invite.uses}/${invite.max_uses}).`);
    return false;
  }
  
  return true;
}

// ==========================================
// USER PLAYBACK STATS (per-user telemetry)
// ==========================================

export async function recordPlaybackForUser(userId: string, trackId: string) {
  const db = await initDB();
  await db.query(`
    INSERT INTO user_playback_stats (user_id, track_id, play_count, last_played_at, rating)
    VALUES ($1, $2, 1, $3, LEAST(1, 5))
    ON CONFLICT (user_id, track_id) DO UPDATE SET
      play_count = user_playback_stats.play_count + 1,
      last_played_at = $3,
      rating = LEAST(user_playback_stats.rating + 1, 5)
  `, [userId, trackId, Date.now()]);

  // Also update the legacy tracks table for backward compat during migration
  await db.query(`
    UPDATE tracks
    SET playCount = playCount + 1,
        lastPlayedAt = $1,
        rating = LEAST(rating + 1, 5)
    WHERE id = $2
  `, [Date.now(), trackId]);
}

export async function recordSkipForUser(userId: string, trackId: string) {
  const db = await initDB();
  await db.query(`
    INSERT INTO user_playback_stats (user_id, track_id, play_count, last_played_at, rating)
    VALUES ($1, $2, 0, 0, GREATEST(-1, 0))
    ON CONFLICT (user_id, track_id) DO UPDATE SET
      rating = GREATEST(user_playback_stats.rating - 1, 0)
  `, [userId, trackId]);

  // Also update the legacy tracks table
  await db.query(`
    UPDATE tracks
    SET rating = GREATEST(rating - 1, 0)
    WHERE id = $1
  `, [trackId]);
}

export async function getUserPlaybackStats(userId: string) {
  const db = await initDB();
  const res = await db.query('SELECT * FROM user_playback_stats WHERE user_id = $1', [userId]);
  return res.rows;
}

export async function getUserTopTracks(userId: string, limit: number = 10) {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.*, ups.play_count, ups.rating as user_rating, ups.last_played_at as user_last_played
    FROM user_playback_stats ups
    JOIN tracks t ON ups.track_id = t.id
    WHERE ups.user_id = $1
    ORDER BY ups.play_count DESC
    LIMIT $2
  `, [userId, limit]);
  return res.rows.map(mapTrackRow);
}

export async function getUserRecentTracks(userId: string, limit: number = 5) {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.*, ups.play_count, ups.rating as user_rating, ups.last_played_at as user_last_played
    FROM user_playback_stats ups
    JOIN tracks t ON ups.track_id = t.id
    WHERE ups.user_id = $1 AND ups.last_played_at > 0
    ORDER BY ups.last_played_at DESC
    LIMIT $2
  `, [userId, limit]);
  return res.rows.map(mapTrackRow);
}

// ==========================================
// USER SETTINGS (per-user preferences)
// ==========================================

export async function getUserSetting(userId: string, key: string) {
  const db = await initDB();
  const res = await db.query('SELECT value FROM user_settings WHERE user_id = $1 AND key = $2', [userId, key]);
  if (res.rows.length === 0 || !(res.rows[0] as any).value) return null;
  try {
    return JSON.parse((res.rows[0] as any).value);
  } catch {
    return null;
  }
}

export async function setUserSetting(userId: string, key: string, value: any) {
  const db = await initDB();
  const valStr = JSON.stringify(value);
  await db.query(`
    INSERT INTO user_settings (user_id, key, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value
  `, [userId, key, valStr]);
}

export async function deleteUserSettings(userId: string) {
  const db = await initDB();
  await db.query('DELETE FROM user_settings WHERE user_id = $1', [userId]);
}
