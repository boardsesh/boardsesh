import { useCallback, useLayoutEffect, useRef } from 'react';
import type { BoardVisibilityConfig } from '@boardsesh/board-config/visibility';
import type { Climb } from '@boardsesh/queue';
import { isQuantumClimbRetired } from '../../db/queries/quantum-climb-retirement';
import { useIsBoardConfigVisible } from '../../hooks/use-board-visibility';
import { isClimbBoardAvailable, resolveClimbRenderBoard } from '../../lib/boards/climb-render-board';
import { getCredentialGeneration } from '../../lib/privacy/privacy-cache';
import type { BoardConfig } from '../../providers/drawer-host-provider';

export function isQuantumMiniPlayerClimb(climb: Climb, board: BoardConfig | null): boolean {
  return climb.boardType === 'quantum' || board?.boardName === 'quantum';
}

export function isMiniPlayerClimbAvailable(
  climb: Climb,
  board: BoardConfig | null,
  isBoardConfigVisible: (config: BoardVisibilityConfig) => boolean,
): boolean {
  if (!isQuantumMiniPlayerClimb(climb, board)) return true;
  if (!isClimbBoardAvailable(climb, board, isBoardConfigVisible)) return false;
  const renderBoard = resolveClimbRenderBoard(climb, board, { loadMissingSpray: false })?.boardConfig;
  return !!renderBoard && isBoardConfigVisible(renderBoard);
}

/**
 * Native controls and menus can retain a callback across a re-render. Check
 * the local marker on tap and recheck the committed target and rollout after
 * the lookup before dispatching a Quantum climb action.
 */
export function useRunMiniPlayerClimbAction(climb: Climb, board: BoardConfig | null) {
  const isBoardConfigVisible = useIsBoardConfigVisible();
  const quantum = isQuantumMiniPlayerClimb(climb, board);
  const available = !quantum || isMiniPlayerClimbAvailable(climb, board, isBoardConfigVisible);
  const generation = getCredentialGeneration();
  const currentClimb = useRef<{ uuid: string; board: BoardConfig | null; generation: number } | null>(null);
  useLayoutEffect(() => {
    if (!available || !quantum) return;
    currentClimb.current = { uuid: climb.uuid, board, generation };
    return () => {
      currentClimb.current = null;
    };
  }, [available, quantum, climb.uuid, board, generation]);

  return useCallback(
    (run: () => void) => {
      if (!quantum) {
        run();
        return;
      }
      const selection = currentClimb.current;
      if (
        !selection ||
        selection.uuid !== climb.uuid ||
        selection.board !== board ||
        selection.generation !== getCredentialGeneration()
      ) {
        return;
      }
      void isQuantumClimbRetired(climb.uuid)
        .then((retired) => {
          if (!retired && currentClimb.current === selection && generation === getCredentialGeneration()) run();
        })
        .catch(() => {
          // A failed local read leaves the action unconfirmed.
        });
    },
    [quantum, climb.uuid, board, generation],
  );
}
