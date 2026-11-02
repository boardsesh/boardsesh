import { useMemo } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { LastPick } from '../../lib/last-pick-store';
import type { BoardConfig } from '../play-drawer/play-drawer-types';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useGymBoards } from '../../lib/graphql/hooks/use-gym-boards';
import { findGymBoardToConnectForClimb, gymBoardButtonName } from '../../lib/boards/gym-board-for-climb';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useWallClimb } from '../play-drawer/use-wall-climb';
import { resolvePickBoard } from './pick-board';

/**
 * What the MiniPlayer's bulb is while the bar shows the climber's last pick
 * (owner decision A). No extra marking: the bulb says whether the pick is lit.
 *
 * - `lit` — the wall shows the pick through a live link (this phone's, a
 *   crewmate's, or a wall with no lights held here): the bar's usual bulb.
 * - `putOnBoard` — anything else the wall can light: a tap opens the player on
 *   the pick and presses Put on board there. `gymBoardName` names another
 *   board at this gym that draws it ("Put on MoonBoard"): the press moves there.
 * - `none` — a climb this wall can't light, with no board at the gym to walk
 *   to: the player shows its switch-board scrim and offers no board control,
 *   so the bar offers none either.
 */
export type PickBulb = { kind: 'lit' } | { kind: 'putOnBoard'; gymBoardName: string | null } | { kind: 'none' };

// One object per answer, so a re-resolve with the same answer hands the bar the same value.
const LIT: PickBulb = { kind: 'lit' };
const PUT_ON_BOARD: PickBulb = { kind: 'putOnBoard', gymBoardName: null };
const NONE: PickBulb = { kind: 'none' };

export type PickBulbInputs = {
  pick: LastPick;
  /**
   * A live link the board's state can be read from. Presence alone is not one:
   * an Aurora or MoonBoard box keeps its LEDs after a disconnect (QA #147), but
   * the bar's usual bulb would then connect, and the connect lights the queue's
   * current climb rather than the pick. The player's wall button knows that
   * case (`on_wall_unlinked`), so the pick's tap goes there.
   */
  linked: boolean;
  /** The climb board presence names as lit, or null. */
  wallClimbUuid: string | null;
  /** The stored active board (`useDrawerHost().boardConfig`). */
  activeBoardConfig: BoardConfig | null;
  activeBoard: Pick<UserBoard, 'uuid' | 'boardType' | 'layoutId'> | null | undefined;
  gymBoards: ReadonlyArray<UserBoard> | null | undefined;
};

export function resolvePickBulb({
  pick,
  linked,
  wallClimbUuid,
  activeBoardConfig,
  activeBoard,
  gymBoards,
}: PickBulbInputs): PickBulb {
  const { renderBoard, boardMismatch, climbBoardMismatch } = resolvePickBoard(pick, activeBoardConfig);
  if (boardMismatch || climbBoardMismatch) {
    // As the player: only a board at this gym that draws the climb is
    // somewhere to put it (Put on {board}); anything else is the scrim.
    const gymBoard =
      climbBoardMismatch && renderBoard
        ? findGymBoardToConnectForClimb(
            { boardType: renderBoard.boardName, layoutId: renderBoard.layoutId },
            activeBoard,
            gymBoards,
          )
        : null;
    return gymBoard ? { kind: 'putOnBoard', gymBoardName: gymBoardButtonName(gymBoard, gymBoards) } : NONE;
  }
  if (linked && wallClimbUuid !== null && wallClimbUuid === pick.item.climb.uuid) return LIT;
  return PUT_ON_BOARD;
}

/**
 * {@link resolvePickBulb} for the bar. Null while the bar shows the queue's
 * current climb. The gym roster is only asked for while a pick shows.
 */
export function usePickBulb(pick: LastPick | null): PickBulb | null {
  const wallClimb = useWallClimb();
  const { localConnected, holderIsAuthoritative, wallHeldLocally } = useBoardConnectionState();
  const { boardConfig } = useDrawerHost();
  const { data: activeBoard } = useActiveBoard();
  const { data: gymBoards } = useGymBoards(pick ? (activeBoard?.gymUuid ?? null) : null);
  const linked = localConnected || holderIsAuthoritative || wallHeldLocally;
  const wallClimbUuid = wallClimb.uuid;
  return useMemo(
    () =>
      pick
        ? resolvePickBulb({ pick, linked, wallClimbUuid, activeBoardConfig: boardConfig, activeBoard, gymBoards })
        : null,
    [pick, linked, wallClimbUuid, boardConfig, activeBoard, gymBoards],
  );
}
