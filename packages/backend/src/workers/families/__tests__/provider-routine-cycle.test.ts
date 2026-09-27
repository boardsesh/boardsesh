process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@boardsesh/crypto';
import { createDb } from '@boardsesh/db/client';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { auroraCredentials, backgroundJobRuns, providerSyncControls } from '@boardsesh/db/schema';
import { acquireCredentialSyncLease, claimNextCredentialForSync, rotateLinkGeneration } from '@boardsesh/db/queries';
import { enqueueBackgroundJob, executeBackgroundJob, handlerForRole, type BackgroundJobPayload } from '../../jobs';
import { InvalidJobPayloadError, type BackgroundJobContext } from '../types';
import { providerRoutineCycleFamily } from '../provider-routine-cycle';
import {
  ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS,
  loadProviderSyncAdapter,
  runRoutineCredentialSync,
  type ProviderSyncAdapter,
  type ProviderSyncOutcome,
} from '../provider-sync-batch';
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
        signal?: AbortSignal,
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
        sync: override
          ? (credential, transaction, signal) => override(context, credential, transaction, signal)
          : real.sync,
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

/**
 * A linked Tension account whose last attempt was `hoursAgo` hours ago, so
 * claims go a, b, c. It synced once before unless `neverSynced`: a never-synced
 * account is handed to the interactive family instead of synced in the cycle.
 */
async function insertAccount(userId: string, hoursAgo: number, { neverSynced = false } = {}): Promise<string> {
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
    lastSyncAt: neverSynced ? null : new Date(Date.now() - 24 * 60 * 60 * 1000),
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

/** The cycle runs this file created; cleanup deletes only these and the interactive runs they queued. */
const cycleRunIds: string[] = [];

async function removeRuns() {
  await database
    .delete(backgroundJobRuns)
    .where(
      or(
        cycleRunIds.length > 0 ? inArray(backgroundJobRuns.id, cycleRunIds) : undefined,
        sql`${backgroundJobRuns.payload}->>'userId' LIKE 'routine-%'`,
      ),
    );
  cycleRunIds.length = 0;
}

async function runCycle(signal = new AbortController().signal) {
  const { runId } = await enqueueBackgroundJob(database, boss, {
    family: 'provider-routine-cycle',
    payload: { provider: 'aurora' },
  });
  cycleRunIds.push(runId);
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
  await boss.deleteAllJobs(BACKGROUND_JOB_QUEUES['interactive-import']);
  await removeRuns();
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
  await removeRuns();
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
    expect(after['routine-a'].lastSyncAt!.getTime()).toBeGreaterThan(before['routine-a'].lastSyncAt!.getTime());
    expect(after['routine-b'].lastSyncAttemptAt).toEqual(before['routine-b'].lastSyncAttemptAt);
  });

  it('skips an account relinked mid-sync and carries on with the next', async () => {
    const synced: string[] = [];
    const record = recordingSync(synced);
    const before = await credentials();
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
    expect((await credentials())['routine-a'].lastSyncAt).toEqual(before['routine-a'].lastSyncAt);
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
    const [{ parkedFor, attemptInPast }] = await database.execute<{ parkedFor: number; attemptInPast: boolean }>(sql`
      SELECT extract(epoch FROM provider_retry_after_until - now())::float AS "parkedFor",
             last_sync_attempt_at <= now() AS "attemptInPast"
        FROM aurora_credentials WHERE user_id = 'routine-a' AND board_type = ${FIXTURE_BOARD}`);
    expect(parkedFor).toBeGreaterThan(100);
    expect(parkedFor).toBeLessThanOrEqual(121);
    // The hold has its own column; the attempt clock stays the claim's stamp.
    expect(attemptInPast).toBe(true);
    // A transient failure, status untouched; the park replaces the backoff
    // step the failure was charged, so the delay is not counted twice.
    expect(after['routine-a']).toMatchObject({ syncStatus: 'active', consecutiveFailures: 0 });
    expect(after['routine-a'].lastSyncError).toBeTruthy();
    expect(after['routine-b'].lastSyncAttemptAt).toEqual(before['routine-b'].lastSyncAttemptAt);
    expect(after['routine-c'].lastSyncAttemptAt).toEqual(before['routine-c'].lastSyncAttemptAt);
  });

  it('hands a never-synced account to its interactive family and coalesces onto that run', async () => {
    await removeAccounts();
    const linkGeneration = await insertAccount('routine-a', 3, { neverSynced: true });
    await insertAccount('routine-b', 2);
    const synced: string[] = [];
    adapterOverride.sync = recordingSync(synced);

    expect((await runCycle()).result).toBe('succeeded');

    // The first sync goes to the 30-minute interactive lease; the cycle moves on.
    expect(synced).toEqual(['routine-b']);
    const interactive = await database
      .select()
      .from(backgroundJobRuns)
      .where(eq(backgroundJobRuns.family, 'aurora-user-sync'));
    expect(interactive).toHaveLength(1);
    expect(interactive[0]).toMatchObject({
      role: 'interactive-import',
      status: 'queued',
      payload: { userId: 'routine-a', boardType: FIXTURE_BOARD, linkGeneration, requestedBy: 'routine' },
    });
    const control = (await controls()).find((row) => row.userId === 'routine-a');
    expect(control).toMatchObject({ pendingRunId: interactive[0].id, activeRunId: null });

    // The next cycle that claims it joins the queued run instead of queueing another.
    await database
      .update(auroraCredentials)
      .set({ lastSyncAttemptAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
      .where(eq(auroraCredentials.userId, 'routine-a'));
    expect((await runCycle()).result).toBe('succeeded');
    expect(
      await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.family, 'aurora-user-sync')),
    ).toHaveLength(1);
    expect(synced).toEqual(['routine-b']);
  });

  it('stops a credential at the cycle deadline and records a transient CYCLE_DEADLINE failure', async () => {
    // Aurora's login hangs until the request is aborted.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );
    const [claimed] = await database.select().from(auroraCredentials).where(eq(auroraCredentials.userId, 'routine-a'));
    const shutdown = new AbortController();
    const context: BackgroundJobContext = {
      runId: randomUUID(),
      family: 'provider-routine-cycle',
      signal: shutdown.signal,
      // One second of deadline left once the one-minute margin is taken off.
      expiresAt: Date.now() + ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS + 1_000,
      database,
      transaction: (callback) => database.transaction(callback),
      enqueue: async () => {
        throw new Error('enqueue not expected');
      },
    };
    const adapter = await loadProviderSyncAdapter(context, 'aurora');

    const outcome = await runRoutineCredentialSync(context, claimed, adapter);

    expect(outcome).toEqual({ result: 'failed', reason: 'CYCLE_DEADLINE' });
    expect(shutdown.signal.aborted).toBe(false);
    const credential = (await credentials())['routine-a'];
    // Backoff counts it and the operator can see it; the climber's card does not change.
    expect(credential).toMatchObject({ consecutiveFailures: 1, lastSyncError: 'CYCLE_DEADLINE', syncStatus: 'active' });
    const control = (await controls()).find((row) => row.userId === 'routine-a');
    expect(control?.activeRunId).toBeNull();
  });
});

