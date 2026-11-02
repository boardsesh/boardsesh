import type { KeepLightingSettingKey } from '../../lib/keep-lighting';
import {
  readLiveActivityLightingWindow,
  type LiveActivityLightingWindowSnapshot,
} from '../../lib/live-activity/live-activity-plugin';
import {
  extendDriveWindow,
  getDriveMode,
  makeDriveOpenEnded,
  startLockScreenDrive,
  type DriveModeState,
} from './drive-mode-store';

/**
 * Lock Screen, Dynamic Island and Android notification Next / Previous light
 * the wall without JS (2.7): iOS writes the board from the intent, Android's
 * receiver acts before the event reaches JS. Each press also opens or renews
 * the keep-lighting window natively, from the settings JS mirrored
 * (`updateKeepLightingConfig`), and stores it with `source: 'lockScreen'`.
 *
 * This adopts that write into the drive store when JS next runs: the app
 * coming back, the press's own `queueNavigate` event, or the link coming up.
 * Each lock-screen write is adopted once, by its `updatedAtMs`.
 */

/** What adopting one lock-screen write does to the drive. */
export type LockScreenAdoption =
  /** No drive here: start one, live, ending where native's window ends (or open-ended). */
  | {
      kind: 'start';
      windowMs: number | null;
      windowSetting: KeepLightingSettingKey | null;
      expiresAt: number | null;
      startedAt: number;
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
  const driveWindowed = drive !== null && drive.windowMs !== null;
  if (snapshot.mode === 'driving') {
    if (!drive) {
      return {
        kind: 'start',
        windowMs: null,
        windowSetting: null,
        expiresAt: null,
        startedAt: Math.min(snapshot.updatedAtMs, now),
      };
    }
    return driveWindowed ? { kind: 'open_ended' } : { kind: 'none' };
  }
  if (snapshot.mode !== 'window') return { kind: 'none' };
  const endsAt = snapshot.endsAtMs ?? null;
  if (endsAt === null || !Number.isFinite(endsAt) || endsAt <= now) return { kind: 'none' };
  if (!drive) {
    const seconds = snapshot.windowSeconds ?? null;
    const windowMs = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : endsAt - now;
    return {
      kind: 'start',
      windowMs,
      windowSetting: settingOf(snapshot.family ?? null),
      expiresAt: endsAt,
      startedAt: Math.min(snapshot.updatedAtMs, now),
    };
  }
  if (driveWindowed && drive.expiresAt !== null && drive.expiresAt < endsAt)
    return { kind: 'extend', expiresAt: endsAt };
  return { kind: 'none' };
}

/** The `updatedAtMs` of the last lock-screen write this JS settled. */
let lastSettledUpdatedAtMs: number | null = null;

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
  if (snapshot?.source !== 'lockScreen' || snapshot.updatedAtMs === lastSettledUpdatedAtMs) return false;
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
  if (!snapshot || snapshot.updatedAtMs === lastSettledUpdatedAtMs) return null;
  const adoption = resolveLockScreenAdoption({ snapshot, drive: getDriveMode(), sessionId, linked, now });
  if (!adoption) return null;
  lastSettledUpdatedAtMs = snapshot.updatedAtMs;
  applyAdoption(adoption, { sessionId, boardId, boardType });
  return adoption;
}

/** Tests only: forget which lock-screen write was settled. */
export function resetLockScreenLightingForTests(): void {
  lastSettledUpdatedAtMs = null;
}
