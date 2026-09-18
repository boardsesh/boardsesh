type CacheEntry<Payload> = { payload: Payload; expiresAt: number; bytes: number };

/** Payload weights are serialized bytes, not a measurement of V8 heap size. */
export class BoundedTtlCache<Payload> {
  private readonly entries = new Map<string, CacheEntry<Payload>>();
  private bytes = 0;

  constructor(private readonly limits: { maxEntries: number; maxBytes: number }) {}

  get(key: string): Payload | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.payload;
  }

  set(key: string, payload: Payload, ttlMs: number): void {
    this.evictExpired();
    this.delete(key);
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      // A cache miss is preferable to failing the caller for an uncacheable value.
      return;
    }
    if (serialized === undefined) return;
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(serialized);
    if (bytes > this.limits.maxBytes || ttlMs <= 0) return;
    this.entries.set(key, { payload, bytes, expiresAt: Date.now() + ttlMs });
    this.bytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  getStats() {
    return { entries: this.entries.size, serializedBytes: this.bytes, ...this.limits };
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
