// On-device DDL + migrations live in @boardsesh/offline-sync (the client half of
// docs/sync-table-manifest.md); this barrel keeps the expo-sqlite lifecycle only.
export {
  DATABASE_NAME,
  initializeDatabase,
  setDatabaseHandle,
  getDatabaseHandle,
  clearLocalData,
  purgeLocalDataForSignOut,
} from './connection';
