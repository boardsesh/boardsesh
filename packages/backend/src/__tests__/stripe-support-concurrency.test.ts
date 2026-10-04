import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { createBarrier, handleLater } from './helpers/concurrency';

const { checkoutCreate, checkoutList, checkoutRetrieve, subscriptionRetrieve, subscriptionUpdate, afterAccountLock } =
  vi.hoisted(() => ({
    checkoutCreate: vi.fn(),
    checkoutList: vi.fn(),
    checkoutRetrieve: vi.fn(),
    subscriptionRetrieve: vi.fn(),
    subscriptionUpdate: vi.fn(),
    afterAccountLock: vi.fn(),
  }));

vi.mock('../services/stripe-support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/stripe-support')>()),
  getStripeClient: () => ({
    checkout: { sessions: { create: checkoutCreate, list: checkoutList, retrieve: checkoutRetrieve } },
    subscriptions: { retrieve: subscriptionRetrieve, update: subscriptionUpdate },
  }),
}));

// Instrument the real row lock to force transaction overlap without replacing
// PostgreSQL or depending on sleeps and scheduler timing.
vi.mock('../services/stripe-support-lock', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/stripe-support-lock')>();
  return {
    ...original,
    lockSupportAccount: async (...parameters: Parameters<typeof original.lockSupportAccount>) => {
      const account = await original.lockSupportAccount(...parameters);
      await afterAccountLock();
      return account;
    },
  };
});

import { supportMutations } from '../graphql/resolvers/support';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { acceptCheckout, updateSubscription } from '../handlers/stripe-webhook';

const USER_ID = 'stripe-concurrency-user';
const CLAIM_ID = 'stripe-concurrency-claim';
const SUBSCRIPTION_ID = 'sub_concurrency';

function context(): ConnectionContext {
  return { connectionId: 'stripe-concurrency', isAuthenticated: true, userId: USER_ID };
}

function createCheckout(cadence: 'MONTHLY' | 'ONE_TIME' = 'MONTHLY') {
  return supportMutations.createSupportCheckoutSession(
    {},
    { input: { amount: 500, cadence, publicCredit: true } },
    context(),
  );
}

function deleteAccount() {
  return userMutations.deleteAccount({}, { input: { removeSetterName: false } }, context());
}

function paidSession(): Stripe.Checkout.Session {
  return {
    id: 'cs_concurrency',
    client_reference_id: CLAIM_ID,
    payment_status: 'paid',
    currency: 'usd',
    amount_total: 500,
    customer: 'cus_concurrency',
    subscription: SUBSCRIPTION_ID,
  } as Stripe.Checkout.Session;
}

async function claims() {
  return db.select().from(schema.stripeSupportClaims).where(eq(schema.stripeSupportClaims.userId, USER_ID));
}

async function accounts() {
  return db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, USER_ID));
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_concurrency');
  checkoutCreate.mockResolvedValue({ id: 'cs_concurrency', url: 'https://checkout.stripe.test/concurrency' });
  checkoutList.mockResolvedValue({ data: [], has_more: false });
  subscriptionRetrieve.mockResolvedValue({ id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: false });
  subscriptionUpdate.mockResolvedValue({ id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: true });
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
  await db.insert(schema.users).values({ id: USER_ID, email: 'stripe-concurrency@test.com', name: 'Stripe tester' });
});

