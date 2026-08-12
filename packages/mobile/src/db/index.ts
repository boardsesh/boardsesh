// On-device DDL + migrations live in @boardsesh/offline-sync (the client half of
// docs/sync-table-manifest.md); this barrel keeps the expo-sqlite lifecycle only.
export { DATABASE_NAME, initializeDatabase, setDatabaseHandle, getDatabaseHandle, clearUserData } from './connection';
// Schema readiness for the consumers that take their db from `useSQLiteContext()`
// and so can't use the null-gated handle above — see ./schema-ready.
export { isSchemaReady, subscribeSchemaReady } from './schema-ready';
