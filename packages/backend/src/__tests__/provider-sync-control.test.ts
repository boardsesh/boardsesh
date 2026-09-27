import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import { auroraCredentials, backgroundJobRuns, providerSyncControls } from '@boardsesh/db/schema';
import {
  StaleLinkGenerationError,
  acquireCredentialSyncLease,
  assertLinkGenerationCurrent,
  claimCredentialForRun,
  claimNextCredentialForSync,
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

async function insertRun(status: BackgroundJobStatus): Promise<string> {
  const id = randomUUID();
  await database.insert(backgroundJobRuns).values({
    id,
    queue: 'background-interactive-import',
    role: 'interactive-import',
    family: 'aurora-user-sync',
    status,
    deadlineAt: new Date(Date.now() + 3_600_000),
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
});

describe('credential claims', () => {
  it('claims a named credential straight after the daemon touched it, but never an ineligible one', async () => {
    await insertCredential(USER_ID, { lastSyncAttemptAt: new Date(), consecutiveFailures: 5 });
    const filter = eq(auroraCredentials.syncStatus, 'active');

    // The daemon claim would skip this row (reclaim gap + backoff); a named claim does not.
    expect(await claimNextCredentialForSync(database, { candidateFilter: eq(auroraCredentials.userId, USER_ID) })).toBe(
      null,
    );
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
