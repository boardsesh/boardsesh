import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const queueHolder = vi.hoisted(() => ({ boss: null as PgBoss | null }));
vi.mock('../services/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/job-queue')>()),
  requireJobQueue: () => {
    if (!queueHolder.boss) throw new Error('test queue not started');
    return queueHolder.boss;
  },
}));

import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { auroraCredentials, backgroundJobRuns } from '@boardsesh/db/schema';
import { rotateLinkGeneration } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { ensureBackgroundJobSchema } from '../workers/families/__tests__/provider-sync-fixtures';

const queue = BACKGROUND_JOB_QUEUES['interactive-import'];
const owner = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL!,
  max: 1,
  migrate: false,
  supervise: false,
  schedule: false,
});
boss.on('error', () => {});

// A fresh user per test: the rate limit is keyed on the user and outlives a test.
let userId = '';
function ctx(): ConnectionContext {
  return { connectionId: 'conn-sync-now', transport: 'http', isAuthenticated: true, userId };
}
const syncNow = (boardType = 'tension') => userMutations.requestProviderSync(null, { boardType }, ctx());

async function linkTension(syncStatus = 'active') {
  await db.insert(auroraCredentials).values({
    userId,
    boardType: 'tension',
    encryptedUsername: 'u',
    encryptedPassword: 'p',
    auroraUserId: 1,
    syncStatus,
  });
  await db.transaction((tx) => rotateLinkGeneration(tx, { userId, boardType: 'tension', linked: true }));
}

beforeAll(async () => {
  await ensureBackgroundJobSchema(owner);
  await boss.start();
  queueHolder.boss = boss;
});
beforeEach(async () => {
  userId = `psync-now-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${userId}, ${userId + '@test.com'}, 'Sync Now Tester', now(), now())
  `);
  await boss.deleteAllJobs(queue);
  await db.delete(backgroundJobRuns);
  process.env.BATCH_FAMILIES_ENABLED = 'aurora-user-sync,kilter-user-sync';
});
afterEach(async () => {
  delete process.env.BATCH_FAMILIES_ENABLED;
  await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
});
afterAll(async () => {
  await boss.stop({ graceful: true, close: true });
  await owner.end();
});

describe('requestProviderSync', () => {
  it('queues one manual run, then joins it while it is still waiting', async () => {
    await linkTension();

    const first = await syncNow();
    const second = await syncNow();

    expect(first).toMatchObject({ status: 'queued', coalesced: false });
    expect(second).toEqual({ runId: first.runId, status: 'queued', coalesced: true });
    const allRuns = await db.select().from(backgroundJobRuns);
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0].payload).toMatchObject({ userId, boardType: 'tension', requestedBy: 'manual' });
  });

  it('refuses a board with no credential, or one that needs a relink', async () => {
    await expect(syncNow()).rejects.toMatchObject({ extensions: { code: 'PROVIDER_NOT_LINKED' } });
    await linkTension('expired');
    await expect(syncNow()).rejects.toMatchObject({ extensions: { code: 'PROVIDER_NOT_LINKED' } });
    expect(await db.select().from(backgroundJobRuns)).toEqual([]);
  });

  it('says so when the board’s sync family is not switched on', async () => {
    await linkTension();
    process.env.BATCH_FAMILIES_ENABLED = 'kilter-user-sync';

    await expect(syncNow()).rejects.toMatchObject({ extensions: { code: 'PROVIDER_SYNC_UNAVAILABLE' } });
  });

  it('rejects a board that is not an Aurora board', async () => {
    await expect(syncNow('moonboard')).rejects.toThrow();
  });

  it('allows five requests a minute and rate limits the sixth', async () => {
    await linkTension();
    for (let request = 0; request < 5; request++) await syncNow();

    await expect(syncNow()).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
  });
});
