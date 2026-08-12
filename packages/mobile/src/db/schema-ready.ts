// Whether the offline SQLite schema is actually in place, as a module-level
// subscribable store. React-free on purpose (the hook lives in
// ./use-offline-schema-ready), mirroring src/sync/sync-status.ts.
//
// WHY THIS EXISTS
//
// `initializeDatabase` releases the launch gate after its FIRST attempt whatever
// that attempt did (connection.ts) — blocking would leave `SQLiteProvider`
// rendering nothing, i.e. a black screen, for the length of the retry chain. So on
// a contended launch the provider hands every child a `useSQLiteContext()` handle
// for a database whose migrations have not run: no `board_climb_grades`, no
// `characteristics` column.
//
// Consumers that go through `getDatabaseHandle()` are safe — it stays null until
// the schema is stamped, and they all null-check. Consumers that take the db from
// `useSQLiteContext()` bypass that gate entirely, and the two that WRITE
// (`OfflineSyncBridge`'s scheduler, `useBoardDownloads`' triggerSync) would start
// a sync and a snapshot import against a half-set-up file. This store is the
// signal they gate on.
//
// Readiness can arrive LATE (a retry wins seconds after launch) and can go back to
// false (sign-out clears the handle), so it is a live store rather than a one-shot
// flag.

let schemaReady = false;
const listeners = new Set<() => void>();

/**
 * Publish schema readiness. Only the database lifecycle may call this — it is
 * driven from `setDatabaseHandle`, so the store can never disagree with the handle
 * every non-React consumer already null-checks.
 */
export function setSchemaReady(ready: boolean): void {
  if (schemaReady === ready) return;
  schemaReady = ready;
  for (const listener of listeners) listener();
}

/** Current readiness without subscribing (tests, imperative callers). */
export function isSchemaReady(): boolean {
  return schemaReady;
}

/** Subscribe to readiness changes. Returns the unsubscribe function. */
export function subscribeSchemaReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop back to the not-ready state between cases. */
export function __resetSchemaReadyForTests(): void {
  setSchemaReady(false);
}
