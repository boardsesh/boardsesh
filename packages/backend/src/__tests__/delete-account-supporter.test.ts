/**
 * Account deletion for a supporter, against real PostgreSQL: a live monthly
 * subscription is set to end at period close before the account goes, and a
 * Stripe failure leaves the account in place.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';

const { subscriptionRetrieve, subscriptionUpdate } = vi.hoisted(() => ({
  subscriptionRetrieve: vi.fn(),
  subscriptionUpdate: vi.fn(),
}));

vi.mock('../services/stripe-support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/stripe-support')>()),
  getStripeClient: () => ({ subscriptions: { retrieve: subscriptionRetrieve, update: subscriptionUpdate } }),
}));

import { userMutations } from '../graphql/resolvers/users/mutations';

const USER_ID = 'delete-account-supporter';

function context(): ConnectionContext {
  return { connectionId: 'delete-account-supporter', isAuthenticated: true, userId: USER_ID } as ConnectionContext;
}

async function accountExists(): Promise<boolean> {
  const rows = await db.select({ id: dbSchema.users.id }).from(dbSchema.users).where(eq(dbSchema.users.id, USER_ID));
  return rows.length === 1;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_delete');
  await db.delete(dbSchema.users).where(eq(dbSchema.users.id, USER_ID));
  await db.insert(dbSchema.users).values({ id: USER_ID, email: 'delete-supporter@test.com', name: 'Supporter' });
});

describe('deleteAccount for a supporter', () => {
  it('sets a live subscription to end at period close, then deletes the account and its supporter rows', async () => {
    await db.insert(dbSchema.stripeSupporters).values({
      userId: USER_ID,
      stripeSubscriptionId: 'sub_delete',
      subscriptionStatus: 'active',
      supportedAt: new Date(),
    });
    subscriptionRetrieve.mockResolvedValue({ id: 'sub_delete', status: 'active', cancel_at_period_end: false });
    subscriptionUpdate.mockResolvedValue({ id: 'sub_delete', status: 'active', cancel_at_period_end: true });

    await expect(userMutations.deleteAccount({}, { input: { removeSetterName: false } }, context())).resolves.toBe(
      true,
    );

    expect(subscriptionUpdate).toHaveBeenCalledWith('sub_delete', { cancel_at_period_end: true });
    expect(await accountExists()).toBe(false);
    const leftovers = await db
      .select()
      .from(dbSchema.stripeSupporters)
      .where(eq(dbSchema.stripeSupporters.userId, USER_ID));
    expect(leftovers).toHaveLength(0);
  });

  it('does not call Stripe for an already-ended subscription', async () => {
    await db.insert(dbSchema.stripeSupporters).values({
      userId: USER_ID,
      stripeSubscriptionId: 'sub_ended',
      subscriptionStatus: 'canceled',
      supportedAt: new Date(),
    });
    subscriptionRetrieve.mockResolvedValue({ id: 'sub_ended', status: 'canceled', cancel_at_period_end: false });

    await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, context());
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(await accountExists()).toBe(false);
  });

  it('keeps the account when Stripe cannot confirm the cancellation, and a retry finishes it', async () => {
    await db.insert(dbSchema.stripeSupporters).values({
      userId: USER_ID,
      stripeSubscriptionId: 'sub_flaky',
      subscriptionStatus: 'active',
      supportedAt: new Date(),
    });
    subscriptionRetrieve.mockResolvedValue({ id: 'sub_flaky', status: 'active', cancel_at_period_end: false });
    subscriptionUpdate.mockRejectedValueOnce(new Error('Stripe unavailable'));

    await expect(userMutations.deleteAccount({}, { input: { removeSetterName: false } }, context())).rejects.toThrow(
      'Your account was not deleted',
    );
    expect(await accountExists()).toBe(true);
    // The intent is kept, so the retry resumes with the same subscription.
    const [operation] = await db
      .select()
      .from(dbSchema.stripeSupportOperations)
      .where(eq(dbSchema.stripeSupportOperations.userId, USER_ID));
    expect(operation).toMatchObject({ state: 'deleting', deletionIntent: { subscriptionId: 'sub_flaky' } });

    subscriptionUpdate.mockResolvedValue({ id: 'sub_flaky', status: 'active', cancel_at_period_end: true });
    await expect(userMutations.deleteAccount({}, { input: { removeSetterName: false } }, context())).resolves.toBe(
      true,
    );
    expect(await accountExists()).toBe(false);
  });

  it('never touches Stripe for an account with no subscription, even unconfigured', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    await db.insert(dbSchema.stripeSupporters).values({
      userId: USER_ID,
      creditUntil: new Date(Date.now() + 86_400_000),
      supportedAt: new Date(),
    });
    await userMutations.deleteAccount({}, { input: { removeSetterName: false } }, context());
    expect(subscriptionRetrieve).not.toHaveBeenCalled();
    expect(await accountExists()).toBe(false);
  });
});
