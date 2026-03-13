import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

// Initialize the database next to the server script
const dbPath = path.resolve(__dirname, 'library.db');
let dbInstance: Database | null = null;

export async function initDB() {
  if (dbInstance) return dbInstance;
  dbInstance = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      title TEXT,
      artist TEXT,
      album TEXT,
      genre TEXT,
      duration REAL,
      trackNumber INTEGER,
      year INTEGER,
      releaseType TEXT,
      isCompilation INTEGER,
      path TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS directories (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE
    );
  `);

  // Migrations for new columns
  try {
    const tableInfo = await dbInstance.all("PRAGMA table_info(tracks)");
    const hasAlbumArtist = tableInfo.some((col: any) => col.name === 'albumArtist');
    const hasArtists = tableInfo.some((col: any) => col.name === 'artists');

    if (!hasAlbumArtist) await dbInstance.exec('ALTER TABLE tracks ADD COLUMN albumArtist TEXT');
    if (!hasArtists) await dbInstance.exec('ALTER TABLE tracks ADD COLUMN artists TEXT');
  } catch (err) {
    console.warn("Migration error:", err);
  }

  return dbInstance;
}

export async function getAllTracks() {
  const db = await initDB();
  return await db.all('SELECT * FROM tracks');
}

// Returns all known track paths as a Set for O(1) existence checks during scanning.
export async function getExistingPaths(): Promise<Set<string>> {
  const db = await initDB();
  const rows = await db.all('SELECT path FROM tracks');
  return new Set(rows.map((r: any) => r.path));
}

export async function addTrack(track: any) {
  const db = await initDB();
  const id = Buffer.from(track.path).toString('base64');
  await db.run(`
    INSERT OR REPLACE INTO tracks (id, title, artist, albumArtist, artists, album, genre, duration, trackNumber, year, releaseType, isCompilation, path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    track.title || path.basename(track.path),
    track.artist || null,
    track.albumArtist || null,
    track.artists ? JSON.stringify(track.artists) : null,
    track.album || null,
    track.genre || null,
    track.duration || 0,
    track.trackNumber || null,
    track.year || null,
    track.releaseType || null,
    track.isCompilation ? 1 : 0,
    track.path
  ]);
}

export async function clearTracks() {
  const db = await initDB();
  await db.run('DELETE FROM tracks');
}

export async function addDirectory(dirPath: string) {
  const db = await initDB();
  const id = Buffer.from(dirPath).toString('base64');
  await db.run('INSERT OR IGNORE INTO directories (id, path) VALUES (?, ?)', [id, dirPath]);
  return { id, path: dirPath };
}

export async function getDirectories() {
  const db = await initDB();
  const dirs = await db.all('SELECT * FROM directories');
  return dirs.map(d => d.path);
}

export async function removeDirectory(dirPath: string) {
  const db = await initDB();
  const id = Buffer.from(dirPath).toString('base64');
  await db.run('DELETE FROM directories WHERE id = ?', [id]);
}

export async function removeTracksByDirectory(dirPath: string) {
  const db = await initDB();
  // Match any file path that starts with the directory path followed by a separator
  const prefix = dirPath.endsWith(path.sep) ? dirPath : dirPath + path.sep;
  await db.run('DELETE FROM tracks WHERE path LIKE ?', [`${prefix}%`]);
}
