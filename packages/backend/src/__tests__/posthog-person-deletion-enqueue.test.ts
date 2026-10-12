import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import type { ConnectionContext, SetAnalyticsConsentInput } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import {
  POSTHOG_PERSON_DELETION_QUEUE,
  POSTHOG_PERSON_DELETION_QUEUE_OPTIONS,
  initializeJobQueueSchema,
} from '@boardsesh/db/job-queue-schema';
import { db } from '../db/client';
import { getJobQueue, requireJobQueue, startJobQueue, stopJobQueue, stopJobQueueWorkers } from '../services/job-queue';
import {
  FIRST_PASS_DELAY_SECONDS,
  LATE_PASS_DELAY_SECONDS,
  enqueuePosthogPersonDeletion,
  startPosthogPersonDeletion,
} from '../services/analytics/posthog-person-deletion';
import { analyticsConsentMutations } from '../graphql/resolvers/users/analytics-consent';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * When the PostHog erasure jobs are queued (docs/analytics-consent.md,
 * "Erasure"), against a running pg-boss, and what the worker does with one.
 * Queued jobs start 15 minutes or 7 days out, so even with the worker
 * registered they stay in `created` and can be counted.
 */

let connectionCounter = 0;
const context = (userId: string): ConnectionContext =>
  ({ connectionId: `erasure-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

async function createUser(): Promise<string> {
  const userId = randomUUID();
  await db.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
  return userId;
}

type QueuedErasure = { distinctId: string; reason: string; pass?: string };

async function queuedErasures(userId: string): Promise<QueuedErasure[]> {
  const rows = await db.execute<{ data: QueuedErasure }>(
    sql`SELECT data FROM pgboss.job WHERE name = ${POSTHOG_PERSON_DELETION_QUEUE} AND data->>'distinctId' = ${userId} ORDER BY start_after, created_on`,
  );
  return Array.from(rows, (row) => row.data);
}

const bothPasses = (distinctId: string, reason: string): QueuedErasure[] => [
  { distinctId, reason, pass: 'first' },
  { distinctId, reason, pass: 'late' },
];

const grant = (basedOnDecidedAt: string | null = null): SetAnalyticsConsentInput => ({
  analytics: 'granted',
  version: 1,
  source: 'ios',
  basedOnDecidedAt,
});
const deny: SetAnalyticsConsentInput = { analytics: 'denied', version: 1, source: 'web', basedOnDecidedAt: null };

function setConsent(userId: string, input: SetAnalyticsConsentInput) {
  return analyticsConsentMutations.setAnalyticsConsent(null, { input }, context(userId));
}

beforeAll(async () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await initializeJobQueueSchema(drizzle(client));
  } finally {
    await client.end();
  }
  await startJobQueue();
  await requireJobQueue().deleteAllJobs(POSTHOG_PERSON_DELETION_QUEUE);
});
afterAll(() => stopJobQueue());
beforeEach(() => {
  resetAllRateLimits();
  vi.restoreAllMocks();
});

describe('account deletion', () => {
  it('queues both erasure passes for the deleted account', async () => {
    const userId = await createUser();

    await userMutations.deleteAccount(null, { input: { removeSetterName: false } }, context(userId));

    expect(await queuedErasures(userId)).toEqual(bothPasses(userId, 'account_deleted'));
    const remaining = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, userId));
    expect(remaining).toHaveLength(0);
  });
});

describe('consent withdrawal', () => {
  it('queues both passes when a denial replaces a grant', async () => {
    const userId = await createUser();
    await setConsent(userId, grant());

    await setConsent(userId, deny);

    expect(await queuedErasures(userId)).toEqual(bothPasses(userId, 'consent_withdrawn'));
  });

  it('queues nothing for a repeated denial', async () => {
    const userId = await createUser();
    await setConsent(userId, grant());
    await setConsent(userId, deny);

    await setConsent(userId, deny);

    expect(await queuedErasures(userId)).toHaveLength(2);
  });

  it('queues both passes for a first-ever denial: the account may predate the consent prompt', async () => {
    const userId = await createUser();

    await setConsent(userId, deny);

    expect(await queuedErasures(userId)).toEqual(bothPasses(userId, 'consent_withdrawn'));
  });

  it('queues nothing for a grant', async () => {
    const userId = await createUser();

    await setConsent(userId, grant());

    expect(await queuedErasures(userId)).toEqual([]);
  });

  it('queues again after a later grant is withdrawn', async () => {
    const userId = await createUser();
    await setConsent(userId, grant());
    const denied = await setConsent(userId, deny);
    await setConsent(userId, grant(denied.decidedAt));

    await setConsent(userId, deny);

    expect(await queuedErasures(userId)).toHaveLength(4);
  });
});

describe('enqueuePosthogPersonDeletion', () => {
  it('starts the first pass 15 minutes out and the late pass 7 days out', async () => {
    const userId = randomUUID();
    await db.transaction((transaction) =>
      enqueuePosthogPersonDeletion(transaction, { distinctId: userId, reason: 'account_deleted' }),
    );

    const rows = await db.execute<{ pass: string; delay_seconds: number; keep_seconds: number }>(
      sql`SELECT data->>'pass' AS pass,
                 EXTRACT(EPOCH FROM start_after - created_on)::int AS delay_seconds,
                 EXTRACT(EPOCH FROM keep_until - start_after)::int AS keep_seconds
          FROM pgboss.job
          WHERE name = ${POSTHOG_PERSON_DELETION_QUEUE} AND data->>'distinctId' = ${userId}
          ORDER BY start_after`,
    );
    const fourteenDays = 14 * 24 * 60 * 60;
    expect(Array.from(rows)).toEqual([
      { pass: 'first', delay_seconds: expect.closeTo(FIRST_PASS_DELAY_SECONDS, -1), keep_seconds: fourteenDays },
      { pass: 'late', delay_seconds: expect.closeTo(LATE_PASS_DELAY_SECONDS, -1), keep_seconds: fourteenDays },
    ]);
  });

  it('rolls the job back with the caller transaction', async () => {
    const userId = randomUUID();
    await expect(
      db.transaction(async (transaction) => {
        expect(await enqueuePosthogPersonDeletion(transaction, { distinctId: userId, reason: 'account_deleted' })).toBe(
          true,
        );
        throw new Error('caller rolled back');
      }),
    ).rejects.toThrow('caller rolled back');

    expect(await queuedErasures(userId)).toEqual([]);
  });

  it('does not abort the caller transaction when the send fails in the database', async () => {
    const userId = randomUUID();
    vi.spyOn(requireJobQueue(), 'send').mockImplementationOnce(async (_name, _data, options) => {
      // A real statement error inside the savepoint, as a missing queue would raise.
      await options?.db?.executeSql('SELECT 1 / 0');
      return null;
    });

    const queued = await db.transaction(async (transaction) => {
      const result = await enqueuePosthogPersonDeletion(transaction, {
        distinctId: userId,
        reason: 'account_deleted',
      });
      // The transaction is still usable after the failed savepoint.
      await transaction.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
      return result;
    });

    expect(queued).toBe(false);
    expect(await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, userId))).toHaveLength(1);
    expect(await queuedErasures(userId)).toEqual([]);
  });
});

describe('the erasure queue', () => {
  it('has the retry budget and retention the docs promise', async () => {
    const queue = await requireJobQueue().getQueue(POSTHOG_PERSON_DELETION_QUEUE);
    expect(queue).toMatchObject({
      retryLimit: 12,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 6 * 60 * 60,
      expireInSeconds: 120,
      retentionSeconds: 14 * 24 * 60 * 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
    });
    expect(queue).toMatchObject(POSTHOG_PERSON_DELETION_QUEUE_OPTIONS);
  });
});

describe('the erasure worker', () => {
  type JobState = {
    state: string;
    retry_count: number;
    output: Record<string, unknown> | null;
    retry_in_seconds: number;
  };

  async function jobState(jobId: string): Promise<JobState> {
    const [row] = await db.execute<JobState>(
      sql`SELECT state::text AS state, retry_count, output,
                 EXTRACT(EPOCH FROM start_after - now())::int AS retry_in_seconds
          FROM pgboss.job WHERE name = ${POSTHOG_PERSON_DELETION_QUEUE} AND id = ${jobId}`,
    );
    return row;
  }

  /** Send one job due now and wait until the worker has settled it. */
  async function workOne(distinctId: string): Promise<JobState> {
    const jobId = await requireJobQueue().send(POSTHOG_PERSON_DELETION_QUEUE, {
      distinctId,
      reason: 'account_deleted',
      pass: 'first',
    });
    if (!jobId) throw new Error('job not queued');
    const deadline = Date.now() + 20_000;
    for (;;) {
      const current = await jobState(jobId);
      if (current.state !== 'created' && current.state !== 'active') return current;
      if (Date.now() > deadline) throw new Error(`job still ${current.state}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const replies = { deletion: 202 };
  const fetchImpl: typeof fetch = async (input) =>
    (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).endsWith('/query/')
      ? new Response(JSON.stringify({ results: [] }), { status: 200 })
      : new Response(
          JSON.stringify({
            persons_found: 1,
            persons_deleted: 0,
            persons_queued_for_deletion: 1,
            events_queued_for_deletion: true,
            recordings_queued_for_deletion: true,
            deletion_errors: [],
          }),
          { status: replies.deletion },
        );

  beforeAll(async () => {
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    vi.stubEnv('POSTHOG_ERASURE_API_KEY', 'phx_test_key');
    await expect(
      startPosthogPersonDeletion(requireJobQueue(), { pollingIntervalSeconds: 0.5, fetchImpl }),
    ).resolves.toBe(true);
  });
  afterAll(async () => {
    await requireJobQueue().offWork(POSTHOG_PERSON_DELETION_QUEUE, { wait: true });
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    replies.deletion = 202;
  });

  it('completes a job PostHog accepted', async () => {
    const settled = await workOne(randomUUID());
    expect(settled).toMatchObject({ state: 'completed', retry_count: 0, output: { outcome: 'deleted' } });
  });

  it('puts a job PostHog could not take yet back for a retry 60 to 120 s out', async () => {
    replies.deletion = 503;
    const settled = await workOne(randomUUID());
    // pg-boss counts the retry when it starts it, so none is spent yet.
    expect(settled).toMatchObject({ state: 'retry', retry_count: 0 });
    expect(settled.retry_in_seconds).toBeGreaterThanOrEqual(55);
    expect(settled.retry_in_seconds).toBeLessThanOrEqual(120);
  });

  it('fails a job PostHog rejected outright, without spending the retries', async () => {
    replies.deletion = 400;
    const settled = await workOne(randomUUID());
    expect(settled).toMatchObject({ state: 'failed', retry_count: 0, output: { outcome: 'rejected' } });
  });
});

// Last: it stops the workers, which the rest of this file needs running.
describe('during shutdown', () => {
  it('keeps accepting erasures after the workers stop, until the queue closes', async () => {
    await stopJobQueueWorkers();
    expect(getJobQueue()).not.toBeNull();

    const userId = randomUUID();
    const queued = await db.transaction((transaction) =>
      enqueuePosthogPersonDeletion(transaction, { distinctId: userId, reason: 'account_deleted' }),
    );

    expect(queued).toBe(true);
    expect(await queuedErasures(userId)).toEqual(bothPasses(userId, 'account_deleted'));

    await stopJobQueue();
    expect(getJobQueue()).toBeNull();
  });
});
