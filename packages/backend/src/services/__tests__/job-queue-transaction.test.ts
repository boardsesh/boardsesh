/**
 * Does `boss.send(..., { db })` really run inside a caller-supplied transaction?
 *
 * `docs/partner-workouts-internal.md` leans its whole design on this — a job
 * committing with the state change is the reason pg-boss beat BullMQ there,
 * because it is what removes the outbox-and-relay. The doc says so, and then
 * says to verify it against the installed version before leaning on it. This is
 * that verification, and it runs the real production path: a drizzle
 * transaction, through pg-boss's own `fromDrizzle` adapter.
 *
 * The type signature only shows the door is open — `SendOptions` extends
 * `ConnectionOptions { db?: IDatabase }`, and `IDatabase` is one method. That
 * says an adapter is ACCEPTED, not that every statement `send` issues goes
 * through it. So the test is behavioural: enqueue on a transaction, roll it
 * back, and assert the job is gone. A `send` that quietly used its own pool
 * would leave the job behind and the rollback would be a lie.
 */

import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../../db/client';
import { enqueueOn, startJobQueue, stopJobQueue } from '../job-queue';

const QUEUE = 'transaction-probe';

describe('pg-boss send() on a caller-supplied transaction', () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = await startJobQueue();
    await boss.createQueue(QUEUE);
  }, 90_000);

  afterAll(async () => {
    await stopJobQueue();
  });

  it('keeps the job when the transaction commits', async () => {
    const jobId = await db.transaction(async (tx) => boss.send(QUEUE, { probe: 'commit' }, { db: enqueueOn(tx) }));

    expect(jobId).toBeTruthy();
    const job = await boss.getJobById(QUEUE, jobId as string);
    expect(job).not.toBeNull();
    expect(job?.data).toEqual({ probe: 'commit' });
  });

  it('loses the job when the transaction rolls back', async () => {
    let jobId: string | null = null;

    await expect(
      db.transaction(async (tx) => {
        jobId = await boss.send(QUEUE, { probe: 'rollback' }, { db: enqueueOn(tx) });
        // A non-null id here proves nothing on its own — it comes back from the
        // INSERT ... RETURNING. Only the rollback below decides it.
        expect(jobId).toBeTruthy();
        throw new Error('roll this back');
      }),
    ).rejects.toThrow('roll this back');

    const job = await boss.getJobById(QUEUE, jobId as unknown as string);
    expect(job).toBeNull();
  });

  it('still enqueues through the pool when no transaction is given', async () => {
    // Guards the rollback assertion against a false pass: if sends were silently
    // failing, or `getJobById` were broken, "the job is gone" would be true for
    // the wrong reason.
    const jobId = await boss.send(QUEUE, { probe: 'pool' });
    expect(jobId).toBeTruthy();
    const job = await boss.getJobById(QUEUE, jobId as string);
    expect(job).not.toBeNull();
  });
});
