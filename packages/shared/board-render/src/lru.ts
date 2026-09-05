// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

type LruEntry<V> = {
  value: V;
  bytes: number;
};

/**
 * A small bounded LRU keyed by string. Evicts least-recently-used entries when
 * either the entry count or the total byte budget is exceeded. `sizeOf` reports
 * each value's weight in bytes; pass a constant `() => 1` when only the entry
 * count matters. Insertion + read are O(1) amortised (Map preserves insertion
 * order; a get re-inserts to mark recency).
 */
export class BoundedLru<V> {
  private readonly store = new Map<string, LruEntry<V>>();
  private totalBytes = 0;

  constructor(
    private readonly options: {
      maxEntries: number;
      maxBytes: number;
      sizeOf: (value: V) => number;
    },
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    // Mark as most-recently-used by re-inserting at the tail.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  set(key: string, value: V): void {
    const bytes = this.options.sizeOf(value);
    const existing = this.store.get(key);
    if (existing !== undefined) {
      this.totalBytes -= existing.bytes;
      this.store.delete(key);
    }
    this.store.set(key, { value, bytes });
    this.totalBytes += bytes;
    this.evictIfNeeded();
  }

  /** Drop every entry. Used to isolate process-lifetime caches between tests. */
  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.store.size;
  }

  get byteSize(): number {
    return this.totalBytes;
  }

  private evictIfNeeded(): void {
    while (
      this.store.size > this.options.maxEntries ||
      (this.totalBytes > this.options.maxBytes && this.store.size > 0)
    ) {
      // Oldest entry is the first key in insertion order.
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.store.get(oldestKey);
      if (oldest !== undefined) this.totalBytes -= oldest.bytes;
      this.store.delete(oldestKey);
    }
  }
}
