import { useLayoutEffect } from 'react';
import type { ClimbQueueItem, QueueAction, QueueClimbReadTarget } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { climbToQueueItem, isClimbResolved } from '../../lib/climb-to-queue-item';
import type { QueueClimbReads, QueueClimbReadDemand } from './use-queue-climb-reads';

type UseQueueResolveClimbsParams = {
  activeBoard: UserBoard | null | undefined;
  queue: ClimbQueueItem[];
  currentClimbQueueItem?: ClimbQueueItem | null;
  privacyRevocationGeneration?: number;
  climbReads: QueueClimbReads;
  dispatch: React.Dispatch<QueueAction>;
};

/** Reauthorize thin local references without changing list order or climbed angles. */
export function useQueueResolveClimbs({
  activeBoard,
  queue,
  currentClimbQueueItem,
  privacyRevocationGeneration,
  climbReads,
  dispatch,
}: UseQueueResolveClimbsParams): void {
  useLayoutEffect(() => {
    const demands: QueueClimbReadDemand[] = [];
    if (activeBoard) {
      const { boardType, layoutId, angle } = activeBoard;
      const currentIndex = currentClimbQueueItem
        ? queue.findIndex((item) => item.uuid === currentClimbQueueItem.uuid)
        : -1;
      const consider = (item: ClimbQueueItem, role: QueueClimbReadTarget['role'], targetAngle: number) => {
        const climb = item.climb;
        if (!climb?.uuid || isClimbResolved(climb)) return;
        // Cross-board references have no complete size/set scope yet.
        if (
          (climb.boardType && climb.boardType !== boardType) ||
          (climb.layoutId != null && climb.layoutId !== layoutId)
        )
          return;
        const target: QueueClimbReadTarget = { role, uuid: item.uuid, expectedClimb: climb, angle: targetAngle };
        demands.push({
          climbUuid: climb.uuid,
          angle: targetAngle,
          expectedClimb: climb,
          targetKey: JSON.stringify([role, item.uuid]),
          apply: (resolvedClimb) =>
            dispatch({
              type: 'HYDRATE_CLIMBS',
              payload: {
                climb: climbToQueueItem(resolvedClimb, { uuid: item.uuid }).climb,
                targets: [target],
                boardType,
                layoutId,
                activeAngle: angle,
              },
            }),
        });
      };
      queue.forEach((item, index) => consider(item, 'queue', index < currentIndex ? item.climb.angle : angle));
      // The current representation may be mirrored independently of its queue slot.
      if (currentClimbQueueItem) consider(currentClimbQueueItem, 'current', angle);
    }
    climbReads.register('resolve', demands);
    return () => climbReads.unregister('resolve');
  }, [queue, currentClimbQueueItem, activeBoard, dispatch, privacyRevocationGeneration, climbReads]);
}
