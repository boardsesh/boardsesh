import type { PgBoss } from 'pg-boss';
import { PARTNER_CONNECTION_NOTICES_QUEUE } from '@boardsesh/db/job-queue-schema';
import { and, asc, eq, gte, isNull, lt, lte, or } from 'drizzle-orm';
import {
  oauthClient,
  partnerConnectionNotices,
  PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS,
  users,
} from '@boardsesh/db/schema/auth';
import { db, type Database } from '../db/client';
import { sendPartnerConnectionEmail } from '../email/partner-developer-email';
import { deliverableEmailSchema } from '../email/email-service';
import { logger } from '../utils/logger';

const CLAIM_LIFETIME_MS = 5 * 60 * 1000;
const BATCH_SIZE = 10;
const PRUNE_BATCH_SIZE = 1000;
export const PARTNER_CONNECTION_NOTICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type NoticeSender = typeof sendPartnerConnectionEmail;

/** Keep pending mail durable; age out only delivered notices and exhausted retries. */
export async function prunePartnerConnectionNotices(database: Database = db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PARTNER_CONNECTION_NOTICE_RETENTION_MS);
  return database.transaction(async (transaction) => {
    const settled = await transaction
      .select({ connectionId: partnerConnectionNotices.connectionId, generation: partnerConnectionNotices.generation })
      .from(partnerConnectionNotices)
      .where(
        or(
          lt(partnerConnectionNotices.deliveredAt, cutoff),
          and(
            isNull(partnerConnectionNotices.deliveredAt),
            gte(partnerConnectionNotices.attempts, PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS),
            lt(partnerConnectionNotices.nextAttemptAt, cutoff),
          ),
        ),
      )
      .orderBy(asc(partnerConnectionNotices.createdAt), asc(partnerConnectionNotices.connectionId))
      .limit(PRUNE_BATCH_SIZE)
      .for('update', { skipLocked: true });
    if (settled.length === 0) return 0;
    await transaction
      .delete(partnerConnectionNotices)
      .where(
        or(
          ...settled.map((notice) =>
            and(
              eq(partnerConnectionNotices.connectionId, notice.connectionId),
              eq(partnerConnectionNotices.generation, notice.generation),
            ),
          ),
        ),
      );
    return settled.length;
  });
}

/** SMTP runs outside a database transaction; a crash after sending can produce a harmless duplicate. */
export async function runPartnerConnectionNotices(send: NoticeSender = sendPartnerConnectionEmail): Promise<void> {
  await prunePartnerConnectionNotices();
  const notices = await db.transaction(async (transaction) => {
    const selected = await transaction
      .select()
      .from(partnerConnectionNotices)
      .where(
        and(
          isNull(partnerConnectionNotices.deliveredAt),
          lt(partnerConnectionNotices.attempts, PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS),
          lte(partnerConnectionNotices.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(asc(partnerConnectionNotices.nextAttemptAt))
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });
    const claimUntil = new Date(Date.now() + CLAIM_LIFETIME_MS);
    for (const notice of selected) {
      await transaction
        .update(partnerConnectionNotices)
        .set({ nextAttemptAt: claimUntil })
        .where(
          and(
            eq(partnerConnectionNotices.connectionId, notice.connectionId),
            eq(partnerConnectionNotices.generation, notice.generation),
          ),
        );
    }
    return selected.map((notice) => ({ ...notice, nextAttemptAt: claimUntil }));
  });
  for (const notice of notices) {
    const identity = and(
      eq(partnerConnectionNotices.connectionId, notice.connectionId),
      eq(partnerConnectionNotices.generation, notice.generation),
      eq(partnerConnectionNotices.nextAttemptAt, notice.nextAttemptAt),
      isNull(partnerConnectionNotices.deliveredAt),
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
    } catch (error) {
      // Count and error name only; SMTP errors may contain addresses or credentials.
      const willRetry = notice.attempts + 1 < PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS;
      logger.warn('[PartnerConnectionNotice] Delivery failed', {
        attempt: notice.attempts + 1,
        willRetry,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      const delayMs = Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(notice.attempts, 10));
      await db
        .update(partnerConnectionNotices)
        .set({
          attempts: notice.attempts + 1,
          nextAttemptAt: new Date(Date.now() + (willRetry ? delayMs : 0)),
        })
        .where(identity);
      continue;
    }
    await db
      .update(partnerConnectionNotices)
      .set({ deliveredAt: new Date(), attempts: notice.attempts + 1 })
      .where(identity);
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
