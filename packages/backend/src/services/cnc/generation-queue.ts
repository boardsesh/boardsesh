import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbInstance } from '@boardsesh/db/client';
import type { BackgroundJobTransaction } from '@boardsesh/db/queries';
import { backgroundJobRuns, cncOrders, type CncOrder } from '@boardsesh/db/schema';
import { requireJobQueue } from '../job-queue';
import type { CncOrdersExecutor } from './orders';

export const CNC_GENERATION_FAMILY = 'cnc-generation';

export const cncGenerationPayload = z
  .object({
    orderId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    generation: z.number().int().positive(),
    deliverable: z.enum(['preview', 'full']),
  })
  .strict();

export type CncGenerationRequest = z.infer<typeof cncGenerationPayload>;

/** The explicit cutover leaves old fixtures and rollback on their existing HTTP transport. */
export function usesCncJobQueue(): boolean {
  return process.env.CNC_TRANSPORT === 'pgboss';
}

/**
 * Caller must hold a transaction: the order state, run, queue insertion and
 * active-run pointer either all commit or all roll back. No credentials or
 * manufacturing/licence payload goes in the generic queue or run ledger.
 */
export async function enqueueCncGenerationOn(transaction: CncOrdersExecutor, order: CncOrder): Promise<CncOrder> {
  if (!usesCncJobQueue()) return order;
  if (order.status !== 'queued' && order.status !== 'preview_queued') throw new Error('CNC_ORDER_NOT_QUEUED');
  const deliverable = order.status === 'preview_queued' ? 'preview' : 'full';
  const runId = randomUUID();
  // Defer the registry import: orders are also read by family modules.
  const { enqueueBackgroundJobOn } = await import('../../workers/jobs');
  const queued = await enqueueBackgroundJobOn(transaction as unknown as BackgroundJobTransaction, requireJobQueue(), {
    family: CNC_GENERATION_FAMILY,
    role: 'cnc-generation',
    runId,
    payload: { orderId: order.id, generation: order.generation, deliverable },
    singletonKey: `${order.id}:${order.generation}:${deliverable}`,
    priority: deliverable === 'full' ? 100 : 0,
  });
  const [attached] = await transaction
    .update(cncOrders)
    .set({ generationRunId: queued.runId, notificationClaimToken: null, notificationClaimedAt: null })
    .where(
      and(eq(cncOrders.id, order.id), eq(cncOrders.generation, order.generation), eq(cncOrders.status, order.status)),
    )
    .returning();
  if (!attached) throw new Error('CNC_ORDER_MOVED_DURING_ENQUEUE');
  return attached;
}

/**
 * Backend-owned recovery, including a process that died on its final attempt.
 * The ledger is locked before the order, matching the worker attempt fence.
 * A superseded generation/run and a refunded order are never changed.
 */
export async function reconcileCncGenerationRuns(database: DbInstance): Promise<number> {
  if (!usesCncJobQueue()) return 0;
  let reconciled = await backfillQueuedCncGenerations(database);
  const candidates = await database
    .select({ runId: backgroundJobRuns.id })
    .from(backgroundJobRuns)
    .innerJoin(cncOrders, eq(cncOrders.generationRunId, backgroundJobRuns.id))
    .where(
      and(
        eq(backgroundJobRuns.family, CNC_GENERATION_FAMILY),
        inArray(backgroundJobRuns.status, ['failed', 'cancelled']),
        inArray(cncOrders.status, ['queued', 'generating', 'preview_queued', 'preview_generating']),
      ),
    )
    .limit(100);
  for (const { runId } of candidates) {
    const failed = await database.transaction(async (transaction) => {
      const [run] = await transaction
        .select({ errorCode: backgroundJobRuns.errorCode })
        .from(backgroundJobRuns)
        .where(and(eq(backgroundJobRuns.id, runId), inArray(backgroundJobRuns.status, ['failed', 'cancelled'])))
        .for('update');
      if (!run) return null;
      const [order] = await transaction
        .select()
        .from(cncOrders)
        .where(
          and(
            eq(cncOrders.generationRunId, runId),
            inArray(cncOrders.status, ['queued', 'generating', 'preview_queued', 'preview_generating']),
          ),
        )
        .for('update');
      if (!order) return null;
      const [updated] = await transaction
        .update(cncOrders)
        .set({
          status: order.status.startsWith('preview') ? 'preview_failed' : 'failed',
          claimToken: null,
          lastError: `CNC_GENERATION_ENDED: ${run.errorCode ?? 'ATTEMPT_EXHAUSTED'}`.slice(0, 2000),
          updatedAt: new Date(),
        })
        .where(
          and(eq(cncOrders.id, order.id), eq(cncOrders.generationRunId, runId), eq(cncOrders.status, order.status)),
        )
        .returning();
      return updated ?? null;
    });
    if (failed) reconciled++;
  }
  await announcePendingCncGenerations(database);
  return reconciled;
}

