const MAX_PERSISTED_ENTRIES = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type GpuFailureRecord = {
  version: 1;
  binaryIdentity: string;
  configHashes: string[];
};

export type GpuFailureSnapshot = {
  readonly hydrated: boolean;
  readonly unavailable: boolean;
  readonly keys: ReadonlySet<string>;
};

type GpuFailureStoreOptions = {
  binaryIdentity: string;
  read: () => Promise<unknown>;
  write: (record: GpuFailureRecord) => Promise<void>;
  maxEntries?: number;
};

function isConfigHash(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.length === 64 && SHA256_PATTERN.test(candidate);
}

function persistedHashes(candidate: unknown, binaryIdentity: string): string[] {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return [];
  const record = candidate as Record<string, unknown>;
  if (record.version !== 1 || record.binaryIdentity !== binaryIdentity) return [];
  const hashes = record.configHashes;
  // Check the collection bound before reading any potentially corrupt entry.
  if (!Array.isArray(hashes) || hashes.length > MAX_PERSISTED_ENTRIES) return [];
  const checked: string[] = [];
  for (const hash of hashes) {
    if (!isConfigHash(hash)) return [];
    checked.push(hash);
  }
  return checked;
}

/** Binary-scoped GPU failures only; the caller owns hashing and platform I/O. */
export function createGpuFailureStore({
  binaryIdentity,
  read,
  write,
  maxEntries = MAX_PERSISTED_ENTRIES,
}: GpuFailureStoreOptions) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_PERSISTED_ENTRIES) {
    throw new RangeError('GPU failure storage requires 1 to 64 entries');
  }

  let keys = new Set<string>();
  let snapshot: GpuFailureSnapshot = { hydrated: false, unavailable: false, keys };
  let hydration: Promise<void> | null = null;
  let writer: Promise<void> | null = null;
  let dirty = false;
  const listeners = new Set<() => void>();

  const notify = (hydrated = snapshot.hydrated, unavailable = snapshot.unavailable) => {
    snapshot = { hydrated, unavailable, keys };
    for (const listener of listeners) listener();
  };

  const trim = (hashes: Set<string>) => {
    while (hashes.size > maxEntries) {
      const oldest = hashes.values().next().value;
      if (oldest !== undefined) hashes.delete(oldest);
    }
    return hashes;
  };

  const persist = () => {
    if (!snapshot.hydrated || snapshot.unavailable || !dirty || writer) return;
    // At most one active write and one dirty latest state: rapid failures do
    // not retain an unbounded queue of obsolete persistence snapshots.
    writer = Promise.resolve()
      .then(async () => {
        while (dirty) {
          dirty = false;
          const record: GpuFailureRecord = { version: 1, binaryIdentity, configHashes: [...keys] };
          try {
            await write(record);
          } catch {
            // The RAM latch remains authoritative for this JS lifetime. A
            // later failure can retry writing the complete current set.
          }
        }
      })
      .finally(() => {
        writer = null;
        if (dirty) persist();
      });
  };

  const hydrate = (): Promise<void> => {
    if (hydration) return hydration;
    // Defer read until hydration is assigned, including reentrant I/O adapters.
    hydration = Promise.resolve().then(async () => {
      let stored: string[];
      try {
        stored = persistedHashes(await read(), binaryIdentity);
      } catch {
        // Do not overwrite an unread record with a partial set. The runtime
        // keeps this session on PNG when storage ownership cannot be checked.
        notify(true, true);
        return;
      }
      const merged = new Set(stored);
      for (const hash of keys) {
        merged.delete(hash);
        merged.add(hash);
      }
      keys = trim(merged);
      notify(true, false);
      persist();
    });
    return hydration;
  };

  return {
    getSnapshot: (): GpuFailureSnapshot => snapshot,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate,
    record(configSha256: string): void {
      if (!isConfigHash(configSha256) || keys.has(configSha256)) return;
      keys = trim(new Set([...keys, configSha256]));
      dirty = true;
      notify();
      if (snapshot.hydrated) persist();
      else void hydrate();
    },
    async flush(): Promise<void> {
      await hydrate();
      persist();
      while (writer) await writer;
    },
  };
}
