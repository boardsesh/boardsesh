/**
 * An in-house, allowlisted, user-scoped persister for the React Query cache
 * (issue #4353, stage 2 of the `docs/offline-reads.md` decision).
 *
 * Six keys only — `['profile']`, `['myBoards', …]`, `['myGyms']`,
 * `['grades', board]`, `['angles', board, layout]`, `['publicProfile', selfId]` —
 * so a cold start with no signal already knows who you are and which walls are
 * yours, instead of rendering "Something went wrong" on My Boards.
 *
 * Shape of the thing:
 *  - the allowlist is a hard gate on the DEHYDRATE path and is re-applied on the
 *    restore path, so neither a new query key nor a tampered blob can widen it;
 *  - the envelope type has no `mutations` field, and `dehydrateAllowlisted`
 *    hard-codes `shouldDehydrateMutation: () => false` — SQLite's
 *    `pending_mutations` is the one outbox;
 *  - native restores SYNCHRONOUSLY from MMKV inside `QueryProvider`'s lazy
 *    initializer (no `isRestoring` frame); web restores asynchronously at the
 *    auth boundary, awaited before the loading gate releases;
 *  - the writer is armed purely by a runtime owner read at write-fire time, so
 *    sign-out is a pause (`suspendCacheWriter`) that any later sign-in re-arms.
 *
 * Deliberately in `packages/mobile` rather than `packages/shared`: web has its
 * own IndexedDB stack and its climbing surfaces are deprecated (#3122).
 * Promoting it later is a file move plus a `package.json`.
 */
export { PERSISTED_QUERY_RULES, matchPersistRule, type PersistRule } from './allowlist';
export {
  PERSISTED_CACHE_VERSION,
  parsePersistedCache,
  serializePersistedCache,
  utf8ByteLength,
  type ParsedCache,
  type PersistedCacheEnvelope,
  type PersistedQueryEntry,
} from './envelope';
export {
  PERSIST_MAX_BYTES,
  PERSIST_MAX_ENTRY_BYTES,
  PERSIST_TARGET_BYTES,
  applyBudget,
  envelopeBytes,
  type BudgetCandidate,
  type BudgetResult,
} from './budget';
export { dehydrateAllowlisted } from './dehydrate';
export { restorePersistedCache, type RestoreInput, type RestoreOutcome } from './restore';
export { createCacheWriter, type CacheWriter, type CacheWriterInput } from './writer';
export {
  getLastRestore,
  getLastWrittenQueries,
  getPersistOwner,
  markRestoreReported,
  resetQueryPersistRuntime,
  setCacheWriter,
  setLastRestore,
  setLastWrittenQueries,
  setPersistOwner,
  suspendCacheWriter,
} from './runtime';
export { adoptPersistedQueryCache, decideOwnerTransition, type OwnerTransition } from './auth-boundary';
export {
  REQUIRES_OWNER_HINT,
  SUPPORTS_SYNC_RESTORE,
  clearPersistedQueryCache,
  persistedQueryCacheExists,
  readCacheOwnerSync,
  readPersistedCacheAsync,
  readPersistedCacheSync,
  writeCacheOwner,
  writePersistedCache,
} from './storage';
