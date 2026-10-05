import { useEffect, useRef } from 'react';
import type { ClimbQueueItem, QueueAction } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { offlineAwareRequest } from '../../lib/graphql/offline-request';
import { GET_CLIMB, type GetClimbQueryResponse } from '@boardsesh/graphql/operations';
import { climbToQueueItem, isClimbResolved } from '../../lib/climb-to-queue-item';
import { getPrivacyRevocationGeneration } from '../../lib/privacy/privacy-cache';

type UseQueueResolveClimbsParams = {
  activeBoard: UserBoard | null | undefined;
  queue: ClimbQueueItem[];
  currentClimbQueueItem?: ClimbQueueItem | null;
  privacyRevocationGeneration?: number;
  dispatch: React.Dispatch<QueueAction>;
};

/** Reauthorize thin local references without changing list order or climbed angles. */
export function useQueueResolveClimbs({
  activeBoard,
  queue,
  currentClimbQueueItem,
  privacyRevocationGeneration,
  dispatch,
}: UseQueueResolveClimbsParams): void {
  const inFlight = useRef(new Map<string, symbol>());
  useEffect(() => {
    if (!activeBoard) return;
    const generation = getPrivacyRevocationGeneration();
    const { boardType, layoutId, sizeId, setIds, angle } = activeBoard;
    const currentIndex = currentClimbQueueItem
      ? queue.findIndex((item) => item.uuid === currentClimbQueueItem.uuid)
      : -1;
    const items =
      currentClimbQueueItem && !queue.some((item) => item.uuid === currentClimbQueueItem.uuid)
        ? [...queue, currentClimbQueueItem]
        : queue;
    const requests = new Map<string, { climbUuid: string; angle: number; items: ClimbQueueItem[] }>();
    items.forEach((item, index) => {
      const climb = item.climb;
      if (!climb?.uuid || isClimbResolved(climb)) return;
      // A cross-board reference lacks the complete size/set scope. Keep it thin
      // until its board is active; never relabel it as this board's climb.
      if ((climb.boardType && climb.boardType !== boardType) || (climb.layoutId && climb.layoutId !== layoutId)) return;
      const targetAngle = index < currentIndex ? climb.angle : angle;
      const key = JSON.stringify([climb.uuid, targetAngle]);
      if (inFlight.current.has(key)) return;
      const existing = requests.get(key);
      if (existing) existing.items.push(item);
      else requests.set(key, { climbUuid: climb.uuid, angle: targetAngle, items: [item] });
    });
    if (!requests.size) return;
    const token = Symbol('queue-resolution');
    for (const key of requests.keys()) inFlight.current.set(key, token);
    let cancelled = false;
    void Promise.all(
      [...requests].map(async ([key, request]) => {
        try {
          const response = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, {
            boardName: boardType,
            layoutId,
            sizeId,
            setIds,
            angle: request.angle,
            climbUuid: request.climbUuid,
          });
          if (
            cancelled ||
            generation !== getPrivacyRevocationGeneration() ||
            !response.climb ||
            !isClimbResolved(response.climb)
          )
            return;
          for (const item of request.items) {
            const resolved = climbToQueueItem(response.climb, { uuid: item.uuid, suggested: item.suggested }).climb;
            dispatch({
              type: 'DELTA_REPLACE_QUEUE_ITEM',
              payload: {
                uuid: item.uuid,
                item: { ...item, climb: { ...resolved, mirrored: item.climb.mirrored } },
              },
            });
          }
        } catch {
          // A denied or offline reference stays in its slot without copied details.
        } finally {
          if (inFlight.current.get(key) === token) inFlight.current.delete(key);
        }
      }),
    );
    return () => {
      cancelled = true;
      for (const key of requests.keys()) {
        if (inFlight.current.get(key) === token) inFlight.current.delete(key);
      }
    };
  }, [queue, currentClimbQueueItem, activeBoard, dispatch, privacyRevocationGeneration]);
}
