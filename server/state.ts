import { Response } from 'express';
import { migrateEntityIds } from './database';
import { genreMatrixService } from './services/genreMatrix.service';

import { EventEmitter } from 'events';

export const settingsEmitter = new EventEmitter();
export const dbEmitter = new EventEmitter();

// Global DB connectivity flag
export let dbConnected = false;

export function setDbConnected(val: boolean) {
  const changed = dbConnected !== val;
  dbConnected = val;
  if (changed) {
    dbEmitter.emit('connectionStatusChanged', val);
  }
}

let isInitializing = false;
export async function initDatabaseConnection(retries = 15, initialDelay = 1000) {
  if (isInitializing) return;
  isInitializing = true;

  for (let i = 0; i < retries; i++) {
    try {
      await genreMatrixService.init();
      setDbConnected(true);
      console.log('[DB] Connected and genre matrix initialized.');
      // Backfill entity IDs for existing tracks
      try {
        const { migrateEntityIds } = await import('./database');
        await migrateEntityIds();
      } catch (e: any) {
        console.error('[DB] Entity migration failed (non-fatal):', e.message || e);
      }
      isInitializing = false;
      return;
    } catch (e: any) {
      setDbConnected(false);
      const delay = initialDelay * Math.pow(2, i);
      console.error(`[DB] Connection attempt ${i + 1}/${retries} failed (retrying in ${delay}ms):`, e.message || e);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  isInitializing = false;
}

// Server-side session history for Infinity Mode (per-user, in-memory, rolling 50 tracks)
const userSessionHistory = new Map<string, string[]>();

export function addToSessionHistory(userId: string, trackId: string) {
  const history = userSessionHistory.get(userId) || [];
  history.push(trackId);
  if (history.length > 50) history.shift();
  userSessionHistory.set(userId, history);
}

export function getSessionHistory(userId: string): string[] {
  return userSessionHistory.get(userId) || [];
}

// Scan status state (shared between library routes)
export const scanStatus = {
  isScanning: false,
  phase: 'idle' as 'idle' | 'walk' | 'metadata' | 'analysis',
  scannedFiles: 0,
  totalFiles: 0,
  activeFiles: [] as string[],
  activeWorkers: 0,
  currentFile: '', // kept for backwards-compat
  libraryChanged: false, // true when a walk/scan actually added or removed tracks
};

export const scanClients = new Set<Response>();

let lastBroadcastTime = 0;
export function broadcastScanStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastBroadcastTime < 100) return;
  lastBroadcastTime = now;
  const msg = `data: ${JSON.stringify(scanStatus)}\n\n`;
  scanClients.forEach(c => c.write(msg));
}

// Utility: Convert a DB-stored Base64 path string back to the original raw byte Buffer.
export function pathToBuffer(p: string): Buffer {
  return Buffer.from(p, 'base64');
}

// Security: Check if a raw-byte path Buffer resides within an allowed directory.
import { getDirectories } from './database';
import path from 'path';

export async function isPathAllowed(requestedPathBuf: Buffer): Promise<boolean> {
  const allowedDirs = await getDirectories();
  for (const dir of allowedDirs) {
    const dirBuf = Buffer.from(path.resolve(dir), 'utf8');
    const sep = Buffer.from(path.sep);
    const dirWithSep = dirBuf[dirBuf.length - 1] === sep[0]
      ? dirBuf
      : Buffer.concat([dirBuf, sep]);
    if (
      requestedPathBuf.length >= dirWithSep.length &&
      requestedPathBuf.slice(0, dirWithSep.length).equals(dirWithSep)
    ) {
      return true;
    }
  }
  return false;
}

// ─── MBDB State ────────────────────────────────────────────────────────
export const mbdbStatus = {
  isImporting: false,
  phase: 'idle', // 'idle' | 'downloading' | 'inserting' | 'refreshing' | 'complete' | 'error'
  progress: 0,
  message: '',
  elapsedSeconds: 0,
  currentTable: '',
  counts: { genres: 0, aliases: 0, links: 0 },
  lastImport: null as { timestamp: number; duration: number; counts: { genres: number; aliases: number; links: number } } | null,
  completedPhases: [] as string[],
};

// Track long-running operations to suppress false-positive leak warnings
let longRunningOperationCount = 0;

export function startLongRunningOperation() {
  longRunningOperationCount++;
}

export function endLongRunningOperation() {
  longRunningOperationCount = Math.max(0, longRunningOperationCount - 1);
}

export function isLongRunningOperationActive(): boolean {
  return longRunningOperationCount > 0;
}

export const mbdbClients = new Set<Response>();
let mbdbCancelRequested = false;

export function setMbdbCancelRequested(val: boolean) {
  mbdbCancelRequested = val;
}

export function getMbdbCancelRequested() {
  return mbdbCancelRequested;
}

export function broadcastMbdbStatus() {
  const payload = `data: ${JSON.stringify(mbdbStatus)}\n\n`;
  for (const client of mbdbClients) {
    client.write(payload);
  }
}

