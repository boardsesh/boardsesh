import { useEffect } from 'react';
import { hapticSuccess } from '../../lib/haptics';
import { enterDriveMode, exitDriveMode, getDriveMode, markDriveLive, type DriveModePhase } from './drive-mode-store';
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
 * 1. Refuse where the control offers no swipe (`unavailable`), or where a
 *    crewmate holds the board (`needs_handoff`): Aurora and MoonBoard boxes
 *    stop advertising once linked, so taking it needs their phone to let go
 *    first. Nothing changes either way.
 * 2. Arm the drive.
 * 3. Put the climb on screen up when it is a preview, with no busy-wall
 *    question: the climber who drives never sees it.
 * 4. With the link up, light it. Otherwise connect, then light it; a connect
 *    that fails ends this drive (`connect_failed`), never a newer one.
 *
 * The drive goes live once this phone's link lights the climb
 * (`useDriveGoesLive`).
 */
export function startDrive(input: StartDriveInput): DriveStartOutcome {
  if (input.model.swipeAction !== 'drive') return 'unavailable';
  if (input.model.holder === 'crew' || input.wallHeldByOtherUser) return 'needs_handoff';
  enterDriveMode({ sessionId: input.sessionId, boardId: null });
  const startedAt = getDriveMode()?.startedAt ?? null;
  const endThisDrive = () => {
    if (getDriveMode()?.startedAt === startedAt) exitDriveMode('connect_failed');
  };
  if (input.committing && !input.commit()) {
    endThisDrive();
    return 'unavailable';
  }
  if (input.connected) {
    input.relight();
    return 'started';
  }
  void input.connect().then(
    (connected) => {
      if (connected) input.relight();
      else endThisDrive();
    },
    () => endThisDrive(),
  );
  return 'started';
}

/**
 * An arming drive goes live once the climb on screen is lit on this phone's
 * link (`lit`), with a success buzz: from then on every change of climb lights
 * the wall.
 */
export function useDriveGoesLive(phase: 'off' | DriveModePhase, lit: boolean): void {
  useEffect(() => {
    if (phase !== 'arming' || !lit) return;
    markDriveLive();
    hapticSuccess();
  }, [phase, lit]);
}
