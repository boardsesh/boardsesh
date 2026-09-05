import { hydrate, type QueryClient } from '@tanstack/react-query';
import { matchPersistRule } from './allowlist';
import { PERSIST_MAX_ENTRY_BYTES } from './budget';
import { parsePersistedCache, utf8ByteLength, type PersistedQueryEntry } from './envelope';
import { setLastWrittenQueries } from './runtime';

export type RestoreOutcome = {
  readonly outcome: 'hydrated' | 'absent' | 'unreadable' | 'owner_mismatch' | 'owner_missing' | 'empty';
  /** The blob's own stamped owner, when it parsed. */
  readonly userId?: string;
  /** Hashes actually put into the cache — what an evict has to remove again. */
  readonly hydratedHashes: readonly string[];
  readonly entryCount: number;
  readonly droppedCount: number;
  readonly bytes: number;
  readonly oldestEntryAgeHours?: number;
  readonly evicted?: true;
};

export type RestoreInput = {
  readonly raw: string | null;
  /** Who auth says this device belongs to; `null` means "we could not tell". */
  readonly ownerHint: string | null;
  /**
   * When true, a `null` ownerHint hydrates NOTHING. Native sets this: its
   * presence check (`persistedQueryCacheExists`) is defined as the short owner
   * sentinel existing, so a blob that could hydrate without one would be
   * invisible to the sign-out wipe.
   */
  readonly requireOwnerHint: boolean;
  readonly now: number;
};

const EMPTY_HASHES: readonly string[] = [];

function outcomeOnly(
  outcome: RestoreOutcome['outcome'],
  extra?: Partial<Omit<RestoreOutcome, 'outcome' | 'hydratedHashes'>>,
): RestoreOutcome {
  return { outcome, hydratedHashes: EMPTY_HASHES, entryCount: 0, droppedCount: 0, bytes: 0, ...extra };
}

/**
 * Parse a persisted blob and hydrate what still qualifies.
 *
 * The allowlist is re-applied HERE, not only on the dehydrate path: a blob
 * written by a future build (or tampered with on a rooted device) must not be
 * able to smuggle a non-allowlisted key — or another climber's `publicProfile` —
 * into memory. Ownership is checked before a single entry is inspected.
 */
export function restorePersistedCache(client: QueryClient, input: RestoreInput): RestoreOutcome {
  const parsed = parsePersistedCache(input.raw);
  if (parsed.status === 'absent') return outcomeOnly('absent');
  if (parsed.status === 'unreadable') return outcomeOnly('unreadable');

  const { envelope } = parsed;
  const blobBytes = utf8ByteLength(input.raw ?? '');

  if (input.requireOwnerHint && input.ownerHint === null) {
    // A torn write or an older build: the blob is there but the sentinel that
    // proves who it belongs to is not. Not a leak, so not a Sentry alarm — but
    // nothing hydrates and the caller deletes it.
    return outcomeOnly('owner_missing', { userId: envelope.userId, bytes: blobBytes });
  }
  if (input.ownerHint !== null && envelope.userId !== input.ownerHint) {
    return outcomeOnly('owner_mismatch', { userId: envelope.userId, bytes: blobBytes });
  }

  let droppedCount = 0;
  const kept: PersistedQueryEntry[] = [];
  for (const entry of envelope.queries) {
    const rule = Array.isArray(entry?.queryKey) ? matchPersistRule(entry.queryKey, envelope.userId) : undefined;
    if (!rule) {
      droppedCount += 1;
      continue;
    }
    const updatedAt = entry.state?.dataUpdatedAt ?? 0;
    if (input.now - updatedAt > rule.maxAgeMs) {
      droppedCount += 1;
      continue;
    }
    if (utf8ByteLength(JSON.stringify(entry)) > PERSIST_MAX_ENTRY_BYTES) {
      droppedCount += 1;
      continue;
    }
    kept.push(entry);
  }

  if (kept.length === 0) {
    return outcomeOnly('empty', { userId: envelope.userId, droppedCount, bytes: blobBytes });
  }

  // `mutations: []` is explicit rather than omitted so the shape of what we hand
  // React Query is impossible to misread at the call site.
  hydrate(client, { mutations: [], queries: kept });
  // Seed the merge set from what we just hydrated. Without this the writer's
  // previous-set is empty until its first write, so a gc `removed` event more
  // than 30 minutes into a launch would trigger a first write that drops every
  // mount-hydrated entry from disk — the exact erosion merge-on-write exists to
  // prevent.
  setLastWrittenQueries(kept);

  const oldestUpdatedAt = kept.reduce(
    (oldest, entry) => Math.min(oldest, entry.state?.dataUpdatedAt ?? input.now),
    input.now,
  );
  return {
    outcome: 'hydrated',
    userId: envelope.userId,
    hydratedHashes: kept.map((entry) => entry.queryHash),
    entryCount: kept.length,
    droppedCount,
    bytes: blobBytes,
    oldestEntryAgeHours: Math.max(0, Math.round((input.now - oldestUpdatedAt) / (60 * 60 * 1000))),
    ...(envelope.evicted === true ? { evicted: true as const } : {}),
  };
}
