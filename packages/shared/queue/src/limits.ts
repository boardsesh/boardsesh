// Protocol limits the client and the party backend have to agree on.

/**
 * Hard cap on the number of items a wholesale `Mutation.setQueue` payload may
 * carry. The backend enforces it in
 * `packages/backend/src/graphql/resolvers/queue/mutations.ts` —
 * `parseArrayTolerant(ClimbQueueItemSchema, rawQueue, 'queue', 500)` THROWS on a
 * longer array rather than truncating, so a client that lets the queue grow past
 * this wedges every later full-queue sync for that session.
 *
 * A replace can only trip it with a >500-climb payload; an append can trip it by
 * addition, which is why the bulk append clamps against it before broadcasting.
 *
 * The resolver still has the literal `500` inline — swapping it for this import
 * is tracked separately so a mobile change doesn't drag the backend suite along.
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
