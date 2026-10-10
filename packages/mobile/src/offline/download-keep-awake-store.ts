// Module-level state behind the download keep-awake (issue #4310): which
// downloads a person started, whether one of them should hold the screen on
// right now, and what each download's telemetry should say about it.
//
// The sync adapter feeds every progress frame in through `noteDownloadProgress`.
// A frame costs a few comparisons here and reaches React only when the answer
// flips: `OfflineDownloadKeepAwake` subscribes to one boolean, so a download
// emitting two frames a second re-renders nothing. The rules themselves are the
// pure functions in `download-keep-awake.ts`.

import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import type { SyncProgress } from '@boardsesh/offline-sync';
import {
  forgetUserStartedDownload,
  getSetting,
  getUserStartedDownloads,
  rememberUserStartedDownload,
  subscribeSettings,
} from '../settings';
import {
  HEARTBEAT_INTERVAL_MS,
  IDLE_KEEP_AWAKE_TRACKING,
  chargedHoldMs,
  downloadProgressSubject,
  msUntilKeepAwakeLapses,
  shouldKeepScreenAwake,
  suspendedMsForHeartbeatGap,
  trackDownloadProgress,
  type DownloadProgressSubject,
  type KeepAwakeTracking,
} from './download-keep-awake';

// Inlined at build time, like every other screenshot-mode gate.
const SCREENSHOT_MODE = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';

/** What `Offline Board Download Completed` / `Failed` say about one download. */
export type DownloadTelemetry = {
  /** The screen was held awake for this download at some point in this app session. */
  keepAwake: boolean;
  /**
   * Heartbeat gaps over three seconds while this board was the one downloading.
   * That is suspension on iOS only, which is the only place the adapter sends
   * it: Android stops JS timers when the activity pauses while JS runs on.
   */
  suspendedMs: number;
};

// The settings value is the truth; this is its in-memory copy, narrowed to the
// boards still in `syncEnabledBoards`. Null until the first read.
let userStartedScopeKeys: Set<string> | null = null;
let unsubscribeSettings: (() => void) | null = null;
let isPruningDelisted = false;

let tracking: KeepAwakeTracking = IDLE_KEEP_AWAKE_TRACKING;
let isKeepAwakeActive = false;
const listeners = new Set<() => void>();

let isForeground = true;
let appStateSubscription: NativeEventSubscription | null = null;

// The stretch the lock is held for right now, and what earlier stretches
// already spent of each download's ten-minute cap. A stretch is charged at
// least `KEEP_AWAKE_MIN_HOLD_CHARGE_MS`, so the cap also bounds how many times
// one tap can take the lock.
let currentHold: { scopeKey: string; startedAt: number } | null = null;
const heldMsByScope = new Map<string, number>();
let lapseTimer: ReturnType<typeof setTimeout> | null = null;

// Runs only while a sync cycle does. `cycleScopeKey` is the board the latest
// frame named: the one whose phase timings a suspension lands in.
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatAt = 0;
let cycleScopeKey: string | null = null;
const telemetryByScope = new Map<string, DownloadTelemetry>();

function telemetryFor(scopeKey: string): DownloadTelemetry {
  let telemetry = telemetryByScope.get(scopeKey);
  if (!telemetry) {
    telemetry = { keepAwake: false, suspendedMs: 0 };
    telemetryByScope.set(scopeKey, telemetry);
  }
  return telemetry;
}

/**
 * The user-started set as settings hold it, split into the boards still in
 * `syncEnabledBoards` and the ones that have left it (those are forgotten on
 * the way). Removing a board and turning it off take it out of that setting as
 * their first step, and sign-out empties the setting near its end, so this one
 * rule covers all three without each call site having to remember the
 * keep-awake.
 */
function readUserStarted(): { pending: Set<string>; delisted: string[] } {
  const enabledScopeKeys = new Set(getSetting('syncEnabledBoards'));
  const pending = new Set<string>();
  const delisted: string[] = [];
  // Forgetting a board writes a setting, which calls straight back into the
  // settings listener below.
  isPruningDelisted = true;
  try {
    for (const scopeKey of getUserStartedDownloads()) {
      if (enabledScopeKeys.has(scopeKey)) {
        pending.add(scopeKey);
      } else {
        forgetUserStartedDownload(scopeKey);
        delisted.push(scopeKey);
      }
    }
  } finally {
    isPruningDelisted = false;
  }
  return { pending, delisted };
}

/**
 * Drop what the store remembers about one board's download. Left behind, a
 * spent cap or a `keepAwake: true` would be inherited by the next download of
 * the same board, including one nobody tapped.
 */
