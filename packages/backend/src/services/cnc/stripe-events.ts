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

/** Claim inside the webhook transaction, recovering unfinished legacy claims. */
export async function claimStripeEvent(
  eventId: string,
  eventType: string,
  executor: CncOrdersExecutor,
): Promise<boolean> {
  const inserted = await executor
    .insert(cncStripeEvents)
    .values({ id: eventId, type: eventType })
    .onConflictDoNothing()
    .returning({ id: cncStripeEvents.id });
  if (inserted.length > 0) return true;
  // UPDATE locks the row. A concurrent delivery rechecks processedAt after
  // the first transaction commits, and cannot claim already-completed work.
  const recovered = await executor
    .update(cncStripeEvents)
    .set({ type: eventType })
    .where(and(eq(cncStripeEvents.id, eventId), isNull(cncStripeEvents.processedAt)))
    .returning({ id: cncStripeEvents.id });
  return recovered.length > 0;
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
