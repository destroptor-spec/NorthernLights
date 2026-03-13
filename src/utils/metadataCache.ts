import * as mm from "music-metadata";
import type { TrackInfo } from './fileSystem';

/**
 * Cache entry for metadata
 */
interface CachedMetadata {
  metadata: mm.IAudioMetadata;
  timestamp: number;
}

/**
 * In-memory cache for parsed metadata
 * Uses file name as key since fileHandle can't be serialized
 */
class MetadataCache {
  private cache: Map<string, CachedMetadata>;
  private maxSize: number;
  private maxAgeMs: number;

  constructor(maxSize: number = 100, maxAgeMs: number = 30 * 60 * 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs; // Default 30 minutes
  }

  /**
   * Get cached metadata for a file
   */
  get(fileHandleName: string): mm.IAudioMetadata | null {
    const entry = this.cache.get(fileHandleName);
    if (!entry) return null;

    // Check if cache entry is expired
    const age = Date.now() - entry.timestamp;
    if (age > this.maxAgeMs) {
      this.cache.delete(fileHandleName);
      return null;
    }

    return entry.metadata;
  }

  /**
   * Store metadata in cache
   */
  set(fileHandleName: string, metadata: mm.IAudioMetadata): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(fileHandleName, {
      metadata,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Remove specific entry from cache
   */
  delete(fileHandleName: string): boolean {
    return this.cache.delete(fileHandleName);
  }

  /**
   * Evict expired entries
   */
  evictExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.maxAgeMs) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Get current cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get stats for debugging
   */
  getStats() {
    const expired = this.evictExpired();
    return {
      total: this.cache.size,
      expired,
    };
  }
}

// Global cache instance
export const metadataCache = new MetadataCache(100, 30 * 60 * 1000);

/**
 * Memoize metadata extraction to avoid duplicate parsing
 */
export async function getCachedMetadata(
  fileHandleName: string,
  parseFn: () => Promise<mm.IAudioMetadata>
): Promise<mm.IAudioMetadata> {
  // Check cache first
  const cached = metadataCache.get(fileHandleName);
  if (cached) {
    return cached;
  }

  // Parse and cache
  const metadata = await parseFn();
  metadataCache.set(fileHandleName, metadata);

  return metadata;
}
