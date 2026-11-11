/** Operator-only enqueue: explicit transaction, no application database module or worker startup. */
import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { backgroundJobRuns } from '@boardsesh/db/schema/app';
import { BACKGROUND_JOB_QUEUES, jobQueueTransactionAdapter } from '@boardsesh/db/background-jobs';
import type { ConsolidationTransaction } from './executor';
import { ConsolidationError } from './planner';

export async function enqueueConsolidationJob(
  transaction: ConsolidationTransaction,
  boss: PgBoss,
  input: {
    readonly family: 'aurora-user-sync' | 'kilter-user-sync';
    readonly role: 'interactive-import' | 'batch';
    readonly payload: Readonly<Record<string, unknown>>;
  },
) {
  const providerPayload = z
    .object({
      userId: z.string().min(1).max(128),
      boardType:
        input.family === 'kilter-user-sync'
          ? z.literal('kilter')
          : z.enum(['tension', 'decoy', 'touchstone', 'grasshopper', 'soill']),
      linkGeneration: z.uuid(),
      requestedBy: z.literal('link'),
    })
    .strict();
  if (input.role !== 'interactive-import' || !providerPayload.safeParse(input.payload).success)
    throw new ConsolidationError('UNSAFE_PLAN');
  const runId = randomUUID();
  const queue = BACKGROUND_JOB_QUEUES[input.role];
  // Unique per committed group job: retries of the group return its durable audit before enqueueing.
  const singletonKey = runId;
  await transaction.insert(backgroundJobRuns).values({
    id: runId,
    queue,
    role: input.role,
    family: input.family,
    payload: input.payload,
    singletonKey,
    status: 'queued',
    deadlineAt: new Date(Date.now() + 7200000),
  });
  const jobId = await boss.send(
    queue,
    { runId },
    {
      id: runId,
      singletonKey: `${input.family}:${singletonKey}`,
      db: jobQueueTransactionAdapter(transaction),
      expireInSeconds: 1800,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 300,
      heartbeatSeconds: 300,
    },
  );
  if (jobId !== runId) throw new ConsolidationError('DATABASE');
  return runId;
}
