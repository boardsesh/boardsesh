import type { KeepLightingPlan, KeepLightingSettingKey } from '../../lib/keep-lighting';
import {
  readLiveActivityLightingWindow,
  readLiveActivityLockScreenPress,
  type LiveActivityLightingWindowSnapshot,
  type LiveActivityLockScreenPress,
} from '../../lib/live-activity/live-activity-plugin';
import {
  enterDriveMode,
  exitDriveMode,
  extendDriveWindow,
  getDriveMode,
  isDriveWindowDue,
  makeDriveOpenEnded,
  startLockScreenDrive,
  stopDrivingForLink,
  type DriveModeState,
} from './drive-mode-store';

/**
 * Lock Screen, Dynamic Island and Android notification Next / Previous each
 * start or renew Put on board's drive (2.7, Stop driving after), the way a
 * climb lit in the app does: a timed drive, or an open-ended one for Until I
 * stop. Under Right away the press lights its one climb and starts no drive.
 * Who writes it depends on who lights the wall:
 *
 * - iOS lights it without JS: the intent writes the board, and once that write
 *   succeeded it starts or renews the drive natively, from the settings JS
 *   mirrored (`updateKeepLightingConfig`), and stores it with
 *   `source: 'lockScreen'`. JS adopts that write when it next runs: the app
 *   coming back, the press's own `queueNavigate` event, or the link coming up.
 *   Each write is adopted once, by its `updatedAtMs`, and never one from before
 *   this JS started.
 * - Android's receiver only forwards the press. JS moves the queue and its
 *   auto-sender lights the wall, so JS starts the drive itself
 *   (`armNotificationPressDrive`), at the wall's lit confirm like Put on board.
 *
 * A press is a pick, so it reads a timed drive's end off the wall clock
 * (#7038), never the watcher's timer, which a suspended app or Android's
 * paused timers hold back: a timed drive over by the press is not one it
 * renews. Native finds it over too and starts a new one (`afterPress`), so the
 * press starts a drive of its own and the old one ends at its end
 * (`window_ended`); under Right away native writes nothing, and the press's
 * own `queueNavigate` ends it (`endTimedDriveOverAtPress`). That end keeps the
 * link (`keepLink`): the press is the climber at the wall lighting a climb, so
 * Disconnect Bluetooth when driving ends must not let go of the board under
 * it. JS hears an iOS press only once its write is done, so the intent stamps
 * it in flight first (`getLockScreenPress`), and the watcher's own end check
 * waits for a press in flight rather than end the drive at the clock under it
 * (`endTimedDriveAtClock`). A crewmate's put-up ends a
 * timed drive either way started (`useDriveCrewPutUp`), and the climber's own
 * press never reads as one: the server names them as its mover.
 *
 * The Lock Screen and the notification keep showing the wall's climb (the
 * queue's current), never the MiniPlayer's last pick, and a press steps from
 * that climb.
 *
 * The bulb stops a drive too, as the frosted button does in the app
 * (`stopDrivingForLink`: reason `stopped`, the link stays unless Disconnect
 * Bluetooth when driving ends frees the board). iOS stores the stop natively
 * (`StopDrivingIntent`: mode off, `source: 'lockScreen'`) and JS adopts it
 * here like a press, by its `updatedAtMs`, and only for a drive that started
 * before the tap. Android's bulb reaches JS directly (`boardControl`
 * `stopDriving`, `live-activity-bridge.tsx`).
 */

/** What adopting one lock-screen write does to the drive. */
export type LockScreenAdoption =
  /**
   * No drive here, or a timed drive here that was over by the press: start
   * one, live, ending where native's timed drive ends (or open-ended).
   */
  | {
      kind: 'start';
      windowMs: number | null;
      windowSetting: KeepLightingSettingKey | null;
      expiresAt: number | null;
      startedAt: number;
      /** The drive here is a timed drive that was over by the press: it ends first (`window_ended`, keeping the link). */
      replacesLapsedWindow?: true;
    }
  /** The timed drive here ends sooner than native's renewal: take the later end. */
  | { kind: 'extend'; expiresAt: number }
  /** A timed drive here, an open-ended one on the lock screen (Until I stop): no end any more. */
  | { kind: 'open_ended' }
  /** The Lock Screen bulb stopped the drive here: stop driving, as the frosted button does. */
  | { kind: 'stop' }
  /** Read and settled: nothing to change (already driving, a later end here, or the timed drive is over). */
  | { kind: 'none' };

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
  if (sessionId === null || snapshot.sessionId !== sessionId) return null;
  // A stop needs no link: the climber stopped driving whatever the radio does.
  if (snapshot.mode === 'off') return isStopFor(snapshot, drive) ? { kind: 'stop' } : { kind: 'none' };
  if (!linked) return null;
  if (drive?.phase === 'arming') return null;
  // A timed drive over by the press is not the one it renewed: the press's
  // own drive takes its place.
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
      // Every board's timed drive comes from Stop driving after, so a snapshot
      // an older JS wrote with the MoonBoard family reads the same.
      windowSetting: 'putOnBoardKeepsLighting',
      expiresAt: endsAt,
      startedAt: Math.min(snapshot.updatedAtMs, now),
      ...replaces,
    };
  }
  if (driveWindowed && current.expiresAt !== null && current.expiresAt < endsAt)
    return { kind: 'extend', expiresAt: endsAt };
  return { kind: 'none' };
}

