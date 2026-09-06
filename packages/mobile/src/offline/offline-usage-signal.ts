import {
  createOfflineUsageSignal,
  type OfflineConnectivityReason,
  type OfflineReadLane,
  type OfflineReadSurface,
  type OfflineUnavailableReason,
  type OfflineUsageEmission,
} from '@boardsesh/offline-sync';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../lib/analytics';

// Binds the shared offline-usage rollup gate to PostHog (issue #4317). Same
// shape as the other injected-telemetry bindings in this directory — the shared
// package emits a plain object and the app decides what that means, so
// @boardsesh/offline-sync never imports an analytics client.
//
// Import direction is one-way: this module imports `track`, and nothing in
// src/lib/analytics may import this module back.
function emitOfflineUsage(emission: OfflineUsageEmission): void {
  if (emission.kind === 'served') {
    track(SHARED_EVENTS.OfflineReadServed, {
      lane: emission.lane,
      surface: emission.surface,
      boardName: emission.boardName,
      readCount: emission.readCount,
    });
    return;
  }
  track(SHARED_EVENTS.OfflineReadUnavailable, {
    reason: emission.reason,
    surface: emission.surface,
    boardName: emission.boardName,
    readCount: emission.readCount,
    // Null rather than absent: a gap we caused (our backend was down) and a gap
    // the climber walked into (a tunnel) have to be separable in the same
    // series, and an absent prop reads as "old build" instead of "unknown".
    connectivityReason: emission.connectivityReason ?? null,
  });
}

const offlineUsageSignal = createOfflineUsageSignal({ emit: emitOfflineUsage });

export function recordOfflineRead(read: {
  lane: OfflineReadLane;
  surface: OfflineReadSurface;
  boardName: string;
}): void {
  offlineUsageSignal.recordRead(read);
}

export function recordOfflineReadUnavailable(miss: {
  reason: OfflineUnavailableReason;
  surface: OfflineReadSurface;
  boardName: string;
  connectivityReason?: OfflineConnectivityReason | null;
}): void {
  offlineUsageSignal.recordUnavailable(miss);
}

// Sign-out boundary. The gate's suppression map is in-memory and unkeyed by
// user, so without this a same-day account switch inherits the previous user's
// counters and the new user's first offline day never fires — silent
// under-counting of exactly the metric this exists to produce.
export function resetOfflineUsageSignal(): void {
  offlineUsageSignal.reset();
}
