import type { KeepLightingPlan, KeepLightingSettingKey } from '../../lib/keep-lighting';
import {
  readLiveActivityLightingWindow,
  type LiveActivityLightingWindowSnapshot,
} from '../../lib/live-activity/live-activity-plugin';
import {
  enterDriveMode,
  exitDriveMode,
  extendDriveWindow,
  getDriveMode,
  isDriveWindowDue,
  makeDriveOpenEnded,
  startLockScreenDrive,
  type DriveModeState,
} from './drive-mode-store';

/**
 * Lock Screen, Dynamic Island and Android notification Next / Previous each
 * open or renew Put on board's keep-lighting window (2.7), the way a climb lit
 * in the app does. Who writes it depends on who lights the wall:
 *
 * - iOS lights it without JS: the intent writes the board, and once that write
 *   succeeded it opens or renews the window natively, from the settings JS
 *   mirrored (`updateKeepLightingConfig`), and stores it with
 *   `source: 'lockScreen'`. JS adopts that write when it next runs: the app
 *   coming back, the press's own `queueNavigate` event, or the link coming up.
 *   Each write is adopted once, by its `updatedAtMs`, and never one from before
 *   this JS started.
 * - Android's receiver only forwards the press. JS moves the queue and its
 *   auto-sender lights the wall, so JS opens the window itself
 *   (`armNotificationPressDrive`), at the wall's lit confirm like Put on board.
 *
 * A press is a pick, so it reads a window's end off the wall clock (#7038),
 * never the watcher's timer, which a suspended app or Android's paused timers
 * hold back: a window over by the press is not one it renews. Native finds it
 * over too and opens a new one (`afterPress`), so the press starts a drive of
 * its own and the old one ends at its end (`window_ended`). A crewmate's
 * put-up ends a window either way opened (`useDriveCrewPutUp`), and the
 * climber's own press never reads as one: the server names them as its mover.
 */

/** What adopting one lock-screen write does to the drive. */
export type LockScreenAdoption =
  /**
   * No drive here, or a window here that was over by the press: start one,
   * live, ending where native's window ends (or open-ended).
   */
  | {
      kind: 'start';
      windowMs: number | null;
      windowSetting: KeepLightingSettingKey | null;
      expiresAt: number | null;
      startedAt: number;
      /** The drive here is a window that was over by the press: it ends first (`window_ended`). */
      replacesLapsedWindow?: true;
    }
  /** The window here ends sooner than native's renewal: take the later end. */
  | { kind: 'extend'; expiresAt: number }
  /** A window here, a drive on the lock screen (Until I stop): no end any more. */
  | { kind: 'open_ended' }
  /** Read and settled: nothing to change (already driving, a later end here, or the window is over). */
  | { kind: 'none' };

function settingOf(family: LiveActivityLightingWindowSnapshot['family']): KeepLightingSettingKey {
  return family === 'moonboard' ? 'moonboardPutOnBoardKeepsLighting' : 'putOnBoardKeepsLighting';
}

/**
 * The adoption for one stored snapshot, or null when it can't be judged yet
 * (not a lock-screen write, another session, no link, a drive still arming):
 * it is then left for the next try.
 */
export function resolveLockScreenAdoption({
  snapshot,
  drive,
  sessionId,
  linked,
  now,
}: {
  snapshot: LiveActivityLightingWindowSnapshot | null;
  drive: DriveModeState | null;
  sessionId: string | null;
  /** This phone's Bluetooth link, or its hold on a wall with no lights. */
  linked: boolean;
  now: number;
}): LockScreenAdoption | null {
  if (snapshot?.source !== 'lockScreen') return null;
  if (sessionId === null || snapshot.sessionId !== sessionId || !linked) return null;
  if (drive?.phase === 'arming') return null;
  // A window over by the press is not the one it renewed: the press's own
  // drive takes its place.
  const lapsed = isDriveWindowDue(drive, snapshot.updatedAtMs);
  const current = lapsed ? null : drive;
  const replaces = lapsed ? { replacesLapsedWindow: true as const } : {};
  const driveWindowed = current !== null && current.windowMs !== null;
  if (snapshot.mode === 'driving') {
    if (!current) {
      return {
        kind: 'start',
        windowMs: null,
        windowSetting: null,
        expiresAt: null,
        startedAt: Math.min(snapshot.updatedAtMs, now),
        ...replaces,
      };
    }
    return driveWindowed ? { kind: 'open_ended' } : { kind: 'none' };
  }
  if (snapshot.mode !== 'window') return { kind: 'none' };
  const endsAt = snapshot.endsAtMs ?? null;
  if (endsAt === null || !Number.isFinite(endsAt) || endsAt <= now) return { kind: 'none' };
  if (!current) {
    const seconds = snapshot.windowSeconds ?? null;
    const windowMs = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : endsAt - now;
    return {
      kind: 'start',
      windowMs,
      windowSetting: settingOf(snapshot.family ?? null),
      expiresAt: endsAt,
      startedAt: Math.min(snapshot.updatedAtMs, now),
      ...replaces,
    };
  }
  if (driveWindowed && current.expiresAt !== null && current.expiresAt < endsAt)
    return { kind: 'extend', expiresAt: endsAt };
  return { kind: 'none' };
}

/** The `updatedAtMs` of the last lock-screen write this JS settled. */
let lastSettledUpdatedAtMs: number | null = null;

