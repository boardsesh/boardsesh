// Module-level sync-status store. The pull client reports progress through a
// plain `onProgress(SyncProgress)` callback (pull-client.ts) with no React
// dependency; this is the small bridge that lets the Settings screen render that
// progress live without threading a callback down through providers.
//
// OfflineSyncBridge feeds `setSyncProgress` into the scheduler's pullSync call;
// the Settings status row reads `useSyncStatus()`. Kept React-free except for the
// one hook, so non-React callers (the bridge) can publish without a render.

import { useSyncExternalStore } from 'react';
import type { BootstrapMetadataChangedInfo, ScopeDownloadCompleteInfo, SyncProgress } from '@boardsesh/offline-sync';

export type SyncStatus = {
  /** Latest progress frame, or null before the first sync of this session. */
  progress: SyncProgress | null;
  /** Whether a sync cycle is mid-flight (progress emitted, not yet idle). */
  isSyncing: boolean;
  /** Epoch ms of the last cycle that reached the idle phase, or null. */
  lastSyncedAt: number | null;
  /**
   * Advances after each bootstrap scope settles. Consumers that read bootstrap
   * markers from SQLite can refresh scope A while scope B is still downloading,
   * without re-querying on every progress frame.
   */
  bootstrapMetadataRevision: number;
  /** Advances immediately after one scope reaches its board-data tail. */
  scopeCompletionRevision: number;
};

const IDLE_STATUS: SyncStatus = {
  progress: null,
  isSyncing: false,
  lastSyncedAt: null,
  bootstrapMetadataRevision: 0,
  scopeCompletionRevision: 0,
};

let currentStatus: SyncStatus = IDLE_STATUS;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Current sync status without subscribing. Useful for one-shot reads (tests,
 * imperative callers); React components should use `useSyncStatus` instead.
 */
export function getSyncStatusSnapshot(): SyncStatus {
  return currentStatus;
}

/**
 * Publish a progress frame from a running pull. Wire this as pullSync's
 * `onProgress`. The terminal `phase: 'idle'` frame flips `isSyncing` off and —
 * unless it is the scheduler's `failed` frame after a thrown cycle — stamps
 * `lastSyncedAt`; every other frame keeps `isSyncing` true.
 */
export function setSyncProgress(progress: SyncProgress): void {
  const reachedIdle = progress.phase === 'idle';
  const completed = reachedIdle && !progress.failed;
  currentStatus = {
    progress,
    isSyncing: !reachedIdle,
    lastSyncedAt: completed ? Date.now() : currentStatus.lastSyncedAt,
    bootstrapMetadataRevision: currentStatus.bootstrapMetadataRevision,
    scopeCompletionRevision: currentStatus.scopeCompletionRevision,
  };
  emit();
}

/** Refresh persisted bootstrap facts after one scope reaches a coherent outcome. */
export function notifyBootstrapMetadataChanged(_info: BootstrapMetadataChangedInfo): void {
  currentStatus = {
    ...currentStatus,
    bootstrapMetadataRevision: currentStatus.bootstrapMetadataRevision + 1,
  };
  emit();
}

/**
 * Publish the engine's per-scope completion callback without disturbing live
 * progress for later scopes in the same cycle. SQLite markers are committed
 * before this fires, so revision-keyed queries can read the completed state now.
 */
export function notifyScopeDownloadComplete(_info: ScopeDownloadCompleteInfo): void {
  currentStatus = {
    ...currentStatus,
    scopeCompletionRevision: currentStatus.scopeCompletionRevision + 1,
  };
  emit();
}

/**
 * Drop back to the never-synced state. Sign-out calls this so the next account on
 * the device doesn't open Settings to "last synced 5 minutes ago" — a timestamp
 * describing somebody else's sync, over data that is gone.
 */
export function resetSyncStatus(): void {
  currentStatus = IDLE_STATUS;
  emit();
}

/** Test-only: drop back to the never-synced state between cases. */
export function __resetSyncStatusForTests(): void {
  resetSyncStatus();
}

/** Subscribe a React component to the live sync status. */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, getSyncStatusSnapshot, () => IDLE_STATUS);
}
