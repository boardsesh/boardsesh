import { trackBoardHandoffRequested } from '../../lib/analytics-wall-control';
import type { BoardReleaseOutcome } from './board-handoff-store';
import { enterDriveMode, exitDriveMode, getDriveMode, type DriveModeExitReason } from './drive-mode-store';
import type { DriveStartOutcome } from './use-wall-control';
import type { WallControlModel } from './wall-control';

/**
 * Taking a crewmate's board (#7113 PR 4): what the cooperative hand-off needs.
 * Aurora and MoonBoard boxes stop advertising once linked and Android refuses a
 * second phone, so this phone asks theirs to let go, waits for presence to show
 * the board free, and only then connects.
 */
export type HandoffInput = {
  /** The crewmate presence names as the holder: the account asked to let go. */
  holderUserId: string;
  /**
   * `requestBoardHandoff`: `asked` the holder was asked, `free` nobody holds it
   * now, `refused` the server said no or the request never reached it.
   */
  request: () => Promise<'asked' | 'free' | 'refused'>;
  /** Resolves once presence shows `holderUserId` gone, or after 12 s. */
  waitForRelease: (holderUserId: string) => Promise<BoardReleaseOutcome>;
  /**
   * Connect for the hand-off: the ordinary connect path with the relay
   * suppression lifted, since presence can still read the board as theirs for
   * a beat. Read at call time, never from the render that started the swipe.
   */
  connect: () => Promise<boolean>;
  /** Say "Couldn't reach the board": the hand-off timed out or was refused. */
  onFailed: () => void;
};

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
  /**
   * The hand-off for a crewmate's board. Without it (an anonymous holder, an
   * older caller) a crewmate's board still answers `needs_handoff`.
   */
  handoff?: HandoffInput | null;
};

/**
 * Start driving the wall (#7113), in this order:
 *
 * 1. Refuse where the control offers no swipe or a drive is already on
 *    (`unavailable`), or where a crewmate holds the board and there is no
 *    hand-off to ask them with (`needs_handoff`). Nothing changes either way.
 * 2. Arm the drive.
 * 3. Put the climb on screen up when it is a preview, with no busy-wall
 *    question: the climber who drives never sees it. Nothing going up ends
 *    the drive (`commit_failed`).
 * 4. With the link up, light it. Otherwise connect, then light it; a connect
 *    that fails ends this drive (`connect_failed`), never a newer one.
 *    On a crewmate's board (#7113 PR 4) the connect waits for the hand-off:
 *    ask their phone to let go, wait up to 12 s for presence to show the board
 *    free, then connect. A refusal ends the drive `handoff_refused` and says
 *    "Couldn't reach the board". No release in 12 s tries one plain connect
 *    anyway (presence can carry a stale holder); only if that fails too does
 *    the drive end `handoff_timed_out` with the same words.
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
  const crewHolds = input.model.holder === 'crew' || input.wallHeldByOtherUser;
  // A virtual hold on a wall with no lights has no radio to hand over.
  const handoff = crewHolds && input.model.holder === 'crew' ? (input.handoff ?? null) : null;
  if (crewHolds && !handoff) return 'needs_handoff';
  enterDriveMode({ sessionId: input.sessionId, boardId: null });
  const startedAt = getDriveMode()?.startedAt ?? null;
  const isThisDrive = () => getDriveMode()?.startedAt === startedAt;
  const endThisDrive = (reason: DriveModeExitReason) => {
    if (isThisDrive()) exitDriveMode(reason);
  };
  if (input.committing && !input.commit()) {
    endThisDrive('commit_failed');
    return 'unavailable';
  }
  if (handoff) {
    void runHandoff(handoff, input, { isThisDrive, endThisDrive });
    return 'started';
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

async function runHandoff(
  handoff: HandoffInput,
  input: StartDriveInput,
  drive: { isThisDrive: () => boolean; endThisDrive: (reason: DriveModeExitReason) => void },
): Promise<void> {
  const inSession = input.sessionId !== null;
  const connect = async () => {
    try {
      return await handoff.connect();
    } catch {
      return false;
    }
  };
  let asked: 'asked' | 'free' | 'refused';
  try {
    asked = await handoff.request();
  } catch {
    asked = 'refused';
  }
  if (!drive.isThisDrive()) return;
  if (asked === 'refused') {
    trackBoardHandoffRequested({ outcome: 'refused', inSession });
    drive.endThisDrive('handoff_refused');
    handoff.onFailed();
    return;
  }
  const released = asked === 'free' ? 'released' : await handoff.waitForRelease(handoff.holderUserId);
  if (released === 'cancelled' || !drive.isThisDrive()) return;
  trackBoardHandoffRequested({ outcome: released, inSession });
  if (released === 'released') {
    if (await connect()) input.relight();
    else drive.endThisDrive('connect_failed');
    return;
  }
  // No release in 12 s. Presence can be wrong: a writer key left behind by a
  // drop whose disconnect report never went out lives up to 12 h. So try one
  // plain connect: against a box that is still linked the scan fails
  // harmlessly within 15 s. Only that failure says "Couldn't reach the board".
  if (await connect()) {
    input.relight();
    return;
  }
  // The watcher may have ended the drive already when the connect settled
  // (`connect_failed`); a newer drive is left alone.
  const current = getDriveMode();
  if (current !== null && !drive.isThisDrive()) return;
  drive.endThisDrive('handoff_timed_out');
  handoff.onFailed();
}
