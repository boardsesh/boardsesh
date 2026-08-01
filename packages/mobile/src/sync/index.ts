// The sync ENGINE (pull client, scheduler, checkpoints, table config) lives in
// @boardsesh/offline-sync; its platform bindings live in
// src/offline/offline-sync-adapter.ts. What remains here is the React-facing
// sync-status store the Settings UI reads.
export {
  useSyncStatus,
  setSyncProgress,
  notifyBootstrapMetadataChanged,
  notifyScopeDownloadComplete,
  getSyncStatusSnapshot,
  __resetSyncStatusForTests,
  type SyncStatus,
} from './sync-status';
