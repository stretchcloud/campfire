/**
 * TTL-based in-memory cache for Linear API responses.
 * Deduplicates concurrent identical requests.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000; // 60 seconds

export class LinearCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private pending = new Map<string, Promise<unknown>>();

  /** Get a cached value, or undefined if expired/missing. */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  /** Store a value in the cache with optional TTL override. */
  set<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
    this.cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  /** Invalidate a specific key. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** Clear all cached data. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Deduplicate concurrent requests for the same key.
   * If a request for `key` is already in-flight, returns the same promise.
   * Otherwise, calls `fetcher()`, caches the result, and returns it.
   */
  async dedupe<T>(key: string, fetcher: () => Promise<T>, ttlMs: number = DEFAULT_TTL_MS): Promise<T> {
    // Check cache first
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    // Check if an identical request is already in-flight
    const inflight = this.pending.get(key);
    if (inflight) return inflight as Promise<T>;

    // Start the fetch
    const promise = fetcher().then((result) => {
      this.set(key, result, ttlMs);
      this.pending.delete(key);
      return result;
    }).catch((err) => {
      this.pending.delete(key);
      throw err;
    });

    this.pending.set(key, promise);
    return promise;
  }
}

/** Singleton instance for the Linear API cache. */
export const linearCache = new LinearCache();
