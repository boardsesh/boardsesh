import type { DriveModeStartedBy } from '@boardsesh/analytics';
import type { KeepLightingPlan } from '../../lib/keep-lighting';
import { enterDriveMode, exitDriveMode, getDriveMode, makeDriveOpenEnded } from './drive-mode-store';
import type { DriveStartOutcome } from './use-wall-control';
import type { WallControlModel } from './wall-control';

/** What starting a drive needs from the player, injected so the order can be tested. */
export type StartDriveInput = {
  /** The board control on screen: where a drive can start (`swipeAction`), whose board it is, and what it shows. */
  model: Pick<WallControlModel, 'swipeAction' | 'holder' | 'state'>;
  /** Another account's phone holds this board (presence), whatever the model shows. */
  wallHeldByOtherUser: boolean;
  /** The party session, or null solo. A drive ends when it changes. */
  sessionId: string | null;
  /** The board type on screen ('kilter', 'moonboard', ...), for Drive Mode Started / Ended. */
  boardType?: string | null;
  /** What started it: the swipe, Put on board (a timed or open-ended drive), or the screen-reader action / sheet row. */
  startedBy: DriveModeStartedBy;
  /** The climb on screen is a preview: it goes up first. */
  committing: boolean;
  /**
   * Put the preview up without the busy-wall question (`handleSetActive` with
   * `skipBusyWall`). False when nothing went up.
   */
  commit: () => boolean;
  /** This phone's Bluetooth link is up. */
  connected: boolean;
  /** Connect (the picker when no board is remembered). Resolves whether it linked. */
  connect: () => Promise<boolean>;
  /** Light the current climb: a reassert, clearing a Turn off all lights and the #4979 hold. */
  relight: () => void;
};

/**
 * Start driving the wall (#7113), in this order:
 *
 * 1. Refuse where the control offers no swipe or a drive is already on
 *    (`unavailable`). During Put on board's keep-lighting window the drive
 *    goes on with no end instead (`started`): the climb goes up first if it
 *    isn't lit, as below. Refuse where a
 *    crewmate holds the board (`held_by_crew`): their phone holds it, so there
 *    is no swipe on it by design (Put on board relays the climb to that
 *    phone). Nothing changes either way.
 * 2. Arm the drive.
 * 3. Put the climb on screen up when it is a preview, with no busy-wall
 *    question: the climber who drives never sees it. Nothing going up ends
 *    the drive (`commit_failed`).
 * 4. With the link up, light it. Otherwise connect, then light it; a connect
 *    that fails ends this drive (`connect_failed`), never a newer one.
 *
 * The drive goes live once this phone's link lights the climb, in
 * `DriveModeWatcher` at the app root, so closing the player mid-connect still
 * goes live.
 */
export function startDrive(input: StartDriveInput): DriveStartOutcome {
  if (input.model.swipeAction !== 'drive') return 'unavailable';
  // Read synchronously: two starts in one frame (a swipe and the screen-reader
  // action, or a double fire) both see a model rendered before either armed.
  const current = getDriveMode();
  if (current) {
    // A keep-lighting window (2.7): the swipe or Light every climb keeps every
    // pick lighting with no end. A climb on screen that isn't lit goes up too.
    if (current.phase !== 'live' || !makeDriveOpenEnded()) return 'unavailable';
    if (input.committing) input.commit();
    if (input.connected && input.model.state !== 'lit') input.relight();
    return 'started';
  }
  if (input.model.holder === 'crew' || input.wallHeldByOtherUser) return 'held_by_crew';
  enterDriveMode({
    sessionId: input.sessionId,
    boardId: null,
    boardType: input.boardType ?? null,
    startedBy: input.startedBy,
  });
  const startedAt = getDriveMode()?.startedAt ?? null;
  const endThisDrive = (reason: 'connect_failed' | 'commit_failed') => {
    if (getDriveMode()?.startedAt === startedAt) exitDriveMode(reason);
  };
  if (input.committing && !input.commit()) {
    endThisDrive('commit_failed');
    return 'unavailable';
  }
  if (input.connected) {
    input.relight();
    return 'started';
  }
  void input.connect().then(
    (connected) => {
      if (connected) input.relight();
      else endThisDrive('connect_failed');
    },
    () => endThisDrive('connect_failed'),
  );
  return 'started';
}

/**
 * Put on board's climb went up and its board family's setting keeps lighting
 * (2.7, `KeepLightingPlan`): arm a drive that, once the wall confirms the climb
 * lit, is a keep-lighting window (or, for Until I stop, an open-ended drive).
 * The press itself already put the climb up, through the busy-wall question in
 * a crew, so unlike `startDrive` this commits and connects nothing.
 *
 * Refuses (false) while a drive is on, or where another account's phone holds
 * the board: lighting stays one climb then.
 */
export function startKeepLighting({
  plan,
  sessionId,
  boardType = null,
  wallHeldByOtherUser,
}: {
  plan: KeepLightingPlan;
  sessionId: string | null;
  /** The board type on screen, for Drive Mode Started / Ended. */
  boardType?: string | null;
  wallHeldByOtherUser: boolean;
}): boolean {
  if (getDriveMode() || wallHeldByOtherUser) return false;
  enterDriveMode({
    sessionId,
    boardId: null,
    boardType,
    startedBy: 'tap',
    windowMs: plan.windowMs,
    windowSetting: plan.windowMs === null ? null : plan.setting,
  });
  return true;
}
