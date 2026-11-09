import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { kilterCatalogCheckpoints, kilterCatalogControl } from '@boardsesh/db/schema';
import { CredentialLeaseLostError } from '@boardsesh/db/queries';

type CatalogDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export type CatalogControlWrite = <Result>(callback: (transaction: CatalogDb) => Promise<Result>) => Promise<Result>;
export type CatalogScope = { scopeKey: string; mappingVersion: string };
export type CatalogCheckpoint = typeof kilterCatalogCheckpoints.$inferSelect;

export const CATALOG_DELTA_OVERLAP_MS = 5 * 60_000;
export const CATALOG_WRITER_LEASE_MS = 120_000;
const CATALOG_WRITER_HEARTBEAT_MS = 30_000;
const WRITER_KEY = 'catalog';

/** Also recognized by existing importer stop/fence handling. */
export class CatalogWriterLeaseLostError extends CredentialLeaseLostError {
  constructor() {
    super();
    this.name = 'CatalogWriterLeaseLostError';
    this.message = 'The Kilter catalog writer lease is held by another run or expired';
  }
}

export function catalogMappingVersion(definition: unknown): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

export function catalogDeltaSince(confirmedThrough: Date): Date {
  if (!Number.isFinite(confirmedThrough.getTime())) throw new Error('Invalid catalog checkpoint timestamp');
  return new Date(confirmedThrough.getTime() - CATALOG_DELTA_OVERLAP_MS);
}

export async function readCatalogCheckpoint(db: CatalogDb, scope: CatalogScope): Promise<CatalogCheckpoint | null> {
  const [checkpoint] = await db
    .select()
    .from(kilterCatalogCheckpoints)
    .where(
      and(
        eq(kilterCatalogCheckpoints.scopeKey, scope.scopeKey),
        eq(kilterCatalogCheckpoints.mappingVersion, scope.mappingVersion),
      ),
    );
  return checkpoint ?? null;
}

/** Re-running or changing a scope withdraws certification until its full replay succeeds. */
export async function startCatalogBaseline(
  write: CatalogControlWrite,
  scope: CatalogScope,
  requestStartedAt: Date,
): Promise<void> {
  validateRequestStart(requestStartedAt);
  await write(async (transaction) => {
    await transaction
      .insert(kilterCatalogCheckpoints)
      .values({ ...scope, baselineStartedAt: requestStartedAt })
      .onConflictDoUpdate({
        target: kilterCatalogCheckpoints.scopeKey,
        set: {
          mappingVersion: scope.mappingVersion,
          baselineStartedAt: requestStartedAt,
          baselineCompletedAt: null,
          confirmedThrough: null,
          updatedAt: sql`clock_timestamp()`,
        },
      });
  });
}

/** Call only after every batch, deferred payload and baseline overlap is durable. */
export async function completeCatalogCheckpoint(
  write: CatalogControlWrite,
  scope: CatalogScope,
  requestStartedAt: Date,
  options: { baseline?: boolean } = {},
): Promise<void> {
  validateRequestStart(requestStartedAt);
  const requestStartIso = requestStartedAt.toISOString();
  await write(async (transaction) => {
    const [checkpoint] = await transaction
      .update(kilterCatalogCheckpoints)
      .set({
        confirmedThrough: sql`GREATEST(${kilterCatalogCheckpoints.confirmedThrough}, ${requestStartIso}::timestamptz)`,
        ...(options.baseline ? { baselineCompletedAt: sql`clock_timestamp()` } : {}),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(kilterCatalogCheckpoints.scopeKey, scope.scopeKey),
          eq(kilterCatalogCheckpoints.mappingVersion, scope.mappingVersion),
          options.baseline
            ? sql`${kilterCatalogCheckpoints.baselineStartedAt} IS NOT NULL AND ${kilterCatalogCheckpoints.baselineStartedAt} <= ${requestStartIso}::timestamptz`
            : sql`${kilterCatalogCheckpoints.baselineCompletedAt} IS NOT NULL`,
        ),
      )
      .returning({ scopeKey: kilterCatalogCheckpoints.scopeKey });
    if (!checkpoint) throw new Error('Catalog scope has no matching complete baseline');
  });
}

