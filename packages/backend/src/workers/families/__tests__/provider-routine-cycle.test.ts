process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@boardsesh/crypto';
import { createDb } from '@boardsesh/db/client';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { auroraCredentials, backgroundJobRuns, providerSyncControls } from '@boardsesh/db/schema';
import { acquireCredentialSyncLease, rotateLinkGeneration } from '@boardsesh/db/queries';
import { enqueueBackgroundJob, executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../../jobs';
import type { BackgroundJobContext } from '../types';
import type { ProviderSyncAdapter, ProviderSyncOutcome } from '../provider-sync-batch';
import { AURORA_USER_ID, FIXTURE_BOARD, ensureBackgroundJobSchema } from './provider-sync-fixtures';

/**
 * The adapter each test runs with. Every cycle's claim is narrowed to this
 * file's accounts, so whatever else sits in the worker database is never
 * claimed. `sync` swaps the provider half for a stand-in; unset, the real
 * Aurora runner runs against the stubbed fetch.
 */
const adapterOverride = vi.hoisted(() => ({
  sync: undefined as
    | undefined
    | ((
        context: BackgroundJobContext,
        credential: { userId: string },
        transaction: Parameters<ProviderSyncAdapter['sync']>[1],
      ) => Promise<ProviderSyncOutcome>),
}));

vi.mock('../provider-sync-batch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider-sync-batch')>();
  const { and: andSql, like: likeSql } = await import('drizzle-orm');
  const { auroraCredentials: credentials } = await import('@boardsesh/db/schema');
  return {
    ...actual,
    loadProviderSyncAdapter: async (context: BackgroundJobContext, provider: 'aurora' | 'kilter') => {
      const real = await actual.loadProviderSyncAdapter(context, provider);
      const override = adapterOverride.sync;
      return {
        ...real,
        candidateFilter: andSql(real.candidateFilter, likeSql(credentials.userId, 'routine-%')),
        sync: override ? (credential, transaction) => override(context, credential, transaction) : real.sync,
      } satisfies ProviderSyncAdapter;
    },
  };
});

const role = 'routine-provider' as const;
const queue = BACKGROUND_JOB_QUEUES[role];
const ACCOUNTS = ['routine-a', 'routine-b', 'routine-c'] as const;
const database = createDb();
const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL!,
  max: 1,
  migrate: false,
  supervise: false,
  schedule: false,
});
boss.on('error', () => {});

/** A linked Tension account whose last attempt was `hoursAgo` hours ago, so claims go a, b, c. */
async function insertAccount(userId: string, hoursAgo: number): Promise<string> {
  await database.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${userId}, ${userId + '@test.com'}, 'Routine Tester', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
  await database.insert(auroraCredentials).values({
    userId,
    boardType: FIXTURE_BOARD,
    encryptedUsername: encrypt(`${userId}-login`),
    encryptedPassword: encrypt('hunter2'),
    auroraUserId: AURORA_USER_ID,
    syncStatus: 'active',
    lastSyncAttemptAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
  });
  const { linkGeneration } = await database.transaction((transaction) =>
    rotateLinkGeneration(transaction, { userId, boardType: FIXTURE_BOARD, linked: true }),
  );
  return linkGeneration;
}

async function removeAccounts() {
  await database.execute(sql`DELETE FROM aurora_credentials WHERE user_id LIKE 'routine-%'`);
  await database.execute(sql`DELETE FROM provider_sync_controls WHERE user_id LIKE 'routine-%'`);
  await database.execute(sql`DELETE FROM users WHERE id LIKE 'routine-%'`);
}

async function runCycle(signal = new AbortController().signal) {
  const { runId } = await enqueueBackgroundJob(database, boss, {
    family: 'provider-routine-cycle',
    payload: { provider: 'aurora' },
  });
  const [job] = await boss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
  expect(job?.id).toBe(runId);
  const result = await executeBackgroundJob(database, boss, job, handlerForRole(role), signal);
  return { runId, result };
}

