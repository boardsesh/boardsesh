import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss, JobWithMetadata } from 'pg-boss';
import type { DbInstance } from '@boardsesh/db/client';
import { BACKGROUND_JOB_QUEUES, type BackgroundWorkerRole } from '@boardsesh/db/background-jobs';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import {
  claimBackgroundJobRun,
  settleBackgroundJobRun,
  withBackgroundJobAttempt,
  type BackgroundJobTransaction,
} from '@boardsesh/db/queries';
import { enqueueOn } from '../services/job-queue';
import { logger } from '../utils/logger';
import {
  BackgroundJobError,
  InvalidJobPayloadError,
  familiesForRole,
  requireFamily,
  type BackgroundJobFamilyModule,
} from './families';

export type { BackgroundJobContext } from './families';

function requireSettlement(result: unknown): void {
  // pg-boss 12.33 returns affected at runtime but publishes an empty CommandResponse type.
  if (!result || typeof result !== 'object' || !('affected' in result) || result.affected !== 1)
    throw new Error('ATTEMPT_LOST');
}

/** The queue payload. Family and family payload live on the run row, never here. */
export type BackgroundJobPayload = { runId: string };

export function requireRunId(runId: unknown): string {
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error('INVALID_RUN_ID');
  }
  return runId;
}

/** What one worker process consumes: its role's queue and the families that role serves. */
export type BackgroundJobHandler = {
  role: BackgroundWorkerRole;
  queue: string;
  resolveFamily(name: string): BackgroundJobFamilyModule | undefined;
};

export function handlerForRole(role: BackgroundWorkerRole): BackgroundJobHandler {
  const families = new Map(familiesForRole(role).map((family) => [family.name as string, family]));
  return {
    role,
    queue: BACKGROUND_JOB_QUEUES[role],
    resolveFamily: (name) => families.get(name),
  };
}

/** The ledger stores payloads as a JSON object; anything else is rejected before enqueue. */
function parseFamilyPayload(family: BackgroundJobFamilyModule, payload: unknown): Record<string, unknown> | null {
  const parsed = family.payload.safeParse(payload);
  if (!parsed.success) return null;
  const { data: parsedPayload } = parsed;
  if (typeof parsedPayload !== 'object' || parsedPayload === null || Array.isArray(parsedPayload)) return null;
  return parsedPayload as Record<string, unknown>;
}

/** The role a run lands on: the caller's, checked against the family, or the family's only role. */
export function requireFamilyRole(
  family: Pick<BackgroundJobFamilyModule, 'roles'>,
  role: BackgroundWorkerRole | undefined,
): BackgroundWorkerRole {
  if (role) {
    if (!family.roles.includes(role)) throw new Error('FAMILY_ROLE_MISMATCH');
    return role;
  }
  if (family.roles.length !== 1) throw new Error('FAMILY_ROLE_REQUIRED');
  return family.roles[0];
}

export type EnqueueBackgroundJobInput = {
  family: string;
  payload: unknown;
  /** Required when the family serves more than one role (the probe serves all). */
  role?: BackgroundWorkerRole;
  /** Doubles as the caller's idempotency key, including after a lost acknowledgement. */
  runId?: string;
  /** Overrides the family's own key. Defaults to the family's key, then the run ID. */
  singletonKey?: string;
};

export type EnqueueBackgroundJobResult = {
  runId: string;
  /** True when the stately queue already held a queued run for this key; `runId` is that run. */
  alreadyQueued: boolean;
};

/** Thrown inside the enqueue savepoint to roll back the ledger row a dropped send left behind. */
class AlreadyQueuedSignal extends Error {}

/**
 * Insert the run row and its `{ runId }` job inside the caller's transaction.
 *
 * The family's options go on the job itself, so one stately queue carries
 * families with different leases and retry budgets. The pg-boss singleton key is
 * `<family>:<key>` so two families never dedupe against each other.
 *
 * When pg-boss drops the send (a queued job already holds the key), the ledger
 * insert is rolled back to a savepoint, not deleted: worker logins have no
 * DELETE on the ledger, and that absence is how `assertWorkerPrivileges` tells
 * them from the backend runtime login.
 */
