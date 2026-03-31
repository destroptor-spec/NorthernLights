import { Response } from 'express';
import { migrateEntityIds } from './database';
import { genreMatrixService } from './services/genreMatrix.service';

import { EventEmitter } from 'events';

export const settingsEmitter = new EventEmitter();

// Global DB connectivity flag
export let dbConnected = false;

export function setDbConnected(val: boolean) {
  dbConnected = val;
}

let isInitializing = false;
export async function initDatabaseConnection(retries = 15, delay = 2000) {
  if (isInitializing) return;
  isInitializing = true;

  for (let i = 0; i < retries; i++) {
    try {
      await genreMatrixService.init();
      dbConnected = true;
      console.log('[DB] Connected and genre matrix initialized.');
      // Backfill entity IDs for existing tracks
      try {
        await migrateEntityIds();
      } catch (e: any) {
        console.error('[DB] Entity migration failed (non-fatal):', e.message || e);
      }
      isInitializing = false;
      return;
    } catch (e: any) {
      dbConnected = false;
      console.error(`[DB] Connection attempt ${i + 1}/${retries} failed:`, e.message || e);
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
  currentFile: '' // kept for backwards-compat
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

// Reverses the frontend's safeBtoa to recover the exact string sent by the client
export function safeAtob(b64: string): string {
  const uriStr = Buffer.from(b64, 'base64').toString('latin1');
  const bytes: number[] = [];
  for (let i = 0; i < uriStr.length; i++) {
    if (uriStr[i] === '%' && i + 2 < uriStr.length) {
      bytes.push(parseInt(uriStr.substring(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(uriStr.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
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
