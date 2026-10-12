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
  type PosthogPersonDeletionJob,
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
  it('does not erase a grant when an older conditional denial is recovered', async () => {
    const userId = await createUser();
    const granted = await setConsent(userId, grant());
    const recovered = await setConsent(userId, { ...deny, conditional: true });
    expect(recovered).toEqual(granted);
    expect(await queuedErasures(userId)).toEqual([]);
  });

  it('queues both passes for a conditional denial against the current grant', async () => {
    const userId = await createUser();
    const granted = await setConsent(userId, grant());
    await setConsent(userId, { ...deny, conditional: true, basedOnDecidedAt: granted.decidedAt });
    expect(await queuedErasures(userId)).toEqual(bothPasses(userId, 'consent_withdrawn'));
  });

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

  async function waitUntil<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`still waiting: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const settled = (state: JobState) => state.state !== 'created' && state.state !== 'active';

  /** Send one job due now and wait until the worker has settled it. */
  async function workOne(data: PosthogPersonDeletionJob, options: { startAfter?: number } = {}): Promise<JobState> {
    const jobId = await requireJobQueue().send(POSTHOG_PERSON_DELETION_QUEUE, data, options);
    if (!jobId) throw new Error('job not queued');
    return waitUntil(() => jobState(jobId), settled);
  }

  type ErasureRow = { id: string; state: string; data: PosthogPersonDeletionJob };
  async function erasureRows(distinctId: string): Promise<ErasureRow[]> {
    const rows = await db.execute<ErasureRow>(
      sql`SELECT id, state::text AS state, data FROM pgboss.job
          WHERE name = ${POSTHOG_PERSON_DELETION_QUEUE} AND data->>'distinctId' = ${distinctId}
          ORDER BY created_on`,
    );
    return Array.from(rows);
  }

  const replies: {
    lookup: number;
    anonymousIds: string[];
    deletion: number;
    personsFound: number;
    personsDeleted: number;
    personsQueued: number;
  } = {
    lookup: 200,
    anonymousIds: [],
    deletion: 202,
    personsFound: 1,
    personsDeleted: 0,
    personsQueued: 1,
  };
  /** The distinct_ids of every bulk_delete PostHog received, per account. */
  const deletedIds = new Map<string, string[][]>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      query?: { values?: { account_id?: string } };
      distinct_ids?: string[];
    };
    if (url.endsWith('/query/')) {
      const accountId = body.query?.values?.account_id ?? '';
      return new Response(
        JSON.stringify({ results: replies.anonymousIds.map((anonymousId) => [anonymousId, [accountId]]) }),
        { status: replies.lookup },
      );
    }
    const [accountId = '', ...rest] = body.distinct_ids ?? [];
    deletedIds.set(accountId, [...(deletedIds.get(accountId) ?? []), [accountId, ...rest]]);
    return new Response(
      JSON.stringify({
        persons_found: replies.personsFound,
        persons_deleted: replies.personsDeleted,
        persons_queued_for_deletion: replies.personsQueued,
        events_queued_for_deletion: true,
        recordings_queued_for_deletion: true,
        deletion_errors: [],
      }),
      { status: replies.deletion },
    );
  };

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
    replies.lookup = 200;
    replies.anonymousIds = [];
    replies.deletion = 202;
    replies.personsFound = 1;
    replies.personsDeleted = 0;
    replies.personsQueued = 1;
  });

  const deleteStep = (distinctId: string): PosthogPersonDeletionJob => ({
    distinctId,
    reason: 'account_deleted',
    pass: 'first',
    anonymousIds: [],
    stage: 'delete',
  });

  it('completes a delete step PostHog accepted', async () => {
    const state = await workOne(deleteStep(randomUUID()));
    expect(state).toMatchObject({ state: 'completed', retry_count: 0, output: { outcome: 'deleted' } });
  });

  it('completes a delete step PostHog deleted in the request (synchronous mode)', async () => {
    replies.personsDeleted = 1;
    replies.personsQueued = 0;
    const state = await workOne(deleteStep(randomUUID()));
    expect(state).toMatchObject({ state: 'completed', retry_count: 0, output: { outcome: 'deleted' } });
  });

  it.each(['first', 'late'] as const)(
    'keeps the %s delete pass retryable when a matched person was neither deleted nor queued',
    async (pass) => {
      replies.personsFound = 1;
      replies.personsQueued = 0;
      const state = await workOne({ ...deleteStep(randomUUID()), pass });
      expect(state).toMatchObject({ state: 'retry', retry_count: 0 });
      expect(state.output).not.toMatchObject({ outcome: 'deleted' });
      expect(state.retry_in_seconds).toBeGreaterThanOrEqual(55);
    },
  );

  it('puts a delete step PostHog could not take yet back for a retry 60 to 120 s out', async () => {
    replies.deletion = 503;
    const state = await workOne(deleteStep(randomUUID()));
    // pg-boss counts the retry when it starts it, so none is spent yet.
    expect(state).toMatchObject({ state: 'retry', retry_count: 0 });
    expect(state.retry_in_seconds).toBeGreaterThanOrEqual(55);
    expect(state.retry_in_seconds).toBeLessThanOrEqual(120);
  });

  it('fails a delete step PostHog rejected outright, without spending the retries', async () => {
    replies.deletion = 400;
    const state = await workOne(deleteStep(randomUUID()));
    expect(state).toMatchObject({ state: 'failed', retry_count: 0, output: { outcome: 'rejected' } });
  });

  it('deletes nothing and retries when the lookup fails, so a fixed query can still find split persons', async () => {
    const distinctId = randomUUID();
    replies.lookup = 400;

    const state = await workOne({ distinctId, reason: 'account_deleted', pass: 'first' });

    expect(state).toMatchObject({ state: 'retry', retry_count: 0 });
    expect(deletedIds.get(distinctId)).toBeUndefined();
    expect((await erasureRows(distinctId)).map((row) => row.data.stage)).toEqual([undefined]);
  });

  it('still erases the account and its split person when the lookup returns an id longer than a job can carry', async () => {
    const distinctId = randomUUID();
    const boss = requireJobQueue();
    const lateId = await boss.send(
      POSTHOG_PERSON_DELETION_QUEUE,
      { distinctId, reason: 'account_deleted', pass: 'late' },
      { startAfter: LATE_PASS_DELAY_SECONDS },
    );
    if (!lateId) throw new Error('late pass not queued');
    replies.anonymousIds = ['x'.repeat(300), 'sdk-anon-split'];

    const first = await workOne({ distinctId, reason: 'account_deleted', pass: 'first' });
    expect(first).toMatchObject({ state: 'completed', output: { outcome: 'discovered' } });

    await waitUntil(
      () => erasureRows(distinctId),
      (rows) => rows.some((row) => row.data.stage === 'delete' && row.state !== 'created' && row.state !== 'active'),
    );
    const rows = await erasureRows(distinctId);
    expect(rows.find((row) => row.data.stage === 'delete')?.state).toBe('completed');
    expect(deletedIds.get(distinctId)).toEqual([[distinctId, 'sdk-anon-split']]);
    expect(rows.find((row) => row.id === lateId)?.data.anonymousIds).toEqual(['sdk-anon-split']);
  });

  it('persists the ids before deleting, and the late pass deletes them after their $identify events are gone', async () => {
    const distinctId = randomUUID();
    const boss = requireJobQueue();
    const lateId = await boss.send(
      POSTHOG_PERSON_DELETION_QUEUE,
      { distinctId, reason: 'consent_withdrawn', pass: 'late' },
      { startAfter: LATE_PASS_DELAY_SECONDS },
    );
    if (!lateId) throw new Error('late pass not queued');

    // First pass: the lookup finds a split person.
    replies.anonymousIds = ['sdk-anon-split'];
    const first = await workOne({ distinctId, reason: 'consent_withdrawn', pass: 'first' });
    expect(first).toMatchObject({ state: 'completed', output: { outcome: 'discovered' } });

    // The ids are on the late pass, written before any delete ran.
    const late = (await erasureRows(distinctId)).find((row) => row.id === lateId);
    expect(late?.data).toEqual({
      distinctId,
      reason: 'consent_withdrawn',
      pass: 'late',
      anonymousIds: ['sdk-anon-split'],
    });
    // The first pass's delete step carries them and erases both.
    await waitUntil(
      () => erasureRows(distinctId),
      (rows) => rows.some((row) => row.data.stage === 'delete' && row.state === 'completed'),
    );
    expect(deletedIds.get(distinctId)).toEqual([[distinctId, 'sdk-anon-split']]);

    // Seven days on, PostHog has deleted the $identify events: the lookup finds nothing.
    replies.anonymousIds = [];
    await boss.update(POSTHOG_PERSON_DELETION_QUEUE, undefined, { id: lateId, startAfter: new Date() });
    await waitUntil(
      () => jobState(lateId),
      (state) => state.state === 'completed',
    );
    await waitUntil(
      () => Promise.resolve(deletedIds.get(distinctId) ?? []),
      (calls) => calls.length === 2,
    );
    expect(deletedIds.get(distinctId)?.[1]).toEqual([distinctId, 'sdk-anon-split']);
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
