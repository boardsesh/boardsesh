import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { GraphQLError } from 'graphql';
import {
  capHistory,
  historyAndUpNextCount,
  historyLine,
  historyOf,
  isUpNextFull,
  lineAfterDelta,
  normaliseHistoryCount,
  normaliseOrphanCurrent,
  MAX_SYNCED_QUEUE_ITEMS,
  QUEUE_FULL,
  upNextOf,
  type NowSlotState,
} from '@boardsesh/queue';

/**
 * The raw-item ceiling for a whole-queue payload (`setQueue`, the
 * `joinSession` seed) when the F3 caps apply. Still a memory guard; the cap on
 * what is stored is `MAX_SYNCED_QUEUE_ITEMS` History + Up next entries plus
 * the climb on the wall, reached by trimming History instead of throwing
 * (docs/current-climb-outside-queue.md, section 5).
 */
export const MAX_RAW_PAYLOAD_ITEMS = 1000;

function uuidOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { uuid } = value as { uuid?: unknown };
  return typeof uuid === 'string' ? uuid : null;
}

/**
 * The `maxLength` for `parseArrayTolerant` on a whole-queue payload, read from
 * the raw input before any item is validated. With the caps:
 * {@link MAX_RAW_PAYLOAD_ITEMS}. Without them (outside the percent, no line):
 * today's 500, plus one when the payload's current climb is in the payload
 * queue. The climb on the wall doesn't count toward the cap (section 5), so a
 * room stored at 501 entries with a climb current is written back by an old
 * phone as is instead of being refused. 501 entries with nothing current, or
 * with a current climb that isn't in the queue, are still refused.
 */
export function maxPayloadItems(rawQueue: unknown, rawCurrentClimbQueueItem: unknown, capsApply: boolean): number {
  if (capsApply) return MAX_RAW_PAYLOAD_ITEMS;
  const currentUuid = uuidOf(rawCurrentClimbQueueItem);
  const holdsCurrent =
    currentUuid !== null && Array.isArray(rawQueue) && rawQueue.some((rawItem) => uuidOf(rawItem) === currentUuid);
  return MAX_SYNCED_QUEUE_ITEMS + (holdsCurrent ? 1 : 0);
}

/**
 * A whole-queue payload whose Up next alone is over `MAX_SYNCED_QUEUE_ITEMS`
 * (History is trimmed first, and the climb on the wall doesn't count).
 * Carries the same `extensions.code` as `addQueueItem`'s rejection
 * (`QUEUE_FULL`), so a client can tell it apart from a malformed payload.
 */
export class UpNextOverCapError extends GraphQLError {
  constructor(upNextCount: number) {
    super(`Invalid queue: Up next holds ${upNextCount} climbs, over ${MAX_SYNCED_QUEUE_ITEMS}`, {
      extensions: { code: QUEUE_FULL },
    });
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
 *    further while History + Up next is over 500; the climb on the wall is
 *    extra). Up next is never trimmed: when Up next alone is over 500 (a climb
 *    current or not) the payload is rejected with {@link UpNextOverCapError},
 *    as today's 500 check did. Stored: at most 501 entries with a climb
 *    current, 500 without.
 * 4. Without `capsApply`, the payload is stored as sent. {@link maxPayloadItems}
 *    already held it to 501 entries with its current climb in it and 500
 *    otherwise, so an orphan inserted into a 500-item payload is the extra
 *    Now entry and nothing is trimmed. Only merge survivors can push History +
 *    Up next past 500; the oldest History entries go, so the phone's next
 *    placement-less `setQueue` isn't rejected. With no History to trim it is
 *    stored over the cap (a percent-0 residual, section 5).
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
    const overflow = historyAndUpNextCount(normalised) - MAX_SYNCED_QUEUE_ITEMS;
    const trimmedCount = overflow > 0 ? Math.min(overflow, historyLine(normalised)) : 0;
    return {
      queue: normalised.queue.slice(trimmedCount),
      currentClimbQueueItem: normalised.currentClimbQueueItem,
      historyCount: lineAfterDelta(normalised, { kind: 'trim', count: trimmedCount }),
      orphanInserted: normalised.normalised,
      trimmedCount,
    };
  }

  // After the trim, anything still over the cap is Now and Up next: History
  // goes first, all of it if needed.
  const capped = capHistory(normalised, 0);
  if (isUpNextFull(capped, 0)) {
    throw new UpNextOverCapError(upNextOf(capped).length);
  }

  return {
    queue: capped.queue,
    currentClimbQueueItem: capped.currentClimbQueueItem,
    historyCount: capped.historyCount,
    orphanInserted: normalised.normalised,
    trimmedCount: capped.trimmedCount,
  };
}