/**
 * When this JS started. A lock-screen write from before then was left by a JS
 * that is gone: the app was killed (or reloaded) between the press and its
 * adoption, and the App Group outlives it. A relaunch starts with nobody
 * driving (`drive-mode-store.ts`), so such a write is never adopted and never
 * kept on the card: the first write from this JS covers it.
 */
let startedAtMs = Date.now();

/** Settled here, or left by an earlier JS. */
function isSettled(snapshot: LiveActivityLightingWindowSnapshot): boolean {
  return snapshot.updatedAtMs === lastSettledUpdatedAtMs || snapshot.updatedAtMs < startedAtMs;
}

/**
 * Whether `snapshot` is a lock-screen window (or drive) this JS has not
 * settled yet and that is still running. The Live Activity writer never
 * covers one with "off": that would wipe a window the climber opened from the
 * Lock Screen before the drive store could adopt it.
 */
export function isUnsettledLockScreenLighting(
  snapshot: LiveActivityLightingWindowSnapshot | null,
  now: number,
): boolean {
  if (snapshot?.source !== 'lockScreen' || isSettled(snapshot)) return false;
  if (snapshot.mode === 'driving') return true;
  return snapshot.mode === 'window' && (snapshot.endsAtMs ?? 0) > now;
}

/** Applies one adoption to the drive store. */
function applyAdoption(
  adoption: LockScreenAdoption,
  context: { sessionId: string | null; boardId: number | null; boardType: string | null },
): void {
  switch (adoption.kind) {
    case 'start':
      if (adoption.replacesLapsedWindow) exitDriveMode('window_ended');
      startLockScreenDrive({
        sessionId: context.sessionId,
        boardId: context.boardId,
        boardType: context.boardType,
        windowMs: adoption.windowMs,
        windowSetting: adoption.windowSetting,
        expiresAt: adoption.expiresAt,
        startedAt: adoption.startedAt,
      });
      return;
    case 'extend':
      extendDriveWindow(adoption.expiresAt);
      return;
    case 'open_ended':
      makeDriveOpenEnded();
      return;
    case 'none':
      return;
  }
}

/**
 * Reads the stored window and adopts a lock-screen write this JS has not
 * settled. Synchronous, so a caller can run it just before its own
 * window-end check. Returns what it did, or null when there was nothing to
 * settle.
 */
export function adoptLockScreenLighting({
  sessionId,
  linked,
  boardId,
  boardType,
  now = Date.now(),
  read = readLiveActivityLightingWindow,
}: {
  sessionId: string | null;
  linked: boolean;
  boardId: number | null;
  boardType: string | null;
  now?: number;
  /** The native read; injectable for tests. */
  read?: () => LiveActivityLightingWindowSnapshot | null;
}): LockScreenAdoption | null {
  const snapshot = read();
  if (!snapshot || isSettled(snapshot)) return null;
  const adoption = resolveLockScreenAdoption({ snapshot, drive: getDriveMode(), sessionId, linked, now });
  if (!adoption) return null;
  lastSettledUpdatedAtMs = snapshot.updatedAtMs;
  applyAdoption(adoption, { sessionId, boardId, boardType });
  return adoption;
}

/**
 * Android: a notification Previous / Next, as JS hears it (`queueNavigate`).
 * The receiver writes no window: JS moves the queue and its auto-sender
 * lights the wall, so the window must start where a climb lit in the app
 * starts it. With nothing driving, the press arms a drive the way Put on board
 * does (`startedBy: 'lock_screen'`); the wall's lit confirm takes it live and
 * starts the window there (`useDriveWallConfirms`). A press that never lights
 * (the party server turned it down, the write failed) leaves arming to time
 * out, and the notification, which reads arming as off, never shows a window
 * for it. A window already running renews at the confirm, a drive goes on,
 * and arming waits for its own confirm. A window over by the press (Android
 * pauses JS timers with the activity, #7038, so the watcher may not have
 * ended it) ends here first (`window_ended`): its confirm must not renew it.
 *
 * Returns whether it armed: not without a link (nothing lights), not with a
 * drive on, and not where the press lights one climb (`plan` null).
 */
export function armNotificationPressDrive({
  sessionId,
  boardId,
  boardType,
  linked,
  plan,
  now = Date.now(),
}: {
  sessionId: string | null;
  boardId: number | null;
  boardType: string | null;
  /** This phone's Bluetooth link, or its hold on a wall with no lights. */
  linked: boolean;
  /** What the press keeps lighting (`lockScreenPressKeepsLighting` + `resolveKeepLightingPlan`), or null for one climb. */
  plan: KeepLightingPlan | null;
  now?: number;
}): boolean {
  if (isDriveWindowDue(getDriveMode(), now)) exitDriveMode('window_ended');
  if (!linked || plan === null || getDriveMode() !== null) return false;
  enterDriveMode({
    sessionId,
    boardId,
    boardType,
    startedBy: 'lock_screen',
    windowMs: plan.windowMs,
    windowSetting: plan.windowMs === null ? null : plan.setting,
  });
  return true;
}

/**
 * Tests only: forget which lock-screen write was settled, and when this JS
 * started (by default long ago, so a test's writes all count as this JS's).
 */
export function resetLockScreenLightingForTests({
  startedAt = Number.NEGATIVE_INFINITY,
}: { startedAt?: number } = {}): void {
  lastSettledUpdatedAtMs = null;
  startedAtMs = startedAt;
}