const credentials = async () =>
  Object.fromEntries(
    (
      await database
        .select()
        .from(auroraCredentials)
        .where(and(like(auroraCredentials.userId, 'routine-%'), eq(auroraCredentials.boardType, FIXTURE_BOARD)))
    ).map((row) => [row.userId, row]),
  );

const controls = async () =>
  database
    .select()
    .from(providerSyncControls)
    .where(inArray(providerSyncControls.userId, [...ACCOUNTS]));

/** A stand-in provider that records who it synced and marks the credential synced through the fence. */
function recordingSync(synced: string[], afterEach?: (userId: string) => void | Promise<void>) {
  return async (
    _context: BackgroundJobContext,
    credential: { userId: string },
    transaction: Parameters<ProviderSyncAdapter['sync']>[1],
  ): Promise<ProviderSyncOutcome> => {
    await transaction((batch) =>
      batch
        .update(auroraCredentials)
        .set({ lastSyncAt: sql`now()` })
        .where(and(eq(auroraCredentials.userId, credential.userId), eq(auroraCredentials.boardType, FIXTURE_BOARD))),
    );
    synced.push(credential.userId);
    await afterEach?.(credential.userId);
    return { status: 'active' };
  };
}

function stubAuroraLogin(response: () => Response) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/sessions')) return response();
    throw new Error(`Unexpected request in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeAll(async () => {
  await ensureBackgroundJobSchema(owner);
  await boss.start();
});
beforeEach(async () => {
  await boss.deleteAllJobs(queue);
  await database.delete(backgroundJobRuns);
  await removeAccounts();
  await insertAccount('routine-a', 3);
  await insertAccount('routine-b', 2);
  await insertAccount('routine-c', 1);
  adapterOverride.sync = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await removeAccounts();
  await boss.stop({ graceful: true, close: true });
  await owner.end();
});

describe('provider-routine-cycle', () => {
  it('syncs at most ROUTINE_CYCLE_MAX_CREDENTIALS, oldest attempt first, and releases every lease', async () => {
    vi.stubEnv('ROUTINE_CYCLE_MAX_CREDENTIALS', '2');
    const synced: string[] = [];
    adapterOverride.sync = recordingSync(synced);
    const before = await credentials();

    const { runId, result } = await runCycle();

    expect(result).toBe('succeeded');
    expect((await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId)))[0].status).toBe(
      'succeeded',
    );
    expect(synced).toEqual(['routine-a', 'routine-b']);
    const after = await credentials();
    // The third account was never claimed: its attempt clock did not move.
    expect(after['routine-c'].lastSyncAttemptAt).toEqual(before['routine-c'].lastSyncAttemptAt);
    expect(after['routine-a'].lastSyncAttemptAt!.getTime()).toBeGreaterThan(
      before['routine-a'].lastSyncAttemptAt!.getTime(),
    );
    for (const control of await controls())
      expect(control).toMatchObject({ activeRunId: null, activeLeaseUntil: null });
  });

  it('claims nothing more once ROUTINE_CYCLE_BUDGET_MS has passed', async () => {
    vi.stubEnv('ROUTINE_CYCLE_BUDGET_MS', '1');
    const synced: string[] = [];
    adapterOverride.sync = recordingSync(synced, () => new Promise((resolve) => setTimeout(resolve, 20)));

    const { result } = await runCycle();

    expect(result).toBe('succeeded');
    expect(synced).toEqual(['routine-a']);
  });

  it('skips a credential another run holds a live lease on', async () => {
    const otherRun = randomUUID();
    await database.transaction((transaction) =>
      acquireCredentialSyncLease(transaction, {
        userId: 'routine-b',
        boardType: FIXTURE_BOARD,
        runId: otherRun,
        ttlMs: 60_000,
      }),
    );
    const synced: string[] = [];
    adapterOverride.sync = recordingSync(synced);
    const before = await credentials();

    expect((await runCycle()).result).toBe('succeeded');

    expect(synced).toEqual(['routine-a', 'routine-c']);
    expect((await credentials())['routine-b'].lastSyncAttemptAt).toEqual(before['routine-b'].lastSyncAttemptAt);
    const leased = (await controls()).find((control) => control.userId === 'routine-b');
    expect(leased?.activeRunId).toBe(otherRun);
  });

  it('stops between credentials when the worker aborts, keeping what already synced', async () => {
    const shutdown = new AbortController();
    const synced: string[] = [];
    adapterOverride.sync = recordingSync(synced, () => shutdown.abort());
    const before = await credentials();

    const { runId, result } = await runCycle(shutdown.signal);

    // The run records the abort; the cycle never claimed a second account.
    expect(result).toBe('failed');
    expect((await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId)))[0].status).toBe(
      'failed',
    );
    expect(synced).toEqual(['routine-a']);
    const after = await credentials();
    expect(after['routine-a'].lastSyncAt).not.toBeNull();
    expect(after['routine-b'].lastSyncAttemptAt).toEqual(before['routine-b'].lastSyncAttemptAt);
  });

  it('skips an account relinked mid-sync and carries on with the next', async () => {
    const synced: string[] = [];
    const record = recordingSync(synced);
    adapterOverride.sync = async (context, credential, transaction) => {
      if (credential.userId === 'routine-a') {
        // The climber relinks while their sync is between two batches.
        await database.transaction((batch) =>
          rotateLinkGeneration(batch, { userId: 'routine-a', boardType: FIXTURE_BOARD, linked: true }),
        );
      }
      return record(context, credential, transaction);
    };

    expect((await runCycle()).result).toBe('succeeded');

    expect(synced).toEqual(['routine-b', 'routine-c']);
    // The stale batch rolled back: nothing was written for the relinked account.
    expect((await credentials())['routine-a'].lastSyncAt).toBeNull();
  });

  it('records a credential failure on the account and still succeeds', async () => {
    // Aurora refuses every password: each account's failure goes through the
    // daemon's bookkeeping, none of them fails the run.
    const fetchMock = stubAuroraLogin(
      () =>
        new Response(JSON.stringify({ error: 'invalid' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const { result } = await runCycle();

    expect(result).toBe('succeeded');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const credential of Object.values(await credentials())) {
      expect(credential).toMatchObject({ syncStatus: 'error', consecutiveFailures: 1, credentialFailureCount: 1 });
      expect(credential.lastSyncError).toMatch(/Login failed/);
    }
    for (const control of await controls()) expect(control.activeRunId).toBeNull();
  });

  it('ends the cycle on a 429 with Retry-After and parks that account for the delay', async () => {
    const fetchMock = stubAuroraLogin(
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    );
    const before = await credentials();

    const { result } = await runCycle();

    // Throttling is not a failed run.
    expect(result).toBe('succeeded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const after = await credentials();
    const [{ parkedFor }] = await database.execute<{ parkedFor: number }>(sql`
      SELECT extract(epoch FROM last_sync_attempt_at - now())::float AS "parkedFor"
        FROM aurora_credentials WHERE user_id = 'routine-a' AND board_type = ${FIXTURE_BOARD}`);
    expect(parkedFor).toBeGreaterThan(100);
    expect(parkedFor).toBeLessThanOrEqual(121);
    // A transient failure: backoff counted, status untouched.
    expect(after['routine-a']).toMatchObject({ syncStatus: 'active', consecutiveFailures: 1 });
    expect(after['routine-b'].lastSyncAttemptAt).toEqual(before['routine-b'].lastSyncAttemptAt);
    expect(after['routine-c'].lastSyncAttemptAt).toEqual(before['routine-c'].lastSyncAttemptAt);
  });
});
