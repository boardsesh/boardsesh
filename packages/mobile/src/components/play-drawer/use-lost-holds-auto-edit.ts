import { useCallback, useRef } from 'react';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { canEditClimb } from '@boardsesh/create-climb-react';
import { climbEditedFromBroken } from '@boardsesh/analytics';
import type { Climb } from '@boardsesh/shared-schema';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { resolveClimbRenderBoard } from '../../lib/boards/climb-render-board';
import { getSprayWall, sprayWallViewerCanEditClimbs, SPRAY_BOARD_NAME } from '../../lib/spray/spray-wall-registry';
import { trackSprayEvent } from '../../lib/spray/spray-telemetry';
import { useCreateClimbNavigation, type DismissSurfaceAndWait } from '../create-climb/use-create-climb-navigation';
import { lostHoldsEditReadiness, type LostHoldsEditReadiness } from './use-lost-holds-edit-readiness';

/**
 * Everything the set-active routing rule reads (#5493). Plain values, so the
 * rule is a pure function a test can walk row by row.
 */
export type BrokenClimbActivation = {
  /** `Climb.missingHoldCount`; anything below 1 is an intact climb. */
  missingHoldCount: number | null | undefined;
  /** The board the climb resolves to is a spray wall. */
  isSprayClimb: boolean;
  /** The opener pinned a preview (or a crew browse), which never makes the climb current. */
  isPreview: boolean;
  /** The climb is the queue's current climb already: a reopen, not an activation. */
  isAlreadyCurrent: boolean;
  /** A crew is climbing together: a tap is a look, and the shared queue stays put. */
  isSharedSession: boolean;
  /** The climb belongs to a different board from the climber's own. */
  isOtherBoard: boolean;
  /** The player is already on screen (a sheet stacked over it): leaving it would lose their place. */
  playerOpen: boolean;
  /** The opener said no (`autoEditBroken: false`): playlist and circuit activation. */
  optedOut: boolean;
  /** `canEditClimb`: the setter, or a wall editor / collaborator. */
  viewerCanEdit: boolean;
  /** Whether the editor would open on something it can save. */
  readiness: LostHoldsEditReadiness;
};

/**
 * Setting a climb that lost holds active opens it in the editor — for someone
 * who can fix it, when the editor can save the fix (#5493). Everyone else, and
 * every case below, keeps today's behaviour: the player, with the banner.
 *
 * Each gate is about one surprise this must not cause:
 *  - not on a reopen (`isAlreadyCurrent`): the climb is current after the first
 *    route, so the bottom bar and a second tap open the player. That is what
 *    keeps a climber who backed out of the editor from being sent back in;
 *  - not for a preview or a crew session: neither makes the climb current;
 *  - not with the player already up: the climber is mid-session in it, and the
 *    banner's Edit is one tap away;
 *  - not for another board's climb: that one raises the switch-board prompt;
 *  - not when the opener opts out: "Play" on a playlist or circuit means climb
 *    it, and dropping the setter into the editor with a fresh queue behind it
 *    is not what that button promises;
 *  - not unless the editor can save (`readiness`): a stale wall, or a climb with
 *    nothing left, would open an editor that cannot finish the job.
 */
export function shouldAutoEditBrokenClimb(activation: BrokenClimbActivation): boolean {
  return (
    (activation.missingHoldCount ?? 0) > 0 &&
    activation.isSprayClimb &&
    !activation.isPreview &&
    !activation.isAlreadyCurrent &&
    !activation.isSharedSession &&
    !activation.isOtherBoard &&
    !activation.playerOpen &&
    !activation.optedOut &&
    activation.viewerCanEdit &&
    activation.readiness === 'ready'
  );
}

/** Same wall: board model and layout. A wall's angle is fixed and its size is the wall. */
function sameBoardModel(left: BoardConfig, right: BoardConfig): boolean {
  return left.boardName === right.boardName && left.layoutId === right.layoutId;
}

/** How long a just-routed climb swallows further opens of itself (a double tap). */
const AUTO_EDIT_IN_FLIGHT_MS = 1500;

