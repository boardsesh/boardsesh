import { desc, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { AnalyticsConsent, ConnectionContext, SetAnalyticsConsentInput } from '@boardsesh/shared-schema';
import { isAnalyticsConsentChoice, isConsentSource } from '@boardsesh/consent';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { SetAnalyticsConsentInputSchema } from '../../../validation/schemas';

/** The primary pool or a transaction on it: both are a `PgDatabase`. */
type DrizzleExecutor = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Advisory-lock namespace for consent writes (ASCII "CNST"). Two-int form so it
 * can't collide with another caller's single-int key; see push-tokens.ts.
 */
const ANALYTICS_CONSENT_LOCK_NAMESPACE = 0x434e5354;

/**
 * A climber answers this once per device and again only when they change their
 * mind, so a handful a minute is already generous. Bounds an append-only table
 * against a looping client.
 */
const SET_ANALYTICS_CONSENT_RATE_LIMIT = 20;

type ConsentEventRow = Pick<dbSchema.UserAnalyticsConsentEvent, 'analytics' | 'version' | 'source' | 'decidedAt'>;

function toAnalyticsConsent(row: ConsentEventRow): AnalyticsConsent {
  // The table's CHECK constraints make both of these unreachable; the guards
  // narrow `text` to the wire unions without a cast.
  if (!isAnalyticsConsentChoice(row.analytics) || !isConsentSource(row.source)) {
    throw new Error('user_analytics_consent_events row holds a value outside its CHECK constraint');
  }
  return {
    analytics: row.analytics,
    version: row.version,
    source: row.source,
    decidedAt: row.decidedAt.toISOString(),
  };
}

const consentColumns = {
  analytics: dbSchema.userAnalyticsConsentEvents.analytics,
  version: dbSchema.userAnalyticsConsentEvents.version,
  source: dbSchema.userAnalyticsConsentEvents.source,
  decidedAt: dbSchema.userAnalyticsConsentEvents.decidedAt,
};

/**
 * The account's current answer: the newest row. {@link nextDecidedAt} keeps a
 * user's rows at least 1 ms apart, so `id` only breaks a tie for rows written
 * some other way (a manual fix), in insert order.
 */
async function readLatestConsent(executor: DrizzleExecutor, userId: string): Promise<ConsentEventRow | null> {
  const [latest] = await executor
    .select(consentColumns)
    .from(dbSchema.userAnalyticsConsentEvents)
    .where(eq(dbSchema.userAnalyticsConsentEvents.userId, userId))
    .orderBy(desc(dbSchema.userAnalyticsConsentEvents.decidedAt), desc(dbSchema.userAnalyticsConsentEvents.id))
    .limit(1);
  return latest ?? null;
}

/**
 * Whether a grant should give way to the answer the account already holds.
 *
 * A grant is the only answer that can be stale in a way that matters: a device
 * that last synced before the climber said "No thanks" elsewhere must not turn
 * tracking back on. A grant must echo the exact server stamp the client saw;
 * a made-up future stamp cannot stand in for reading the account's answer.
 * When the client saw none, an existing grant may be recorded again, but a
 * denial wins. A denial is never dropped: withdrawing must always work.
 *
 * The ISO echo is exact: {@link nextDecidedAt} stores whole
 * milliseconds and keeps each user's rows at least 1 ms apart, so the ISO string
 * a client echoes back names exactly one row.
 */
export function grantIsStale(latest: ConsentEventRow | null, basedOnDecidedAt: string | null | undefined): boolean {
  if (latest === null) return false;
  if (basedOnDecidedAt === null || basedOnDecidedAt === undefined) return latest.analytics !== 'granted';
  return latest.decidedAt.toISOString() !== basedOnDecidedAt;
}

/**
 * The server stamp for a new row: the database clock read after the lock
 * (`clock_timestamp()`, not the transaction-start `now()`, so a write that
 * waited on the lock is not dated before the write it waited for), truncated to
 * whole milliseconds, and at least 1 ms after the user's previous row. The
 * result rises strictly in write order, and a millisecond ISO string round-trips
 * through a client to exactly the stored value.
 */
function nextDecidedAt(userId: string) {
  const consentEvents = dbSchema.userAnalyticsConsentEvents;
  return sql`date_trunc('milliseconds', GREATEST(
    clock_timestamp(),
    (SELECT max(${consentEvents.decidedAt}) + interval '1 millisecond' FROM ${consentEvents} WHERE ${consentEvents.userId} = ${userId})
  ))`;
}

/**
 * Append one answer, compare-and-set for grants. Runs under a per-user
 * transaction-scoped advisory lock so two devices answering at once can't both
 * read the same "latest" and interleave.
 */
export async function setAnalyticsConsentForUser(
  userId: string,
  input: SetAnalyticsConsentInput,
): Promise<AnalyticsConsent> {
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(${ANALYTICS_CONSENT_LOCK_NAMESPACE}, hashtext(${userId}))`,
    );

    if (input.analytics === 'granted') {
      const latest = await readLatestConsent(transaction, userId);
      if (latest !== null && grantIsStale(latest, input.basedOnDecidedAt)) {
        return toAnalyticsConsent(latest);
      }
    }

    const [inserted] = await transaction
      .insert(dbSchema.userAnalyticsConsentEvents)
      .values({
        userId,
        analytics: input.analytics,
        version: input.version,
        source: input.source,
        decidedAt: nextDecidedAt(userId),
      })
      .returning(consentColumns);
    return toAnalyticsConsent(inserted);
  });
}

/** Read the account answer without caching, including when it changes during a request. */
export async function readAnalyticsConsentForUser(userId: string): Promise<AnalyticsConsent | null> {
  const latest = await readLatestConsent(db, userId);
  return latest ? toAnalyticsConsent(latest) : null;
}

export const analyticsConsentQueries = {
  myAnalyticsConsent: async (_: unknown, _args: unknown, ctx: ConnectionContext): Promise<AnalyticsConsent | null> => {
    requireAuthenticated(ctx);
    return readAnalyticsConsentForUser(ctx.userId!);
  },
};

export const analyticsConsentMutations = {
  setAnalyticsConsent: async (
    _: unknown,
    { input }: { input: SetAnalyticsConsentInput },
    ctx: ConnectionContext,
  ): Promise<AnalyticsConsent> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, SET_ANALYTICS_CONSENT_RATE_LIMIT, 'setAnalyticsConsent');
    const validatedInput = validateInput(SetAnalyticsConsentInputSchema, input, 'input');
    return setAnalyticsConsentForUser(ctx.userId!, validatedInput);
  },
};
