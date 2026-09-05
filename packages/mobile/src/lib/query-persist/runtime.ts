import type { PersistedQueryEntry } from './envelope';
import type { RestoreOutcome } from './restore';
import type { CacheWriter } from './writer';

// The only mutable state in this module tree. Module singletons rather than
// React state on purpose: the writer subscribes to the query cache outside
// React, and the auth boundary is a callback deep inside AuthProvider that
// cannot reach a hook.

let persistOwner: string | null = null;
let lastRestore: RestoreOutcome | null = null;
let lastWrittenQueries: readonly PersistedQueryEntry[] = [];
let cacheWriter: CacheWriter | null = null;
let restoreReported = false;

/** Read at write-FIRE time (never at schedule time) — see `createCacheWriter`. */
export function getPersistOwner(): string | null {
  return persistOwner;
}

/**
 * Arm the writer for `userId`. There is no separate "start" call: setting an
 * owner is what makes writes happen, and clearing it is what stops them.
 */
export function setPersistOwner(userId: string): void {
  persistOwner = userId;
}

export function getLastRestore(): RestoreOutcome | null {
  return lastRestore;
}

export function setLastRestore(outcome: RestoreOutcome | null): void {
  lastRestore = outcome;
}

/** The previous write's entries, merged forward so gc cannot erode the blob. */
export function getLastWrittenQueries(): readonly PersistedQueryEntry[] {
  return lastWrittenQueries;
}

export function setLastWrittenQueries(entries: readonly PersistedQueryEntry[]): void {
  lastWrittenQueries = entries;
}

export function setCacheWriter(writer: CacheWriter | null): void {
  cacheWriter = writer;
}

/**
 * Sign-out / anonymous-transition entry point. SYNCHRONOUS and idempotent:
 * clears the owner (so any queued or future write is a no-op), cancels the
 * pending throttle, and clears the merge set + lastRestore so the next account
 * starts from nothing.
 *
 * Deliberately a PAUSE, not a permanent stop. `clearPersistedUserStores` runs on
 * the LIGHT signed-out path too, which fires on every logged-out cold start and
 * every anonymous foreground re-check — a latched stop would therefore be dead
 * from the first anonymous launch onward, and the first sign-in after it would
 * persist nothing. The writer stays subscribed for the app's lifetime and
 * `setPersistOwner` re-arms it.
 */
export function suspendCacheWriter(): void {
  persistOwner = null;
  lastRestore = null;
  lastWrittenQueries = [];
  cacheWriter?.suspend();
}

/** True the first time it is called in a launch; false forever after. */
export function markRestoreReported(): boolean {
  if (restoreReported) return false;
  restoreReported = true;
  return true;
}

/** Tests only. */
export function resetQueryPersistRuntime(): void {
  persistOwner = null;
  lastRestore = null;
  lastWrittenQueries = [];
  cacheWriter = null;
  restoreReported = false;
}