/**
 * Whether a lock-screen "off" stops `drive`: only a drive that started before
 * the tap. One started since (Put on board again, a swipe) is not the drive
 * the climber stopped.
 */
function isStopFor(snapshot: LiveActivityLightingWindowSnapshot, drive: DriveModeState | null): boolean {
  return snapshot.mode === 'off' && drive !== null && drive.startedAt <= snapshot.updatedAtMs;
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
 * Whether `snapshot` is a lock-screen drive (timed or open-ended) this JS
 * has not settled yet and that is still running. The Live Activity writer
 * never covers one with "off": that would wipe a drive the climber started
 * from the Lock Screen before the drive store could adopt it.
 */
export function isUnsettledLockScreenLighting(
  snapshot: LiveActivityLightingWindowSnapshot | null,
  now: number,
): boolean {
  if (snapshot?.source !== 'lockScreen' || isSettled(snapshot)) return false;
  if (snapshot.mode === 'driving') return true;
  return snapshot.mode === 'window' && (snapshot.endsAtMs ?? 0) > now;
}

/**
 * Whether `snapshot` is a Lock Screen stop this JS has not adopted yet that
 * stops `drive`. The Live Activity writer never covers one with the drive it
 * stopped: the card would show the drive again, and the next adoption could
 * not find the stop.
 */
export function isUnsettledLockScreenStop(
  snapshot: LiveActivityLightingWindowSnapshot | null,
  drive: DriveModeState | null,
): boolean {
  if (snapshot?.source !== 'lockScreen' || isSettled(snapshot)) return false;
  return isStopFor(snapshot, drive);
}

/** Applies one adoption to the drive store. */
function applyAdoption(
  adoption: LockScreenAdoption,
  context: { sessionId: string | null; boardId: number | null; boardType: string | null },
): void {
  switch (adoption.kind) {
    case 'start':
      // The press took the board again: the old drive's end never lets go of it.
      if (adoption.replacesLapsedWindow) exitDriveMode('window_ended', { keepLink: true });
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
    case 'stop':
      stopDrivingForLink();
      return;
    case 'none':
      return;
  }
}

/**
 * Reads the stored drive and adopts a lock-screen write this JS has not
 * settled. Synchronous, so a caller can run it just before its own
 * timed-drive end check. Returns what it did, or null when there was nothing to
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
 * A Lock Screen, Dynamic Island or notification Previous / Next, as JS hears
 * it (`queueNavigate`): a timed drive over by now ends at its end
 * (`window_ended`), keeping the link. The press is the climber at the wall
 * lighting a climb, so Disconnect Bluetooth when driving ends must not let go
 * of the board under it, Right away included. Android reads it here before
 * arming (`armNotificationPressDrive`). iOS reads it once the press's own
 * write is adopted: that write replaces a lapsed drive itself, but under Right
 * away the intent writes none, so the old drive ends here. A catch-up that
 * runs before this event reads the press's stamp instead and ends it the same
 * way (`endTimedDriveAtClock`). Returns whether it ended one.
 */
export function endTimedDriveOverAtPress(now = Date.now()): boolean {
  if (!isDriveWindowDue(getDriveMode(), now)) return false;
  exitDriveMode('window_ended', { keepLink: true });
  return true;
}

/**
 * How long a timed-drive end check waiting on a Lock Screen press in flight
 * waits before it looks again. A press usually settles well inside a second.
 */
export const LOCK_SCREEN_PRESS_RECHECK_MS = 250;

/**
 * The longest a press stamp may still claim to be in flight, counted from now.
 * Native gives a press 18 s at most (`SharedLockScreenPress`); a stamp that
 * claims more (the clock moved back since it was written) counts as no press.
 */
export const LOCK_SCREEN_PRESS_MAX_IN_FLIGHT_MS = 20_000;

/**
 * How far past now a settled press may say it landed: native stamps fractions
 * of a millisecond, JS reads whole ones. Any later and the clock moved back.
 */
const LOCK_SCREEN_PRESS_CLOCK_SLACK_MS = 1_000;

/** What the watcher's end check does with a timed drive the clock found over. */
export type TimedDriveEndAtClock =
  /** A Lock Screen press is on its way to the wall: leave the drive, look again in `recheckInMs`. */
  | { kind: 'wait'; recheckInMs: number }
  /** A press landed once the drive was over: it ends keeping the board, as the press's `queueNavigate` ends it. */
  | { kind: 'end_keeping_board' }
  /** No press: the clock ends it, and Disconnect Bluetooth when driving ends may let go of the board. */
  | { kind: 'end' };

/**
 * The iOS Lock Screen press stamp, read where the clock found a timed drive
 * over (the watcher's timer, or its catch-up when the app comes back). Native
 * writes a press's own drive only after its board write, and under Right away
 * none, and JS hears the press later still (`queueNavigate`). Ended at the
 * clock in that gap, the drive would let go of the board under the press.
 *
 * - In flight (not settled, before its expiry): wait. The press either renews
 *   the drive (adopted at the next look) or settles.
 * - Settled at or after the drive's end: the press found the drive over, so it
 *   ends keeping the board, as `endTimedDriveOverAtPress` ends it when the
 *   press's `queueNavigate` arrives. That event may still be on its way. A
 *   press the party server turned down settles too and never sends one: its
 *   stamp may cover an earlier press still writing, so it keeps the board too.
 * - Anything else (no stamp, one that expired unsettled, a press that landed
 *   before the end and so renewed the drive): the clock ends it.
 */
export function resolveTimedDriveEndAtClock({
  press,
  expiresAt,
  now,
}: {
  press: LiveActivityLockScreenPress | null;
  /** The timed drive's end, already passed. */
  expiresAt: number;
  now: number;
}): TimedDriveEndAtClock {
  if (!press) return { kind: 'end' };
  const { expiresAtMs, settledAtMs } = press;
  if (settledAtMs === null || settledAtMs === undefined) {
    const leftMs = expiresAtMs - now;
    if (!Number.isFinite(leftMs) || leftMs <= 0 || leftMs > LOCK_SCREEN_PRESS_MAX_IN_FLIGHT_MS) return { kind: 'end' };
    return { kind: 'wait', recheckInMs: Math.min(LOCK_SCREEN_PRESS_RECHECK_MS, leftMs) };
  }
  const landedOverTheEnd =
    Number.isFinite(settledAtMs) && settledAtMs >= expiresAt && settledAtMs <= now + LOCK_SCREEN_PRESS_CLOCK_SLACK_MS;
  return landedOverTheEnd ? { kind: 'end_keeping_board' } : { kind: 'end' };
}

/**
 * The watcher's end check found the timed drive over: end it (`window_ended`)
 * as `resolveTimedDriveEndAtClock` says, keeping the board for a press that
 * landed once it was over. Returns how long to wait before looking again while
 * a press is in flight, or null when it ended the drive (or none was due).
 */
export function endTimedDriveAtClock({
  now = Date.now(),
  readPress = readLiveActivityLockScreenPress,
}: {
  now?: number;
  /** The native read; injectable for tests. */
  readPress?: () => LiveActivityLockScreenPress | null;
} = {}): number | null {
  const drive = getDriveMode();
  if (drive === null || drive.expiresAt === null || !isDriveWindowDue(drive, now)) return null;
  const end = resolveTimedDriveEndAtClock({ press: readPress(), expiresAt: drive.expiresAt, now });
  if (end.kind === 'wait') return end.recheckInMs;
  exitDriveMode('window_ended', end.kind === 'end_keeping_board' ? { keepLink: true } : {});
  return null;
}

/**
 * Android: a notification Previous / Next, as JS hears it (`queueNavigate`).
 * The receiver writes no drive: JS moves the queue and its auto-sender
 * lights the wall, so a timed drive must start where a climb lit in the app
 * starts it. With nothing driving, the press arms a drive the way Put on board
 * does (`startedBy: 'lock_screen'`); the wall's lit confirm takes it live and
 * starts the clock there (`useDriveWallConfirms`). A press that never lights
 * (the party server turned it down, the write failed) leaves arming to time
 * out, and the notification, which reads arming as off, never shows a drive
 * for it. A timed drive already running renews at the confirm, an open-ended
 * one goes on, and arming waits for its own confirm. A timed drive over by the
 * press (Android pauses JS timers with the activity, #7038, so the watcher may
 * not have ended it) ends here first (`window_ended`): its confirm must not
 * renew it. That end keeps the link (`keepLink`): the press is lighting a
 * climb, so Disconnect Bluetooth when driving ends must not let go of the
 * board under it.
 *
 * Returns whether it armed: not without a link (nothing lights), not with a
 * drive on, and not under Right away, where the press lights one climb
 * (`plan` null).
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
  endTimedDriveOverAtPress(now);
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
