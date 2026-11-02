import { useSyncExternalStore } from 'react';
import type { DriveModeStartedBy } from '@boardsesh/analytics';
import { trackDriveModeEnded, trackDriveModeStarted } from '../../lib/analytics-wall-control';
import { readAutoDisconnectDeadlineMs } from '../../lib/auto-disconnect-deadline';
import type { KeepLightingChoice, KeepLightingSettingKey } from '../../lib/keep-lighting';

/**
 * Driving the wall (#7113): a swipe on the wall button connects (or takes the
 * board), lights the climb, and from then on every change of climb lights the
 * wall straight away, in a crew too.
 *
 * In memory only, like `ble/wall-cleared-store.ts`: a relaunch starts with
 * nobody driving. `DriveModeWatcher` ends it when the link drops, a connect
 * fails, the session or the board changes, or the climber signs out. Going to
 * the background does not end it.
 *
 * - `arming` — the swipe landed and the connect (or the first light) is in
 *   flight. Nothing lights on a climb change yet.
 * - `live` — the climb is lit on this phone's link; every change lights.
 *
 * Put on board's keep-lighting window (2.7) is a live drive with an end
 * (`windowMs`, `expiresAt`): it starts at the wall's lit confirm, not at the
 * press, so a slow write doesn't eat the climber's seconds, and each climb that
 * lights restarts it. A swipe or Light every climb during it makes it
 * open-ended. `DriveModeWatcher` ends it (`window_ended`) once its time is up.
 */
export type DriveModePhase = 'arming' | 'live';

export type DriveModeState = {
  phase: DriveModePhase;
  /** The party session the drive started in, or null solo. A different session ends it. */
  sessionId: string | null;
  /** The board being driven, once known. */
  boardId: number | null;
  /** The board type driven ('kilter', 'moonboard', ...), for Drive Mode Started / Ended. Null when unknown. */
  boardType: string | null;
  /** `Date.now()` when the swipe landed. */
  startedAt: number;
  /** What started it, for Drive Mode Ended. */
  startedBy: DriveModeStartedBy;
  /** Climbs lit on this phone's link, the swipe's own included, for Drive Mode Ended. */
  climbsLit: number;
  /**
   * Put on board's keep-lighting window (2.7): how long it lasts after each
   * climb that lights, or null for an open-ended drive (a swipe, Light every
   * climb, Until I stop, or a window a swipe turned open-ended).
   */
  windowMs: number | null;
  /** The setting the window came from, so turning it Off ends the window. Null with no window. */
  windowSetting: KeepLightingSettingKey | null;
  /**
   * `Date.now()` when the window ends: set when the drive goes live (the lit
   * confirm), renewed by each climb that lights. Null while arming and with no window.
   */
  expiresAt: number | null;
  /** Lit climbs that renewed the window (the one that opened it not counted), for Drive Mode Ended. */
  windowRenewals: number;
};

/**
 * Why driving ended, for Drive Mode Ended. Sent as `DriveModeEndReason`
 * (shared analytics), so a reason added here fails to compile until it is
 * added there.
 */
export type DriveModeExitReason =
  /** A press on the frosted button: the link stays, swipes go back to previews. */
  | 'stopped'
  /** This phone's link (or its hold on a wall with no lights) dropped. */
  | 'link_dropped'
  /** The connect the swipe started failed. */
  | 'connect_failed'
  /** The swipe's climb never went up: there was nothing to commit. */
  | 'commit_failed'
  /** Arming never reached the wall: nothing connected or lit in time. */
  | 'arming_timed_out'
  /** The climber joined, left or switched party sessions. */
  | 'session_changed'
  /** The board changed under a live drive. */
  | 'board_changed'
  | 'signed_out'
  /** Put on board's keep-lighting window ran out, or its setting was turned off. */
  | 'window_ended';

