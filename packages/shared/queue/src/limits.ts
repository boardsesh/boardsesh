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
