// Protocol limits the client and the party backend have to agree on.

/**
 * Hard cap on History + Up next in the synced queue. The climb on the wall is
 * extra (docs/current-climb-outside-queue.md, section 5), so the stored array
 * holds at most this + 1 entries with a climb current and this many with
 * nothing current. The backend reads it through `maxPayloadItems` in
 * `packages/backend/src/graphql/resolvers/queue/now-slot-payload.ts` (the
 * `setQueue` and `joinSession` raw guard) and through `isUpNextFull`
 * (`addQueueItem`, and the payload's Up next check).
 *
 * F3: outside `QUEUE_NOW_SLOT_PERCENT`, a placement-less `setQueue` or seed
 * longer than this + 1 (current climb in the payload) or this (otherwise)
 * still THROWS (`parseArrayTolerant`). Inside it, or when the payload carries
 * `historyCount`, the server accepts up to 1,000 raw items and trims the
 * oldest History entries to fit; it throws only when Up next alone exceeds
 * the cap. `addQueueItem` refuses with `QUEUE_FULL` when Up next already
 * fills it.
 *
 * An append can still trip the throw by addition, which is why the bulk append
 * clamps against it before broadcasting. `clampQueueAroundCurrent` below keeps
 * this many entries in all, the current climb included: stricter than the
 * server, so its payloads are never refused. It is the legacy-mode clamp, and
 * a pre-F3 server refuses 501 entries. In now-slot mode (the server probe said
 * the backend serves F3) phones clamp with `clampNowSlotPayload` in
 * `now-slot.ts` instead, which keeps the climb on the wall out of the count.
 */
export const MAX_SYNCED_QUEUE_ITEMS = 500;

/**
 * The part of a queue that a wholesale `Mutation.setQueue` can carry: at most
 * `max` items, in their order, always including the item at `anchorIndex` (the
 * current climb). The window keeps the anchor and as many items after it as
 * fit, then fills from before it when the anchor sits near the end. A plain
 * `slice(0, max)` would drop the current climb whenever it sits past row `max`.
 *
 * An `anchorIndex` outside the array keeps the first `max` items. A queue that
 * already fits comes back as the same array.
 */
export function clampQueueWindow<Item>(
  items: Item[],
  anchorIndex: number,
  max: number = MAX_SYNCED_QUEUE_ITEMS,
): Item[] {
  if (items.length <= max) return items;
  if (anchorIndex < 0 || anchorIndex >= items.length) return items.slice(0, max);
  const windowStart = Math.min(anchorIndex, items.length - max);
  return items.slice(windowStart, windowStart + max);
}

/**
 * {@link clampQueueWindow} anchored on the current climb, found by queue-item
 * uuid. For every wholesale `setQueue` payload: the local replace, the session
 * seed and its #3878 re-seed. No current climb keeps the first `max` items.
 */
export function clampQueueAroundCurrent<Item extends { uuid: string }>(
  items: Item[],
  currentItem: { uuid: string } | null | undefined,
  max: number = MAX_SYNCED_QUEUE_ITEMS,
): Item[] {
  if (items.length <= max) return items;
  const currentIndex = currentItem ? items.findIndex((item) => item.uuid === currentItem.uuid) : -1;
  return clampQueueWindow(items, currentIndex, max);
}