describe('Stripe support account serialization — real PostgreSQL', () => {
  it('allows exactly one payable monthly Checkout when creation races', async () => {
    const results = await Promise.allSettled([createCheckout(), createCheckout()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { extensions: { code: 'PENDING_CHECKOUT_EXISTS' } } });
    expect(checkoutCreate).toHaveBeenCalledOnce();
    const pendingClaims = await claims();
    expect(pendingClaims).toHaveLength(1);
    expect(pendingClaims[0].checkoutExpiresAt).toBeInstanceOf(Date);
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        client_reference_id: pendingClaims[0].id,
        expires_at: Math.floor(pendingClaims[0].checkoutExpiresAt!.getTime() / 1000),
      }),
      { idempotencyKey: pendingClaims[0].id },
    );
  });

  it('retains the payment guard when Stripe loses the Checkout response', async () => {
    checkoutCreate.mockRejectedValueOnce(
      Object.assign(new Error('Connection lost'), { type: 'StripeConnectionError' }),
    );

    await expect(createCheckout()).rejects.toThrow('Connection lost');
    expect(await claims()).toHaveLength(1);
    await expect(createCheckout()).rejects.toMatchObject({ extensions: { code: 'PENDING_CHECKOUT_EXISTS' } });
    await expect(deleteAccount()).rejects.toMatchObject({ extensions: { code: 'PENDING_CHECKOUT_EXISTS' } });
    expect(checkoutCreate).toHaveBeenCalledOnce();
    expect(await accounts()).toHaveLength(1);
  });

  it.each(['MONTHLY', 'ONE_TIME'] as const)('blocks deletion while a %s Checkout is being created', async (cadence) => {
    const stripeEntered = createBarrier();
    const releaseStripe = createBarrier();
    checkoutCreate.mockImplementationOnce(async () => {
      stripeEntered.release();
      await releaseStripe.promise;
      return { id: 'cs_concurrency', url: 'https://checkout.stripe.test/concurrency' };
    });
    const creation = createCheckout(cadence);
    handleLater(creation);
    try {
      await stripeEntered.promise;
      await expect(deleteAccount()).rejects.toMatchObject({ extensions: { code: 'PENDING_CHECKOUT_EXISTS' } });
      expect(await accounts()).toHaveLength(1);
      expect(await claims()).toHaveLength(1);
    } finally {
      releaseStripe.release();
      await creation;
    }
  });

  it('cancels the subscription accepted by a concurrent webhook before deletion commits', async () => {
    await db.insert(schema.stripeSupportClaims).values({ id: CLAIM_ID, userId: USER_ID, cadence: 'monthly' });
    const acceptanceLocked = createBarrier();
    const releaseAcceptance = createBarrier();
    const cancellationEntered = createBarrier();
    const releaseCancellation = createBarrier();
    afterAccountLock.mockImplementationOnce(async () => {
      acceptanceLocked.release();
      await releaseAcceptance.promise;
    });
    subscriptionUpdate.mockImplementationOnce(async () => {
      cancellationEntered.release();
      await releaseCancellation.promise;
      return { id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: true };
    });
    const acceptance = acceptCheckout(paidSession(), 100);
    handleLater(acceptance);
    let deletion: Promise<boolean> | undefined;
    try {
      await acceptanceLocked.promise;
      deletion = deleteAccount();
      handleLater(deletion);
      releaseAcceptance.release();
      await acceptance;
      await cancellationEntered.promise;
      expect(await accounts()).toHaveLength(1);
      expect(subscriptionUpdate).toHaveBeenCalledWith(SUBSCRIPTION_ID, { cancel_at_period_end: true });
      releaseCancellation.release();
      await expect(deletion).resolves.toBe(true);
      expect(await accounts()).toHaveLength(0);
    } finally {
      releaseAcceptance.release();
      releaseCancellation.release();
      await Promise.allSettled([acceptance, ...(deletion ? [deletion] : [])]);
    }
  });

  it('keeps the account when Stripe cancellation fails after webhook acceptance', async () => {
    await db.insert(schema.stripeSupportClaims).values({ id: CLAIM_ID, userId: USER_ID, cadence: 'monthly' });
    await acceptCheckout(paidSession(), 100);
    subscriptionUpdate.mockRejectedValueOnce(new Error('Stripe unavailable'));

    await expect(deleteAccount()).rejects.toMatchObject({ extensions: { code: 'STRIPE_CANCELLATION_FAILED' } });
    expect(await accounts()).toHaveLength(1);
    const supporters = await db
      .select()
      .from(schema.stripeSupporters)
      .where(eq(schema.stripeSupporters.userId, USER_ID));
    expect(supporters).toHaveLength(1);
    expect(supporters[0].stripeSubscriptionId).toBe(SUBSCRIPTION_ID);
  });

  it('keeps the subscription customer when a different one-time customer completes later', async () => {
    await db.insert(schema.stripeSupportClaims).values({ id: CLAIM_ID, userId: USER_ID, cadence: 'monthly' });
    await acceptCheckout(paidSession(), 100);
    await db.insert(schema.stripeSupportClaims).values({ id: 'one-time-claim', userId: USER_ID, cadence: 'one_time' });

    await acceptCheckout(
      {
        ...paidSession(),
        id: 'cs_one_time',
        client_reference_id: 'one-time-claim',
        subscription: null,
        customer: 'cus_different_one_time',
      },
      200,
    );

    const supporters = await db
      .select()
      .from(schema.stripeSupporters)
      .where(eq(schema.stripeSupporters.userId, USER_ID));
    expect(supporters[0]).toMatchObject({
      stripeSubscriptionId: SUBSCRIPTION_ID,
      stripeCustomerId: 'cus_concurrency',
    });
  });

  it.each([
    { subscriptionStatus: 'active', cancelAtPeriodEnd: true },
    { subscriptionStatus: 'canceled', cancelAtPeriodEnd: false },
  ])('checks Stripe before deleting with stale billing cache %j', async (cachedSubscription) => {
    await db.insert(schema.stripeSupporters).values({
      userId: USER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      ...cachedSubscription,
    });

    await expect(deleteAccount()).resolves.toBe(true);

    expect(subscriptionRetrieve).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(subscriptionUpdate).toHaveBeenCalledWith(SUBSCRIPTION_ID, { cancel_at_period_end: true });
    expect(await accounts()).toHaveLength(0);
  });

  it('blocks another monthly Checkout when cached cancellation disagrees with Stripe', async () => {
    await db.insert(schema.stripeSupporters).values({
      userId: USER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscriptionStatus: 'canceled',
      stripeCustomerId: 'cus_concurrency',
    });

    await expect(createCheckout()).rejects.toMatchObject({ extensions: { code: 'ACTIVE_SUBSCRIPTION_EXISTS' } });

    expect(subscriptionRetrieve).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(await claims()).toHaveLength(0);
  });

  it.each([100, 99])('uses authoritative Stripe state for a canceled event timestamp %i', async (eventCreated) => {
    await db.insert(schema.stripeSupporters).values({
      userId: USER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscriptionStatus: 'active',
      stripeEventCreatedAt: new Date(100_000),
    });
    subscriptionRetrieve.mockResolvedValue({
      id: SUBSCRIPTION_ID,
      status: 'canceled',
      cancel_at_period_end: false,
      customer: 'cus_concurrency',
    });

    await updateSubscription(
      {
        id: SUBSCRIPTION_ID,
        status: 'active',
        customer: 'cus_stale',
        cancel_at_period_end: true,
      } as Stripe.Subscription,
      eventCreated,
    );

    const supporters = await db
      .select()
      .from(schema.stripeSupporters)
      .where(eq(schema.stripeSupporters.userId, USER_ID));
    expect(supporters[0]).toMatchObject({
      subscriptionStatus: 'canceled',
      cancelAtPeriodEnd: false,
      stripeCustomerId: 'cus_concurrency',
      stripeEventCreatedAt: new Date(100_000),
    });
  });

  it('reads Checkout subscription state only after a concurrent subscription update unlocks', async () => {
    await db.insert(schema.stripeSupporters).values({
      userId: USER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscriptionStatus: 'active',
    });
    await db.insert(schema.stripeSupportClaims).values({ id: CLAIM_ID, userId: USER_ID, cadence: 'monthly' });
    const updateLocked = createBarrier();
    const releaseUpdate = createBarrier();
    afterAccountLock.mockImplementationOnce(async () => {
      updateLocked.release();
      await releaseUpdate.promise;
    });
    subscriptionRetrieve.mockResolvedValue({
      id: SUBSCRIPTION_ID,
      status: 'canceled',
      cancel_at_period_end: false,
      customer: 'cus_concurrency',
    });
    const updating = updateSubscription({ id: SUBSCRIPTION_ID, status: 'active' } as Stripe.Subscription, 200);
    handleLater(updating);
    let acceptance: Promise<void> | undefined;
    try {
      await updateLocked.promise;
      acceptance = acceptCheckout(paidSession(), 100);
      handleLater(acceptance);
      expect(subscriptionRetrieve).not.toHaveBeenCalled();
      releaseUpdate.release();
      await Promise.all([updating, acceptance]);
      const supporters = await db
        .select()
        .from(schema.stripeSupporters)
        .where(eq(schema.stripeSupporters.userId, USER_ID));
      expect(supporters[0]).toMatchObject({ subscriptionStatus: 'canceled', stripeEventCreatedAt: new Date(200_000) });
      expect(subscriptionRetrieve).toHaveBeenCalledTimes(2);
    } finally {
      releaseUpdate.release();
      await Promise.allSettled([updating, ...(acceptance ? [acceptance] : [])]);
    }
  });

  it('rejects Checkout creation from a stale authenticated deleted account', async () => {
    await expect(deleteAccount()).resolves.toBe(true);

    await expect(createCheckout()).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(await claims()).toHaveLength(0);
  });

  it('recovers a crash before session creation after the fixed expiry passes', async () => {
    await db.insert(schema.stripeSupportClaims).values({
      id: CLAIM_ID,
      userId: USER_ID,
      cadence: 'monthly',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      checkoutExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await expect(createCheckout()).resolves.toMatchObject({ url: 'https://checkout.stripe.test/concurrency' });

    expect(checkoutList).toHaveBeenCalledOnce();
    const pendingClaims = await claims();
    expect(pendingClaims).toHaveLength(1);
    expect(pendingClaims[0].id).not.toBe(CLAIM_ID);
    expect(checkoutCreate).toHaveBeenCalledOnce();
  });

  it.each([null, 'cs_concurrency'])(
    'retains an expired paid claim with session reference %s for a delayed webhook',
    async (checkoutSessionId) => {
      await db.insert(schema.stripeSupportClaims).values({
        id: CLAIM_ID,
        userId: USER_ID,
        cadence: 'monthly',
        checkoutSessionId,
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        checkoutExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      const completedSession = { ...paidSession(), status: 'complete' };
      checkoutList.mockResolvedValue({ data: [completedSession], has_more: false });
      checkoutRetrieve.mockResolvedValue(completedSession);

      await expect(deleteAccount()).rejects.toMatchObject({ extensions: { code: 'PENDING_CHECKOUT_EXISTS' } });
      expect(await accounts()).toHaveLength(1);
      expect(await claims()).toHaveLength(1);

      await acceptCheckout(paidSession(), 100);
      expect(await claims()).toHaveLength(0);
      await expect(deleteAccount()).resolves.toBe(true);
      expect(subscriptionUpdate).toHaveBeenCalledWith(SUBSCRIPTION_ID, { cancel_at_period_end: true });
    },
  );
});
