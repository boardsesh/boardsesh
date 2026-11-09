import { BoundedLru } from '@boardsesh/board-render';

/**
 * A short memory for the expensive reads behind a card, plus coalescing of
 * identical reads in flight.
 *
 * Deliberately only ever reached AFTER a card's gate has passed: the gate runs on
 * every request and this never answers for it, so a card that goes private stops
 * at the gate on the very next fetch whatever is still held here.
 */
export class PostGateCache<T> {
  private readonly entries: BoundedLru<{ value: T; expiresAt: number }>;
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(private readonly options: { ttlMs: number; maxEntries: number }) {
    this.entries = new BoundedLru({ maxEntries: options.maxEntries, maxBytes: options.maxEntries, sizeOf: () => 1 });
  }

  /** The cached value, or the shared result of one `load`. A failed load is never kept. */
  read(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

    const running = this.inFlight.get(key);
    if (running) return running;

    const started = load()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: Date.now() + this.options.ttlMs });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, started);
    return started;
  }

  /** Drop one entry, so the next read loads it fresh. */
  forget(key: string): void {
    const held = this.entries.get(key);
    if (held) this.entries.set(key, { ...held, expiresAt: 0 });
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}
