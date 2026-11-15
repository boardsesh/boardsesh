import { createHash, randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { cncComputations, backgroundJobRuns, type CncComputation } from '@boardsesh/db/schema';
import { db } from '../../db/client';
import { enqueueBackgroundJobOn } from '../../workers/jobs';
import { requireJobQueue } from '../job-queue';

export type CncComputationAssets = Record<string, { key: string; mime: string; sha256: string }>;
export type CncComputationView = Pick<CncComputation, 'id' | 'status' | 'result' | 'errorCode'>;
export const CNC_COMPUTATION_TIMEOUT_MS = 90_000;

export function computationView(computation: CncComputation): CncComputationView {
  if (computation.expiresAt.getTime() <= Date.now()) {
    return { id: computation.id, status: 'failed', result: null, errorCode: 'CNC_WORKER_UNAVAILABLE' };
  }
  return {
    id: computation.id,
    status: computation.status,
    result: computation.result,
    errorCode: computation.errorCode,
  };
}

/** Queued payloads name only this CNC-owned row; results never enter the generic ledger. */
export async function submitCncComputation(input: {
  operation: 'layout' | 'artwork';
  ownerId: string | null;
  request: Record<string, unknown>;
  assetKeys?: CncComputationAssets;
}): Promise<CncComputationView> {
  if (process.env.CNC_TRANSPORT !== 'pgboss' || !/^[a-f0-9]{40}$/.test(process.env.CNC_GENERATOR_SHA ?? '')) {
    throw new Error('CNC_WORKER_UNAVAILABLE');
  }
  const assetKeys = input.assetKeys ?? {};
  if (
    input.ownerId === null &&
    (input.operation !== 'layout' || input.request.includeHoles !== false || Object.keys(assetKeys).length !== 0)
  ) {
    throw new Error('CNC_PRIVATE_COMPUTATION_REQUIRES_OWNER');
  }
  const generatorSha = process.env.CNC_GENERATOR_SHA!;
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ operation: input.operation, request: input.request, assetKeys, generatorSha }))
    .digest('hex');
  const [cached] = await db
    .select()
    .from(cncComputations)
    .where(
      and(
        input.ownerId === null ? isNull(cncComputations.ownerId) : eq(cncComputations.ownerId, input.ownerId),
        eq(cncComputations.requestHash, requestHash),
        eq(cncComputations.status, 'ready'),
        gt(cncComputations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(cncComputations.createdAt))
    .limit(1);
  if (cached) return computationView(cached);
  return db.transaction(async (transaction) => {
    const [backlog] = await transaction
      .select({ total: count() })
      .from(cncComputations)
      .where(and(inArray(cncComputations.status, ['queued', 'running']), gt(cncComputations.expiresAt, new Date())));
    if (backlog.total >= 100) throw new Error('CNC_WORKER_UNAVAILABLE');
    const requestId = randomUUID();
    const runId = randomUUID();
    const [computation] = await transaction
      .insert(cncComputations)
      .values({
        ...input,
        assetKeys,
        id: requestId,
        runId,
        generatorSha,
        requestHash,
        expiresAt: new Date(Date.now() + CNC_COMPUTATION_TIMEOUT_MS),
      })
      .returning();
    // A fresh singleton per row: hash dedupe cannot strand a row behind another request's job.
    await enqueueBackgroundJobOn(transaction, requireJobQueue(), {
      family: 'cnc-computation',
      payload: { requestId },
      runId,
      singletonKey: requestId,
    });
    return computationView(computation);
  });
}

export async function readCncComputation(
  requestId: string,
  viewerId: string | null,
): Promise<CncComputationView | null> {
  const [computation] = await db.select().from(cncComputations).where(eq(cncComputations.id, requestId)).limit(1);
  if (!computation || (computation.ownerId !== null && computation.ownerId !== viewerId)) return null;
  const view = computationView(computation);
  if (view.status === 'queued' || view.status === 'running') {
    const [run] = await db
      .select({ status: backgroundJobRuns.status })
      .from(backgroundJobRuns)
      .where(eq(backgroundJobRuns.id, computation.runId))
      .limit(1);
    if (!run || run.status === 'failed' || run.status === 'cancelled')
      return { ...view, status: 'failed', result: null, errorCode: 'CNC_WORKER_UNAVAILABLE' };
  }
  return view;
}
