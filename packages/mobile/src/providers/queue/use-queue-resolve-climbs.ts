import { useEffect, useRef } from 'react';
import type { ClimbQueueItem, QueueAction } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { offlineAwareRequest } from '../../lib/graphql/offline-request';
import { GET_CLIMB, type GetClimbQueryResponse } from '../../lib/graphql/operations';
import { climbToQueueItem, isClimbResolved } from '../../lib/climb-to-queue-item';
import { getPrivacyRevocationGeneration } from '../../lib/privacy/privacy-cache';

type UseQueueResolveClimbsParams = {
  activeBoard: UserBoard | null | undefined;
  queue: ClimbQueueItem[];
  currentClimbQueueItem?: ClimbQueueItem | null;
  privacyRevocationGeneration?: number;
  dispatch: React.Dispatch<QueueAction>;
};

/** One climb read the queue is waiting on, and the slots it fills. */
type WantedRead = { climbUuid: string; angle: number; items: ClimbQueueItem[] };

/**
 * How long an applied answer keeps its read from being sent again. React can
 * run an older commit's effect after a newer answer was dispatched, and that
 * run still sees the slot thin; the answer is already on its way into state.
 * Past this, a slot that is still thin was not fixed by the answer, and asking
 * again is right.
 */
const APPLIED_ANSWER_GRACE_MS = 2000;

/**
 * Reauthorize thin local references without changing list order or climbed angles.
 *
 * A saved queue comes back as references only (`sanitizeQueueSnapshot`), so
 * every launch resolves the whole queue through here, and each answer changes
 * `queue` and re-runs the effect. A read is therefore identified by what it
 * asks for, not by the run that sent it: a run sends only the reads nobody has
 * sent yet, and an answer is applied to whichever slots want that read when it
 * lands. Tying a read to its run instead made every answer throw away the
 * others still on the wire and send them again: 112 reads to restore a queue of
 * 15, where 15 will do.
 */
export function useQueueResolveClimbs({
  activeBoard,
  queue,
  currentClimbQueueItem,
  privacyRevocationGeneration,
  dispatch,
}: UseQueueResolveClimbsParams): void {
  // Reads on the wire (`pending`), and reads whose answer was just applied
  // (the time it was). Outlives an effect run on purpose; see above.
  const sent = useRef(new Map<string, 'pending' | number>());
  // What the queue wants as of the latest run. An answer nothing wants any more
  // (the slot left the queue, was resolved, moved to another angle, or belongs
  // to another board or privacy generation) is dropped when it lands.
  const wanted = useRef(new Map<string, WantedRead>());

  useEffect(
    () => () => {
      wanted.current = new Map();
    },
    [],
  );

  useEffect(() => {
    if (!activeBoard) {
      wanted.current = new Map();
      return;
    }
    const generation = getPrivacyRevocationGeneration();
    const { boardType, layoutId, sizeId, setIds, angle } = activeBoard;
    const currentIndex = currentClimbQueueItem
      ? queue.findIndex((item) => item.uuid === currentClimbQueueItem.uuid)
      : -1;
    const items =
      currentClimbQueueItem && !queue.some((item) => item.uuid === currentClimbQueueItem.uuid)
        ? [...queue, currentClimbQueueItem]
        : queue;
    const requests = new Map<string, WantedRead>();
    items.forEach((item, index) => {
      const climb = item.climb;
      if (!climb?.uuid || isClimbResolved(climb)) return;
      // A cross-board reference lacks the complete size/set scope. Keep it thin
      // until its board is active; never relabel it as this board's climb.
      if ((climb.boardType && climb.boardType !== boardType) || (climb.layoutId && climb.layoutId !== layoutId)) return;
      const targetAngle = index < currentIndex ? climb.angle : angle;
      // Everything the read's answer depends on. A change to any of it is a
      // different read, so an answer to the old one finds nothing waiting.
      const key = JSON.stringify([generation, boardType, layoutId, sizeId, setIds, climb.uuid, targetAngle]);
      const existing = requests.get(key);
      if (existing) existing.items.push(item);
      else requests.set(key, { climbUuid: climb.uuid, angle: targetAngle, items: [item] });
    });
    wanted.current = requests;

    // An applied answer whose slot no longer asks for it has done its job.
    for (const [key, state] of sent.current) {
      if (state !== 'pending' && !requests.has(key)) sent.current.delete(key);
    }

    for (const [key, request] of requests) {
      const state = sent.current.get(key);
      if (state === 'pending') continue;
      if (state !== undefined && Date.now() - state < APPLIED_ANSWER_GRACE_MS) continue;
      sent.current.set(key, 'pending');
      let applied = false;
      void (async () => {
        try {
          const response = await offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, {
            boardName: boardType,
            layoutId,
            sizeId,
            setIds,
            angle: request.angle,
            climbUuid: request.climbUuid,
          });
          // Read the slots now, not the ones this run saw: the queue may have
          // been rebuilt since, and a slot keeps its newest `mirrored`.
          const waiting = wanted.current.get(key);
          if (
            !waiting ||
            generation !== getPrivacyRevocationGeneration() ||
            !response.climb ||
            !isClimbResolved(response.climb)
          )
            return;
          applied = true;
          for (const item of waiting.items) {
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
          // An answer that filled its slots keeps the read marked until a run
          // sees them filled. Anything else frees it: a slot still thin is
          // asked for again the next time the queue, the board or the privacy
          // generation changes.
          if (applied) sent.current.set(key, Date.now());
          else sent.current.delete(key);
        }
      })();
    }
  }, [queue, currentClimbQueueItem, activeBoard, dispatch, privacyRevocationGeneration]);
}
