import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { createBarrier, handleLater } from './helpers/concurrency';

const { checkoutCreate, checkoutList, checkoutRetrieve, subscriptionRetrieve, subscriptionUpdate, requestListeners } =
  vi.hoisted(() => ({
    checkoutCreate: vi.fn(),
    checkoutList: vi.fn(),
    checkoutRetrieve: vi.fn(),
    subscriptionRetrieve: vi.fn(),
    subscriptionUpdate: vi.fn(),
    requestListeners: new Set<(event: { idempotency_key?: string }) => void>(),
  }));

vi.mock('../services/stripe-support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/stripe-support')>()),
  getStripeClient: () => ({
    on: (_event: string, listener: (event: { idempotency_key?: string }) => void) => requestListeners.add(listener),
    off: (_event: string, listener: (event: { idempotency_key?: string }) => void) => requestListeners.delete(listener),
    checkout: {
      sessions: {
        create: async (parameters: unknown, options?: { idempotencyKey?: string; maxNetworkRetries?: number }) => {
          for (const listener of requestListeners) listener({ idempotency_key: options?.idempotencyKey });
          return checkoutCreate(parameters, options);
        },
        list: checkoutList,
        retrieve: checkoutRetrieve,
      },
    },
    subscriptions: { retrieve: subscriptionRetrieve, update: subscriptionUpdate },
  }),
}));

import { supportMutations } from '../graphql/resolvers/support';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { acceptCheckout, discardCheckout, updateSubscription } from '../handlers/stripe-webhook';
import { withSupportOperation } from '../services/stripe-support-operation';

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