/**
 * How long arming may wait for the wall before it gives up. The Bluetooth scan
 * is 15 s; past twice that the swipe's connect is not coming, and an arming
 * drive left behind would keep the button from offering the swipe again. The
 * clock runs only while no connect is in flight (`DriveModeWatcher`): an open
 * device picker holds it, and it starts over when the connect settles.
 */
export const DRIVE_ARMING_TIMEOUT_MS = 30_000;

/** What `DriveModeWatcher` reads each render. */
export type DriveWatchSnapshot = {
  /** This phone's Bluetooth link, or its hold on a wall with no lights. */
  linked: boolean;
  /** A connect or disconnect is in flight. */
  pending: boolean;
  sessionId: string | null;
  /** The board presence is bound to. */
  boardId: number | null;
  signedIn: boolean;
};

/**
 * Whether the drive ends between two reads, and why. First match wins.
 *
 * `connectSeen` says this arming drive's connect was seen in flight: arming
 * starts a beat before the connect does, so a link that isn't up yet only
 * means failure once a connect has come and gone.
 */
export function resolveDriveModeExit({
  drive,
  previous,
  current,
  connectSeen,
}: {
  drive: DriveModeState;
  previous: DriveWatchSnapshot;
  current: DriveWatchSnapshot;
  connectSeen: boolean;
}): DriveModeExitReason | null {
  if (previous.signedIn && !current.signedIn) return 'signed_out';
  if (drive.sessionId !== current.sessionId) return 'session_changed';
  if (previous.linked && !current.linked) return 'link_dropped';
  if (drive.phase === 'arming') {
    return connectSeen && !current.pending && !current.linked ? 'connect_failed' : null;
  }
  // Live: another board (never a binding that is only on its way, null).
  const drivenBoardId = drive.boardId ?? previous.boardId;
  if (drivenBoardId !== null && current.boardId !== null && current.boardId !== drivenBoardId) return 'board_changed';
  return null;
}

/**
 * Whether a keep-lighting window ends because Settings › Board changed under it:
 * its own choice turned Off, or (the general choice, in a crew session) In a
 * session too turned off. A MoonBoard's window ignores In a session too.
 */
export function shouldEndWindowForSettings({
  drive,
  keepLighting,
  moonboardKeepLighting,
  drivesInSession,
  inSession,
}: {
  drive: DriveModeState | null;
  keepLighting: KeepLightingChoice;
  moonboardKeepLighting: KeepLightingChoice;
  drivesInSession: boolean;
  inSession: boolean;
}): boolean {
  if (!drive || drive.windowMs === null || drive.windowSetting === null) return false;
  if (drive.windowSetting === 'moonboardPutOnBoardKeepsLighting') return moonboardKeepLighting === 'off';
  return keepLighting === 'off' || (inSession && !drivesInSession);
}

/** The window's time is up (a live drive with an end at or before `now`). */
export function isDriveWindowDue(drive: DriveModeState | null, now = Date.now()): boolean {
  return drive?.phase === 'live' && drive.expiresAt !== null && drive.expiresAt <= now;
}

/**
 * A render's read of a live drive, checked again at the pick being made now.
 * A keep-lighting window past its end lights nothing, even while the watcher's
 * timer has not fired: Android pauses JS timers with the activity (#7038), so
 * the end is read off the wall clock at every pick, never trusted to a timer.
 * `DriveModeWatcher` still ends the drive and tidies the button.
 */
export function drivingAtPick(rendered: boolean, now = Date.now()): boolean {
  return rendered && !isDriveWindowDue(driveMode, now);
}

/**
 * The end the window shows: its own, or auto-disconnect's when that comes
 * first (spec B2), since the link drops then and lighting stops with it.
 */
export function clampWindowEnd(expiresAt: number, autoDisconnectDeadlineMs: number | null): number {
  return autoDisconnectDeadlineMs !== null && autoDisconnectDeadlineMs < expiresAt
    ? autoDisconnectDeadlineMs
    : expiresAt;
}

