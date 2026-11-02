import { useSyncExternalStore } from 'react';
import type { DriveModeStartedBy } from '@boardsesh/analytics';
import { trackDriveModeEnded, trackDriveModeStarted } from '../../lib/analytics-wall-control';
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
 * Put on board's timed drive (2.7, Stop driving after) is a live drive with an
 * end (`windowMs`, `expiresAt`): it starts at the wall's lit confirm, not at
 * the press, so a slow write doesn't eat the climber's seconds, and each climb
 * that lights restarts it. It looks like any drive (the frost, You are driving
 * the wall), plus a clock, and the frost shrinks as its time runs out. Only Put
 * on board's drive is timed: a swipe or Light every climb starts an open-ended
 * one, and during a timed drive makes it open-ended. `DriveModeWatcher` ends it
 * (`window_ended`) once its time is up.
 *
 * Every end is handed on (`subscribeDriveEnded`), so Disconnect Bluetooth when
 * driving ends can let go of the board for the ends the climber or the clock
 * caused (`use-driving-ended-disconnect.ts`).
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
   * Put on board's timed drive (2.7, Stop driving after): how long it lasts after each
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
  /**
   * Put on board's timed drive ran out, its setting was turned to Right away,
   * or a crewmate's put-up ended it.
   */
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
 * Whether a timed drive ends because Settings › Board changed under it:
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
 * A timed drive past its end lights nothing, even while the watcher's
 * timer has not fired: Android pauses JS timers with the activity (#7038), so
 * the end is read off the wall clock at every pick, never trusted to a timer.
 * `DriveModeWatcher` still ends the drive and tidies the button.
 */
export function drivingAtPick(rendered: boolean, now = Date.now()): boolean {
  return rendered && !isDriveWindowDue(driveMode, now);
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

/** How a drive ended, as `subscribeDriveEnded` hands it on. */
export type DriveEnded = {
  reason: DriveModeExitReason;
  /**
   * The drive that ended, or null for a stop on this link while only Light the
   * board as I swipe drove (solo, no drive in this store).
   */
  drive: DriveModeState | null;
  /**
   * What letting go of the board must wait for, where something is still on
   * its way to the wall: Turn off all lights' write, or a crewmate's climb.
   * Called only by a listener that lets go. Null: nothing to wait for.
   */
  disconnectAfter: (() => Promise<void>) | null;
};

/** What the caller ending a drive knows about it. */
export type DriveEndOptions = {
  /** See `DriveEnded.disconnectAfter`. */
  disconnectAfter?: () => Promise<void>;
};

const endedListeners = new Set<(ended: DriveEnded) => void>();

function emitEnded(ended: DriveEnded): void {
  for (const listener of endedListeners) listener(ended);
}

/**
 * Every end of a drive, after the store has dropped it: a press on the frosted
 * button, the clock, a dropped link, a changed session, and the rest. For
 * Disconnect Bluetooth when driving ends, outside React.
 */
export function subscribeDriveEnded(listener: (ended: DriveEnded) => void): () => void {
  endedListeners.add(listener);
  return () => {
    endedListeners.delete(listener);
  };
}

/** A line the player speaks about a timed drive: its start, a swipe opening it up, its end. */
export type DriveAnnouncement = 'window_started' | 'window_opened_up' | 'window_ended';
/** The lines already said for one drive (by its start). A new drive starts empty. */
let claimedAnnouncements: { startedAt: number; said: Set<DriveAnnouncement> } | null = null;

/**
 * Whether this caller says `line` for the drive that started at `startedAt`:
 * true once per drive and line. Every mounted player (each tab's pane on the
 * phone split) watches the same drive, so only the first to claim it speaks.
 */
export function claimDriveAnnouncement(startedAt: number, line: DriveAnnouncement): boolean {
  if (claimedAnnouncements?.startedAt !== startedAt) claimedAnnouncements = { startedAt, said: new Set() };
  if (claimedAnnouncements.said.has(line)) return false;
  claimedAnnouncements.said.add(line);
  return true;
}

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
 * Stop driving after set to a time (or Until I stop): start arming. A fresh drive clears an earlier stop.
 * `windowMs` makes it a timed drive once live; omitted, it is open-ended.
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
  claimedAnnouncements = null;
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
 * A swipe or Light every climb during a timed drive: the drive goes on
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
export function exitDriveMode(reason: DriveModeExitReason, options: DriveEndOptions = {}): DriveModeState | null {
  const ended = driveMode;
  if (!ended) return null;
  driveMode = null;
  lastExitReason = reason;
  emit();
  reportEnded(ended, reason);
  emitEnded({ reason, drive: ended, disconnectAfter: options.disconnectAfter ?? null });
  return ended;
}

/**
 * The press on the frosted button (or Turn off all lights during a drive):
 * stop driving and keep the link. Swipes stay previews until the link drops,
 * solo with Light the board as I swipe on too. Handed on as a `stopped` end
 * even with no drive in this store, since the climber stopped driving all the
 * same; Disconnect Bluetooth when driving ends then lets go of the board.
 */
export function stopDrivingForLink(options: DriveEndOptions = {}): DriveModeState | null {
  const ended = driveMode;
  driveMode = null;
  if (ended) lastExitReason = 'stopped';
  if (ended || !stoppedForLink) {
    stoppedForLink = true;
    emit();
  }
  if (ended) reportEnded(ended, 'stopped');
  emitEnded({ reason: 'stopped', drive: ended, disconnectAfter: options.disconnectAfter ?? null });
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
 * - `window` — Put on board's timed drive: the frost with a clock, picks light
 *   until its time runs out.
 * - `driving` — an open-ended drive, the frost: picks light until stopped.
 */
export type DriveLightingMode = 'off' | 'arming' | 'window' | 'driving';

function lightingModeOf(drive: DriveModeState | null): DriveLightingMode {
  if (!drive) return 'off';
  if (drive.phase === 'arming') return 'arming';
  return drive.windowMs !== null ? 'window' : 'driving';
}

/** The lighting mode and, for a timed drive, when it ends. */
export type DriveLightingSnapshot = { mode: DriveLightingMode; endsAt: number | null };

/**
 * The seam for the Live Activity and the Android notification bridge (Step 3b):
 * read `{ mode, endsAt }` here on every `subscribeDriveMode` call. `endsAt` is
 * the timed drive's end, null outside one. A fresh object per call: read it in
 * a listener, never as a `useSyncExternalStore` snapshot.
 */
export function getDriveLightingSnapshot(): DriveLightingSnapshot {
  const mode = lightingModeOf(driveMode);
  return { mode, endsAt: mode === 'window' ? (driveMode?.expiresAt ?? null) : null };
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

/** Tests only: back to nobody driving, nothing stopped, no end listeners. */
export function resetDriveModeForTests(): void {
  driveMode = null;
  stoppedForLink = false;
  lastExitReason = null;
  claimedAnnouncements = null;
  endedListeners.clear();
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

/** Off, arming, a timed drive, or open-ended driving. Re-renders only when that word changes. */
export function useDriveLightingMode(): DriveLightingMode {
  return useSyncExternalStore(subscribe, readLightingMode, readLightingMode);
}

/**
 * The live timed drive's end, or null outside one.
 * A primitive, so its readers re-render on a renewal, never on a count alone.
 */
export function useDriveWindowExpiresAt(): number | null {
  return useSyncExternalStore(subscribe, readWindowExpiresAt, readWindowExpiresAt);
}

/** The timed drive's length, or null with no timed drive. */
export function useDriveWindowMs(): number | null {
  return useSyncExternalStore(subscribe, readWindowMs, readWindowMs);
}

/** A press on the frosted button stopped driving on this link. */
export function useDrivingStoppedForLink(): boolean {
  return useSyncExternalStore(subscribe, readStopped, readStopped);
}
