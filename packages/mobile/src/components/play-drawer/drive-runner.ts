import { enterDriveMode, exitDriveMode, getDriveMode } from './drive-mode-store';
import type { DriveStartOutcome } from './use-wall-control';
import type { WallControlModel } from './wall-control';

/** What starting a drive needs from the player, injected so the order can be tested. */
export type StartDriveInput = {
  /** The board control on screen: where a drive can start (`swipeAction`) and whose board it is. */
  model: Pick<WallControlModel, 'swipeAction' | 'holder'>;
  /** Another account's phone holds this board (presence), whatever the model shows. */
  wallHeldByOtherUser: boolean;
  /** The party session, or null solo. A drive ends when it changes. */
  sessionId: string | null;
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
 *    (`unavailable`), or where a
 *    crewmate holds the board (`needs_handoff`): Aurora and MoonBoard boxes
 *    stop advertising once linked, so taking it needs their phone to let go
 *    first. Nothing changes either way.
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
  if (getDriveMode()) return 'unavailable';
  if (input.model.holder === 'crew' || input.wallHeldByOtherUser) return 'needs_handoff';
  enterDriveMode({ sessionId: input.sessionId, boardId: null });
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
