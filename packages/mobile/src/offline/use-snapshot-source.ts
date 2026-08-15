import type { SnapshotSource } from '@boardsesh/offline-sync';
import { isSnapshotBaseUrlConfigured } from '../lib/env';
import { mobileSnapshotSource } from './snapshot-source';

/**
 * The single source handed to every native sync entry point. Snapshot bootstrap
 * and byte progress are permanently enabled; only a missing build-time manifest
 * URL can make this unavailable. Production mobile workflows always provide the
 * URL, while builds without it safely retain the paged fallback.
 */
export function useSnapshotSource(): SnapshotSource | undefined {
  return isSnapshotBaseUrlConfigured() ? mobileSnapshotSource : undefined;
}
