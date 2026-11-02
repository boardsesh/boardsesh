import { useLayoutEffect } from 'react';
import { historyLine, type ClimbQueueItem, type QueueAction, type QueueClimbReadTarget } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { climbToQueueItem, isClimbResolved } from '../../lib/climb-to-queue-item';
import type { QueueClimbReads, QueueClimbReadDemand } from './use-queue-climb-reads';

type UseQueueResolveClimbsParams = {
  activeBoard: UserBoard | null | undefined;
  queue: ClimbQueueItem[];
  /** F3 now-slot mode: the line while nothing is current; null in legacy mode. */
  historyCount?: number | null;
  currentClimbQueueItem?: ClimbQueueItem | null;
  credentialGeneration?: number;
  climbReads: QueueClimbReads;
  dispatch: React.Dispatch<QueueAction>;
};

/** Reauthorize thin local references without changing list order or climbed angles. */
export function useQueueResolveClimbs({
  activeBoard,
  queue,
  historyCount = null,
  currentClimbQueueItem,
  credentialGeneration,
  climbReads,
  dispatch,
}: UseQueueResolveClimbsParams): void {
  useLayoutEffect(() => {
    const demands: QueueClimbReadDemand[] = [];
    if (activeBoard) {
      const { boardType, layoutId, angle } = activeBoard;
      // History keeps its climbed-at angle: everything before the current climb,
      // or before the line while nothing is current (F3 now-slot mode; 0 in
      // legacy mode, so nothing is frozen there, as before).
      const historyEnd = historyLine({ queue, currentClimbQueueItem: currentClimbQueueItem ?? null, historyCount });
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
      queue.forEach((item, index) => consider(item, 'queue', index < historyEnd ? item.climb.angle : angle));
      // The current representation may be mirrored independently of its queue slot.
      if (currentClimbQueueItem) consider(currentClimbQueueItem, 'current', angle);
    }
    climbReads.register('resolve', demands);
    return () => climbReads.unregister('resolve');
  }, [queue, historyCount, currentClimbQueueItem, activeBoard, dispatch, credentialGeneration, climbReads]);
}
