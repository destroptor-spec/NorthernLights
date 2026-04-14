import { Pool } from 'pg';
import path from 'path';

let pool: Pool | null = null;
let initPromise: Promise<Pool> | null = null;

// Reference-counted leak detection control - allows nested long-running operations
let leakDetectionDisabledCount = 0;

export function disableLeakDetection() {
  leakDetectionDisabledCount++;
}

export function enableLeakDetection() {
  leakDetectionDisabledCount = Math.max(0, leakDetectionDisabledCount - 1);
}

export function isLeakDetectionActive(): boolean {
  return leakDetectionDisabledCount === 0;
}

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
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        statement_timeout: 30000,
        keepAlive: true,
      });

      instance.on('connect', () => {
        console.log('[DB] New client connected to database pool');
      });

      instance.on('error', (err) => {
        console.error('[DB] Unexpected error on idle client:', err);
      });

      instance.on('remove', (client) => {
        if (client && (client as any)._leakTimeout) {
          clearTimeout((client as any)._leakTimeout);
          delete (client as any)._leakTimeout;
        }
        console.log('[DB] Client removed from database pool');
      });

      instance.on('acquire', (client) => {
        if (!client) return;
        
        // Skip leak detection during long-running operations (e.g., MBDB import)
        if (!isLeakDetectionActive()) return;
        
        const stack = new Error().stack;
        (client as any)._leakTimeout = setTimeout(() => {
          console.warn('[DB] CONNECTION LEAK DETECTED: Client held for > 2 minutes.');
          if (stack) console.warn('[DB] Leak origin stack trace:', stack);
        }, 2 * 60 * 1000);
      });

      instance.on('release', (err, client) => {
        if (client && (client as any)._leakTimeout) {
          clearTimeout((client as any)._leakTimeout);
          delete (client as any)._leakTimeout;
        }
      });

      // Test connection and initialize schema
      client = await instance.connect();

      await client.query(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;

        CREATE TABLE IF NOT EXISTS tracks (
          id TEXT PRIMARY KEY,
          title TEXT,
          artist TEXT,
          album_artist TEXT,
          artists TEXT,
          album TEXT,
          genre TEXT,
          duration REAL,
          track_number INTEGER,
          year INTEGER,
          release_type TEXT,
          is_compilation BOOLEAN,
          path TEXT UNIQUE,
          play_count INTEGER DEFAULT 0,
          last_played_at TIMESTAMPTZ,
          rating INTEGER DEFAULT 0,
          bitrate INTEGER,
          format TEXT
        );

        DO $$ 
        BEGIN 
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS play_count INTEGER DEFAULT 0;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS last_played_at TIMESTAMPTZ;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0;
        EXCEPTION 
          WHEN OTHERS THEN null; 
        END $$;

        DO $$ 
        BEGIN 
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS bitrate INTEGER;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS format TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS genres TEXT;
        EXCEPTION 
          WHEN OTHERS THEN null; 
        END $$;

        DO $$ 
        BEGIN 
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS isrc TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_recording_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_track_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_album_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_artist_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_album_artist_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_release_group_id TEXT;
          ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_work_id TEXT;
        EXCEPTION 
          WHEN OTHERS THEN null; 
        END $$;

        CREATE TABLE IF NOT EXISTS track_features (
          track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE PRIMARY KEY,
          bpm NUMERIC,
          acoustic_vector VECTOR(7)
        );

        -- Migration: Add 8D acoustic_vector column (VECTOR(8))
        DO $$
        BEGIN
          ALTER TABLE track_features ADD COLUMN IF NOT EXISTS acoustic_vector_8d VECTOR(8);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Create HNSW index for 8D vectors
        DO $$
        BEGIN
          CREATE INDEX IF NOT EXISTS track_features_vector_8d_idx 
          ON track_features USING hnsw (acoustic_vector_8d vector_l2_ops);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Migration: Add is_simulated flag for tracks analyzed without real ffmpeg audio
        DO $$
        BEGIN
          ALTER TABLE track_features ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT FALSE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Migration: Add 8D acoustic vector (named column for 10D expansion)
        DO $$
        BEGIN
          ALTER TABLE track_features ADD COLUMN IF NOT EXISTS acoustic_vector VECTOR(10);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- Migration: Add/resize Discogs-EffNet embedding column to 1280D
        -- EffNet produces 1280D embeddings (bs64 refers to batch size, not dims)
        DO $$
        BEGIN
          -- If the column exists as VECTOR(128) (wrong size), drop and recreate it
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'track_features'
              AND column_name = 'embedding_vector'
          ) THEN
            DECLARE
              col_dims INTEGER;
            BEGIN
              SELECT atttypmod INTO col_dims
              FROM pg_attribute a
              JOIN pg_class c ON a.attrelid = c.oid
              WHERE c.relname = 'track_features' AND a.attname = 'embedding_vector';
              IF col_dims != 1280 THEN
                DROP INDEX IF EXISTS track_features_embedding_idx;
                ALTER TABLE track_features DROP COLUMN embedding_vector;
                ALTER TABLE track_features ADD COLUMN embedding_vector VECTOR(1280);
              END IF;
            END;
          ELSE
            ALTER TABLE track_features ADD COLUMN embedding_vector VECTOR(1280);
          END IF;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- HNSW index for 10D acoustic vectors (L2 distance)
        DO $$
        BEGIN
          CREATE INDEX IF NOT EXISTS track_features_acoustic_idx 
          ON track_features USING hnsw (acoustic_vector vector_l2_ops);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- HNSW index for 1280D EffNet embeddings (Cosine distance)
        DO $$
        BEGIN
          CREATE INDEX IF NOT EXISTS track_features_embedding_idx 
          ON track_features USING hnsw (embedding_vector vector_cosine_ops);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

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

        -- Add MFCC timbre vector column (nullable — backfilled by background migrator)
        DO $$
        BEGIN
          ALTER TABLE track_features ADD COLUMN IF NOT EXISTS mfcc_vector VECTOR(13);
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- HNSW index for 13D timbre similarity search
        CREATE INDEX IF NOT EXISTS track_features_mfcc_idx ON track_features USING hnsw (mfcc_vector vector_l2_ops);

        CREATE TABLE IF NOT EXISTS playlists (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          is_llm_generated BOOLEAN NOT NULL DEFAULT FALSE
        );

        DO $$ 
        BEGIN 
          ALTER TABLE playlists ALTER COLUMN created_at TYPE TIMESTAMPTZ; 
        EXCEPTION 
          WHEN OTHERS THEN null; 
        END $$;

        CREATE TABLE IF NOT EXISTS playlist_tracks (
          playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,
          track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL,
          PRIMARY KEY (playlist_id, track_id)
        );
        CREATE INDEX IF NOT EXISTS playlist_tracks_track_id_idx ON playlist_tracks(track_id);

        DROP TABLE IF EXISTS subgenre_mappings CASCADE;
        CREATE TABLE subgenre_mappings (
          sub_genre TEXT PRIMARY KEY,
          path TEXT NOT NULL
        );

        DROP TABLE IF EXISTS macro_matrix_cache CASCADE;

        CREATE TABLE IF NOT EXISTS genre (
          id INTEGER PRIMARY KEY,
          gid UUID NOT NULL,
          name TEXT NOT NULL,
          comment TEXT,
          edits_pending INTEGER,
          last_updated TIMESTAMP WITH TIME ZONE
        );

        CREATE TABLE IF NOT EXISTS genre_alias (
          id INTEGER PRIMARY KEY,
          genre INTEGER REFERENCES genre(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          locale TEXT,
          edits_pending INTEGER,
          last_updated TIMESTAMP WITH TIME ZONE,
          type INTEGER,
          sort_name TEXT,
          begin_date_year INTEGER,
          begin_date_month INTEGER,
          begin_date_day INTEGER,
          end_date_year INTEGER,
          end_date_month INTEGER,
          end_date_day INTEGER,
          primary_for_locale BOOLEAN,
          ended BOOLEAN
        );
        CREATE INDEX IF NOT EXISTS genre_alias_genre_idx ON genre_alias (genre);
        CREATE INDEX IF NOT EXISTS genre_alias_name_lower_idx ON genre_alias (LOWER(name));
        CREATE INDEX IF NOT EXISTS genre_alias_name_trgm_idx ON genre_alias USING gin (LOWER(name) gin_trgm_ops);

        CREATE TABLE IF NOT EXISTS l_genre_genre (
          id INTEGER PRIMARY KEY,
          link INTEGER NOT NULL,
          entity0 INTEGER NOT NULL REFERENCES genre(id) ON DELETE CASCADE,
          entity1 INTEGER NOT NULL REFERENCES genre(id) ON DELETE CASCADE,
          edits_pending INTEGER,
          last_updated TIMESTAMP WITH TIME ZONE,
          link_order INTEGER,
          entity0_credit TEXT,
          entity1_credit TEXT
        );

        -- Indexes for l_genre_genre to speed up materialized view refresh
        CREATE INDEX IF NOT EXISTS l_genre_genre_entity0_idx ON l_genre_genre (entity0);
        CREATE INDEX IF NOT EXISTS l_genre_genre_entity1_idx ON l_genre_genre (entity1);
        CREATE INDEX IF NOT EXISTS l_genre_genre_link_idx ON l_genre_genre (link);
        CREATE INDEX IF NOT EXISTS l_genre_genre_link_subgenre_idx ON l_genre_genre (entity0, entity1) WHERE link = 944810;

        -- Note: We can only create the materialized view after l_genre_genre and genre are created.
        -- We will recreate it inside a DO block to catch if tables are empty.
        -- Auto-migrate the materialized view if the old schema exists
        DO $$ 
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_class c 
                JOIN pg_namespace n ON n.oid = c.relnamespace 
                WHERE c.relname = 'genre_tree_paths' AND c.relkind = 'm'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_attribute a 
                JOIN pg_class c ON a.attrelid = c.oid 
                WHERE c.relname = 'genre_tree_paths' AND a.attname = 'genre_name'
            ) THEN
                DROP MATERIALIZED VIEW genre_tree_paths CASCADE;
            END IF;
        END $$;

        DO $$ 
        BEGIN 
            CREATE MATERIALIZED VIEW IF NOT EXISTS genre_tree_paths AS
            WITH RECURSIVE genre_tree AS (
                -- Base cases: top-level genres (genres that have no parents)
                -- In the MBDB link data, entity0 is the broader genre and entity1 is the specific subgenre
                SELECT 
                    g.id AS genre_id, 
                    g.name::TEXT AS genre_name,
                    g.name::TEXT AS path,
                    1 AS level,
                    ARRAY[g.id] AS visited
                FROM genre g
                WHERE EXISTS (SELECT 1 FROM l_genre_genre lgg WHERE lgg.link = 944810 AND lgg.entity0 = g.id)
                AND NOT EXISTS (SELECT 1 FROM l_genre_genre lgg WHERE lgg.link = 944810 AND lgg.entity1 = g.id)
                
                UNION ALL
                
                -- Recursive step: traverse entity0 (broad) → entity1 (specific)
                SELECT 
                    child.entity1, -- The specific subgenre
                    g.name::TEXT AS genre_name,
                    (parent.path || '.' || g.name)::TEXT,
                    parent.level + 1,
                    parent.visited || child.entity1
                FROM l_genre_genre child
                JOIN genre_tree parent ON child.entity0 = parent.genre_id
                JOIN genre g ON child.entity1 = g.id
                WHERE child.link = 944810
                AND child.entity1 != ALL(parent.visited)  -- cycle protection
                AND parent.level < 20                     -- max depth guard
            )
            SELECT genre_id, genre_name, path, level FROM genre_tree;
        EXCEPTION 
            WHEN OTHERS THEN 
                RAISE NOTICE 'Materialized view creation failed (tables might be empty): %', SQLERRM;
        END $$;

        -- Enhance lookups on the materialized view
        CREATE INDEX IF NOT EXISTS genre_tree_paths_name_idx ON genre_tree_paths (LOWER(genre_name));
        CREATE INDEX IF NOT EXISTS genre_tree_paths_name_trgm_idx ON genre_tree_paths USING gin (LOWER(genre_name) gin_trgm_ops);
        DO $$ 
        BEGIN 
            CREATE UNIQUE INDEX IF NOT EXISTS genre_tree_paths_genre_path_idx ON genre_tree_paths (genre_id, path);
        EXCEPTION WHEN OTHERS THEN null; 
        END $$;

        -- Entity tables for UUID-based navigation
        CREATE EXTENSION IF NOT EXISTS "pgcrypto";

        CREATE TABLE IF NOT EXISTS artists (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS albums (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          artist_name TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(title, artist_name)
        );

        CREATE TABLE IF NOT EXISTS genres (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
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

        -- External metadata cache columns
        DO $$
        BEGIN
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS image_url TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS bio TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS mbid TEXT;
          ALTER TABLE artists ADD COLUMN IF NOT EXISTS last_updated BIGINT DEFAULT 0;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS image_url TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS mbid TEXT;
          ALTER TABLE albums ADD COLUMN IF NOT EXISTS last_updated BIGINT DEFAULT 0;
          ALTER TABLE genres ADD COLUMN IF NOT EXISTS image_url TEXT;
          ALTER TABLE genres ADD COLUMN IF NOT EXISTS description TEXT;
          ALTER TABLE genres ADD COLUMN IF NOT EXISTS last_updated BIGINT DEFAULT 0;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;

        -- ==========================================
        -- MULTI-USER TABLES
        -- ==========================================

        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS invites (
          token TEXT PRIMARY KEY DEFAULT encode(gen_random_bytes(32), 'hex'),
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
          max_uses INTEGER DEFAULT 1,
          uses INTEGER DEFAULT 0,
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS user_playback_stats (
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
          play_count INTEGER NOT NULL DEFAULT 0,
          rating INTEGER NOT NULL DEFAULT 0,
          last_played_at TIMESTAMPTZ,
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

        -- Add pinned column to playlists
        DO $$
        BEGIN
          ALTER TABLE playlists ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
        EXCEPTION WHEN OTHERS THEN null;
        END $$;
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

export async function closeDB() {
  if (pool) {
    await pool.end();
    pool = null;
    initPromise = null;
  }
}

export async function getPoolStats() {
  if (!pool) return null;
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
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
    albumArtist: row.album_artist,
    trackNumber: row.track_number,
    releaseType: row.release_type,
    isCompilation: !!row.is_compilation,
    playCount: row.play_count,
    lastPlayedAt: row.last_played_at ? new Date(row.last_played_at).getTime() : 0,
    bitrate: row.bitrate,
    format: row.format,
    artistId: row.artist_id,
    albumId: row.album_id,
    genreId: row.genre_id,
    genres: row.genres ? JSON.parse(row.genres) : []
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

// Returns a Buffer array of decoded UTF-8 paths matching a specific directory prefix
export async function getPathsForDirectory(dirPath: string): Promise<Buffer[]> {
  const db = await initDB();
  const res = await db.query('SELECT path FROM tracks');
  const dirBuf = Buffer.from(dirPath, 'utf8');
  const fileBufs: Buffer[] = [];
  
  for (const row of res.rows) {
    if (!row.path) continue;
    const fileBuf = Buffer.from(row.path, 'base64');
    const prefixMatches = fileBuf.length >= dirBuf.length && fileBuf.slice(0, dirBuf.length).equals(dirBuf);
    const atBoundary = fileBuf.length === dirBuf.length || fileBuf[dirBuf.length] === 0x2F;
    if (prefixMatches && atBoundary) {
      fileBufs.push(fileBuf);
    }
  }
  return fileBufs;
}

export async function addTrack(track: any) {
  const db = await initDB();
  const id = Buffer.from(track.path).toString('base64');
  
  // Sanitize strings to remove null bytes which crash Postgres
  const sanitizeArray = (arr: any) => Array.isArray(arr) ? arr.map(sanitizeString) : arr;

  await db.query(`
    INSERT INTO tracks (id, title, artist, album_artist, artists, album, genre, duration, track_number, year, release_type, is_compilation, path, bitrate, format, artist_id, album_id, genre_id, genres, isrc, mb_recording_id, mb_track_id, mb_album_id, mb_artist_id, mb_album_artist_id, mb_release_group_id, mb_work_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      artist = EXCLUDED.artist,
      album_artist = EXCLUDED.album_artist,
      artists = EXCLUDED.artists,
      album = EXCLUDED.album,
      genre = EXCLUDED.genre,
      duration = EXCLUDED.duration,
      track_number = EXCLUDED.track_number,
      year = EXCLUDED.year,
      release_type = EXCLUDED.release_type,
      is_compilation = EXCLUDED.is_compilation,
      path = EXCLUDED.path,
      bitrate = EXCLUDED.bitrate,
      format = EXCLUDED.format,
      artist_id = EXCLUDED.artist_id,
      album_id = EXCLUDED.album_id,
      genre_id = EXCLUDED.genre_id,
      genres = EXCLUDED.genres,
      isrc = EXCLUDED.isrc,
      mb_recording_id = EXCLUDED.mb_recording_id,
      mb_track_id = EXCLUDED.mb_track_id,
      mb_album_id = EXCLUDED.mb_album_id,
      mb_artist_id = EXCLUDED.mb_artist_id,
      mb_album_artist_id = EXCLUDED.mb_album_artist_id,
      mb_release_group_id = EXCLUDED.mb_release_group_id,
      mb_work_id = EXCLUDED.mb_work_id
    WHERE 
      tracks.title IS DISTINCT FROM EXCLUDED.title OR
      tracks.artist IS DISTINCT FROM EXCLUDED.artist OR
      tracks.album_artist IS DISTINCT FROM EXCLUDED.album_artist OR
      tracks.artists IS DISTINCT FROM EXCLUDED.artists OR
      tracks.album IS DISTINCT FROM EXCLUDED.album OR
      tracks.genre IS DISTINCT FROM EXCLUDED.genre OR
      tracks.duration IS DISTINCT FROM EXCLUDED.duration OR
      tracks.track_number IS DISTINCT FROM EXCLUDED.track_number OR
      tracks.year IS DISTINCT FROM EXCLUDED.year OR
      tracks.release_type IS DISTINCT FROM EXCLUDED.release_type OR
      tracks.is_compilation IS DISTINCT FROM EXCLUDED.is_compilation OR
      tracks.path IS DISTINCT FROM EXCLUDED.path OR
      tracks.bitrate IS DISTINCT FROM EXCLUDED.bitrate OR
      tracks.format IS DISTINCT FROM EXCLUDED.format OR
      tracks.artist_id IS DISTINCT FROM EXCLUDED.artist_id OR
      tracks.album_id IS DISTINCT FROM EXCLUDED.album_id OR
      tracks.genre_id IS DISTINCT FROM EXCLUDED.genre_id OR
      tracks.genres IS DISTINCT FROM EXCLUDED.genres OR
      tracks.isrc IS DISTINCT FROM EXCLUDED.isrc OR
      tracks.mb_recording_id IS DISTINCT FROM EXCLUDED.mb_recording_id OR
      tracks.mb_track_id IS DISTINCT FROM EXCLUDED.mb_track_id OR
      tracks.mb_album_id IS DISTINCT FROM EXCLUDED.mb_album_id OR
      tracks.mb_artist_id IS DISTINCT FROM EXCLUDED.mb_artist_id OR
      tracks.mb_album_artist_id IS DISTINCT FROM EXCLUDED.mb_album_artist_id OR
      tracks.mb_release_group_id IS DISTINCT FROM EXCLUDED.mb_release_group_id OR
      tracks.mb_work_id IS DISTINCT FROM EXCLUDED.mb_work_id
  `, [
    id,
    sanitizeString(track.title) || path.basename(track.path),
    sanitizeString(track.artist) || null,
    sanitizeString(track.albumArtist) || null,
    track.artists ? JSON.stringify(sanitizeArray(track.artists)) : null,
    sanitizeString(track.album) || null,
    sanitizeString(track.genre) || null,
    track.duration || 0,
    track.trackNumber || null,
    track.year || null,
    track.releaseType || null,
    !!track.isCompilation,
    track.path,
    track.bitrate || null,
    track.format || null,
    track.artistId || null,
    track.albumId || null,
    track.genreId || null,
    track.genres ? JSON.stringify(sanitizeArray(track.genres)) : null,
    track.isrc || null,
    track.mbRecordingId || null,
    track.mbTrackId || null,
    track.mbAlbumId || null,
    track.mbArtistId || null,
    track.mbAlbumArtistId || null,
    track.mbReleaseGroupId || null,
    track.mbWorkId || null
  ]);

  if (track.audioFeatures) {
    const vector7dStr = `[${track.audioFeatures.acoustic_vector.slice(0, 7).join(',')}]`;
    const vector8dStr = `[${track.audioFeatures.acoustic_vector.join(',')}]`;
    await db.query(`
      INSERT INTO track_features (track_id, bpm, acoustic_vector, acoustic_vector_8d)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (track_id) DO UPDATE SET
        bpm = EXCLUDED.bpm,
        acoustic_vector = EXCLUDED.acoustic_vector,
        acoustic_vector_8d = EXCLUDED.acoustic_vector_8d
      WHERE track_features.bpm IS DISTINCT FROM EXCLUDED.bpm OR track_features.acoustic_vector IS DISTINCT FROM EXCLUDED.acoustic_vector
    `, [id, track.audioFeatures.bpm, vector7dStr, vector8dStr]);
  }
}

export async function clearTracks() {
  const db = await initDB();
  await db.query('DELETE FROM tracks');
}

export async function addTrackFeatures(trackId: string, audioFeatures: { bpm: number; acoustic_vector: number[]; embedding_vector?: number[]; mfcc_vector?: number[]; is_simulated?: boolean }) {
  const db = await initDB();
  // Legacy column expects 7D, old column expects 8D, new column expects 8-10D
  const vector7dStr = `[${audioFeatures.acoustic_vector.slice(0, 7).join(',')}]`;
  const vector8dStr = `[${audioFeatures.acoustic_vector.slice(0, 8).join(',')}]`;
  const vectorStr = `[${audioFeatures.acoustic_vector.join(',')}]`;
  const simulated = audioFeatures.is_simulated ?? false;
  const embStr = audioFeatures.embedding_vector && audioFeatures.embedding_vector.length > 0
    ? `[${audioFeatures.embedding_vector.join(',')}]`
    : null;
  // mfcc_vector is fully deprecated in favour of 1280D EffNet embeddings
  const mfccStr = null;

  await db.query(`
    INSERT INTO track_features (track_id, bpm, acoustic_vector, acoustic_vector_8d, mfcc_vector, embedding_vector, is_simulated)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (track_id) DO UPDATE SET
      bpm = EXCLUDED.bpm,
      acoustic_vector = EXCLUDED.acoustic_vector,
      acoustic_vector_8d = EXCLUDED.acoustic_vector_8d,
      mfcc_vector = EXCLUDED.mfcc_vector,
      embedding_vector = EXCLUDED.embedding_vector,
      is_simulated = EXCLUDED.is_simulated
  `, [trackId, audioFeatures.bpm, vector7dStr, vector8dStr, mfccStr, embStr, simulated]);
}

export async function getTracksWithoutFeatures(): Promise<{ id: string; filePath: Buffer; title: string; artist: string | null }[]> {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.id, t.path, t.title, t.artist
    FROM tracks t
    LEFT JOIN track_features tf ON t.id = tf.track_id
    WHERE tf.track_id IS NULL
    ORDER BY t.title
  `);
  return res.rows.map((r: any) => ({
    id: r.id,
    filePath: Buffer.from(r.path, 'base64'),
    title: r.title,
    artist: r.artist || null,
  }));
}

// Tracks that have acoustic_vector but are missing mfcc_vector (for background MFCC migration)
export async function getTracksWithoutMfcc(): Promise<{ id: string; filePath: Buffer; title: string; artist: string | null }[]> {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.id, t.path, t.title, t.artist
    FROM tracks t
    JOIN track_features tf ON t.id = tf.track_id
    WHERE tf.acoustic_vector IS NOT NULL
      AND tf.mfcc_vector IS NULL
    ORDER BY t.title
  `);
  return res.rows.map((r: any) => ({
    id: r.id,
    filePath: Buffer.from(r.path, 'base64'),
    title: r.title,
    artist: r.artist || null,
  }));
}

export async function getTrackCountWithFeatures(): Promise<{ withFeatures: number; total: number }> {
  const db = await initDB();
  const res = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(tf.track_id) as with_features
    FROM tracks t
    LEFT JOIN track_features tf ON t.id = tf.track_id
  `);
  const row = res.rows[0];
  return { withFeatures: parseInt(row.with_features), total: parseInt(row.total) };
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
  const id = Buffer.from(dirPath, 'utf8').toString('base64');  // Fixed: explicit 'utf8' encoding
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
    const prefixMatches = fileBuf.length >= dirBuf.length && fileBuf.slice(0, dirBuf.length).equals(dirBuf);
    const atBoundary = fileBuf.length === dirBuf.length || fileBuf[dirBuf.length] === 0x2F; // '/'
    if (prefixMatches && atBoundary) {
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

// Delete a specific set of tracks by their IDs (used by the sync-walk diff).
// IDs are base64-encoded file paths, same as the primary key.
export async function deleteTracksByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await initDB();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
    await db.query(`DELETE FROM tracks WHERE id IN (${placeholders})`, chunk);
  }
}

/**
 * Safety-net: removes tracks whose decoded file path no longer belongs to any
 * registered directory in the directories table.
 *
 * This catches the edge case where removeTracksByDirectory() found 0 matches
 * due to a subtle path encoding mismatch, leaving stale tracks in the DB even
 * after a directory was correctly de-registered.
 */
export async function purgeOrphanedTracks(): Promise<number> {
  const db = await initDB();

  const [tracksRes, dirsRes] = await Promise.all([
    db.query('SELECT id, path FROM tracks'),
    db.query('SELECT path FROM directories'),
  ]);

  const dirs: Buffer[] = dirsRes.rows.map((r: any) => Buffer.from(r.path as string, 'utf8'));

  const staleIds: string[] = [];
  for (const row of tracksRes.rows) {
    const fileBuf = Buffer.from(row.path as string, 'base64');
    const belongs = dirs.some(dirBuf => {
      const prefixMatches =
        fileBuf.length >= dirBuf.length &&
        fileBuf.slice(0, dirBuf.length).equals(dirBuf);
      const atBoundary =
        fileBuf.length === dirBuf.length ||
        fileBuf[dirBuf.length] === 0x2f; // '/'
      return prefixMatches && atBoundary;
    });
    if (!belongs) staleIds.push(row.id as string);
  }

  if (staleIds.length > 0) {
    console.log(`[DB] purgeOrphanedTracks: removing ${staleIds.length} tracks with no registered directory`);
    for (let i = 0; i < staleIds.length; i += 100) {
      const chunk = staleIds.slice(i, i + 100);
      const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
      await db.query(`DELETE FROM tracks WHERE id IN (${placeholders})`, chunk);
    }
  }

  return staleIds.length;
}

/**
 * Remove albums, artists, and genres that have zero tracks still referencing them.
 * Call this after any bulk track deletion (folder removal, sync-walk pruning) to prevent
 * ghost entries appearing in the library UI.
 */
export async function purgeOrphanedEntities(): Promise<{ albums: number; artists: number; genres: number }> {
  const db = await initDB();

  const [albumRes, artistRes, genreRes] = await Promise.all([
    db.query(`
      DELETE FROM albums
      WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)
      RETURNING id
    `),
    db.query(`
      DELETE FROM artists
      WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)
      RETURNING id
    `),
    db.query(`
      DELETE FROM genres
      WHERE id NOT IN (SELECT DISTINCT genre_id FROM tracks WHERE genre_id IS NOT NULL)
      RETURNING id
    `),
  ]);

  // Clear in-memory caches so subsequent getOrCreate* calls re-fetch from DB
  clearEntityCaches();

  return {
    albums: albumRes.rowCount ?? 0,
    artists: artistRes.rowCount ?? 0,
    genres: genreRes.rowCount ?? 0,
  };
}

export async function recordPlayback(trackId: string) {
  const db = await initDB();
  // Increment playCount, update lastPlayedAt, and passively give a small rating bump
  await db.query(`
    UPDATE tracks 
    SET play_count = play_count + 1,
        last_played_at = NOW(),
        rating = LEAST(rating + 1, 5)
    WHERE id = $1
  `, [trackId]);
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

// Constants for missing metadata
const UNKNOWN_ARTIST = 'Unknown Artist';
const UNKNOWN_ALBUM = 'Unknown Album';
const UNKNOWN_GENRE = 'Unknown Genre';

// Utility for splitting multiple artists (e.g., "A feat. B", "A & B")
export function splitArtistNames(artistStr: string | null | undefined): string[] {
  if (!artistStr) return [];
  const parts = artistStr.split(/\s+(?:feat\.?|ft\.?|featuring|&)\s+(?!$)/i).map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [];
}

// Utility for splitting multiple genres (e.g., "Folk, Country, Rock")
export function splitGenreNames(genreStr: string | null | undefined): string[] {
  if (!genreStr) return [];
  // Only split on comma or semicolon. Do NOT split on slash or ampersand
  // as this breaks genres like 'Pop/Rock', 'Dance/Electronic', and 'R&B'.
  const parts = genreStr.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [];
}

// In-memory caches to reduce DB round-trips during scanning
const artistCache = new Map<string, string>();   // name -> UUID
const albumCache = new Map<string, string>();     // "title::::artist" -> UUID
const genreCache = new Map<string, string>();     // name -> UUID

function clearEntityCaches() {
  artistCache.clear();
  albumCache.clear();
  genreCache.clear();
}

// Sanitize strings to remove null bytes which crash Postgres
const sanitizeString = (str: any) => typeof str === 'string' ? str.replace(/\x00/g, '') : str;

export async function getOrCreateArtist(name?: string | null): Promise<string> {
  const safeName = sanitizeString(name)?.trim() || UNKNOWN_ARTIST;
  const lowerName = safeName.toLowerCase();
  
  const cached = artistCache.get(lowerName);
  if (cached) return cached;

  const db = await initDB();
  
  const existing = await db.query('SELECT id FROM artists WHERE LOWER(name) = $1', [lowerName]);
  if (existing.rows.length > 0) {
    artistCache.set(lowerName, existing.rows[0].id);
    return existing.rows[0].id;
  }

  const res = await db.query(
    `INSERT INTO artists (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [safeName]
  );
  const id = (res.rows[0] as any).id as string;
  artistCache.set(lowerName, id);
  return id;
}

export async function getOrCreateAlbum(title?: string | null, artistName?: string | null): Promise<string> {
  const safeTitle = sanitizeString(title)?.trim() || UNKNOWN_ALBUM;
  const safeArtist = sanitizeString(artistName)?.trim() || UNKNOWN_ARTIST;
  const lowerTitle = safeTitle.toLowerCase();
  const lowerArtist = safeArtist.toLowerCase();
  const key = `${lowerTitle}::::${lowerArtist}`;
  
  const cached = albumCache.get(key);
  if (cached) return cached;

  const db = await initDB();

  const existing = await db.query('SELECT id FROM albums WHERE LOWER(title) = $1 AND LOWER(artist_name) = $2', [lowerTitle, lowerArtist]);
  if (existing.rows.length > 0) {
    albumCache.set(key, existing.rows[0].id);
    return existing.rows[0].id;
  }

  const res = await db.query(
    `INSERT INTO albums (title, artist_name) VALUES ($1, $2) ON CONFLICT (title, artist_name) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
    [safeTitle, safeArtist]
  );
  const id = (res.rows[0] as any).id as string;
  albumCache.set(key, id);
  return id;
}

export async function getOrCreateGenre(name?: string | null): Promise<string> {
  const safeName = sanitizeString(name)?.trim() || UNKNOWN_GENRE;
  const lowerName = safeName.toLowerCase();

  const cached = genreCache.get(lowerName);
  if (cached) return cached;

  const db = await initDB();
  
  const existing = await db.query('SELECT id FROM genres WHERE LOWER(name) = $1', [lowerName]);
  if (existing.rows.length > 0) {
    genreCache.set(lowerName, existing.rows[0].id);
    return existing.rows[0].id;
  }

  const res = await db.query(
    `INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [safeName]
  );
  const id = (res.rows[0] as any).id as string;
  genreCache.set(lowerName, id);
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
  const res = await db.query('SELECT * FROM tracks WHERE album_id = $1 ORDER BY track_number ASC NULLS LAST', [albumId]);
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

  // 1. One-time deduplication to fix case-sensitive duplicates
  try {
    const artistsRes = await db.query('SELECT * FROM artists ORDER BY created_at ASC');
    const seenArtists = new Map<string, string>(); // lowerName -> canonicalId
    for (const row of artistsRes.rows) {
      const lowerName = row.name.toLowerCase();
      if (seenArtists.has(lowerName)) {
        const canonicalId = seenArtists.get(lowerName)!;
        await db.query('UPDATE tracks SET artist_id = $1 WHERE artist_id = $2', [canonicalId, row.id]);
        await db.query('DELETE FROM artists WHERE id = $1', [row.id]);
      } else {
        seenArtists.set(lowerName, row.id);
      }
    }

    const albumsRes = await db.query('SELECT * FROM albums ORDER BY created_at ASC');
    const seenAlbums = new Map<string, string>();
    for (const row of albumsRes.rows) {
      const lowerTitle = row.title.toLowerCase();
      const lowerArtist = (row.artist_name || UNKNOWN_ARTIST).toLowerCase();
      const key = `${lowerTitle}::::${lowerArtist}`;
      if (seenAlbums.has(key)) {
        const canonicalId = seenAlbums.get(key)!;
        await db.query('UPDATE tracks SET album_id = $1 WHERE album_id = $2', [canonicalId, row.id]);
        await db.query('DELETE FROM albums WHERE id = $1', [row.id]);
      } else {
        seenAlbums.set(key, row.id);
      }
    }

    const genresRes = await db.query('SELECT * FROM genres ORDER BY created_at ASC');
    const seenGenres = new Map<string, string>();
    for (const row of genresRes.rows) {
      const lowerName = row.name.toLowerCase();
      if (seenGenres.has(lowerName)) {
        const canonicalId = seenGenres.get(lowerName)!;
        await db.query('UPDATE tracks SET genre_id = $1 WHERE genre_id = $2', [canonicalId, row.id]);
        await db.query('DELETE FROM genres WHERE id = $1', [row.id]);
      } else {
        seenGenres.set(lowerName, row.id);
      }
    }
    
    // Clear caches after deduplication
    clearEntityCaches();
  } catch(e) {
    console.error('[DB Migration] Deduplication failed:', e);
  }

  const res = await db.query(
    'SELECT id, artist, album_artist, artists, album, genre, genres FROM tracks WHERE artist_id IS NULL OR album_id IS NULL OR genre_id IS NULL OR genres IS NULL'
  );

  if (res.rows.length === 0) return;

  console.log(`[DB Migration] Backfilling entity IDs for ${res.rows.length} tracks...`);
  let count = 0;

  for (const row of res.rows) {
    const trackId = (row as any).id;
    const rawArtist = (row as any).artist;
    const rawAlbumArtist = (row as any).album_artist;
    const albumArtistName = rawAlbumArtist || rawArtist;
    const albumTitle = (row as any).album;
    const rawGenre = (row as any).genre;
    
    const individualGenres = splitGenreNames(rawGenre);
    const primaryGenreName = individualGenres.length > 0 ? individualGenres[0] : null;
    
    let rawArtistsArray: string[] = [];
    const rawArtistsField = (row as any).artists;
    if (rawArtistsField) {
      if (typeof rawArtistsField === 'string') {
        try { rawArtistsArray = JSON.parse(rawArtistsField); } catch {}
      } else if (Array.isArray(rawArtistsField)) {
        rawArtistsArray = rawArtistsField;
      }
    } else if (rawArtist) {
      rawArtistsArray = splitArtistNames(rawArtist);
    }
    if (rawArtistsArray.length === 0 && rawArtist) {
      rawArtistsArray = [rawArtist];
    }
    
    // 2. Fetch or create canonical entities, ensuring valid strings
    const artistId = await getOrCreateArtist(albumArtistName);
    const albumId = await getOrCreateAlbum(albumTitle, albumArtistName);
    const genreId = await getOrCreateGenre(primaryGenreName);
    
    // Create/update entities for all individual artists to ensure they exist for 'Also appears on'
    for (const a of rawArtistsArray) {
      if (a && a.trim() !== '') {
         await getOrCreateArtist(a);
      }
    }

    // Prepare JSON arrays
    const tracksGenresJson = JSON.stringify(individualGenres);
    const tracksArtistsJson = JSON.stringify(rawArtistsArray);

    await db.query(
      'UPDATE tracks SET artist_id = $1, album_id = $2, genre_id = $3, genres = $4, artists = $5 WHERE id = $6',
      [artistId, albumId, genreId, tracksGenresJson, tracksArtistsJson, trackId]
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
    INSERT INTO playlists (id, title, description, created_at, is_llm_generated, user_id)
    VALUES ($1, $2, $3, NOW(), $4, $5)
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description
  `, [id, title, description, isLlmGenerated, userId]);
}

export async function addTracksToPlaylist(playlistId: string, trackIds: string[]) {
  const db = await initDB();
  // Clear existing tracks for a clean overwrite or handle deduplication depending on logic.
  // We'll wipe and re-insert for LLM generated ones, or append for user playlists.
  // For simplicity here, we clear and reinsert.
  await db.query(`DELETE FROM playlist_tracks WHERE playlist_id = $1`, [playlistId]);
  
  if (trackIds.length > 0) {
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramCount = 1;

    for (let i = 0; i < trackIds.length; i++) {
      placeholders.push(`($${paramCount++}, $${paramCount++}, $${paramCount++})`);
      values.push(playlistId, trackIds[i], i);
    }

    await db.query(`
      INSERT INTO playlist_tracks (playlist_id, track_id, sort_order)
      VALUES ${placeholders.join(', ')}
    `, values);
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
      WHERE playlist_id IN (SELECT id FROM playlists WHERE is_llm_generated = TRUE AND pinned = FALSE AND created_at < to_timestamp($1 / 1000.0) AND user_id = $2)
    `, [threshold, userId]);

    const res = await db.query(`
      DELETE FROM playlists
      WHERE is_llm_generated = TRUE AND pinned = FALSE AND created_at < to_timestamp($1 / 1000.0) AND user_id = $2
    `, [threshold, userId]);
    return res.rowCount;
  } else {
    // Global cleanup (backward compat)
    await db.query(`
      DELETE FROM playlist_tracks
      WHERE playlist_id IN (SELECT id FROM playlists WHERE is_llm_generated = TRUE AND pinned = FALSE AND created_at < to_timestamp($1 / 1000.0))
    `, [threshold]);

    const res = await db.query(`
      DELETE FROM playlists
      WHERE is_llm_generated = TRUE AND pinned = FALSE AND created_at < to_timestamp($1 / 1000.0)
    `, [threshold]);
    return res.rowCount;
  }
}

export async function getPlaylists(userId: string | null = null) {
  const db = await initDB();
  let res;
  if (userId) {
    res = await db.query('SELECT * FROM playlists WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  } else {
    res = await db.query('SELECT * FROM playlists ORDER BY created_at DESC');
  }
  return res.rows.map((row: any) => ({
    ...row,
    isLlmGenerated: row.is_llm_generated,
    pinned: row.pinned,
    createdAt: new Date(row.created_at).getTime(),
  }));
}

export async function getPlaylistTracks(playlistId: string) {
  const db = await initDB();
  const res = await db.query(`
    SELECT t.* FROM tracks t
    JOIN playlist_tracks pt ON t.id = pt.track_id
    WHERE pt.playlist_id = $1
    ORDER BY pt.sort_order ASC
  `, [playlistId]);
  return res.rows.map(mapTrackRow);
}

export async function deletePlaylist(playlistId: string, userId: string | null = null) {
  const db = await initDB();
  if (userId) {
    // Only delete if user owns the playlist
    await db.query('DELETE FROM playlist_tracks WHERE playlist_id = $1', [playlistId]);
    await db.query('DELETE FROM playlists WHERE id = $1 AND user_id = $2', [playlistId, userId]);
  } else {
    // Admin/global delete
    await db.query('DELETE FROM playlist_tracks WHERE playlist_id = $1', [playlistId]);
    await db.query('DELETE FROM playlists WHERE id = $1', [playlistId]);
  }
}

export async function getPlaylistOwner(playlistId: string): Promise<string | null> {
  const db = await initDB();
  const res = await db.query('SELECT user_id FROM playlists WHERE id = $1', [playlistId]);
  if (res.rows.length === 0) return null;
  return (res.rows[0] as any).user_id || null;
}

export async function cleanupOrphanedPlaylists() {
  const db = await initDB();
  const res = await db.query(`
    DELETE FROM playlists
    WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users)
  `);
  return res.rowCount || 0;
}

export async function togglePlaylistPin(playlistId: string, userId: string, pinned: boolean) {
  const db = await initDB();
  const res = await db.query(
    'UPDATE playlists SET pinned = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
    [!!pinned, playlistId, userId]
  );
  return res.rows.length > 0;
}

export async function getVectorStats() {
  const db = await initDB();
  
  // Compute means and stddevs in SQL by casting vector to float array.
  // This is significantly faster than fetching all rows and parsing in JS.
  const DIM = 8;
  const selectors = [];
  for (let i = 1; i <= DIM; i++) {
    selectors.push(`AVG((acoustic_vector_8d::text::float8[])[${i}]) as m${i}`);
    selectors.push(`STDDEV((acoustic_vector_8d::text::float8[])[${i}]) as s${i}`);
  }

  const res = await db.query(`
    SELECT ${selectors.join(', ')}
    FROM track_features 
    WHERE acoustic_vector_8d IS NOT NULL
  `);
  
  if (!res.rows[0] || res.rows[0].m1 === null) {
    return null;
  }

  const row = res.rows[0];
  const means = [];
  const stddevs = [];

  for (let i = 1; i <= DIM; i++) {
    means.push(Number(row[`m${i}`]) || 0);
    // Standard deviation can be null or 0; fallback to 1 to prevent division by zero in normalization
    stddevs.push(Number(row[`s${i}`]) || 1);
  }

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
export async function upsertSubGenreMapping(subGenre: string, path: string) {
  const db = await initDB();
  const sanitized = subGenre.toLowerCase().trim().replace(/[^\w\s-]/g, '');
  if (!sanitized) return;
  await db.query(`
    INSERT INTO subgenre_mappings (sub_genre, path)
    VALUES ($1, $2)
    ON CONFLICT (sub_genre) DO UPDATE SET path = EXCLUDED.path
  `, [sanitized, path]);
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
    mappings[row.sub_genre] = row.path;
  });
  return mappings;
}

export async function getGenrePathFromKNN(acoustic8D: number[], mfcc?: number[]): Promise<string | null> {
  if (acoustic8D.some(v => !isFinite(v))) return null;
  if (mfcc && mfcc.some(v => !isFinite(v))) mfcc = undefined;

  const db = await initDB();
  const acousticStr = `[${acoustic8D.join(',')}]`;
  const mfccStr = mfcc ? `[${mfcc.join(',')}]` : null;
  
  // Tier 3: KNN Timbre Fallback. 
  // Finds the most common hierarchical path among the 10 mathematically 
  // closest matches using 21D distance (Acoustic 8D + MFCC 13D) or 8D distance fallback.
  const query = mfccStr 
    ? `
    WITH neighbors AS (
      SELECT sm.path
      FROM tracks t
      JOIN track_features tf ON t.id = tf.track_id
      JOIN subgenre_mappings sm ON lower(trim(t.genre)) = sm.sub_genre
      WHERE tf.acoustic_vector_8d IS NOT NULL 
        AND tf.mfcc_vector IS NOT NULL
      ORDER BY (tf.acoustic_vector_8d <-> $1::vector) + (tf.mfcc_vector <-> $2::vector) ASC
      LIMIT 10
    )
    SELECT path, COUNT(*) as frequency
    FROM neighbors
    GROUP BY path
    ORDER BY frequency DESC
    LIMIT 1
  `
    : `
    WITH neighbors AS (
      SELECT sm.path
      FROM tracks t
      JOIN track_features tf ON t.id = tf.track_id
      JOIN subgenre_mappings sm ON lower(trim(t.genre)) = sm.sub_genre
      WHERE tf.acoustic_vector_8d IS NOT NULL 
      ORDER BY tf.acoustic_vector_8d <-> $1::vector ASC
      LIMIT 10
    )
    SELECT path, COUNT(*) as frequency
    FROM neighbors
    GROUP BY path
    ORDER BY frequency DESC
    LIMIT 1
  `;

  const params = mfccStr ? [acousticStr, mfccStr] : [acousticStr];
  const res = await db.query(query, params);

  if (res.rows.length > 0) {
    return (res.rows[0] as any).path;
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
  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id]);
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
    VALUES ($1, $2, 1, NOW(), LEAST(1, 5))
    ON CONFLICT (user_id, track_id) DO UPDATE SET
      play_count = user_playback_stats.play_count + 1,
      last_played_at = NOW(),
      rating = LEAST(user_playback_stats.rating + 1, 5)
  `, [userId, trackId]);

  // Removed legacy tracks table update to prevent write amplification bloat.
  // The frontend should rely on user_playback_stats for user-specific telemetry.
}

export async function recordSkipForUser(userId: string, trackId: string) {
  const db = await initDB();
  await db.query(`
    INSERT INTO user_playback_stats (user_id, track_id, play_count, last_played_at, rating)
    VALUES ($1, $2, 0, NULL, GREATEST(-1, 0))
    ON CONFLICT (user_id, track_id) DO UPDATE SET
      rating = GREATEST(user_playback_stats.rating - 1, 0)
  `, [userId, trackId]);

  // Removed legacy tracks table update to prevent write amplification bloat.
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
    WHERE ups.user_id = $1 AND ups.last_played_at IS NOT NULL
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
