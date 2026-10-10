// The rules behind holding the screen awake during an offline board download
// (issue #4310). In the 14 days to 2026-10-11, 17% of the iOS people who started
// a download had it cut off by the phone locking, and their median download took
// 493 s against 44.5 s for a clean run.
//
// Pure: no timers, no settings, no React. `download-keep-awake-store.ts` feeds
// these from the sync engine's progress frames and the app state, and
// `OfflineDownloadKeepAwake` applies the answer.

import type { SyncProgress } from '@boardsesh/offline-sync';
import type { OfflineDownloadTrigger } from '../settings';

/**
 * How long a download may go without a progress frame before it stops holding
 * the screen on. A stalled transfer must not keep a phone awake in a pocket.
 */
export const KEEP_AWAKE_PROGRESS_STALE_MS = 60_000;

/**
 * The most one download may hold the screen on, however lively it is. A Kilter
 * download is 20–60 s and the paged crawl behind a failed fast path is about
 * 5 minutes at the median, so ten covers both and bounds everything else.
 */
export const KEEP_AWAKE_MAX_HOLD_MS = 10 * 60_000;

/**
 * The least one stretch of holding costs against that cap, however short it
 * was. Letting go and taking the lock again restarts the phone's own auto-lock
 * countdown, so a download that fails half a second into every retry would keep
 * the screen on for hours while charging almost nothing. Thirty seconds is the
 * shortest auto-lock iOS offers and the one Low Power Mode forces, which is
 * about what a re-take costs. It also bounds the count: at most
 * `KEEP_AWAKE_MAX_HOLD_MS / KEEP_AWAKE_MIN_HOLD_CHARGE_MS` = 20 stretches per tap.
 */
export const KEEP_AWAKE_MIN_HOLD_CHARGE_MS = 30_000;

/** How often the store samples the clock while a sync cycle runs. */
export const HEARTBEAT_INTERVAL_MS = 1_000;

/**
 * A heartbeat this late means the JS thread was stopped (the app was suspended),
 * not that a timer ran a little behind.
 */
export const SUSPENSION_GAP_MS = 3_000;

/**
 * What one progress frame is about: a single board's download, the work every
 * board in the cycle waits behind (deletions, the user tables), or the end of
 * the cycle.
 */
export type DownloadProgressSubject = { kind: 'scope'; scopeKey: string } | { kind: 'shared' } | { kind: 'idle' };

/**
 * Which board a progress frame belongs to.
 *
 * THE ONE PLACE the keep-awake reads a `SyncProgress` frame. The snapshot detail
 * it reads first is due to be replaced by a per-download field; when that lands,
 * this function is the only thing here that changes.
 *
 * A snapshot frame names its board itself. The frames around it carry the board
 * in `currentTable`: the bare scope key during the bootstrap phase, and
 * `table:scopeKey` during the paged crawl (table names hold no colon, so the
 * first one is the separator).
 */
export function downloadProgressSubject(progress: SyncProgress): DownloadProgressSubject {
  if (progress.phase === 'idle') return { kind: 'idle' };
  if (progress.snapshot) return { kind: 'scope', scopeKey: progress.snapshot.scopeKey };
  if (progress.currentTable === null) return { kind: 'shared' };
  if (progress.phase === 'bootstrap') return { kind: 'scope', scopeKey: progress.currentTable };
  if (progress.phase === 'board_data') {
    const separatorIndex = progress.currentTable.indexOf(':');
    if (separatorIndex >= 0) return { kind: 'scope', scopeKey: progress.currentTable.slice(separatorIndex + 1) };
  }
  return { kind: 'shared' };
}

/** The user-started download the running cycle is working on, and when it last moved. */
export type KeepAwakeTracking = {
  scopeKey: string | null;
  lastProgressAt: number | null;
};

export const IDLE_KEEP_AWAKE_TRACKING: KeepAwakeTracking = { scopeKey: null, lastProgressAt: null };

/**
 * Fold one progress frame into the tracking state.
 *
 * Only a frame naming a download the person started begins tracking, so the
 * routine sync of a board that is already on the phone can never hold the
 * screen on. Shared work counts as that download's progress once it has been
 * seen this cycle: the deletions and user-table pulls sit between its import
 * and its last pages. Another board's frames change nothing, so a long crawl
 * of a board nobody asked for lets the stall rule release the lock.
 */
export function trackDownloadProgress(
  tracking: KeepAwakeTracking,
  subject: DownloadProgressSubject,
  isUserStarted: (scopeKey: string) => boolean,
  now: number,
): KeepAwakeTracking {
  if (subject.kind === 'idle') return IDLE_KEEP_AWAKE_TRACKING;
  if (subject.kind === 'scope') {
    return isUserStarted(subject.scopeKey) ? { scopeKey: subject.scopeKey, lastProgressAt: now } : tracking;
  }
  return tracking.scopeKey === null ? tracking : { scopeKey: tracking.scopeKey, lastProgressAt: now };
}

export type KeepAwakeDecisionInput = {
  /** The running cycle is working on a download a person started. */
  userStartedDownloadInFlight: boolean;
  isForeground: boolean;
  /** Milliseconds since that download last made progress; null before its first frame. */
  msSinceProgress: number | null;
  /** What this download has already spent of the cap: earlier stretches as charged, plus the open one. */
  heldMs: number;
  /** `EXPO_PUBLIC_SCREENSHOT_MODE`: a capture run never holds the lock. */
  screenshotMode: boolean;
};

/** Should the screen be held awake right now? Every condition has to hold. */
export function shouldKeepScreenAwake(input: KeepAwakeDecisionInput): boolean {
  if (input.screenshotMode) return false;
  if (!input.userStartedDownloadInFlight || !input.isForeground) return false;
  if (input.msSinceProgress === null || input.msSinceProgress >= KEEP_AWAKE_PROGRESS_STALE_MS) return false;
  return input.heldMs < KEEP_AWAKE_MAX_HOLD_MS;
}

/**
 * How long until a hold that is active now lapses with no further input: the
 * stall rule or the cap, whichever comes first. The store sleeps this long
 * instead of polling.
 */
export function msUntilKeepAwakeLapses(input: { msSinceProgress: number; heldMs: number }): number {
  const untilStale = KEEP_AWAKE_PROGRESS_STALE_MS - input.msSinceProgress;
  const untilCap = KEEP_AWAKE_MAX_HOLD_MS - input.heldMs;
  return Math.max(0, Math.min(untilStale, untilCap));
}

/** What a finished stretch of holding costs against the cap. */
export function chargedHoldMs(heldMs: number): number {
  return Math.max(heldMs, KEEP_AWAKE_MIN_HOLD_CHARGE_MS);
}

/**
 * Time the JS thread lost in one heartbeat gap. A gap over three seconds counts
 * in full, so each one carries up to one heartbeat of ordinary running time.
 */
export function suspendedMsForHeartbeatGap(gapMs: number): number {
  return gapMs > SUSPENSION_GAP_MS ? gapMs : 0;
}

/**
 * The enables that are not a tap: the "download all" setting acting on a later
 * mount, a board adopted under that setting, and an owned spray wall pinned at
 * launch. Nobody is watching those start, so they do not hold the screen on.
 */
const AUTOMATIC_TRIGGERS: readonly OfflineDownloadTrigger[] = ['auto-download-all', 'adopt-auto', 'owned-wall'];

/** Did a person start this download? `unknown` is a tap from a surface that names no trigger. */
export function isUserStartedTrigger(trigger: OfflineDownloadTrigger): boolean {
  return !AUTOMATIC_TRIGGERS.includes(trigger);
}
