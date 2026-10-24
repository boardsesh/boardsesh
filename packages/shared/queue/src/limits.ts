// Protocol limits the client and the party backend have to agree on.

/**
 * Hard cap on the number of items the whole synced queue (History + Now + Up
 * next) may hold. The backend imports it in
 * `packages/backend/src/graphql/resolvers/queue/mutations.ts` and the
 * `joinSession` seed.
 *
 * F3 (docs/current-climb-outside-queue.md, section 5): outside
 * `QUEUE_NOW_SLOT_PERCENT`, a placement-less `setQueue` or seed longer than
 * this still THROWS (`parseArrayTolerant`). Inside it, or when the payload
 * carries `historyCount`, the server accepts up to 1,000 raw items and trims
 * the oldest History entries to fit; it throws only when Now + Up next alone
 * exceed the cap with a climb current. `addQueueItem` refuses with
 * `QUEUE_FULL` when Now + Up next already fill it.
 *
 * An append can still trip the throw by addition, which is why the bulk append
 * clamps against it before broadcasting.
 */
export const MAX_SYNCED_QUEUE_ITEMS = 500;