async function assertAccountUnlocked() {
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL lock_timeout = '1000ms'`);
    const unlockedAccounts = await transaction
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, USER_ID))
      .for('update');
    expect(unlockedAccounts).toHaveLength(1);
  });
}

async function operations() {
  return db.select().from(schema.stripeSupportOperations).where(eq(schema.stripeSupportOperations.userId, USER_ID));
}

beforeEach(async () => {
  vi.resetAllMocks();
  requestListeners.clear();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_concurrency');
  checkoutCreate.mockResolvedValue({ id: 'cs_concurrency', url: 'https://checkout.stripe.test/concurrency' });
  checkoutList.mockResolvedValue({ data: [], has_more: false });
  subscriptionRetrieve.mockResolvedValue({ id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: false });
  subscriptionUpdate.mockResolvedValue({ id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: true });
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
  await db.insert(schema.users).values({ id: USER_ID, email: 'stripe-concurrency@test.com', name: 'Stripe tester' });
});

describe('Stripe support account serialization — real PostgreSQL', () => {
  it.each([false, true])(
    'retains the newer visibility choice %s while payment acceptance is in flight',
    async (showPublicly) => {
      await db
        .insert(schema.stripeSupporters)
        .values({ userId: USER_ID, supportedAt: new Date(), showPublicly: !showPublicly });
      await db.insert(schema.stripeSupportClaims).values([
        { id: CLAIM_ID, userId: USER_ID, cadence: 'monthly', showPublicly: !showPublicly },
        { id: 'other-pending-payment', userId: USER_ID, cadence: 'one_time', showPublicly: !showPublicly },
      ]);
      const acceptanceEntered = createBarrier();
      const releaseAcceptance = createBarrier();
      subscriptionRetrieve.mockImplementationOnce(async () => {
        acceptanceEntered.release();
        await releaseAcceptance.promise;
        return { id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: false };
      });
      const acceptance = acceptCheckout(paidSession(), 100);
      handleLater(acceptance);
      try {
        await acceptanceEntered.promise;
        await expect(
          supportMutations.updateSupporterVisibility({}, { showPublicly }, context()),
        ).resolves.toMatchObject({ showPublicly });
        const pendingClaims = await claims();
        expect(pendingClaims).toHaveLength(2);
        expect(pendingClaims.every((claim) => claim.showPublicly === showPublicly)).toBe(true);
        releaseAcceptance.release();
        await acceptance;
        const [supporter] = await db
          .select()
          .from(schema.stripeSupporters)
          .where(eq(schema.stripeSupporters.userId, USER_ID));
        expect(supporter.showPublicly).toBe(showPublicly);
      } finally {
        releaseAcceptance.release();
        await Promise.allSettled([acceptance]);
      }
    },
  );

  it.each([false, true])(
    'honors a returning supporter explicitly choosing Checkout credit %s',
    async (publicCredit) => {
      await db
        .insert(schema.stripeSupporters)
        .values({ userId: USER_ID, supportedAt: new Date(), showPublicly: !publicCredit });
      await supportMutations.createSupportCheckoutSession(
        {},
        { input: { amount: 500, cadence: 'ONE_TIME', publicCredit } },
        context(),
      );
      const [claim] = await claims();
      expect(claim.showPublicly).toBe(publicCredit);

      await acceptCheckout({ ...paidSession(), client_reference_id: claim.id, subscription: null }, 100);

      const [supporter] = await db
        .select()
        .from(schema.stripeSupporters)
        .where(eq(schema.stripeSupporters.userId, USER_ID));
      expect(supporter.showPublicly).toBe(publicCredit);
    },
  );

  it('blocks a visibility change during a live Checkout check but allows an expired check', async () => {
    await db.insert(schema.stripeSupporters).values({ userId: USER_ID, supportedAt: new Date(), showPublicly: true });
    await db
      .insert(schema.stripeSupportClaims)
      .values({ id: CLAIM_ID, userId: USER_ID, cadence: 'one_time', showPublicly: true });
    await db.insert(schema.stripeSupportOperations).values({
      userId: USER_ID,
      state: 'checking_checkout',
      operationId: 'checking-operation',
      ownerToken: 'checking-owner',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      supportMutations.updateSupporterVisibility({}, { showPublicly: false }, context()),
    ).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_PENDING' } });
    expect((await claims())[0].showPublicly).toBe(true);
    await db
      .update(schema.stripeSupportOperations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.stripeSupportOperations.userId, USER_ID));
    await expect(
      supportMutations.updateSupporterVisibility({}, { showPublicly: false }, context()),
    ).resolves.toMatchObject({ showPublicly: false });
    expect((await claims())[0].showPublicly).toBe(false);
  });

  it('fences an expired reader without releasing or overwriting its successor', async () => {
    const firstEntered = createBarrier();
    const releaseFirst = createBarrier();
    const successorEntered = createBarrier();
    const releaseSuccessor = createBarrier();
    const firstFinish = vi.fn();
    const first = withSupportOperation(
      USER_ID,
      'subscription',
      async () => 'first',
      async () => {
        firstEntered.release();
        await releaseFirst.promise;
        return 'first';
      },
      firstFinish,
    );
    handleLater(first);
    let successor: Promise<string | null> | undefined;
    try {
      await firstEntered.promise;
      await assertAccountUnlocked();
      await db
        .update(schema.stripeSupportOperations)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(schema.stripeSupportOperations.userId, USER_ID));
      successor = withSupportOperation(
        USER_ID,
        'subscription',
        async () => 'successor',
        async () => {
          successorEntered.release();
          await releaseSuccessor.promise;
          return 'successor';
        },
        async (transaction, _prepared, result) => {
          await transaction.update(schema.users).set({ name: result }).where(eq(schema.users.id, USER_ID));
          return result;
        },
      );
      handleLater(successor);
      await successorEntered.promise;
      const [successorOperation] = await operations();
      releaseFirst.release();
      await expect(first).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_STALE' } });
      expect(firstFinish).not.toHaveBeenCalled();
      expect(await operations()).toEqual([successorOperation]);
      releaseSuccessor.release();
      await expect(successor).resolves.toBe('successor');
      expect((await operations())[0].state).toBe('idle');
      const [account] = await db
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, USER_ID));
      expect(account.name).toBe('successor');
    } finally {
      releaseFirst.release();
      releaseSuccessor.release();
      await Promise.allSettled([first, ...(successor ? [successor] : [])]);
    }
  });

  it('retains uncertain deletion intent and resumes with the same operation ID', async () => {
    const intent = { subscriptionId: SUBSCRIPTION_ID, removeSetterName: true };
    const seenOperationIds: string[] = [];
    const finish = vi.fn();
    await expect(
      withSupportOperation(
        USER_ID,
        'deleting',
        async () => intent,
        async (_prepared, operationId) => {
          await assertAccountUnlocked();
          seenOperationIds.push(operationId);
          throw new Error('Cancellation response lost');
        },
        finish,
        { deletionIntent: (prepared) => prepared },
      ),
    ).rejects.toThrow('Cancellation response lost');
    const [pendingDeletion] = await operations();
    expect(pendingDeletion).toMatchObject({ state: 'deleting', deletionIntent: intent });
    expect(finish).not.toHaveBeenCalled();
    const competingNetwork = vi.fn();
    await expect(
      withSupportOperation(
        USER_ID,
        'checking_checkout',
        async () => null,
        competingNetwork,
        async () => null,
      ),
    ).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_PENDING' } });
    expect(competingNetwork).not.toHaveBeenCalled();

    await expect(
      withSupportOperation(
        USER_ID,
        'deleting',
        async (_transaction, priorIntent) => {
          expect(priorIntent).toEqual(intent);
          return priorIntent!;
        },
        async (_prepared, operationId) => {
          seenOperationIds.push(operationId);
          return true;
        },
        async (_transaction, prepared) => prepared,
        { deletionIntent: (prepared) => prepared },
      ),
    ).resolves.toEqual(intent);
    expect(seenOperationIds).toEqual([pendingDeletion.operationId, pendingDeletion.operationId]);
    expect((await operations())[0]).toMatchObject({ state: 'idle', deletionIntent: null });
  });

  it('allows exactly one payable monthly Checkout when creation races', async () => {
    const results = await Promise.allSettled([createCheckout(), createCheckout()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(['PENDING_CHECKOUT_EXISTS', 'SUPPORT_OPERATION_PENDING']).toContain(
        (rejected.reason as { extensions: { code: string } }).extensions.code,
      );
    }
    expect(checkoutCreate).toHaveBeenCalledOnce();
    const pendingClaims = await claims();
    expect(pendingClaims).toHaveLength(1);
    expect(pendingClaims[0].checkoutExpiresAt).toBeInstanceOf(Date);
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        client_reference_id: pendingClaims[0].id,
        expires_at: Math.floor(pendingClaims[0].checkoutExpiresAt!.getTime() / 1000),
      }),
      { idempotencyKey: pendingClaims[0].id, maxNetworkRetries: 0 },
    );
  });

  it.each([
    Stripe.errors.StripeInvalidRequestError,
    Stripe.errors.StripeAuthenticationError,
    Stripe.errors.StripePermissionError,
    Stripe.errors.StripeRateLimitError,
  ])('releases the pending claim after a definitive first-attempt %s rejection', async (ErrorClass) => {
    checkoutCreate.mockRejectedValueOnce(
      new ErrorClass({ type: 'rate_limit_error', message: 'Definitively rejected' }),
    );
    await expect(createCheckout()).rejects.toThrow('Definitively rejected');
    expect(await claims()).toHaveLength(0);
    expect(requestListeners.size).toBe(0);
    await expect(createCheckout()).resolves.toMatchObject({ url: 'https://checkout.stripe.test/concurrency' });
    expect(await claims()).toHaveLength(1);
  });

  it('retains the claim when a definitive error follows a hidden transport retry', async () => {
    checkoutCreate.mockImplementationOnce(async (_parameters: unknown, options: { idempotencyKey: string }) => {
      for (const listener of requestListeners) listener({ idempotency_key: options.idempotencyKey });
      throw new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'Retry rejected after uncertain first attempt',
      });
    });
    await expect(createCheckout()).rejects.toThrow('Retry rejected after uncertain first attempt');
    expect(await claims()).toHaveLength(1);
    expect(requestListeners.size).toBe(0);
    await expect(createCheckout()).rejects.toMatchObject({ extensions: { code: 'PENDING_CHECKOUT_EXISTS' } });
    expect(checkoutCreate).toHaveBeenCalledOnce();
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
    const acceptanceEntered = createBarrier();
    const releaseAcceptance = createBarrier();
    const cancellationEntered = createBarrier();
    const releaseCancellation = createBarrier();
    subscriptionRetrieve.mockImplementationOnce(async () => {
      await assertAccountUnlocked();
      acceptanceEntered.release();
      await releaseAcceptance.promise;
      return { id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: false };
    });
    subscriptionUpdate.mockImplementationOnce(async () => {
      await assertAccountUnlocked();
      cancellationEntered.release();
      await releaseCancellation.promise;
      return { id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: true };
    });
    const acceptance = acceptCheckout(paidSession(), 100);
    handleLater(acceptance);
    let deletion: Promise<boolean> | undefined;
    try {
      await acceptanceEntered.promise;
      await expect(deleteAccount()).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_PENDING' } });
      releaseAcceptance.release();
      await acceptance;
      deletion = deleteAccount();
      handleLater(deletion);
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

  it('fences cleanup while paid Checkout acceptance is reading Stripe, then makes cleanup retry a no-op', async () => {
    await db.insert(schema.stripeSupportClaims).values({
      id: CLAIM_ID,
      userId: USER_ID,
      cadence: 'monthly',
      showPublicly: true,
    });
    const acceptanceEntered = createBarrier();
    const releaseAcceptance = createBarrier();
    subscriptionRetrieve.mockImplementationOnce(async () => {
      await assertAccountUnlocked();
      acceptanceEntered.release();
      await releaseAcceptance.promise;
      return { id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: false };
    });
    const accepting = acceptCheckout(paidSession(), 100);
    handleLater(accepting);
    try {
      await acceptanceEntered.promise;
      await expect(discardCheckout(paidSession(), 'expired')).rejects.toMatchObject({
        extensions: { code: 'SUPPORT_OPERATION_PENDING' },
      });
      expect(await claims()).toHaveLength(1);
      expect(checkoutRetrieve).not.toHaveBeenCalled();
      releaseAcceptance.release();
      await accepting;
      const creditedSupporters = await db
        .select()
        .from(schema.stripeSupporters)
        .where(eq(schema.stripeSupporters.userId, USER_ID));
      expect(creditedSupporters).toHaveLength(1);
      expect(creditedSupporters[0]).toMatchObject({
        stripeSubscriptionId: SUBSCRIPTION_ID,
        showPublicly: true,
      });
      expect(creditedSupporters[0].supportedAt).toBeInstanceOf(Date);
      expect(await claims()).toHaveLength(0);
      await expect(discardCheckout(paidSession(), 'expired')).resolves.toBeUndefined();
      expect(checkoutRetrieve).not.toHaveBeenCalled();
      expect(
        await db.select().from(schema.stripeSupporters).where(eq(schema.stripeSupporters.userId, USER_ID)),
      ).toEqual(creditedSupporters);
    } finally {
      releaseAcceptance.release();
      await Promise.allSettled([accepting]);
    }
  });

  it.each(['expired', 'async_payment_failed'] as const)(
    'retains a currently paid claim when stale %s cleanup arrives first',
    async (reason) => {
      await db.insert(schema.stripeSupportClaims).values({
        id: CLAIM_ID,
        userId: USER_ID,
        cadence: 'monthly',
        showPublicly: true,
      });
      checkoutRetrieve.mockImplementationOnce(async () => {
        await assertAccountUnlocked();
        return { ...paidSession(), status: 'complete' };
      });
      const staleSession = { ...paidSession(), payment_status: 'unpaid', status: 'expired' } as Stripe.Checkout.Session;
      await discardCheckout(staleSession, reason);
      expect(checkoutRetrieve).toHaveBeenCalledWith('cs_concurrency');
      expect(await claims()).toHaveLength(1);
      expect((await operations())[0].state).toBe('idle');
      await acceptCheckout(paidSession(), 100);
      expect(await claims()).toHaveLength(0);
      const creditedSupporters = await db
        .select()
        .from(schema.stripeSupporters)
        .where(eq(schema.stripeSupporters.userId, USER_ID));
      expect(creditedSupporters[0]).toMatchObject({
        stripeSubscriptionId: SUBSCRIPTION_ID,
        showPublicly: true,
      });
      expect(creditedSupporters[0].supportedAt).toBeInstanceOf(Date);
    },
  );

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

  it('resumes failed account deletion without permitting Checkout or changing its intent', async () => {
    await db.insert(schema.stripeSupporters).values({
      userId: USER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscriptionStatus: 'active',
    });
    subscriptionUpdate.mockRejectedValueOnce(new Error('Cancellation response lost'));

    await expect(deleteAccount()).rejects.toMatchObject({ extensions: { code: 'STRIPE_CANCELLATION_FAILED' } });
    const [pendingDeletion] = await operations();
    expect(pendingDeletion).toMatchObject({
      state: 'deleting',
      deletionIntent: { subscriptionId: SUBSCRIPTION_ID, removeSetterName: false },
    });
    await expect(createCheckout()).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_PENDING' } });
    expect(checkoutCreate).not.toHaveBeenCalled();
    await expect(userMutations.deleteAccount({}, { input: { removeSetterName: true } }, context())).resolves.toBe(true);
    expect(subscriptionUpdate).toHaveBeenNthCalledWith(1, SUBSCRIPTION_ID, { cancel_at_period_end: true });
    expect(subscriptionUpdate).toHaveBeenNthCalledWith(2, SUBSCRIPTION_ID, { cancel_at_period_end: true });
    expect(await accounts()).toHaveLength(0);
  });

  it('reapplies cancellation after a failed deletion and a portal resume', async () => {
    await db.insert(schema.stripeSupporters).values({ userId: USER_ID, stripeSubscriptionId: SUBSCRIPTION_ID });
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION reject_stripe_user_delete() RETURNS trigger AS $$
      BEGIN
        IF OLD.id = 'stripe-concurrency-user' THEN
          RAISE EXCEPTION 'Simulated account deletion commit failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER reject_stripe_user_delete BEFORE DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION reject_stripe_user_delete()
    `);
    try {
      await expect(deleteAccount()).rejects.toThrow();
      expect(await accounts()).toHaveLength(1);
      expect(subscriptionUpdate).toHaveBeenCalledTimes(1);
      const [pendingDeletion] = await operations();
      expect(pendingDeletion.state).toBe('deleting');
      await db.execute(sql`DROP TRIGGER reject_stripe_user_delete ON users`);
      // An already-open Stripe portal resumed billing after cancellation.
      subscriptionRetrieve.mockResolvedValue({ id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: false });
      subscriptionUpdate.mockImplementationOnce(async (...parameters: unknown[]) => {
        expect(parameters).toEqual([SUBSCRIPTION_ID, { cancel_at_period_end: true }]);
        expect((await operations())[0].operationId).toBe(pendingDeletion.operationId);
        return { id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: true };
      });
      await expect(deleteAccount()).resolves.toBe(true);
      expect(subscriptionUpdate).toHaveBeenCalledTimes(2);
      expect(await accounts()).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS reject_stripe_user_delete ON users`);
      await db.execute(sql`DROP FUNCTION IF EXISTS reject_stripe_user_delete()`);
    }
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

  it('retries Checkout acceptance after a concurrent subscription update finishes', async () => {
    await db.insert(schema.stripeSupporters).values({
      userId: USER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscriptionStatus: 'active',
    });
    await db.insert(schema.stripeSupportClaims).values({ id: CLAIM_ID, userId: USER_ID, cadence: 'monthly' });
    const updateEntered = createBarrier();
    const releaseUpdate = createBarrier();
    subscriptionRetrieve.mockImplementationOnce(async () => {
      await assertAccountUnlocked();
      updateEntered.release();
      await releaseUpdate.promise;
      return { id: SUBSCRIPTION_ID, status: 'canceled', cancel_at_period_end: false, customer: 'cus_concurrency' };
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
      await updateEntered.promise;
      acceptance = acceptCheckout(paidSession(), 100);
      handleLater(acceptance);
      await expect(acceptance).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_PENDING' } });
      expect(subscriptionRetrieve).toHaveBeenCalledOnce();
      releaseUpdate.release();
      await updating;
      await acceptCheckout(paidSession(), 100);
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
