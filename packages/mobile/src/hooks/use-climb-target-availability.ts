import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BoardVisibilityConfig } from '@boardsesh/board-config/visibility';
import type { Climb } from '@boardsesh/queue';
import { isQuantumClimbRetired } from '../db/queries/quantum-climb-retirement';
import { useIsBoardConfigVisible } from './use-board-visibility';
import { isClimbBoardAvailable, resolveClimbRenderBoard } from '../lib/boards/climb-render-board';
import { CLIMB_QUERY_KEY } from '../lib/graphql/query-keys';
import { getCredentialGeneration } from '../lib/privacy/privacy-cache';
import type { BoardConfig } from '../providers/drawer-host-provider';

export function isQuantumClimbTarget(climb: Climb, board: BoardConfig | null): boolean {
  return climb.boardType === 'quantum' || board?.boardName === 'quantum';
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
 * no retirement marker.
 */
export function useClimbTargetAvailable(climb: Climb | null, board: BoardConfig | null): boolean {
  const isBoardConfigVisible = useIsBoardConfigVisible();
  const boardAvailable = useMemo(
    () => !climb || isClimbTargetBoardAvailable(climb, board, isBoardConfigVisible),
    [climb, board, isBoardConfigVisible],
  );
  const quantumClimbUuid = climb && boardAvailable && isQuantumClimbTarget(climb, board) ? climb.uuid : undefined;
  const retirement = useQuery({
    queryKey: [...CLIMB_QUERY_KEY, 'quantumRetirement', quantumClimbUuid],
    queryFn: () => isQuantumClimbRetired(quantumClimbUuid!),
    enabled: quantumClimbUuid !== undefined,
    networkMode: 'always',
  });
  return boardAvailable && (!quantumClimbUuid || (retirement.data === false && !retirement.isError));
}

/**
 * Native controls and menus can retain a callback across a re-render. Check
 * the local marker on tap and recheck the committed target and rollout after
 * the lookup before dispatching a Quantum climb action.
 */
export function useRunAvailableClimbAction(climb: Climb | null, board: BoardConfig | null) {
  const isBoardConfigVisible = useIsBoardConfigVisible();
  const quantum = climb !== null && isQuantumClimbTarget(climb, board);
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
    if (!available || !quantum || !climbUuid) return;
    currentClimb.current = { uuid: climbUuid, board, boardType: climbBoardType, layoutId: climbLayoutId, generation };
    return () => {
      currentClimb.current = null;
    };
  }, [available, quantum, climbUuid, climbBoardType, climbLayoutId, board, generation]);

  return useCallback(
    (run: () => void) => {
      if (!quantum) {
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
      void isQuantumClimbRetired(selection.uuid)
        .then((retired) => {
          if (!retired && currentClimb.current === selection && generation === getCredentialGeneration()) run();
        })
        .catch(() => {
          // A failed local read leaves the action unconfirmed.
        });
    },
    [quantum, climbUuid, climbBoardType, climbLayoutId, board, generation],
  );
}
