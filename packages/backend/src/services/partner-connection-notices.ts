import type { PgBoss } from 'pg-boss';
import { PARTNER_CONNECTION_NOTICES_QUEUE } from '@boardsesh/db/job-queue-schema';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { oauthClient, partnerConnectionNotices, users } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { sendPartnerConnectionEmail } from '../email/partner-developer-email';
import { deliverableEmailSchema } from '../email/email-service';
import { logger } from '../utils/logger';

const CLAIM_LIFETIME_MS = 5 * 60 * 1000;
const BATCH_SIZE = 10;
type NoticeSender = typeof sendPartnerConnectionEmail;

/** SMTP runs outside a database transaction; a crash after sending can produce a harmless duplicate. */
export async function runPartnerConnectionNotices(send: NoticeSender = sendPartnerConnectionEmail): Promise<void> {
  const notices = await db.transaction(async (transaction) => {
    const selected = await transaction
      .select()
      .from(partnerConnectionNotices)
      .where(and(isNull(partnerConnectionNotices.deliveredAt), lte(partnerConnectionNotices.nextAttemptAt, new Date())))
      .orderBy(asc(partnerConnectionNotices.nextAttemptAt))
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });
    for (const notice of selected) {
      await transaction
        .update(partnerConnectionNotices)
        .set({ attempts: notice.attempts + 1, nextAttemptAt: new Date(Date.now() + CLAIM_LIFETIME_MS) })
        .where(
          and(
            eq(partnerConnectionNotices.connectionId, notice.connectionId),
            eq(partnerConnectionNotices.generation, notice.generation),
          ),
        );
    }
    return selected;
  });
  for (const notice of notices) {
    const identity = and(
      eq(partnerConnectionNotices.connectionId, notice.connectionId),
      eq(partnerConnectionNotices.generation, notice.generation),
    );
    const [account] = await db.select({ email: users.email }).from(users).where(eq(users.id, notice.userId));
    const [app] = await db
      .select({ name: oauthClient.name })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, notice.clientId));
    if (!account || !app || !deliverableEmailSchema.safeParse(account.email).success) {
      await db.update(partnerConnectionNotices).set({ deliveredAt: new Date() }).where(identity);
      continue;
    }
    try {
      await send(account.email, app.name ?? 'An app');
      await db.update(partnerConnectionNotices).set({ deliveredAt: new Date() }).where(identity);
    } catch (error) {
      // Count and error name only; SMTP errors may contain addresses or credentials.
      logger.warn('[PartnerConnectionNotice] Delivery failed; will retry', {
        attempt: notice.attempts + 1,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      const delayMs = Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(notice.attempts, 10));
      await db
        .update(partnerConnectionNotices)
        .set({ nextAttemptAt: new Date(Date.now() + delayMs) })
        .where(identity);
    }
  }
}

export async function startPartnerConnectionNotices(boss: PgBoss): Promise<void> {
  await boss.schedule(PARTNER_CONNECTION_NOTICES_QUEUE, '* * * * *', null, { tz: 'UTC' });
  await boss.work(PARTNER_CONNECTION_NOTICES_QUEUE, async () => {
    try {
      await runPartnerConnectionNotices();
    } catch {
      throw new Error('PARTNER_CONNECTION_NOTICE_FAILED');
    }
  });
}
