import { getAlbumImage } from './metadata';

export interface ArtworkProviderContext {
  albumId?: string | null;
  album?: string | null;
  artist?: string | null;
  mbAlbumId?: string | null;
  cachedImageUrl?: string | null;
}

const LOOKUP_TTL_MS = 60 * 60 * 1000;
const MAX_LOOKUPS = 1000;
const lookups = new Map<string, { expiresAt: number; promise: Promise<string | undefined> }>();

function lookupKey(context: ArtworkProviderContext): string {
  return context.albumId || [context.artist || '', context.album || '', context.mbAlbumId || ''].join('\0');
}

function pruneLookups(now: number): void {
  for (const [key, entry] of lookups) {
    if (entry.expiresAt <= now) lookups.delete(key);
  }
  while (lookups.size >= MAX_LOOKUPS) {
    const oldest = lookups.keys().next().value as string | undefined;
    if (!oldest) break;
    lookups.delete(oldest);
  }
}

export async function resolveProviderArtworkUrl(context: ArtworkProviderContext): Promise<string | undefined> {
  if (context.cachedImageUrl) return context.cachedImageUrl;
  if (!context.album || !context.artist) return undefined;

  const now = Date.now();
  const key = lookupKey(context);
  const existing = lookups.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;

  pruneLookups(now);
  const promise = getAlbumImage(context.album, context.artist, context.mbAlbumId).catch((error) => {
    lookups.delete(key);
    throw error;
  });
  lookups.set(key, { expiresAt: now + LOOKUP_TTL_MS, promise });
  return promise;
}

export function providerArtworkProxyPath(externalUrl: string): string {
  return `/api/providers/external/proxy-image?url=${encodeURIComponent(externalUrl)}`;
}
