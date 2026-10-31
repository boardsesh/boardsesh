import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import { isCurrentSupporter } from './supporter-status';

/**
 * Whether an account is currently a supporter, whatever it chose for public
 * credit. For internal triage (the bug-report issue label), never for anything
 * a viewer sees: the public tag also needs `show_publicly`.
 *
 * Never throws. A failed lookup answers false and is logged, so a database
 * hiccup costs a label, not the bug report.
 */
export async function isAccountCurrentSupporter(userId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const [row] = await db
      .select({
        stripeSubscriptionId: dbSchema.stripeSupporters.stripeSubscriptionId,
        subscriptionStatus: dbSchema.stripeSupporters.subscriptionStatus,
        creditUntil: dbSchema.stripeSupporters.creditUntil,
      })
      .from(dbSchema.stripeSupporters)
      .where(eq(dbSchema.stripeSupporters.userId, userId))
      .limit(1);
    return isCurrentSupporter(row, now);
  } catch (error) {
    logger.error('[support] supporter lookup for triage failed', { userId, error });
    return false;
  }
}
