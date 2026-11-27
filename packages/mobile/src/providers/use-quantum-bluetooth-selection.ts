import { useCallback, useContext } from 'react';
import { QUANTUM_MODELS, QUANTUM_RELEASED_MODELS } from '@boardsesh/board-constants/quantum';
import { QUANTUM_BOARD_FLAG } from '@boardsesh/board-config/visibility';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useFeatureFlag, useFeatureFlagsResolved } from './feature-flags-provider';
import { QueueSessionIdContext } from './queue/queue-contexts';

export function useQuantumBluetoothSelection(
  activeBoard: UserBoard | null | undefined,
  isBoardSelectionCurrent: () => boolean,
) {
  const flagEnabled = useFeatureFlag(QUANTUM_BOARD_FLAG) === true;
  const flagsResolved = useFeatureFlagsResolved();
  const session = useContext(QueueSessionIdContext);
  const selectedModelId =
    flagsResolved && flagEnabled && activeBoard?.boardType === 'quantum'
      ? (QUANTUM_RELEASED_MODELS.find((modelId) => {
          const model = QUANTUM_MODELS[modelId];
          return model.layoutId === activeBoard.layoutId && model.sizeId === activeBoard.sizeId;
        }) ?? null)
      : null;

  const readSessionRevision = session?.getSessionContextRevision;
  const sessionRevision = readSessionRevision?.();
  const isSessionLeavePending = session?.isSessionLeavePending;
  const isSelectionIntentCurrent = useCallback(
    () =>
      isBoardSelectionCurrent() && sessionRevision === readSessionRevision?.() && isSessionLeavePending?.() !== true,
    [isBoardSelectionCurrent, isSessionLeavePending, readSessionRevision, sessionRevision],
  );
  return {
    selectedModelId,
    isSelectionIntentCurrent,
    selectedBoardUuid: selectedModelId ? activeBoard?.uuid : null,
    preferredSerial: selectedModelId ? activeBoard?.serialNumber : undefined,
    sessionId: session?.sessionId ?? null,
    accountId: session?.accountId ?? null,
    getCurrentSessionId: session?.getCurrentSessionId,
    sessionContextReady: session === null || session.sessionAuthorityReady === true,
  };
}
