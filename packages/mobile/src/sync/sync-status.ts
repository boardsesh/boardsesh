// Module-level sync-status store. The pull client reports progress through a
// plain `onProgress(SyncProgress)` callback (pull-client.ts) with no React
// dependency; this is the small bridge that lets the Settings screen render that
// progress live without threading a callback down through providers.
//
// OfflineSyncBridge feeds `setSyncProgress` into the scheduler's pullSync call;
// the Settings status row reads `useSyncStatus()`. Kept React-free except for the
// one hook, so non-React callers (the bridge) can publish without a render.

import { useSyncExternalStore } from 'react';
import type { SyncProgress } from './pull-client';

export type SyncStatus = {
  /** Latest progress frame, or null before the first sync of this session. */
  progress: SyncProgress | null;
  /** Whether a sync cycle is mid-flight (progress emitted, not yet idle). */
  isSyncing: boolean;
  /** Epoch ms of the last cycle that reached the idle phase, or null. */
  lastSyncedAt: number | null;
};

const IDLE_STATUS: SyncStatus = {
  progress: null,
  isSyncing: false,
  lastSyncedAt: null,
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
 * `onProgress`. The terminal `phase: 'idle'` frame flips `isSyncing` off and
 * stamps `lastSyncedAt`; every other frame keeps `isSyncing` true.
 */
export function setSyncProgress(progress: SyncProgress): void {
  const reachedIdle = progress.phase === 'idle';
  currentStatus = {
    progress,
    isSyncing: !reachedIdle,
    lastSyncedAt: reachedIdle ? Date.now() : currentStatus.lastSyncedAt,
  };
  emit();
}

/** Test-only: drop back to the never-synced state between cases. */
export function __resetSyncStatusForTests(): void {
  currentStatus = IDLE_STATUS;
  emit();
}

/** Subscribe a React component to the live sync status. */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, getSyncStatusSnapshot, () => IDLE_STATUS);
}
