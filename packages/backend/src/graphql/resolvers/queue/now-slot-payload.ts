import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import {
  capHistory,
  historyOf,
  isUpNextFull,
  normaliseHistoryCount,
  normaliseOrphanCurrent,
  MAX_SYNCED_QUEUE_ITEMS,
  type NowSlotState,
} from '@boardsesh/queue';

/**
 * The raw-item ceiling for a whole-queue payload (`setQueue`, the
 * `joinSession` seed) when the F3 caps apply. Still a memory guard; the cap on
 * what is stored is `MAX_SYNCED_QUEUE_ITEMS`, reached by trimming History
 * instead of throwing (docs/current-climb-outside-queue.md, section 5).
 */
export const MAX_RAW_PAYLOAD_ITEMS = 1000;

export class UpNextOverCapError extends Error {
  constructor(nowAndUpNextCount: number) {
    super(`Invalid queue: Now and Up next hold ${nowAndUpNextCount} climbs, over ${MAX_SYNCED_QUEUE_ITEMS}`);
    this.name = 'UpNextOverCapError';
  }
}

export type ComposedQueuePayload = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCount: number;
  /** A current climb that wasn't in the payload's queue was inserted at the line. */
  orphanInserted: boolean;
  trimmedCount: number;
};

/**
 * The line for a payload with nothing current and no `historyCount` (an old
 * phone's Undo, playlist replace or clear): just after the last payload entry
 * that is in the stored History, or 0 when the payload holds none. An Undo of
 * a History removal puts the line back: stored [B | C D] after A was removed,
 * payload [A B C D], line 2.
 */
export function deriveLineFromStoredHistory(
  payloadQueue: readonly ClimbQueueItem[],
  stored: NowSlotState<ClimbQueueItem> | null,
): number {
  if (!stored) return 0;
  const storedHistoryUuids = new Set(historyOf(stored).map((queueItem) => queueItem.uuid));
  for (let index = payloadQueue.length - 1; index >= 0; index--) {
    if (storedHistoryUuids.has(payloadQueue[index].uuid)) return index + 1;
  }
  return 0;
}

/**
 * Whether composing this payload needs the stored state: nothing current (or
 * a payload orphan) and no usable `historyCount`. Such a write must be
 * versioned and retried, so a crewmate's removal between the read and the
 * write can't leave the line one off (section 2, Redis).
 */
export function payloadNeedsStoredLine(
  payloadQueue: readonly ClimbQueueItem[],
  currentClimbQueueItem: ClimbQueueItem | null,
  historyCountInput: number | null,
): boolean {
  return normaliseHistoryCount(historyCountInput, payloadQueue, currentClimbQueueItem) === null;
}

/**
 * Turn a whole-queue payload into the state to store (sections 3 and 5):
 *
 * 1. The line: the current index when the current climb is in the payload;
 *    else the client's `historyCount`, clamped; else the derivation from the
 *    stored History.
 * 2. Invariant 1, at every percent: a current climb missing from the payload
 *    (an old solo snapshot) is inserted at that line, never cleared and never
 *    appended. A seed of only a current climb becomes `[current]`.
 * 3. With `capsApply`: History is trimmed (100 kept, trimmed at 125, and
 *    further while the array is over 500). With a climb current, Now and Up
 *    next alone over 500 throws; with nothing current the excess comes off
 *    the head of the array and the line moves down with it.
 */
export function composeQueuePayload(input: {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  historyCountInput: number | null;
  stored: NowSlotState<ClimbQueueItem> | null;
  capsApply: boolean;
}): ComposedQueuePayload {
  const { queue, currentClimbQueueItem, historyCountInput, stored, capsApply } = input;
  const line =
    normaliseHistoryCount(historyCountInput, queue, currentClimbQueueItem) ??
    deriveLineFromStoredHistory(queue, stored);
  const normalised = normaliseOrphanCurrent({ queue, currentClimbQueueItem, historyCount: line });

  if (!capsApply) {
    return {
      queue: normalised.queue,
      currentClimbQueueItem: normalised.currentClimbQueueItem,
      historyCount: normalised.historyCount,
      orphanInserted: normalised.normalised,
      trimmedCount: 0,
    };
  }

  const capped = capHistory(normalised, 0);
  let cappedQueue = capped.queue;
  let cappedLine = capped.historyCount;
  let trimmedCount = capped.trimmedCount;

  if (capped.currentClimbQueueItem) {
    if (isUpNextFull(capped, 0)) {
      throw new UpNextOverCapError(capped.queue.length - capped.historyCount);
    }
  } else if (cappedQueue.length > MAX_SYNCED_QUEUE_ITEMS) {
    const excess = cappedQueue.length - MAX_SYNCED_QUEUE_ITEMS;
    cappedQueue = cappedQueue.slice(excess);
    cappedLine = Math.max(cappedLine - excess, 0);
    trimmedCount += excess;
  }

  return {
    queue: cappedQueue,
    currentClimbQueueItem: capped.currentClimbQueueItem,
    historyCount: cappedLine,
    orphanInserted: normalised.normalised,
    trimmedCount,
  };
}
