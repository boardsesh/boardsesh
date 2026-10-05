// Whether the offline database on this device was migrated by a NEWER bundle than
// the one running, as a module-level subscribable store. React-free and
// import-free on purpose, like ./schema-ready, so both `connection.ts` (loaded by
// node-env suites) and the React hooks can reach it.
//
// HOW A DEVICE GETS HERE. JS can go backwards: a canary OTA is reverted, or a
// climber leaves the early-updates track. The newer bundle already ran its
// migrations, so the older one finds a `schema_version` above its own
// LATEST_SCHEMA_VERSION. `initializeDatabase` then refuses the file — it never
// publishes a handle — and records the two versions here.
//
// WHAT READS IT.
// - `useOfflineDatabase()`, which hands out a connection that refuses every call
//   instead of the provider's live one (see ./refused-database).
// - `useOfflineSchemaDowngrade()`, for the one screen that says so out loud.
// - `app/_layout.tsx`, which asks the OTA server for a bundle new enough for the
//   file (lib/schema-downgrade-recovery).
//
// One-way for the process: a database cannot get older, so once set this only
// goes back to null in tests.

export type SchemaDowngrade = {
  /** The version stamped in the file. */
  storedVersion: number;
  /** The highest version this bundle knows how to read. */
  supportedVersion: number;
};

let schemaDowngrade: SchemaDowngrade | null = null;
const listeners = new Set<() => void>();

/** Record the downgrade. Only the database lifecycle (`connection.ts`) may call this. */
export function setSchemaDowngrade(downgrade: SchemaDowngrade): void {
  if (
    schemaDowngrade !== null &&
    schemaDowngrade.storedVersion === downgrade.storedVersion &&
    schemaDowngrade.supportedVersion === downgrade.supportedVersion
  ) {
    return;
  }
  schemaDowngrade = downgrade;
  for (const listener of listeners) listener();
}

/** The downgrade this launch found, or null when the database is one this bundle can open. */
export function getSchemaDowngrade(): SchemaDowngrade | null {
  return schemaDowngrade;
}

/** Subscribe to the downgrade being found. Returns the unsubscribe function. */
export function subscribeSchemaDowngrade(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget the downgrade between cases. */
export function resetSchemaDowngradeForTests(): void {
  if (schemaDowngrade === null) return;
  schemaDowngrade = null;
  for (const listener of listeners) listener();
}