function forgetDownloadState(scopeKey: string): void {
  heldMsByScope.delete(scopeKey);
  telemetryByScope.delete(scopeKey);
}

/**
 * Run `work` from a settings write, an app-state event or a timer. A throw out
 * of any of those lands in code that has nothing to do with the keep-awake: an
 * unrelated settings write, or the top of the event loop, where an uncaught
 * error can take the app down. Holding the screen on is never worth that.
 */
function quietly(work: () => void): void {
  try {
    work();
  } catch (error) {
    if (__DEV__) console.warn('[offline] download keep-awake failed:', error);
  }
}

function handleSettingsChange(): void {
  if (isPruningDelisted) return;
  quietly(() => {
    const { pending, delisted } = readUserStarted();
    userStartedScopeKeys = pending;
    if (tracking.scopeKey !== null && !pending.has(tracking.scopeKey)) tracking = IDLE_KEEP_AWAKE_TRACKING;
    evaluate();
    // After the evaluation: closing a hold that was still open charges it.
    for (const scopeKey of delisted) forgetDownloadState(scopeKey);
  });
}

function userStarted(): Set<string> {
  if (userStartedScopeKeys !== null) return userStartedScopeKeys;
  unsubscribeSettings = subscribeSettings(handleSettingsChange);
  const { pending } = readUserStarted();
  userStartedScopeKeys = pending;
  return pending;
}

/**
 * A person started or retried this board's download. Call it AFTER the board is
 * in `syncEnabledBoards`: a board that is not enabled is not downloading, and
 * the settings listener drops it. Each call buys a fresh ten-minute cap, because
 * each one is a person asking again.
 */
export function markUserStartedDownload(scopeKey: string): void {
  userStarted();
  heldMsByScope.delete(scopeKey);
  if (currentHold?.scopeKey === scopeKey) currentHold.startedAt = Date.now();
  rememberUserStartedDownload(scopeKey);
}

/**
 * This board's download finished. A board that is removed or turned off needs
 * no call: leaving `syncEnabledBoards` already drops it.
 */
export function clearUserStartedDownload(scopeKey: string): void {
  userStarted();
  // The settings write runs the listener, which closes any hold still open.
  forgetUserStartedDownload(scopeKey);
  forgetDownloadState(scopeKey);
}

/** Scope keys of the downloads a person started that have not finished. */
export function getPendingUserStartedDownloads(): string[] {
  return [...userStarted()];
}

/**
 * Count a gap between two clock samples as suspension when it is long enough.
 * Every path that reads the clock samples first, so whichever of a timer, a
 * progress frame or a telemetry read runs first after a resume sees the gap.
 */
function sampleHeartbeat(now: number): void {
  if (heartbeatTimer === null) return;
  const suspendedMs = suspendedMsForHeartbeatGap(now - lastHeartbeatAt);
  lastHeartbeatAt = now;
  if (suspendedMs === 0) return;
  // A stopped JS thread means a suspended app, and the lock holds nothing on
  // then. Keep that time off the cap.
  if (currentHold) currentHold.startedAt += suspendedMs;
  if (cycleScopeKey !== null) telemetryFor(cycleScopeKey).suspendedMs += suspendedMs;
}

function startHeartbeat(now: number): void {
  if (heartbeatTimer !== null) return;
  lastHeartbeatAt = now;
  heartbeatTimer = setInterval(() => sampleHeartbeat(Date.now()), HEARTBEAT_INTERVAL_MS);
}

/**
 * The cycle ended. `suspendedMs` is scoped to one cycle, the same as the phase
 * timings it sits beside, so it does not carry into the next. A board whose
 * download never held the screen has nothing left worth keeping.
 */
function endCycle(): void {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  cycleScopeKey = null;
  for (const [scopeKey, telemetry] of telemetryByScope) {
    if (telemetry.keepAwake) telemetry.suspendedMs = 0;
    else telemetryByScope.delete(scopeKey);
  }
}

function clearLapseTimer(): void {
  if (lapseTimer !== null) clearTimeout(lapseTimer);
  lapseTimer = null;
}

function heldMsFor(scopeKey: string, now: number): number {
  const earlierHolds = heldMsByScope.get(scopeKey) ?? 0;
  if (currentHold?.scopeKey !== scopeKey) return earlierHolds;
  return earlierHolds + Math.max(0, now - currentHold.startedAt);
}

