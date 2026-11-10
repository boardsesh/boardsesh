// "Email me project news": the account's opt-in, its history, and the one
// query a future send script reads. See docs/project-news-email.md.

import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { ProjectNewsEmailConsent } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';

/** The primary pool or a transaction on it: both are a `PgDatabase`. */
type DrizzleExecutor = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Where an answer came from. `email_link` is the signed unsubscribe link. */
export type ProjectNewsEmailSource = 'web' | 'ios' | 'android' | 'email_link';

/**
 * Advisory-lock namespace for opt-in writes (ASCII "PNEW"). Two-int form so it
 * can't collide with another caller's single-int key; see push-tokens.ts.
 */
const PROJECT_NEWS_EMAIL_LOCK_NAMESPACE = 0x504e4557;

const events = dbSchema.userProjectNewsEmailEvents;

type LatestRow = { subscribed: boolean; decidedAt: Date };

/** Never answered reads as off: the opt-in is off until the climber turns it on. */
const NEVER_ANSWERED: ProjectNewsEmailConsent = { subscribed: false, decidedAt: null };

function toConsent(row: LatestRow | null): ProjectNewsEmailConsent {
  return row ? { subscribed: row.subscribed, decidedAt: row.decidedAt.toISOString() } : NEVER_ANSWERED;
}

/**
 * The newest row is the current answer. `id` is the order: rows are written
 * under a per-user lock, so the insert order is the order the answers landed.
 */
async function readLatest(executor: DrizzleExecutor, userId: string): Promise<LatestRow | null> {
  const [latest] = await executor
    .select({ subscribed: events.subscribed, decidedAt: events.decidedAt })
    .from(events)
    .where(eq(events.userId, userId))
    .orderBy(desc(events.id))
    .limit(1);
  return latest ?? null;
}

export async function readProjectNewsEmailConsent(
  userId: string,
  executor: DrizzleExecutor = db,
): Promise<ProjectNewsEmailConsent> {
  return toConsent(await readLatest(executor, userId));
}

export type SetProjectNewsEmailConsentResult = {
  consent: ProjectNewsEmailConsent;
  /** False when the account already held this answer, so nothing was written. */
  changed: boolean;
};

/**
 * Record an answer. A row is appended only when it changes the current answer,
 * so the history holds exactly the moments the climber opted in or out, and a
 * repeated tap or a second unsubscribe click writes nothing.
 *
 * `clock_timestamp()` rather than `now()`: a write that waited on the lock is
 * stamped when it ran, not when its transaction started.
 */
export async function setProjectNewsEmailConsent(
  userId: string,
  subscribed: boolean,
  source: ProjectNewsEmailSource,
): Promise<SetProjectNewsEmailConsentResult> {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(${PROJECT_NEWS_EMAIL_LOCK_NAMESPACE}, hashtext(${userId}))`,
    );
    const latest = await readLatest(transaction, userId);
    const current = latest?.subscribed ?? false;
    // Never answered and asked to switch off: there is nothing to withdraw, and
    // an unsubscribe click on an account that never opted in leaves no trace.
    if (current === subscribed) return { consent: toConsent(latest), changed: false };
    const [inserted] = await transaction
      .insert(events)
      .values({ userId, subscribed, source, decidedAt: sql`clock_timestamp()` })
      .returning({ subscribed: events.subscribed, decidedAt: events.decidedAt });
    return { consent: toConsent(inserted), changed: true };
  });
}

export type ProjectNewsRecipient = { userId: string; email: string; name: string | null };

/**
 * Who a project news send may go to: accounts whose newest answer is "on" AND
 * whose email is verified. Nobody else, in any country. The send script reads
 * this at send time, never a cached list, so an unsubscribe a minute earlier
 * holds. An account deletion cascades its rows away, so it drops out too.
 */
export async function selectProjectNewsRecipients(
  executor: Pick<DrizzleExecutor, 'select' | 'selectDistinctOn'> = db,
): Promise<ProjectNewsRecipient[]> {
  const latest = executor
    .selectDistinctOn([events.userId], { userId: events.userId, subscribed: events.subscribed })
    .from(events)
    .orderBy(events.userId, desc(events.id))
    .as('latest_project_news_answer');
  return executor
    .select({ userId: dbSchema.users.id, email: dbSchema.users.email, name: dbSchema.users.name })
    .from(latest)
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, latest.userId))
    .where(and(eq(latest.subscribed, true), isNotNull(dbSchema.users.emailVerified)))
    .orderBy(asc(dbSchema.users.id));
}
