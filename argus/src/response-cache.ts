// ============ TIER 3: Response Cache ============
// In-memory LRU cache for Tier 1 (LLM) results.
// On Tier 1 success → store result.
// On Tier 3 (total failure) → look up cache; if miss → return safe defaults.

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

// Module-level state (initialized with defaults, overridable via configureCache)
let maxSize = 500;
let ttlMs = 3600 * 1000; // 1 hour default

// Map preserves insertion order → oldest entries are first → O(1) LRU eviction
const cache = new Map<string, CacheEntry>();

export function configureCache(opts: { maxSize?: number; ttlSec?: number }): void {
  if (opts.maxSize !== undefined) maxSize = opts.maxSize;
  if (opts.ttlSec !== undefined) ttlMs = opts.ttlSec * 1000;
}

// Simple DJB2 hash for cache key generation
function simpleHash(str: string): string {
  let h = 5381;
  const limit = Math.min(str.length, 500);
  for (let i = 0; i < limit; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

export function cacheGet<T>(fnName: string, inputKey: string): T | undefined {
  const key = `${fnName}:${simpleHash(inputKey)}`;
  const entry = cache.get(key);

  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  // LRU: move to end (most recently used)
  cache.delete(key);
  cache.set(key, entry);
  return entry.value as T;
}

export function cacheSet(fnName: string, inputKey: string, value: unknown): void {
  const key = `${fnName}:${simpleHash(inputKey)}`;

  // Evict oldest entry if at capacity and key is new
  if (cache.size >= maxSize && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function getCacheStats(): { size: number; maxSize: number; ttlSec: number } {
  return { size: cache.size, maxSize, ttlSec: ttlMs / 1000 };
}

export function clearCache(): void {
  cache.clear();
}
