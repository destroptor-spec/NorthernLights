// Pictures for artists shown without one (initials, the Hub's artist icon).
// Every such card asks here; the names on screen go to the server together
// (POST /api/v1/artists/image-lookups), which looks them up in the background
// at the providers' slow pace, ahead of the rest of the library. While a card
// is still on screen it asks again every few seconds and shows the picture once
// one comes back. One request per batch, never one per card: per-card lookups
// once flooded the rate-limited providers and made the Artists grid janky.
import { useCallback, useSyncExternalStore } from 'react';
import { auroraApiRequest } from '../api/auroraApi';
import type { ArtistImageLookups, ArtistImageLookupStatus } from '../../shared/api/v1';

interface Entry {
  status: ArtistImageLookupStatus | 'pending';
  imageUrl: string | null;
  /** When the server first said "queued": the card stops asking after GIVE_UP_MS. */
  queuedSince?: number;
  /** Cards showing this artist right now. */
  watchers: number;
}

const BATCH_DELAY_MS = 250;
const POLL_MS = 5000;
const GIVE_UP_MS = 3 * 60 * 1000;
const MAX_NAMES_PER_REQUEST = 100;

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const toSend = new Set<string>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
// Set by main.tsx (the signed-in user's header). Not imported from the store:
// this module sits under small shared components, and the store pulls in the
// playback singletons. Unset (tests, signed out), nothing is asked.
let authHeader: (() => Record<string, string> | null) | null = null;

export function setArtistImageLookupAuth(getHeader: () => Record<string, string> | null): void {
  authHeader = getHeader;
}

function notify(name: string) {
  listeners.get(name)?.forEach((listener) => listener());
}

function scheduleBatch(delay = BATCH_DELAY_MS) {
  if (batchTimer) return;
  batchTimer = setTimeout(() => {
    batchTimer = null;
    void sendBatch();
  }, delay);
}

function schedulePoll() {
  if (pollTimer) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    const now = Date.now();
    for (const [name, entry] of entries) {
      if (entry.status !== 'queued' || entry.watchers === 0) continue;
      if (entry.queuedSince !== undefined && now - entry.queuedSince > GIVE_UP_MS) continue;
      toSend.add(name);
    }
    if (toSend.size > 0) scheduleBatch(0);
  }, POLL_MS);
}

async function sendBatch() {
  if (inFlight) {
    scheduleBatch();
    return;
  }
  // Only names some card still shows.
  const names = Array.from(toSend).filter((name) => (entries.get(name)?.watchers ?? 0) > 0).slice(0, MAX_NAMES_PER_REQUEST);
  for (const name of names) toSend.delete(name);
  for (const name of Array.from(toSend)) if ((entries.get(name)?.watchers ?? 0) === 0) toSend.delete(name);
  if (names.length === 0) return;
  const headers = authHeader?.();
  if (!headers || Object.keys(headers).length === 0) {
    for (const name of names) {
      const entry = entries.get(name);
      if (entry?.status === 'pending') entry.status = 'none';
    }
    return;
  }

  inFlight = true;
  try {
    const result = await auroraApiRequest<ArtistImageLookups>('/artists/image-lookups', headers, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
    const now = Date.now();
    for (const artist of result?.artists ?? []) {
      const entry = entries.get(artist.name);
      if (!entry) continue;
      entry.status = artist.status;
      entry.imageUrl = artist.imageUrl;
      if (artist.status === 'queued') entry.queuedSince ??= now;
      notify(artist.name);
    }
  } catch {
    // Signed out, offline, a server restart: these cards keep their initials.
    for (const name of names) {
      const entry = entries.get(name);
      if (entry && entry.status === 'pending') entry.status = 'none';
    }
  } finally {
    inFlight = false;
  }
  if (toSend.size > 0) scheduleBatch();
  if (Array.from(entries.values()).some((entry) => entry.status === 'queued' && entry.watchers > 0)) schedulePoll();
}

function watch(name: string): () => void {
  let entry = entries.get(name);
  if (!entry) {
    entry = { status: 'pending', imageUrl: null, watchers: 0 };
    entries.set(name, entry);
  }
  entry.watchers += 1;
  // New, or still waiting from an earlier showing (asked again: it moves to
  // the front of the server's queue).
  if (entry.status === 'pending' || entry.status === 'queued') {
    toSend.add(name);
    scheduleBatch();
  }
  return () => {
    entry!.watchers = Math.max(0, entry!.watchers - 1);
  };
}

function subscribe(name: string, listener: () => void): () => void {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(listener);
  const unwatch = watch(name);
  return () => {
    set!.delete(listener);
    unwatch();
  };
}

const noop = () => () => {};

/**
 * The picture for an artist shown without one, once the server has it; null
 * until then (and when no provider has one). Pass null to ask nothing (the
 * card has a picture, or its page looks the artist up itself).
 */
export function useArtistImageLookup(name: string | null | undefined): string | null {
  const key = name?.trim() || null;
  const subscribeToKey = useCallback(
    (listener: () => void) => (key ? subscribe(key, listener) : noop()),
    [key],
  );
  return useSyncExternalStore(
    subscribeToKey,
    () => (key ? entries.get(key)?.imageUrl ?? null : null),
    () => null,
  );
}

/** Test hook. */
export function resetArtistImageLookupsForTests(): void {
  entries.clear();
  listeners.clear();
  toSend.clear();
  if (batchTimer) clearTimeout(batchTimer);
  if (pollTimer) clearTimeout(pollTimer);
  batchTimer = null;
  pollTimer = null;
  inFlight = false;
  authHeader = null;
}
