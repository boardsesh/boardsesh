// Follow a driving climber to the next board at their gym (#7076).
//
// A climber with a mixed queue at a gym (a Kilter and a MoonBoard side by side)
// presses Next while driving the MoonBoard and lands on a Kilter climb. The
// MoonBoard can't draw it. Before this, the wall stayed on the old climb and
// the player offered nothing; now the app moves to the Kilter and lights it,
// the same switch and connect a tap on Put on {board} runs, with no tap.
//
// Only when it can't surprise anyone:
//   - this phone holds a live link, so the climber is at a wall, driving it;
//   - no crewmate shares the session (in a crew the climb is shared, and moving
//     everyone's board on one person's Next is not this phone's call);
//   - the climb's board is another board at this gym that has lights;
//   - this phone has connected to that board before, so the connect looks for
//     a device it knows, out of sight (`quiet`): no picker, no alert. If the
//     board doesn't answer, the player is left on that board with Connect
//     board, one tap from trying again.
// Anything else leaves the player's Put on {board} to the climber.
//
// Only a change of current climb is followed, never a change of board: a
// climber who picks the MoonBoard by hand while the Kilter's link is still
// coming down must not be pulled back to the Kilter by the climb on screen.
//
// One move at a time. A climb that changes during a move is looked at once the
// move settles, so a climber who bounces back to the first board's climb is
// followed back there rather than stranded on the second.

import { useEffect, useRef, useState } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { findGymBoardToConnectForClimb, type ClimbBoardModel } from './gym-board-for-climb';
import type { ClimbBoardMove } from './climb-board-connect-context';
import { trackBoardConnectTapped } from '../analytics-board-connect';

export type GymBoardAutoFollowInput = {
  climb: ClimbBoardModel | null | undefined;
  activeBoard: UserBoard | null | undefined;
  gymBoards: ReadonlyArray<UserBoard> | null | undefined;
  /** This phone holds a live Bluetooth link. */
  connected: boolean;
  /** Another climber shares this session. */
  sharedSession: boolean;
  hasRememberedDeviceForBoard: (board: UserBoard) => boolean;
};

/** The board to follow the climber to, or null to leave it to them. Pure. */
export function resolveGymBoardAutoFollow({
  climb,
  activeBoard,
  gymBoards,
  connected,
  sharedSession,
  hasRememberedDeviceForBoard,
}: GymBoardAutoFollowInput): UserBoard | null {
  if (!connected || sharedSession) return null;
  const target = findGymBoardToConnectForClimb(climb, activeBoard, gymBoards);
  if (!target || target.hasLeds === false) return null;
  return hasRememberedDeviceForBoard(target) ? target : null;
}

export type UseGymBoardAutoFollowOptions = Omit<GymBoardAutoFollowInput, 'climb'> & {
  /** The current climb's uuid: a change is what's followed. */
  currentClimbUuid: string | null;
  /** The current climb, read when it changes. */
  getCurrentClimb: () => ClimbBoardModel | null;
  moveToClimbBoard: (climb: ClimbBoardModel | null) => Promise<ClimbBoardMove>;
  connectAfterBoardSwitch: (board: UserBoard, options: { quiet: true }) => Promise<boolean>;
};

export function useGymBoardAutoFollow({
  currentClimbUuid,
  getCurrentClimb,
  activeBoard,
  gymBoards,
  connected,
  sharedSession,
  hasRememberedDeviceForBoard,
  moveToClimbBoard,
  connectAfterBoardSwitch,
}: UseGymBoardAutoFollowOptions): void {
  const inFlightRef = useRef(false);
  // The last current climb looked at. Seeded with the climb on mount, so a
  // launch onto another board's climb is left to the climber.
  const lastEvaluatedClimbRef = useRef(currentClimbUuid);
  // Bumped when a move settles, so the climb is looked at once more.
  const [settledCount, setSettledCount] = useState(0);
  const latestRef = useRef({ getCurrentClimb, hasRememberedDeviceForBoard, moveToClimbBoard, connectAfterBoardSwitch });
  latestRef.current = { getCurrentClimb, hasRememberedDeviceForBoard, moveToClimbBoard, connectAfterBoardSwitch };

  useEffect(() => {
    if (inFlightRef.current || currentClimbUuid === lastEvaluatedClimbRef.current) return;
    lastEvaluatedClimbRef.current = currentClimbUuid;
    if (!currentClimbUuid) return;
    const latest = latestRef.current;
    const climb = latest.getCurrentClimb();
    const target = resolveGymBoardAutoFollow({
      climb,
      activeBoard,
      gymBoards,
      connected,
      sharedSession,
      hasRememberedDeviceForBoard: latest.hasRememberedDeviceForBoard,
    });
    if (!target) return;
    inFlightRef.current = true;
    void (async () => {
      try {
        const move = await latest.moveToClimbBoard(climb);
        if (move.kind !== 'switched') return;
        trackBoardConnectTapped({ surface: 'auto_follow', boardName: move.board.boardType, reconnect: true });
        await latest.connectAfterBoardSwitch(move.board, { quiet: true });
      } finally {
        inFlightRef.current = false;
        setSettledCount((count) => count + 1);
      }
    })();
  }, [currentClimbUuid, activeBoard, gymBoards, connected, sharedSession, settledCount]);
}
