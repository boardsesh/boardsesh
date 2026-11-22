import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import { auroraCredentials, backgroundJobRuns, providerSyncControls } from '@boardsesh/db/schema';
import {
  StaleLinkGenerationError,
  isSyncFenceError,
  acquireCredentialSyncLease,
  assertLinkGenerationCurrent,
  claimCredentialForRun,
  claimNextCredentialForSync,
  deferCredentialSyncAttempt,
  findSharedSyncDonorCredential,
  clearFinishedProviderSyncRuns,
  coalesceInteractiveRun,
  releaseCredentialSyncLease,
  rotateLinkGeneration,
  setPendingProviderSyncRun,
} from '@boardsesh/db/queries';
import type { BackgroundJobStatus } from '@boardsesh/db/background-jobs';
import { ensureBackgroundJobSchema } from '../workers/families/__tests__/provider-sync-fixtures';

/**
 * The provider sync fences against real Postgres: the row locks, the
 * database-clock lease and the ledger joins are the behaviour under test.
 */
const database = createDb();
const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const USER_ID = 'psc-user';
const OTHER_USER_ID = 'psc-other-user';
const key = { userId: USER_ID, boardType: 'tension' };

const control = async () =>
  (
    await database
      .select()
      .from(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, USER_ID), eq(providerSyncControls.boardType, 'tension')))
  )[0];

async function insertRun(
  status: BackgroundJobStatus,
  overrides: Partial<typeof backgroundJobRuns.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await database.insert(backgroundJobRuns).values({
    id,
    queue: 'background-interactive-import',
    role: 'interactive-import',
    family: 'aurora-user-sync',
    status,
    deadlineAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  });
  return id;
}

async function insertCredential(userId: string, overrides: Partial<typeof auroraCredentials.$inferInsert> = {}) {
  await database.insert(auroraCredentials).values({
    userId,
    boardType: 'tension',
    encryptedUsername: 'u',
    encryptedPassword: 'p',
    auroraUserId: 1,
    syncStatus: 'active',
    ...overrides,
  });
}

