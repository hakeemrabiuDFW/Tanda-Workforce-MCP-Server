/**
 * Small LRU cache of GET responses keyed by token scope + path + params.
 * Entries carry the upstream ETag so requests can be revalidated with If-None-Match.
 */
export interface CacheEntry {
  etag?: string;
  data: unknown;
  storedAt: number;
}

export class ETagCache {
  private map = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries = 1000) {}

  static key(scope: string, path: string, params: Record<string, string>): string {
    const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    return `${scope}|${path}?${sorted}`;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (entry) {
      // refresh LRU position
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  touch(key: string): void {
    const entry = this.map.get(key);
    if (entry) this.set(key, { ...entry, storedAt: Date.now() });
  }

  clear(): void {
    this.map.clear();
  }
}