function validateRequestStart(requestStartedAt: Date): void {
  if (!Number.isFinite(requestStartedAt.getTime())) throw new Error('Invalid catalog request-start timestamp');
}

/**
 * The attempt fence (when supplied) is always outermost. Updating this lease
 * takes an exclusive row lock, held through each bounded callback and final
 * expiry check. Takeover waits for that transaction and stale owners cannot
 * commit. A heartbeat keeps the lease alive during network reads.
 */
export async function withCatalogWriterLease<Result>(
  options: { db: CatalogDb; transaction?: CatalogControlWrite; signal?: AbortSignal; log?: (message: string) => void },
  callback: (lease: { write: CatalogControlWrite; ownerId: string; signal: AbortSignal }) => Promise<Result>,
): Promise<Result> {
  const ownerId = randomUUID();
  const transact: CatalogControlWrite = options.transaction ?? ((work) => options.db.transaction(work));
  const leaseAbort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, leaseAbort.signal]) : leaseAbort.signal;
  signal.throwIfAborted();
  await transact(async (transaction) => {
    const [claimed] = await transaction
      .insert(kilterCatalogControl)
      .values({
        key: WRITER_KEY,
        ownerId,
        leaseUntil: sql`clock_timestamp() + ${CATALOG_WRITER_LEASE_MS} * interval '1 millisecond'`,
      })
      .onConflictDoUpdate({
        target: kilterCatalogControl.key,
        set: {
          ownerId,
          leaseUntil: sql`clock_timestamp() + ${CATALOG_WRITER_LEASE_MS} * interval '1 millisecond'`,
        },
        setWhere: sql`${kilterCatalogControl.leaseUntil} <= clock_timestamp()`,
      })
      .returning({ ownerId: kilterCatalogControl.ownerId });
    if (!claimed) throw new CatalogWriterLeaseLostError();
  });

  const renew = async (transaction: CatalogDb): Promise<void> => {
    const [renewed] = await transaction
      .update(kilterCatalogControl)
      .set({ leaseUntil: sql`clock_timestamp() + ${CATALOG_WRITER_LEASE_MS} * interval '1 millisecond'` })
      .where(
        and(
          eq(kilterCatalogControl.key, WRITER_KEY),
          eq(kilterCatalogControl.ownerId, ownerId),
          sql`${kilterCatalogControl.leaseUntil} > clock_timestamp()`,
        ),
      )
      .returning({ ownerId: kilterCatalogControl.ownerId });
    if (!renewed) throw new CatalogWriterLeaseLostError();
  };

  const write: CatalogControlWrite = (work) =>
    transact(async (transaction) => {
      signal.throwIfAborted();
      await renew(transaction);
      const result = await work(transaction);
      signal.throwIfAborted();
      // A slow callback cannot commit after its renewed TTL elapsed. Retake
      // neither the lease nor the worker fence: the whole batch rolls back.
      await renew(transaction);
      return result;
    });

  const heartbeat: { pending: Promise<void> | null } = { pending: null };
  const timer = setInterval(() => {
    if (heartbeat.pending) return;
    heartbeat.pending = transact(renew)
      .catch((error: unknown) => leaseAbort.abort(error))
      .finally(() => {
        heartbeat.pending = null;
      });
  }, CATALOG_WRITER_HEARTBEAT_MS);
  timer.unref();
  try {
    const result = await callback({ write, ownerId, signal });
    signal.throwIfAborted();
    return result;
  } finally {
    clearInterval(timer);
    if (heartbeat.pending) await heartbeat.pending;
    // Releasing a stale owner never touches a replacement. Use a fresh ordinary
    // transaction: cancellation/attempt loss must not strand a healthy TTL.
    try {
      await options.db
        .update(kilterCatalogControl)
        .set({ leaseUntil: sql`clock_timestamp()` })
        .where(and(eq(kilterCatalogControl.key, WRITER_KEY), eq(kilterCatalogControl.ownerId, ownerId)));
    } catch (error) {
      // The TTL still releases this owner. Preserve the original provider error
      // (especially Retry-After) or successful result for its caller.
      options.log?.(`[kilter-catalog] lease release failed; waiting for expiry: ${String(error)}`);
    }
  }
}