describe('runRoutineCredentialSync first-sync fallback', () => {
  function contextWithEnqueue(enqueue: BackgroundJobContext['enqueue']): BackgroundJobContext {
    return {
      runId: randomUUID(),
      family: 'provider-routine-cycle',
      signal: new AbortController().signal,
      expiresAt: Date.now() + 60 * 60 * 1000,
      database,
      transaction: (callback) => database.transaction(callback),
      enqueue,
    };
  }

  const inlineAdapter = (synced: string[]) => ({
    interactiveFamily: 'aurora-user-sync' as const,
    sync: async (credential: { userId: string }) => {
      synced.push(credential.userId);
      return { status: 'active' as const };
    },
    recordTransientFailure: async () => {},
  });

  it('syncs inline when the interactive family refuses the payload (the typed error)', async () => {
    await removeAccounts();
    await insertAccount('routine-a', 3, { neverSynced: true });
    const [claimed] = await database.select().from(auroraCredentials).where(eq(auroraCredentials.userId, 'routine-a'));
    const synced: string[] = [];

    const outcome = await runRoutineCredentialSync(
      contextWithEnqueue(async () => {
        throw new InvalidJobPayloadError();
      }),
      claimed,
      inlineAdapter(synced) as unknown as Parameters<typeof runRoutineCredentialSync>[2],
    );

    expect(outcome).toMatchObject({ result: 'synced' });
    expect(synced).toEqual(['routine-a']);
  });

  it('does not treat another error that merely says INVALID_PAYLOAD as a refused payload', async () => {
    await removeAccounts();
    await insertAccount('routine-a', 3, { neverSynced: true });
    const [claimed] = await database.select().from(auroraCredentials).where(eq(auroraCredentials.userId, 'routine-a'));
    const synced: string[] = [];

    await expect(
      runRoutineCredentialSync(
        contextWithEnqueue(async () => {
          throw new Error('INVALID_PAYLOAD');
        }),
        claimed,
        inlineAdapter(synced) as unknown as Parameters<typeof runRoutineCredentialSync>[2],
      ),
    ).rejects.toThrow('INVALID_PAYLOAD');
    expect(synced).toEqual([]);
  });
});

