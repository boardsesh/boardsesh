import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BoardVisibilityConfig } from '@boardsesh/board-config/visibility';
import type { Climb } from '@boardsesh/queue';
import { boardHidesWithdrawnClimbs } from '@boardsesh/offline-sync/withdrawn-climb';
import { isClimbWithdrawn } from '../db/queries/withdrawn-climb';
import { useIsBoardConfigVisible } from './use-board-visibility';
import { isClimbBoardAvailable, resolveClimbRenderBoard } from '../lib/boards/climb-render-board';
import { CLIMB_QUERY_KEY } from '../lib/graphql/query-keys';
import { getCredentialGeneration } from '../lib/privacy/privacy-cache';
import type { BoardConfig } from '../providers/drawer-host-provider';

export function isQuantumClimbTarget(climb: Climb, board: BoardConfig | null): boolean {
  return climb.boardType === 'quantum' || board?.boardName === 'quantum';
}

/** The climb's own board or the board it is opened on hides withdrawn climbs, so a tombstone can stand in for it. */
function mayBeWithdrawnTarget(climb: Climb, board: BoardConfig | null): boolean {
  return boardHidesWithdrawnClimbs(climb.boardType) || boardHidesWithdrawnClimbs(board?.boardName);
}

/**
 * A tap on this climb must be re-checked before it runs: Quantum's rollout can
 * hide its board ({@link isClimbTargetBoardAvailable}), and a board that hides
 * withdrawn climbs can hold a tombstone for it. Any other climb runs at once.
 */
export function climbTargetNeedsTapCheck(climb: Climb, board: BoardConfig | null): boolean {
  return isQuantumClimbTarget(climb, board) || mayBeWithdrawnTarget(climb, board);
}

function isClimbTargetBoardAvailable(
  climb: Climb,
  board: BoardConfig | null,
  isBoardConfigVisible: (config: BoardVisibilityConfig) => boolean,
): boolean {
  if (!isQuantumClimbTarget(climb, board)) return true;
  if (!isClimbBoardAvailable(climb, board, isBoardConfigVisible)) return false;
  const renderBoard = resolveClimbRenderBoard(climb, board, { loadMissingSpray: false })?.boardConfig;
  return !!renderBoard && isBoardConfigVisible(renderBoard);
}

/**
 * The visible state uses the local catalogue and refreshes with the same
 * climb queries a board pull invalidates. Unknown or undownloaded rows have
 * no withdrawal tombstone.
 */
export function useClimbTargetAvailable(climb: Climb | null, board: BoardConfig | null): boolean {
  const isBoardConfigVisible = useIsBoardConfigVisible();
  const boardAvailable = useMemo(
    () => !climb || isClimbTargetBoardAvailable(climb, board, isBoardConfigVisible),
    [climb, board, isBoardConfigVisible],
  );
  const withdrawableClimbUuid = climb && boardAvailable && mayBeWithdrawnTarget(climb, board) ? climb.uuid : undefined;
  const withdrawal = useQuery({
    queryKey: [...CLIMB_QUERY_KEY, 'withdrawn', withdrawableClimbUuid],
    queryFn: () => isClimbWithdrawn(withdrawableClimbUuid!),
    enabled: withdrawableClimbUuid !== undefined,
    networkMode: 'always',
  });
  return boardAvailable && (!withdrawableClimbUuid || (withdrawal.data === false && !withdrawal.isError));
}

/**
 * Native controls and menus can retain a callback across a re-render. For a
 * climb that {@link climbTargetNeedsTapCheck}, check the local tombstone on tap
 * and recheck the committed target and rollout after the lookup before
 * dispatching the action.
 */
export function useRunAvailableClimbAction(climb: Climb | null, board: BoardConfig | null) {
  const isBoardConfigVisible = useIsBoardConfigVisible();
  const needsTapCheck = climb !== null && climbTargetNeedsTapCheck(climb, board);
  const available = useMemo(
    () => !climb || isClimbTargetBoardAvailable(climb, board, isBoardConfigVisible),
    [climb, board, isBoardConfigVisible],
  );
  const climbUuid = climb?.uuid;
  const climbBoardType = climb?.boardType;
  const climbLayoutId = climb?.layoutId;
  const generation = getCredentialGeneration();
  const currentClimb = useRef<{
    uuid: string;
    board: BoardConfig | null;
    boardType: typeof climbBoardType;
    layoutId: typeof climbLayoutId;
    generation: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!available || !needsTapCheck || !climbUuid) return;
    currentClimb.current = { uuid: climbUuid, board, boardType: climbBoardType, layoutId: climbLayoutId, generation };
    return () => {
      currentClimb.current = null;
    };
  }, [available, needsTapCheck, climbUuid, climbBoardType, climbLayoutId, board, generation]);

  return useCallback(
    (run: () => void) => {
      if (!needsTapCheck) {
        run();
        return;
      }
      const selection = currentClimb.current;
      if (
        !selection ||
        selection.uuid !== climbUuid ||
        selection.board !== board ||
        selection.boardType !== climbBoardType ||
        selection.layoutId !== climbLayoutId ||
        selection.generation !== getCredentialGeneration()
      ) {
        return;
      }
      void isClimbWithdrawn(selection.uuid)
        .then((withdrawn) => {
          if (!withdrawn && currentClimb.current === selection && generation === getCredentialGeneration()) run();
        })
        .catch(() => {
          // A failed local read leaves the action unconfirmed.
        });
    },
    [needsTapCheck, climbUuid, climbBoardType, climbLayoutId, board, generation],
  );
}