/** Close the open stretch when the lock moves to another board or lets go, and open the next. */
function settleHold(scopeKey: string | null, now: number): void {
  if (currentHold && currentHold.scopeKey !== scopeKey) {
    const earlierHolds = heldMsByScope.get(currentHold.scopeKey) ?? 0;
    const stretchMs = Math.max(0, now - currentHold.startedAt);
    heldMsByScope.set(currentHold.scopeKey, earlierHolds + chargedHoldMs(stretchMs));
    currentHold = null;
    // The next board has its own cap, so the armed deadline no longer applies.
    clearLapseTimer();
  }
  if (scopeKey !== null && !currentHold) {
    currentHold = { scopeKey, startedAt: now };
    telemetryFor(scopeKey).keepAwake = true;
  }
}

function evaluate(now: number = Date.now()): void {
  sampleHeartbeat(now);
  const scopeKey = tracking.scopeKey;
  const msSinceProgress = tracking.lastProgressAt === null ? null : now - tracking.lastProgressAt;
  const heldMs = scopeKey === null ? 0 : heldMsFor(scopeKey, now);
  const nextActive =
    // No mounted consumer means nothing is applying the lock.
    listeners.size > 0 &&
    shouldKeepScreenAwake({
      userStartedDownloadInFlight: scopeKey !== null && userStarted().has(scopeKey),
      isForeground,
      msSinceProgress,
      heldMs,
      screenshotMode: SCREENSHOT_MODE,
    });
  settleHold(nextActive ? scopeKey : null, now);

  if (!nextActive || msSinceProgress === null) {
    clearLapseTimer();
  } else if (lapseTimer === null) {
    // Not re-armed per frame. Progress only ever moves the deadline later, so
    // the timer wakes at the one it was given, finds newer progress, and sleeps
    // again for what is left.
    lapseTimer = setTimeout(() => {
      lapseTimer = null;
      quietly(evaluate);
    }, msUntilKeepAwakeLapses({ msSinceProgress, heldMs }));
  }

  if (nextActive === isKeepAwakeActive) return;
  isKeepAwakeActive = nextActive;
  for (const listener of listeners) listener();
}

/**
 * Feed one sync progress frame in. Returns what the frame was about, so the
 * adapter can act on the end of a cycle without reading the frame itself.
 */
export function noteDownloadProgress(progress: SyncProgress): DownloadProgressSubject['kind'] {
  const now = Date.now();
  const subject = downloadProgressSubject(progress);
  // Before the subject moves on: a gap that ends here happened under the
  // board the previous frame named.
  sampleHeartbeat(now);
  if (subject.kind === 'idle') {
    endCycle();
  } else {
    startHeartbeat(now);
    cycleScopeKey = subject.kind === 'scope' ? subject.scopeKey : null;
  }
  tracking = trackDownloadProgress(tracking, subject, (scopeKey) => userStarted().has(scopeKey), now);
  evaluate(now);
  return subject.kind;
}

/**
 * Read what a download event should report. Each read resets `suspendedMs`, so
 * the events of one cycle add up without counting a gap twice. `keepAwake`
 * stays until the download finishes or its board is pruned.
 */
export function takeDownloadTelemetry(scopeKey: string): DownloadTelemetry {
  sampleHeartbeat(Date.now());
  const telemetry = telemetryByScope.get(scopeKey);
  if (!telemetry) return { keepAwake: false, suspendedMs: 0 };
  const reported: DownloadTelemetry = { ...telemetry };
  telemetry.suspendedMs = 0;
  return reported;
}

function handleAppStateChange(nextState: AppStateStatus): void {
  // `inactive` is a transient interruption on iOS (Control Centre, a system
  // prompt), not a trip to the background. Same reading as the engine's guard.
  isForeground = nextState !== 'background';
  quietly(evaluate);
}

/** Subscribe to the one boolean. The listener runs only when it flips. */
export function subscribeDownloadKeepAwake(listener: () => void): () => void {
  listeners.add(listener);
  if (appStateSubscription === null) {
    isForeground = AppState.currentState !== 'background';
    appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
  }
  evaluate();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    appStateSubscription?.remove();
    appStateSubscription = null;
    evaluate();
  };
}

/** Should the screen be held awake right now? */
export function isDownloadKeepAwakeActive(): boolean {
  return isKeepAwakeActive;
}

/** Test-only: forget everything, including the settings and app-state subscriptions. */
export function __resetDownloadKeepAwakeForTests(): void {
  clearLapseTimer();
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  unsubscribeSettings?.();
  unsubscribeSettings = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  userStartedScopeKeys = null;
  isPruningDelisted = false;
  tracking = IDLE_KEEP_AWAKE_TRACKING;
  isKeepAwakeActive = false;
  listeners.clear();
  isForeground = true;
  currentHold = null;
  heldMsByScope.clear();
  lastHeartbeatAt = 0;
  cycleScopeKey = null;
  telemetryByScope.clear();
}