describe('runRoutineCredentialSync binds the run to the credential as it is now', () => {
  const enqueued: unknown[] = [];
  function routineContext(): BackgroundJobContext {
    return {
      runId: randomUUID(),
      family: 'provider-routine-cycle',
      signal: new AbortController().signal,
      expiresAt: Date.now() + 60 * 60 * 1000,
      database,
      transaction: (callback) => database.transaction(callback),
      enqueue: async (_transaction, request) => {
        enqueued.push(request);
        throw new Error('enqueue not expected');
      },
    };
  }

  const claim = (userId: string) =>
    database.transaction((transaction) =>
      claimNextCredentialForSync(transaction, {
        candidateFilter: eq(auroraCredentials.userId, userId),
        excludeLeased: true,
      }),
    );

  /** What saveAuroraCredential does to a relinked account: a new generation and new secrets, in one transaction. */
  const relink = (userId: string) =>
    database.transaction(async (transaction) => {
      await rotateLinkGeneration(transaction, { userId, boardType: FIXTURE_BOARD, linked: true });
      await transaction
        .update(auroraCredentials)
        .set({ encryptedPassword: encrypt('the-new-accounts-password'), updatedAt: sql`now()` })
        .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, FIXTURE_BOARD)));
    });

  beforeEach(() => {
    enqueued.length = 0;
  });

  it('skips a credential relinked between the claim and the fence, signing in with nothing', async () => {
    const fetchMock = stubAuroraLogin(() => new Response('{}', { status: 200 }));
    const claimed = await claim('routine-a');
    expect(claimed?.userId).toBe('routine-a');
    const before = (await credentials())['routine-a'];

    // The relink lands after the claim returned its snapshot but before the
    // routine sync reads the control row: the fence would adopt the new
    // generation while the snapshot still carries the old account's secrets.
    await relink('routine-a');
    const context = routineContext();
    const adapter = await loadProviderSyncAdapter(context, 'aurora');

    const outcome = await runRoutineCredentialSync(context, claimed!, adapter);

    expect(outcome).toEqual({ result: 'skipped', reason: 'CREDENTIAL_RELINKED' });
    // No sign-in with either account's secrets, and nothing recorded.
    expect(fetchMock).not.toHaveBeenCalled();
    const after = (await credentials())['routine-a'];
    expect(after).toMatchObject({
      syncStatus: before.syncStatus,
      lastSyncAt: before.lastSyncAt,
      consecutiveFailures: before.consecutiveFailures,
      lastSyncError: before.lastSyncError,
    });
    const control = (await controls()).find((row) => row.userId === 'routine-a');
    expect(control).toMatchObject({ activeRunId: null, activeLeaseUntil: null });
  });

  it('applies the same check to the first-sync handoff: nothing queued for a relinked account', async () => {
    await removeAccounts();
    await insertAccount('routine-a', 3, { neverSynced: true });
    const claimed = await claim('routine-a');
    await relink('routine-a');
    const context = routineContext();
    const adapter = await loadProviderSyncAdapter(context, 'aurora');

    const outcome = await runRoutineCredentialSync(context, claimed!, adapter);

    expect(outcome).toEqual({ result: 'skipped', reason: 'CREDENTIAL_RELINKED' });
    expect(enqueued).toEqual([]);
    const control = (await controls()).find((row) => row.userId === 'routine-a');
    expect(control).toMatchObject({ activeRunId: null, pendingRunId: null });
  });

  it('syncs the row it re-read, not the snapshot, when nothing changed', async () => {
    const claimed = await claim('routine-a');
    const seen: unknown[] = [];
    adapterOverride.sync = async (_context, credential) => {
      seen.push(credential);
      return { status: 'active' };
    };
    const context = routineContext();
    const adapter = await loadProviderSyncAdapter(context, 'aurora');

    expect(await runRoutineCredentialSync(context, claimed!, adapter)).toEqual({ result: 'synced' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(claimed);
    expect(seen[0]).toMatchObject({ id: claimed!.id, userId: 'routine-a' });
  });
});