export async function enqueueBackgroundJobOn(
  transaction: BackgroundJobTransaction,
  boss: PgBoss,
  input: EnqueueBackgroundJobInput,
): Promise<EnqueueBackgroundJobResult> {
  const family = requireFamily(input.family);
  const role = requireFamilyRole(family, input.role);
  const payload = parseFamilyPayload(family, input.payload);
  if (!payload) throw new InvalidJobPayloadError();
  const runId = requireRunId(input.runId ?? randomUUID());
  const singletonKey = input.singletonKey ?? family.singletonKey?.(payload) ?? runId;
  if (!singletonKey || singletonKey.length > 200) throw new Error('INVALID_SINGLETON_KEY');
  const queue = BACKGROUND_JOB_QUEUES[role];
  const queueSingletonKey = `${family.name}:${singletonKey}`;
  const { deadlineSeconds, ...jobOptions } = family.options;
  const insertAndSend = () =>
    transaction.transaction(async (savepoint) => {
      const inserted = await savepoint
        .insert(backgroundJobRuns)
        .values({
          id: runId,
          queue,
          role,
          family: family.name,
          payload,
          singletonKey,
          status: 'queued',
          deadlineAt: new Date(Date.now() + deadlineSeconds * 1000),
        })
        .onConflictDoNothing()
        .returning({ id: backgroundJobRuns.id });
      if (!inserted.length) {
        const [existing] = await savepoint.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId));
        if (existing?.queue !== queue || existing.role !== role || existing.family !== family.name)
          throw new Error('RUN_ID_CONFLICT');
        return { runId, alreadyQueued: false };
      }
      const jobId = await boss.send(
        queue,
        { runId },
        { ...jobOptions, id: runId, singletonKey: queueSingletonKey, db: enqueueOn(savepoint) },
      );
      if (jobId === null) throw new AlreadyQueuedSignal();
      if (jobId !== runId) throw new Error('JOB_ENQUEUE_FAILED');
      return { runId, alreadyQueued: false };
    });
  /** The run holding this key in `state` (`stately` admits one per state), if the ledger agrees. */
  const holderRun = async (state: 'created' | 'active') => {
    const jobs = await boss.findJobs(queue, { key: queueSingletonKey, db: enqueueOn(transaction) });
    const holder = jobs.find((job) => job.state === state);
    if (!holder) return undefined;
    const [existing] = await transaction
      .select({ id: backgroundJobRuns.id })
      .from(backgroundJobRuns)
      .where(
        and(
          eq(backgroundJobRuns.id, holder.id),
          eq(backgroundJobRuns.family, family.name),
          eq(backgroundJobRuns.singletonKey, singletonKey),
        ),
      );
    return existing;
  };
  const deduplicated = (existingRunId: string): EnqueueBackgroundJobResult => {
    logger.info('[worker] enqueue deduplicated', { code: 'ALREADY_QUEUED', family: family.name, runId: existingRunId });
    return { runId: existingRunId, alreadyQueued: true };
  };
  // Two tries: between a dropped send and the holder lookup, the queued twin can
  // be fetched to `active` (or cancelled), which frees the `created` slot. A
  // throw here would roll back the caller's whole transaction, so retry instead.
  for (let tries = 0; tries < 2; tries++) {
    try {
      return await insertAndSend();
    } catch (error) {
      if (!(error instanceof AlreadyQueuedSignal)) throw error;
    }
    const queuedHolder = await holderRun('created');
    if (queuedHolder) return deduplicated(queuedHolder.id);
  }
  // Still dropped with no queued holder: the key is busy with a running twin.
  const activeHolder = await holderRun('active');
  if (!activeHolder) throw new Error('JOB_ENQUEUE_FAILED');
  return deduplicated(activeHolder.id);
}

export async function enqueueBackgroundJob(
  database: DbInstance,
  boss: PgBoss,
  input: EnqueueBackgroundJobInput,
): Promise<EnqueueBackgroundJobResult> {
  return database.transaction((transaction) => enqueueBackgroundJobOn(transaction, boss, input));
}

/** ID doubles as the caller's idempotency key, including after a lost acknowledgement. */
export async function enqueueWorkerProbe(
  database: DbInstance,
  boss: PgBoss,
  role: BackgroundWorkerRole,
  runId: string = randomUUID(),
): Promise<string> {
  const { runId: acceptedRunId } = await enqueueBackgroundJob(database, boss, {
    role,
    family: 'worker-probe',
    payload: {},
    runId,
  });
  return acceptedRunId;
}

type FailureOutcome = { errorCode: string; retryable: boolean };

function failureOutcome(error: unknown): FailureOutcome {
  if (error instanceof BackgroundJobError) return { errorCode: error.code, retryable: error.retryable };
  return { errorCode: 'ATTEMPT_FAILED', retryable: true };
}

/**
 * Record a failed attempt. A retryable failure goes back to pg-boss's retry
 * budget; a permanent one cancels the job so no retry repeats it. pg-boss
 * persists the output, so only the bounded code goes in: never provider URLs,
 * SQL or credentials.
 */
