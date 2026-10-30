import { useSyncExternalStore } from 'react';

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
 */
export type DriveModePhase = 'arming' | 'live';

export type DriveModeState = {
  phase: DriveModePhase;
  /** The party session the drive started in, or null solo. A different session ends it. */
  sessionId: string | null;
  /** The board being driven, once known. */
  boardId: number | null;
  /** `Date.now()` when the swipe landed. */
  startedAt: number;
  /** Climbs lit while live, for Drive Mode Ended. */
  climbsLit: number;
};

/** Why driving ended, for Drive Mode Ended (#7113 PR 3). */
export type DriveModeExitReason =
  /** A press on the frosted button: the link stays, swipes go back to previews. */
  | 'stopped'
  /** This phone's link (or its hold on a wall with no lights) dropped. */
  | 'link_dropped'
  /** The connect the swipe started failed. */
  | 'connect_failed'
  /** Arming never reached the wall: nothing connected or lit in time. */
  | 'arming_timed_out'
  /** The climber joined, left or switched party sessions. */
  | 'session_changed'
  /** The board changed under a live drive. */
  | 'board_changed'
  | 'signed_out';

/**
 * How long arming may wait for the wall before it gives up. The Bluetooth scan
 * is 15 s; past twice that the swipe's connect is not coming, and an arming
 * drive left behind would keep the button from offering the swipe again.
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

/** A swipe on the wall button landed: start arming. A fresh drive clears an earlier stop. */
export function enterDriveMode({
  sessionId,
  boardId,
  now = Date.now(),
}: {
  sessionId: string | null;
  boardId: number | null;
  now?: number;
}): void {
  driveMode = { phase: 'arming', sessionId, boardId, startedAt: now, climbsLit: 0 };
  stoppedForLink = false;
  lastExitReason = null;
  emit();
}

/** The swipe's climb is lit on this phone's link: every change of climb lights from now on. */
export function markDriveLive({ boardId }: { boardId?: number | null } = {}): void {
  if (!driveMode) return;
  const nextBoardId = boardId ?? driveMode.boardId;
  if (driveMode.phase === 'live' && nextBoardId === driveMode.boardId) return;
  driveMode = { ...driveMode, phase: 'live', boardId: nextBoardId };
  emit();
}

/** One more climb went up while driving. */
export function noteDriveClimbLit(): void {
  if (driveMode?.phase !== 'live') return;
  driveMode = { ...driveMode, climbsLit: driveMode.climbsLit + 1 };
  emit();
}

/** End driving. Returns what ended, or null when nobody was driving. */
export function exitDriveMode(reason: DriveModeExitReason): DriveModeState | null {
  const ended = driveMode;
  if (!ended) return null;
  driveMode = null;
  lastExitReason = reason;
  emit();
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

/** The drive in progress, or null. */
export function useDriveMode(): DriveModeState | null {
  return useSyncExternalStore(subscribe, readDriveMode, readDriveMode);
}

/** The phase as the board control reads it. */
export function useDriveModePhase(): 'off' | DriveModePhase {
  return useSyncExternalStore(subscribe, readPhase, readPhase);
}

/** A press on the frosted button stopped driving on this link. */
export function useDrivingStoppedForLink(): boolean {
  return useSyncExternalStore(subscribe, readStopped, readStopped);
}