/**
 * Adopt durable queued rows created before the explicit transport cutover.
 * Row locks and the NULL pointer predicate make repeated/concurrent passes
 * idempotent. A queue outage rolls the pointer and new run back together.
 */
async function backfillQueuedCncGenerations(database: DbInstance): Promise<number> {
  let enqueued = 0;
  for (let count = 0; count < 100; count++) {
    const attached = await database.transaction(async (transaction) => {
      const [order] = await transaction
        .select()
        .from(cncOrders)
        .where(and(isNull(cncOrders.generationRunId), inArray(cncOrders.status, ['queued', 'preview_queued'])))
        .orderBy(cncOrders.queuedAt, cncOrders.id)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!order) return false;
      await enqueueCncGenerationOn(transaction, order);
      return true;
    });
    if (!attached) break;
    enqueued++;
  }
  return enqueued;
}

/**
 * Short database claims serialize the two backend replicas. Network calls
 * happen after commit, with a ten-minute recovery lease. A crash after sending
 * but before stamping can redeliver mail; it cannot publish a different order.
 */
async function announcePendingCncGenerations(database: DbInstance): Promise<void> {
  const deadline = performance.now() + 30_000;
  const terminal = ['ready', 'failed', 'preview_ready', 'preview_failed'] as const;
  const notNotified = or(
    ne(cncOrders.notificationGeneration, cncOrders.generation),
    isNull(cncOrders.notificationStatus),
    ne(cncOrders.notificationStatus, sql`${cncOrders.status}::text`),
  );
  const notificationLeaseAvailable = or(
    isNull(cncOrders.notificationClaimedAt),
    lt(cncOrders.notificationClaimedAt, sql`clock_timestamp() - interval '10 minutes'`),
  );
  const candidates = await database
    .select({ id: cncOrders.id, generation: cncOrders.generation, status: cncOrders.status })
    .from(cncOrders)
    .where(
      and(
        isNotNull(cncOrders.generationRunId),
        inArray(cncOrders.status, terminal),
        notNotified,
        notificationLeaseAvailable,
      ),
    )
    .orderBy(cncOrders.updatedAt, cncOrders.id)
    .limit(3);
  const { announceCncGenerationComplete, announceCncGenerationFailure } = await import('./generation-completion');
  for (const candidate of candidates) {
    if (performance.now() >= deadline) break;
    const token = randomUUID();
    const [claimed] = await database
      .update(cncOrders)
      .set({ notificationClaimToken: token, notificationClaimedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(cncOrders.id, candidate.id),
          eq(cncOrders.generation, candidate.generation),
          eq(cncOrders.status, candidate.status),
          notNotified,
          notificationLeaseAvailable,
        ),
      )
      .returning();
    if (!claimed) continue;
    let sent = false;
    try {
      sent = claimed.status.endsWith('ready')
        ? await announceCncGenerationComplete(claimed, { bounded: true })
        : await announceCncGenerationFailure(claimed, { bounded: true });
    } catch {
      // Leave this notification eligible; another row must not wait for it.
    } finally {
      await database
        .update(cncOrders)
        .set({
          notificationClaimToken: null,
          // A failed notification keeps its retry delay, letting later orders
          // progress instead of three malformed recipients starving the batch.
          notificationClaimedAt: sent ? null : sql`clock_timestamp()`,
          ...(sent ? { notificationGeneration: claimed.generation, notificationStatus: claimed.status } : {}),
        })
        .where(
          and(
            eq(cncOrders.id, claimed.id),
            eq(cncOrders.generation, claimed.generation),
            eq(cncOrders.status, claimed.status),
            eq(cncOrders.notificationClaimToken, token),
          ),
        );
    }
  }
}