async function settleFailure(
  database: DbInstance,
  boss: PgBoss,
  job: JobWithMetadata<BackgroundJobPayload>,
  token: string,
  { errorCode, retryable }: FailureOutcome,
): Promise<'failed' | 'stale'> {
  const settled = await settleBackgroundJobRun(database, job.id, token, async (transaction) => {
    const adapter = enqueueOn(transaction);
    if (!retryable) {
      requireSettlement(await boss.cancel(job.name, job.id, { db: adapter }));
      return { status: 'failed', errorCode };
    }
    requireSettlement(await boss.fail(job.name, job.id, { code: errorCode }, { db: adapter }));
    const retry = await boss.getJobById(job.name, job.id, { db: adapter });
    return { status: retry?.state === 'failed' ? 'failed' : 'retrying', errorCode };
  });
  return settled ? 'failed' : 'stale';
}

/** All data batches, including completion, remain behind the current attempt fence. */
export async function executeBackgroundJob(
  database: DbInstance,
  boss: PgBoss,
  job: JobWithMetadata<BackgroundJobPayload>,
  handler: BackgroundJobHandler,
  shutdownSignal: AbortSignal,
): Promise<'succeeded' | 'failed' | 'stale'> {
  if (
    !job.data ||
    Object.keys(job.data).length !== 1 ||
    requireRunId(job.data.runId) !== job.id ||
    job.name !== handler.queue
  ) {
    throw new Error('INVALID_JOB_PAYLOAD');
  }
  shutdownSignal.throwIfAborted();
  const token = await claimBackgroundJobRun(database, job.id, job.name, job.retryCount);
  if (!token) return 'stale';
  // Family and payload are written once at enqueue, so an unfenced read is exact.
  const [run] = await database
    .select({ family: backgroundJobRuns.family, payload: backgroundJobRuns.payload })
    .from(backgroundJobRuns)
    .where(eq(backgroundJobRuns.id, job.id));
  const family = run ? handler.resolveFamily(run.family) : undefined;
  if (!run || !family) {
    logger.warn('[worker] job rejected', { runId: job.id, role: handler.role, code: 'UNKNOWN_FAMILY' });
    return settleFailure(database, boss, job, token, { errorCode: 'UNKNOWN_FAMILY', retryable: false });
  }
  const parsed = family.payload.safeParse(run.payload);
  if (!parsed.success) {
    logger.warn('[worker] job rejected', { runId: job.id, family: family.name, code: 'INVALID_PAYLOAD' });
    return settleFailure(database, boss, job, token, { errorCode: 'INVALID_PAYLOAD', retryable: false });
  }
  const lostAttempt = new AbortController();
  const remainingMs = Math.max(1, job.startedOn.getTime() + job.expireInSeconds * 1000 - Date.now());
  const signal = AbortSignal.any([shutdownSignal, AbortSignal.timeout(remainingMs), lostAttempt.signal]);
  // Touch at least three times per pg-boss heartbeat window, and never less often than every 10 s.
  const heartbeatIntervalMs = job.heartbeatSeconds ? Math.min(10_000, (job.heartbeatSeconds * 1000) / 3) : 10_000;
  let heartbeatPending: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = withBackgroundJobAttempt(database, job.id, token, async (transaction) => {
      const touched = await boss.touch(job.name, job.id, { db: enqueueOn(transaction) });
      requireSettlement(touched);
      await transaction
        .update(backgroundJobRuns)
        .set({ heartbeatAt: sql`clock_timestamp()` })
        .where(eq(backgroundJobRuns.id, job.id));
    })
      .catch(() => {
        lostAttempt.abort();
      })
      .finally(() => {
        heartbeatPending = undefined;
      });
  }, heartbeatIntervalMs);
  heartbeat.unref();
  try {
    signal.throwIfAborted();
    await family.execute(
      {
        runId: job.id,
        family: family.name,
        signal,
        expiresAt: job.startedOn.getTime() + job.expireInSeconds * 1000,
        database,
        enqueue: (transaction, input) => enqueueBackgroundJobOn(transaction, boss, input),
        transaction: (callback) =>
          withBackgroundJobAttempt(database, job.id, token, async (transaction) => {
            signal.throwIfAborted();
            const result = await callback(transaction);
            signal.throwIfAborted();
            return result;
          }),
      },
      parsed.data,
    );
    signal.throwIfAborted();
    const settled = await settleBackgroundJobRun(database, job.id, token, async (transaction) => {
      signal.throwIfAborted();
      const completed = await boss.complete(job.name, job.id, undefined, { db: enqueueOn(transaction) });
      requireSettlement(completed);
      return { status: 'succeeded' };
    });
    return settled ? 'succeeded' : 'stale';
  } catch (error) {
    return await settleFailure(database, boss, job, token, failureOutcome(error));
  } finally {
    clearInterval(heartbeat);
    await heartbeatPending;
  }
}