type UseLostHoldsAutoEditArgs = {
  /** Who is signed in; null when nobody is. */
  currentUserId: string | null;
  /** Dismisses any root sheet the open came from (queue, board) before the editor presents. */
  dismissSourceSheets: DismissSurfaceAndWait;
};

export type LostHoldsAutoEditContext = {
  /** The opener passed `autoEditBroken: false`. */
  optedOut: boolean;
  /** The climber's own board, never a drawer override. */
  storedBoard: BoardConfig | null;
  /** The board the opener asked the drawer to show the climb on, if any. */
  boardOverride: BoardConfig | null | undefined;
  isPreview: boolean;
  isAlreadyCurrent: boolean;
  isSharedSession: boolean;
  playerOpen: boolean;
};

/**
 * The one interception point for set-active routing. `DrawerHostProvider`'s
 * `openPlayDrawer` asks this first; every list, queue-sheet, board-sheet and
 * suggestion tap that makes a climb current goes through there.
 *
 * Returns true when it took the open: the caller must then neither navigate to
 * the player nor apply the open target. The caller still owns making the climb
 * current.
 */
export function useLostHoldsAutoEdit({ currentUserId, dismissSourceSheets }: UseLostHoldsAutoEditArgs) {
  const { openEdit, resetActionGuard } = useCreateClimbNavigation({ dismissSourceSheet: dismissSourceSheets });
  const lastRoutedRef = useRef<{ climbUuid: string; atMs: number } | null>(null);

  const tryAutoEdit = useCallback(
    (climb: Climb, context: LostHoldsAutoEditContext): 'routed' | 'swallowed' | 'declined' => {
      const missingHoldCount = climb.missingHoldCount ?? 0;
      if (missingHoldCount <= 0 || !context.storedBoard) return 'declined';

      // A double tap lands here twice before the first route has re-rendered
      // anything; the second must not open the player over the editor sliding up.
      const lastRouted = lastRoutedRef.current;
      if (lastRouted && lastRouted.climbUuid === climb.uuid && Date.now() - lastRouted.atMs < AUTO_EDIT_IN_FLIGHT_MS) {
        return 'swallowed';
      }

      const board = resolveClimbRenderBoard(climb, context.storedBoard)?.boardConfig ?? context.storedBoard;
      const isSprayClimb = board.boardName === SPRAY_BOARD_NAME;
      const isOtherBoard =
        !sameBoardModel(board, context.storedBoard) ||
        (context.boardOverride != null && !sameBoardModel(context.boardOverride, context.storedBoard));
      const wall = isSprayClimb ? getSprayWall(board.layoutId) : null;
      const liveHoldIds = wall ? new Set(wall.holds.map((hold) => hold.id)) : null;
      const viewerCanEdit =
        getBoardCapabilities(board.boardName).climbCreation &&
        canEditClimb({
          climb,
          boardType: board.boardName,
          currentUserId,
          viewerCanEditClimbs: sprayWallViewerCanEditClimbs(board.boardName, board.layoutId),
          wallLayoutId: board.layoutId,
        });

      const shouldRoute = shouldAutoEditBrokenClimb({
        missingHoldCount,
        isSprayClimb,
        isPreview: context.isPreview,
        isAlreadyCurrent: context.isAlreadyCurrent,
        isSharedSession: context.isSharedSession,
        isOtherBoard,
        playerOpen: context.playerOpen,
        optedOut: context.optedOut,
        viewerCanEdit,
        readiness: isSprayClimb ? lostHoldsEditReadiness(climb.frames, missingHoldCount, liveHoldIds) : 'wall-stale',
      });
      if (!shouldRoute) return 'declined';

      lastRoutedRef.current = { climbUuid: climb.uuid, atMs: Date.now() };
      trackSprayEvent(climbEditedFromBroken({ lostHoldCount: missingHoldCount, source: 'set_active' }));
      // This hook lives as long as the host: each route is its own accepted action.
      resetActionGuard();
      openEdit(climb, board);
      return 'routed';
    },
    [currentUserId, openEdit, resetActionGuard],
  );

  return { tryAutoEdit };
}
