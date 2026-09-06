import { and, eq, isNull } from 'drizzle-orm';
import { cncStripeEvents } from '@boardsesh/db/schema';
import { db } from '../../db/client';
import type { CncOrdersExecutor } from './orders';

/**
 * The webhook's idempotency gate.
 *
 * Stripe retries a delivery it did not get a 2xx for, and can deliver the same
 * event twice without any retry at all. Doing that safely is a uniqueness
 * constraint, not application logic: the handler inserts the event id first and
 * only acts if the insert actually took. Two concurrent deliveries of the same
 * event race on the primary key, and exactly one of them wins — a
 * read-then-write would let both through.
 */

/**
 * Claim an event for processing.
 *
 * Returns true when this process owns the event and should act on it, false
 * when it is a redelivery of one already claimed. The row is written before
 * any side effect, so "we started handling this" is durable even if the
 * process dies half way through.
 */
export async function claimStripeEvent(eventId: string, eventType: string): Promise<boolean> {
  const inserted = await db
    .insert(cncStripeEvents)
    .values({ id: eventId, type: eventType })
    .onConflictDoNothing()
    .returning({ id: cncStripeEvents.id });
  return inserted.length > 0;
}

/**
 * Stamp an event as fully handled, and record which order it moved.
 *
 * `orderId` is null for an event we deliberately ignored — an unpaid session,
 * an order we could not resolve, a type we do not act on. It is still marked
 * processed: "handled" here means "will never be acted on again", not "changed
 * something".
 *
 * The handler passes its open transaction as `executor` so this stamp and the
 * order transition it describes commit together: a stamp that survived a
 * rolled-back transition would tell every redelivery there was nothing left to
 * do, stranding a paid order in `pending_payment`.
 */
export async function markStripeEventProcessed(
  eventId: string,
  orderId: number | null,
  executor: CncOrdersExecutor = db,
): Promise<void> {
  await executor
    .update(cncStripeEvents)
    .set({ orderId, processedAt: new Date() })
    .where(eq(cncStripeEvents.id, eventId));
}

/**
 * Give a claimed event back after the handler failed.
 *
 * Without this, a handler that threw would answer 500 (so Stripe retries) while
 * its claim row makes every retry look like a duplicate — the order would sit
 * unpaid forever with no further deliveries able to fix it.
 *
 * `processed_at IS NULL` in the WHERE means this can only ever undo a claim
 * that never finished, never one that succeeded. A process that is *killed*
 * mid-handler never reaches this call, and the null-`processed_at` row it
 * leaves behind is exactly the "started and died" trace the table was designed
 * to keep.
 */
export async function releaseStripeEvent(eventId: string): Promise<void> {
  await db.delete(cncStripeEvents).where(and(eq(cncStripeEvents.id, eventId), isNull(cncStripeEvents.processedAt)));
}