describe('queue share on the routine-provider queue', () => {
  const enqueue = async (family: string, payload: Record<string, unknown>) => {
    const { runId } = await enqueueBackgroundJob(database, boss, { family, payload });
    cycleRunIds.push(runId);
    return runId;
  };
  const fetchNext = async () => {
    const [job] = await boss.fetch<BackgroundJobPayload>(queue, { includeMetadata: true, batchSize: 1 });
    return job?.id;
  };

  it('fetches a board-wide job no later than third behind two routine cycles, even as new cycles arrive', async () => {
    const auroraCycle = await enqueue('provider-routine-cycle', { provider: 'aurora' });
    const kilterCycle = await enqueue('provider-routine-cycle', { provider: 'kilter' });
    const sharedSync = await enqueue('aurora-shared-sync', { board: 'tension' });

    // Each cycle finishes and the next five-minute tick queues its successor
    // before the worker fetches again: the stream of cycles never runs dry.
    expect(await fetchNext()).toBe(auroraCycle);
    await boss.complete(queue, auroraCycle);
    await enqueue('provider-routine-cycle', { provider: 'aurora' });
    expect(await fetchNext()).toBe(kilterCycle);
    await boss.complete(queue, kilterCycle);
    await enqueue('provider-routine-cycle', { provider: 'kilter' });

    // At a lower priority the shared job would wait behind both new cycles,
    // and every cycle after them; at the same priority FIFO order runs it now.
    expect(await fetchNext()).toBe(sharedSync);
  });
});

describe('a routine cycle near the end of its lease', () => {
  function nearDeadlineContext(leftMs: number): BackgroundJobContext {
    return {
      runId: randomUUID(),
      family: 'provider-routine-cycle',
      signal: new AbortController().signal,
      expiresAt: Date.now() + leftMs,
      database,
      transaction: (callback) => database.transaction(callback),
      enqueue: async () => {
        throw new Error('enqueue not expected');
      },
    };
  }

  it('ends a cycle that starts with under a minute of lease left before loading anything (CYCLE_LATE)', async () => {
    const synced: string[] = [];
    adapterOverride.sync = recordingSync(synced);
    const before = await credentials();
    const context = nearDeadlineContext(ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS - 1_000);
    const transaction = vi.spyOn(context, 'transaction');

    await providerRoutineCycleFamily.execute(context, { provider: 'aurora' });

    // Not one fenced batch: no claim, no control row, no attempt clock.
    expect(transaction).not.toHaveBeenCalled();
    expect(synced).toEqual([]);
    expect(await credentials()).toEqual(before);
  });

  it('stops claiming once the lease runs down to the last minute mid-cycle, moving no further attempt clock', async () => {
    // Enough lease to start and sync one credential, which takes half a second;
    // after it, under a minute is left.
    const synced: string[] = [];
    adapterOverride.sync = recordingSync(synced, () => new Promise((resolve) => setTimeout(resolve, 500)));
    const before = await credentials();

    await providerRoutineCycleFamily.execute(nearDeadlineContext(ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS + 300), {
      provider: 'aurora',
    });

    expect(synced).toEqual(['routine-a']);
    const after = await credentials();
    expect(after['routine-b'].lastSyncAttemptAt).toEqual(before['routine-b'].lastSyncAttemptAt);
    expect(after['routine-c'].lastSyncAttemptAt).toEqual(before['routine-c'].lastSyncAttemptAt);
  });

  it('skips a claimed credential whose lease ran down before it started, recording nothing', async () => {
    const fetchMock = stubAuroraLogin(() => new Response('{}', { status: 200 }));
    const [claimed] = await database.select().from(auroraCredentials).where(eq(auroraCredentials.userId, 'routine-a'));
    const context = nearDeadlineContext(ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS - 1_000);
    const adapter = await loadProviderSyncAdapter(context, 'aurora');
    const before = (await credentials())['routine-a'];

    expect(await runRoutineCredentialSync(context, claimed, adapter)).toEqual({
      result: 'skipped',
      reason: 'CYCLE_DEADLINE_NEAR',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await credentials())['routine-a']).toMatchObject({
      consecutiveFailures: before.consecutiveFailures,
      lastSyncError: before.lastSyncError,
    });
    const control = (await controls()).find((row) => row.userId === 'routine-a');
    expect(control).toMatchObject({ activeRunId: null });
  });
});
