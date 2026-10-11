import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import type { ConnectionContext, SetAnalyticsConsentInput } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { POSTHOG_PERSON_DELETION_QUEUE, initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { db } from '../db/client';
import { requireJobQueue, startJobQueue, stopJobQueue } from '../services/job-queue';
import { enqueuePosthogPersonDeletion } from '../services/analytics/posthog-person-deletion';
import { analyticsConsentMutations } from '../graphql/resolvers/users/analytics-consent';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * When the PostHog erasure job is queued (docs/analytics-consent.md,
 * "Erasure"), against a running pg-boss. No worker runs here, so every queued
 * job stays in `created` and can be counted.
 */

let connectionCounter = 0;
const context = (userId: string): ConnectionContext =>
  ({ connectionId: `erasure-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

async function createUser(): Promise<string> {
  const userId = randomUUID();
  await db.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
  return userId;
}

type QueuedErasure = { distinctId: string; reason: string };

async function queuedErasures(userId: string): Promise<QueuedErasure[]> {
  const rows = await db.execute<{ data: QueuedErasure }>(
    sql`SELECT data FROM pgboss.job WHERE name = ${POSTHOG_PERSON_DELETION_QUEUE} AND data->>'distinctId' = ${userId} ORDER BY created_on`,
  );
  return Array.from(rows, (row) => row.data);
}

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
  it('queues one PostHog erasure for the deleted account', async () => {
    const userId = await createUser();

    await userMutations.deleteAccount(null, { input: { removeSetterName: false } }, context(userId));

    expect(await queuedErasures(userId)).toEqual([{ distinctId: userId, reason: 'account_deleted' }]);
    const remaining = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, userId));
    expect(remaining).toHaveLength(0);
  });
});

describe('consent withdrawal', () => {
  it('queues one erasure when a denial replaces a grant', async () => {
    const userId = await createUser();
    await setConsent(userId, grant());

    await setConsent(userId, deny);

    expect(await queuedErasures(userId)).toEqual([{ distinctId: userId, reason: 'consent_withdrawn' }]);
  });

  it('queues nothing for a repeated denial', async () => {
    const userId = await createUser();
    await setConsent(userId, grant());
    await setConsent(userId, deny);

    await setConsent(userId, deny);

    expect(await queuedErasures(userId)).toHaveLength(1);
  });

  it('queues nothing for a denial with no grant before it', async () => {
    const userId = await createUser();

    await setConsent(userId, deny);

    expect(await queuedErasures(userId)).toEqual([]);
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

    expect(await queuedErasures(userId)).toHaveLength(2);
  });
});

describe('enqueuePosthogPersonDeletion', () => {
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