let driveMode: DriveModeState | null = null;
/**
 * A press on the frosted button stopped driving while the link stays up. Solo
 * with Light the board as I swipe on, swipes stay previews until the link drops,
 * so the stop means something; the setting itself never flips.
 */
let stoppedForLink = false;
let lastExitReason: DriveModeExitReason | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Drive Mode Ended, once per drive: whichever exit ran first reports it. A
 * window that ran out ended at its end, not when a late timer (or the app
 * coming back) noticed it (#7038), so its duration is the climber's.
 */
function reportEnded(ended: DriveModeState, reason: DriveModeExitReason, now = Date.now()): void {
  const endedAt = reason === 'window_ended' && ended.expiresAt !== null ? Math.min(now, ended.expiresAt) : now;
  trackDriveModeEnded({
    reason,
    startedBy: ended.startedBy,
    startedAt: ended.startedAt,
    endedAt,
    climbsLit: ended.climbsLit,
    inSession: ended.sessionId !== null,
    windowRenewals: ended.windowRenewals,
    windowMs: ended.windowMs,
    boardType: ended.boardType,
  });
}

/**
 * A swipe on the wall button landed, or Put on board's climb went up with
 * keep-lighting on: start arming. A fresh drive clears an earlier stop.
 * `windowMs` makes it a keep-lighting window once live; omitted, it is open-ended.
 */
export function enterDriveMode({
  sessionId,
  boardId,
  boardType = null,
  startedBy,
  windowMs = null,
  windowSetting = null,
  now = Date.now(),
}: {
  sessionId: string | null;
  boardId: number | null;
  /** The board type driven, for analytics only. */
  boardType?: string | null;
  startedBy: DriveModeStartedBy;
  windowMs?: number | null;
  windowSetting?: KeepLightingSettingKey | null;
  now?: number;
}): void {
  const windowed = windowMs !== null && windowMs > 0;
  driveMode = {
    phase: 'arming',
    sessionId,
    boardId,
    boardType,
    startedAt: now,
    startedBy,
    climbsLit: 0,
    windowMs: windowed ? windowMs : null,
    windowSetting: windowed ? windowSetting : null,
    expiresAt: null,
    windowRenewals: 0,
  };
  stoppedForLink = false;
  lastExitReason = null;
  emit();
  trackDriveModeStarted({ startedBy, inSession: sessionId !== null, boardType });
}

/**
 * The swipe's climb is lit on this phone's link: every change of climb lights
 * from now on. The light that made it live is counted by `noteDriveClimbLit`,
 * like every other.
 */
export function markDriveLive({ boardId, now = Date.now() }: { boardId?: number | null; now?: number } = {}): void {
  if (!driveMode) return;
  const nextBoardId = boardId ?? driveMode.boardId;
  if (driveMode.phase === 'live') {
    if (nextBoardId === driveMode.boardId) return;
    driveMode = { ...driveMode, boardId: nextBoardId };
  } else {
    // The window starts at the lit confirm, not at the press.
    const expiresAt = driveMode.windowMs !== null ? now + driveMode.windowMs : null;
    driveMode = { ...driveMode, phase: 'live', boardId: nextBoardId, expiresAt };
  }
  emit();
}

/** One more climb went up while driving. In a window it restarts the clock. */
export function noteDriveClimbLit({ now = Date.now() }: { now?: number } = {}): void {
  if (driveMode?.phase !== 'live') return;
  const windowed = driveMode.windowMs !== null && driveMode.expiresAt !== null;
  driveMode = {
    ...driveMode,
    climbsLit: driveMode.climbsLit + 1,
    ...(windowed && driveMode.windowMs !== null
      ? {
          expiresAt: now + driveMode.windowMs,
          // The climb that opened the window is the first counted; every later one renews it.
          windowRenewals: driveMode.windowRenewals + (driveMode.climbsLit > 0 ? 1 : 0),
        }
      : {}),
  };
  emit();
}

/**
 * The window's own choice moved to another length while it runs (the board
 * sheet's Keep lighting row, spec B4): the new length counts from now, as a
 * climb that lights would restart it. An arming window only takes the length.
 * Returns whether anything changed.
 */
export function retimeDriveWindow(windowMs: number, now = Date.now()): boolean {
  if (!driveMode || driveMode.windowMs === null || windowMs <= 0 || driveMode.windowMs === windowMs) return false;
  driveMode = {
    ...driveMode,
    windowMs,
    expiresAt: driveMode.phase === 'live' ? now + windowMs : null,
  };
  emit();
  return true;
}

/**
 * A swipe or Light every climb during a keep-lighting window: the drive goes on
 * with no end, the frost. Returns whether there was a window to open up.
 */
export function makeDriveOpenEnded(): boolean {
  if (!driveMode || driveMode.windowMs === null) return false;
  driveMode = { ...driveMode, windowMs: null, windowSetting: null, expiresAt: null };
  emit();
  return true;
}

/**
 * Whether a crew forming carries driving into it (#7113 QA, Marco: keep
 * driving). A climber who drives solo keeps driving when a crew forms: a live
 * drive (from a swipe, Put on board or the action) simply goes on, since only a
 * change of session ends one. The other way to drive solo, Light the board as
 * I swipe with no stop, is a setting that a crew doesn't honour (swipes there
 * open previews), so it turns into a live drive the moment the crew forms. Not
 * after a stop on this link, and not without a link: nothing was driving then.
 *
 * "Forms" is the roster's crew (`useIsCrewSession`) turning true, after its
 * arrival dwell: until then the climber is solo.
 */
export function shouldCarryDriveIntoCrew({
  crewFormed,
  drive,
  linked,
  stopped,
  lightOnSwipe,
}: {
  /** The roster just turned into a crew. */
  crewFormed: boolean;
  drive: DriveModeState | null;
  /** This phone's link, or its hold on a wall with no lights. */
  linked: boolean;
  /** A press on the frosted button stopped driving on this link. */
  stopped: boolean;
  lightOnSwipe: boolean;
}): boolean {
  return crewFormed && drive === null && linked && !stopped && lightOnSwipe;
}

/** Carry solo, setting-driven driving into the crew that just formed: a live drive. */
export function carryDriveIntoCrew({
  sessionId,
  boardId,
  boardType = null,
}: {
  sessionId: string | null;
  boardId: number | null;
  boardType?: string | null;
}): void {
  enterDriveMode({ sessionId, boardId, boardType, startedBy: 'solo_carry' });
  markDriveLive({ boardId });
}

/** End driving. Returns what ended, or null when nobody was driving. */
export function exitDriveMode(reason: DriveModeExitReason): DriveModeState | null {
  const ended = driveMode;
  if (!ended) return null;
  driveMode = null;
  lastExitReason = reason;
  emit();
  reportEnded(ended, reason);
  return ended;
}

/**
 * The press on the frosted button: stop driving and keep the link. Swipes stay
 * previews until the link drops, solo with Light the board as I swipe on too.
 */
export function stopDrivingForLink(): DriveModeState | null {
  const ended = driveMode;
  driveMode = null;
  if (ended) lastExitReason = 'stopped';
  if (ended || !stoppedForLink) {
    stoppedForLink = true;
    emit();
  }
  if (ended) reportEnded(ended, 'stopped');
  return ended;
}

/** The link this stop belonged to dropped (or the climber signed out): the setting rules again. */
export function clearDrivingStopped(): void {
  if (!stoppedForLink) return;
  stoppedForLink = false;
  emit();
}

export function getDriveMode(): DriveModeState | null {
  return driveMode;
}

/**
 * What the wall is doing for this phone, as one word:
 *
 * - `off` — nobody drives: picks are previews (unless a setting lights them).
 * - `arming` — a drive (or a window) is on its way to the wall.
 * - `window` — Put on board's keep-lighting window: picks light until it ends.
 * - `driving` — an open-ended drive, the frost: picks light until stopped.
 */
export type DriveLightingMode = 'off' | 'arming' | 'window' | 'driving';

function lightingModeOf(drive: DriveModeState | null): DriveLightingMode {
  if (!drive) return 'off';
  if (drive.phase === 'arming') return 'arming';
  return drive.windowMs !== null ? 'window' : 'driving';
}

/** The lighting mode and, for a window, when it ends (clamped to auto-disconnect). */
export type DriveLightingSnapshot = { mode: DriveLightingMode; endsAt: number | null };

/**
 * The seam for the Live Activity and the Android notification bridge (Step 3b):
 * read `{ mode, endsAt }` here on every `subscribeDriveMode` call. `endsAt` is
 * the window's shown end (`clampWindowEnd`), null outside a window. A fresh
 * object per call: read it in a listener, never as a `useSyncExternalStore`
 * snapshot.
 */
export function getDriveLightingSnapshot(): DriveLightingSnapshot {
  const mode = lightingModeOf(driveMode);
  const expiresAt = mode === 'window' ? (driveMode?.expiresAt ?? null) : null;
  return {
    mode,
    endsAt: expiresAt === null ? null : clampWindowEnd(expiresAt, readAutoDisconnectDeadlineMs()),
  };
}

/** Every change to the drive (start, live, a lit climb, a renewal, the end), for a bridge outside React. */
export function subscribeDriveMode(listener: () => void): () => void {
  return subscribe(listener);
}

export function isDrivingStoppedForLink(): boolean {
  return stoppedForLink;
}

/** Why the last drive ended, for tests and the Drive Mode Ended event. */
export function getLastDriveModeExitReason(): DriveModeExitReason | null {
  return lastExitReason;
}

/** Tests only: back to nobody driving, nothing stopped. */
export function resetDriveModeForTests(): void {
  driveMode = null;
  stoppedForLink = false;
  lastExitReason = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readDriveMode = (): DriveModeState | null => driveMode;
const readStopped = (): boolean => stoppedForLink;
const readPhase = (): 'off' | DriveModePhase => driveMode?.phase ?? 'off';
const readLightingMode = (): DriveLightingMode => lightingModeOf(driveMode);
const readWindowExpiresAt = (): number | null =>
  driveMode?.phase === 'live' && driveMode.windowMs !== null ? driveMode.expiresAt : null;
const readWindowMs = (): number | null => driveMode?.windowMs ?? null;

/** The drive in progress, or null. */
export function useDriveMode(): DriveModeState | null {
  return useSyncExternalStore(subscribe, readDriveMode, readDriveMode);
}

/** The phase as the board control reads it. */
export function useDriveModePhase(): 'off' | DriveModePhase {
  return useSyncExternalStore(subscribe, readPhase, readPhase);
}

/** Off, arming, a keep-lighting window, or open-ended driving. Re-renders only when that word changes. */
export function useDriveLightingMode(): DriveLightingMode {
  return useSyncExternalStore(subscribe, readLightingMode, readLightingMode);
}

/**
 * The live keep-lighting window's own end (unclamped), or null outside one.
 * A primitive, so its readers re-render on a renewal, never on a count alone.
 */
export function useDriveWindowExpiresAt(): number | null {
  return useSyncExternalStore(subscribe, readWindowExpiresAt, readWindowExpiresAt);
}

/** The keep-lighting window's length, or null with no window. */
export function useDriveWindowMs(): number | null {
  return useSyncExternalStore(subscribe, readWindowMs, readWindowMs);
}

/** A press on the frosted button stopped driving on this link. */
export function useDrivingStoppedForLink(): boolean {
  return useSyncExternalStore(subscribe, readStopped, readStopped);
}