beforeAll(async () => {
  await ensureBackgroundJobSchema(owner);
});
beforeEach(async () => {
  for (const userId of [USER_ID, OTHER_USER_ID]) {
    await database.execute(sql`DELETE FROM aurora_credentials WHERE user_id = ${userId}`);
    await database.execute(sql`DELETE FROM provider_sync_controls WHERE user_id = ${userId}`);
    await database.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${userId}, ${userId + '@test.com'}, 'Control Tester', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
  }
  await database.delete(backgroundJobRuns);
});
afterAll(async () => {
  await database.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`);
  await owner.end();
});

describe('link generation', () => {
  it('creates the row on first link and starts a new generation on every relink, dropping the old run state', async () => {
    const first = await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    await database
      .update(providerSyncControls)
      .set({
        pendingRunId: randomUUID(),
        activeRunId: randomUUID(),
        activeLeaseUntil: new Date(Date.now() + 60_000),
        notifyRequester: true,
      })
      .where(eq(providerSyncControls.userId, USER_ID));

    const second = await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));

    expect(second.linkGeneration).not.toBe(first.linkGeneration);
    expect(await control()).toMatchObject({
      linkGeneration: second.linkGeneration,
      linked: true,
      pendingRunId: null,
      activeRunId: null,
      activeLeaseUntil: null,
      notifyRequester: false,
    });
  });

  it('accepts only the current generation of a linked account', async () => {
    const { linkGeneration } = await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    await expect(
      database.transaction((tx) => assertLinkGenerationCurrent(tx, { ...key, linkGeneration })),
    ).resolves.toBeUndefined();
    await expect(
      database.transaction((tx) => assertLinkGenerationCurrent(tx, { ...key, linkGeneration: randomUUID() })),
    ).rejects.toBeInstanceOf(StaleLinkGenerationError);
    await expect(
      database.transaction((tx) =>
        assertLinkGenerationCurrent(tx, { userId: OTHER_USER_ID, boardType: 'tension', linkGeneration }),
      ),
    ).rejects.toBeInstanceOf(StaleLinkGenerationError);

    // Unlinking keeps the row, with a generation no queued job holds.
    const unlinked = await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: false }));
    expect((await control()).linked).toBe(false);
    await expect(
      database.transaction((tx) =>
        assertLinkGenerationCurrent(tx, { ...key, linkGeneration: unlinked.linkGeneration }),
      ),
    ).rejects.toBeInstanceOf(StaleLinkGenerationError);
  });

  it('makes a relink wait for a batch holding the generation, then fails the next batch', async () => {
    const { linkGeneration } = await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    let releaseBatch!: () => void;
    const batchHeld = new Promise<void>((resolve) => (releaseBatch = resolve));
    let batchStarted!: () => void;
    const started = new Promise<void>((resolve) => (batchStarted = resolve));
    const batch = database.transaction(async (tx) => {
      await assertLinkGenerationCurrent(tx, { ...key, linkGeneration });
      batchStarted();
      await batchHeld;
    });
    await started;
    let relinked = false;
    const relink = database
      .transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }))
      .then(() => (relinked = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(relinked).toBe(false);
    releaseBatch();
    await batch;
    await relink;
    await expect(
      database.transaction((tx) => assertLinkGenerationCurrent(tx, { ...key, linkGeneration })),
    ).rejects.toBeInstanceOf(StaleLinkGenerationError);
  });
});

describe('a board-wide job holding the donor it borrowed', () => {
  const holdOf = async () =>
    (
      await database
        .select({ until: auroraCredentials.providerRetryAfterUntil })
        .from(auroraCredentials)
        .where(eq(auroraCredentials.userId, USER_ID))
    )[0].until;
  const borrow = async () => {
    const donor = await findSharedSyncDonorCredential(database, {
      boardType: 'tension',
      candidateFilter: eq(auroraCredentials.userId, USER_ID),
    });
    if (!donor) throw new Error('expected a donor');
    return donor;
  };
  const holdBorrowed = (donor: Awaited<ReturnType<typeof borrow>>) =>
    deferCredentialSyncAttempt(database, {
      ...key,
      delayMs: 60 * 60 * 1000,
      onlyLink: { id: donor.id, linkGeneration: donor.linkGeneration },
    });

  it('holds the donor when its link is unchanged', async () => {
    await insertCredential(USER_ID, { lastSyncAt: new Date() });
    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    const donor = await borrow();
    expect(donor.linkGeneration).not.toBeNull();

    await holdBorrowed(donor);
    expect(await holdOf()).not.toBeNull();
  });

  it('leaves a credential relinked during the run unheld', async () => {
    await insertCredential(USER_ID, { lastSyncAt: new Date() });
    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    const donor = await borrow();

    // The climber relinks while the shared sync runs on the old token.
    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    await holdBorrowed(donor);

    expect(await holdOf()).toBeNull();
  });

  it('binds a donor read before any control row existed to that state', async () => {
    await insertCredential(USER_ID, { lastSyncAt: new Date() });
    const donor = await borrow();
    expect(donor.linkGeneration).toBeNull();

    // A first link since then creates the control row: that is a relink too.
    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    await holdBorrowed(donor);
    expect(await holdOf()).toBeNull();
  });
});

describe('relink and the provider Retry-After hold', () => {
  const holdOf = async () =>
    (
      await database
        .select({ until: auroraCredentials.providerRetryAfterUntil })
        .from(auroraCredentials)
        .where(eq(auroraCredentials.userId, USER_ID))
    )[0].until;

  it('a relink ends the hold; an unlink leaves it', async () => {
    const until = new Date(Date.now() + 5 * 60 * 60 * 1000);
    await insertCredential(USER_ID, { providerRetryAfterUntil: until });

    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: false }));
    expect(await holdOf()).toEqual(until);

    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    expect(await holdOf()).toBeNull();
  });
});

describe('fence errors', () => {
  it('are the fence refusals only, never an error that merely looks like an abort', () => {
    expect(isSyncFenceError(new StaleLinkGenerationError())).toBe(true);
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    // A daemon's own timeout must still be recorded against the credential.
    expect(isSyncFenceError(timeout)).toBe(false);
  });
});

describe('credential lease', () => {
  it('is free, renewable by its holder, closed to others while live and open again once expired', async () => {
    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    const holder = randomUUID();
    const other = randomUUID();
    const acquire = (runId: string, ttlMs = 60_000) =>
      database.transaction((tx) => acquireCredentialSyncLease(tx, { ...key, runId, ttlMs }));

    expect(await acquire(holder)).toBe(true);
    expect(await acquire(holder)).toBe(true);
    expect(await acquire(other)).toBe(false);

    // Only the holder can release it.
    await database.transaction((tx) => releaseCredentialSyncLease(tx, { ...key, runId: other }));
    expect((await control()).activeRunId).toBe(holder);
    await database.transaction((tx) => releaseCredentialSyncLease(tx, { ...key, runId: holder }));
    expect(await control()).toMatchObject({ activeRunId: null, activeLeaseUntil: null });

    expect(await acquire(holder, 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await acquire(other)).toBe(true);
    expect((await control()).activeRunId).toBe(other);
  });
});

describe('interactive run coalescing', () => {
  it('joins the pending run while it is queued, running or retrying, and not after it finished', async () => {
    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    expect(await database.transaction((tx) => coalesceInteractiveRun(tx, key))).toBeNull();

    for (const status of ['queued', 'running', 'retrying'] as const) {
      const runId = await insertRun(status);
      await database.transaction((tx) => setPendingProviderSyncRun(tx, { ...key, runId }));
      expect(await database.transaction((tx) => coalesceInteractiveRun(tx, key))).toEqual({ runId, status });
    }
    const finished = await insertRun('succeeded');
    await database.transaction((tx) => setPendingProviderSyncRun(tx, { ...key, runId: finished }));
    expect(await database.transaction((tx) => coalesceInteractiveRun(tx, key))).toBeNull();
  });
});

describe('reconciler step', () => {
  const credential = async () =>
    (
      await database
        .select()
        .from(auroraCredentials)
        .where(and(eq(auroraCredentials.userId, USER_ID), eq(auroraCredentials.boardType, 'tension')))
    )[0];
  const incompleteMessage = 'Your board import did not finish. Try Sync now again.';

  async function interruptedImport(
    overrides: Partial<typeof backgroundJobRuns.$inferInsert> = {},
    credentialOverrides: Partial<typeof auroraCredentials.$inferInsert> = {},
  ) {
    await insertCredential(USER_ID, { syncStatus: 'pending', ...credentialOverrides });
    const { linkGeneration } = await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    const runId = await insertRun('failed', {
      errorCode: 'RETRIES_EXHAUSTED',
      payload: { ...key, linkGeneration, requestedBy: 'link' },
      createdAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
      ...overrides,
    });
    await database
      .update(providerSyncControls)
      .set({ pendingRunId: runId, activeRunId: runId, activeLeaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(providerSyncControls.userId, USER_ID));
    return { runId, linkGeneration };
  }

  it('clears pending runs and leases whose run finished or vanished, and keeps live ones', async () => {
    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    await database.transaction((tx) =>
      rotateLinkGeneration(tx, { userId: OTHER_USER_ID, boardType: 'tension', linked: true }),
    );
    const failed = await insertRun('failed');
    const live = await insertRun('running');
    await database
      .update(providerSyncControls)
      .set({ pendingRunId: failed, activeRunId: randomUUID(), activeLeaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(providerSyncControls.userId, USER_ID));
    await database
      .update(providerSyncControls)
      .set({ pendingRunId: live, activeRunId: live, activeLeaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(providerSyncControls.userId, OTHER_USER_ID));

    expect(await clearFinishedProviderSyncRuns(database)).toBe(1);

    expect(await control()).toMatchObject({ pendingRunId: null, activeRunId: null, activeLeaseUntil: null });
    const [other] = await database
      .select()
      .from(providerSyncControls)
      .where(eq(providerSyncControls.userId, OTHER_USER_ID));
    expect(other).toMatchObject({ pendingRunId: live, activeRunId: live });
  });

  it('explains an exhausted first import, clears its pointers, and keeps the account retryable', async () => {
    await interruptedImport();

    expect(await clearFinishedProviderSyncRuns(database)).toBe(1);
    expect(await control()).toMatchObject({ pendingRunId: null, activeRunId: null, activeLeaseUntil: null });
    expect(await credential()).toMatchObject({
      syncStatus: 'error',
      syncError: incompleteMessage,
      lastSyncError: incompleteMessage,
      lastSyncAt: null,
      consecutiveFailures: 0,
      credentialFailureCount: 0,
    });
    expect(
      await claimCredentialForRun(database, { ...key, candidateFilter: eq(auroraCredentials.syncStatus, 'error') }),
    ).not.toBeNull();
    expect(await clearFinishedProviderSyncRuns(database)).toBe(0);
  });

  it.each(['QUEUE_EXPIRED', 'JOB_MISSING', 'RESULT_MISSING', 'ATTEMPT_FAILED'])(
    'explains a terminal %s import without changing its authentication state',
    async (errorCode) => {
      await interruptedImport({ errorCode });
      await clearFinishedProviderSyncRuns(database);
      expect(await credential()).toMatchObject({ syncError: incompleteMessage, credentialFailureCount: 0 });
    },
  );

  it('can explain a failed run left only in the active lease', async () => {
    await interruptedImport();
    await database
      .update(providerSyncControls)
      .set({ pendingRunId: null })
      .where(eq(providerSyncControls.userId, USER_ID));

    await clearFinishedProviderSyncRuns(database);
    expect(await credential()).toMatchObject({ syncStatus: 'error', syncError: incompleteMessage });
    expect((await control()).activeRunId).toBeNull();
  });

  it.each(['queued', 'running', 'retrying'] as const)(
    'leaves a replacement %s import alone while clearing the old failed lease',
    async (status) => {
      await interruptedImport();
      const replacement = await insertRun(status);
      await database.transaction((tx) => setPendingProviderSyncRun(tx, { ...key, runId: replacement }));

      await clearFinishedProviderSyncRuns(database);
      expect(await control()).toMatchObject({ pendingRunId: replacement, activeRunId: null });
      expect(await credential()).toMatchObject({ syncStatus: 'pending', syncError: null });
    },
  );

  it('preserves a successful import completed after the failed run was requested', async () => {
    const lastSyncAt = new Date();
    await interruptedImport({}, { syncStatus: 'active', lastSyncAt });

    await clearFinishedProviderSyncRuns(database);
    expect(await credential()).toMatchObject({ syncStatus: 'active', syncError: null, lastSyncAt });
    expect((await control()).pendingRunId).toBeNull();
  });

  it('reports a new failed import after an older successful sync', async () => {
    const lastSyncAt = new Date(Date.now() - 3_600_000);
    await interruptedImport({}, { syncStatus: 'active', lastSyncAt });

    await clearFinishedProviderSyncRuns(database);
    expect(await credential()).toMatchObject({ syncStatus: 'error', syncError: incompleteMessage, lastSyncAt });
  });

  it.each([
    { syncStatus: 'error', syncError: 'Existing provider failure' },
    { syncStatus: 'active', syncError: 'duplicate-board-account-link:circuits:foreign' },
    { syncStatus: 'expired', syncError: null },
  ])('preserves existing credential status $syncStatus / $syncError', async (existing) => {
    await interruptedImport({}, existing);

    await clearFinishedProviderSyncRuns(database);
    expect(await credential()).toMatchObject(existing);
  });

  it.each([
    { status: 'succeeded' as const, errorCode: null },
    { status: 'cancelled' as const, errorCode: 'JOB_CANCELLED' },
    { status: 'failed' as const, errorCode: 'STALE_LINK_GENERATION' },
    { status: 'failed' as const, errorCode: 'CREDENTIAL_UNAVAILABLE' },
  ])('does not turn $status / $errorCode into a credential failure', async (outcome) => {
    await interruptedImport(outcome);

    await clearFinishedProviderSyncRuns(database);
    expect(await credential()).toMatchObject({ syncStatus: 'pending', syncError: null });
  });

  it.each(['userId', 'boardType', 'linkGeneration'] as const)(
    'ignores a failed import whose payload has a different %s',
    async (field) => {
      const { runId, linkGeneration } = await interruptedImport();
      await database
        .update(backgroundJobRuns)
        .set({ payload: { ...key, linkGeneration, requestedBy: 'link', [field]: randomUUID() } })
        .where(eq(backgroundJobRuns.id, runId));

      await clearFinishedProviderSyncRuns(database);
      expect(await credential()).toMatchObject({ syncStatus: 'pending', syncError: null });
    },
  );

  it('preserves the fresh link after an old failed import', async () => {
    const { linkGeneration } = await interruptedImport();
    const relinked = await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    expect(relinked.linkGeneration).not.toBe(linkGeneration);

    expect(await clearFinishedProviderSyncRuns(database)).toBe(0);
    expect(await credential()).toMatchObject({ syncStatus: 'pending', syncError: null });
  });

  it.each(['relink', 'replacement run'] as const)(
    'rechecks an observed failed run after waiting for a concurrent %s',
    async (change) => {
      await interruptedImport();
      const replacement = await insertRun('queued');
      let finishChange!: () => void;
      const changeAllowed = new Promise<void>((resolve) => (finishChange = resolve));
      let locked!: (pid: number) => void;
      const lockHeld = new Promise<number>((resolve) => (locked = resolve));
      const concurrentChange = database.transaction(async (transaction) => {
        await transaction
          .select()
          .from(providerSyncControls)
          .where(eq(providerSyncControls.userId, USER_ID))
          .for('update');
        const [backend] = await transaction.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        locked(backend.pid);
        await changeAllowed;
        if (change === 'relink') await rotateLinkGeneration(transaction, { ...key, linked: true });
        await setPendingProviderSyncRun(transaction, { ...key, runId: replacement });
      });
      const blockingPid = await lockHeld;
      const reconciliation = clearFinishedProviderSyncRuns(database);
      try {
        // Observe the actual lock wait, rather than assuming a timer means the
        // reconciler already read the old generation/run pointers.
        await expect
          .poll(async () => {
            const [waiting] = await owner<{ count: number }[]>`
              SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE ${blockingPid} = ANY(pg_blocking_pids(pid))
            `;
            return waiting.count;
          })
          .toBeGreaterThan(0);
      } finally {
        finishChange();
        await concurrentChange;
      }

      expect(await reconciliation).toBe(0);
      expect((await control()).pendingRunId).toBe(replacement);
      expect(await credential()).toMatchObject({ syncStatus: 'pending', syncError: null });
    },
  );

  it('clears stale pointers without reporting errors on an unlinked account', async () => {
    await interruptedImport();
    await database.update(providerSyncControls).set({ linked: false }).where(eq(providerSyncControls.userId, USER_ID));

    await clearFinishedProviderSyncRuns(database);
    expect(await credential()).toMatchObject({ syncStatus: 'pending', syncError: null });
    expect((await control()).pendingRunId).toBeNull();
  });
});

describe('credential claims', () => {
  it('claims a named credential straight after the daemon touched it, but never an ineligible one', async () => {
    await insertCredential(USER_ID, { lastSyncAttemptAt: new Date(), consecutiveFailures: 5 });
    const filter = eq(auroraCredentials.syncStatus, 'active');

    // The daemon claim would skip this row (reclaim gap + backoff); a named claim does not.
    expect(
      await claimNextCredentialForSync(database, {
        candidateFilter: eq(auroraCredentials.userId, USER_ID),
        excludeLeased: true,
      }),
    ).toBe(null);
    const claimed = await claimCredentialForRun(database, { ...key, candidateFilter: filter });
    expect(claimed?.userId).toBe(USER_ID);

    await database
      .update(auroraCredentials)
      .set({ syncStatus: 'expired' })
      .where(eq(auroraCredentials.userId, USER_ID));
    expect(await claimCredentialForRun(database, { ...key, candidateFilter: filter })).toBeNull();
  });

  it('keeps leased and unlinked credentials out of the daemon claim when asked', async () => {
    await insertCredential(USER_ID);
    await database.transaction((tx) => rotateLinkGeneration(tx, { ...key, linked: true }));
    await database.transaction((tx) => acquireCredentialSyncLease(tx, { ...key, runId: randomUUID(), ttlMs: 60_000 }));
    const filter = eq(auroraCredentials.userId, USER_ID);

    expect(await claimNextCredentialForSync(database, { candidateFilter: filter, excludeLeased: true })).toBeNull();
    await database
      .update(providerSyncControls)
      .set({ activeRunId: null, activeLeaseUntil: null, linked: false })
      .where(eq(providerSyncControls.userId, USER_ID));
    expect(await claimNextCredentialForSync(database, { candidateFilter: filter, excludeLeased: true })).toBeNull();
    await database.update(providerSyncControls).set({ linked: true }).where(eq(providerSyncControls.userId, USER_ID));
    expect((await claimNextCredentialForSync(database, { candidateFilter: filter, excludeLeased: true }))?.userId).toBe(
      USER_ID,
    );
  });
});
