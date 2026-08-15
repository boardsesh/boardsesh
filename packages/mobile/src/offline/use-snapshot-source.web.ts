import type { SnapshotSource } from '@boardsesh/offline-sync';

/** Expo web has no native SQLite/filesystem snapshot pipeline. */
export function useSnapshotSource(): SnapshotSource | undefined {
  return undefined;
}
