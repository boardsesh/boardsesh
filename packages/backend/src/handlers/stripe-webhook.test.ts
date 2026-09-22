import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { mockDb, mockRetrieveSubscription } = vi.hoisted(() => ({
  mockDb: {
    transaction: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
  mockRetrieveSubscription: vi.fn(),
}));

vi.mock('../db/client', () => ({ db: mockDb }));
vi.mock('../services/stripe-support', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/stripe-support')>();
  return {
    ...original,
    getStripeClient: () => ({
      subscriptions: { retrieve: mockRetrieveSubscription },
    }),
  };
});

import { acceptCheckout, updateSubscription } from './stripe-webhook';

function checkoutSession(overrides: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_test_1',
    client_reference_id: 'claim-1',
    payment_status: 'paid',
    currency: 'usd',
    amount_total: 500,
    customer: 'cus_1',
    subscription: null,
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function subscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function setupCheckoutTransaction(options?: { claim?: Record<string, unknown>; supporter?: Record<string, unknown> }) {
  const insertedValues = vi.fn();
  const claimUpdate = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const conflictUpdate = vi.fn().mockResolvedValue(undefined);
  const transaction = {
    select: vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue(
                options?.claim === undefined
                  ? [{ id: 'claim-1', userId: 'user-1', showPublicly: true, completedAt: null }]
                  : [options.claim],
              ),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(options?.supporter ? [options.supporter] : []),
          }),
        }),
      }),
    insert: vi.fn().mockReturnValue({
      values: insertedValues.mockReturnValue({ onConflictDoUpdate: conflictUpdate }),
    }),
    update: vi.fn().mockReturnValue({ set: claimUpdate }),
  };
  mockDb.transaction.mockImplementation(async (callback: (database: typeof transaction) => Promise<void>) => {
    await callback(transaction);
  });
  return { insertedValues, conflictUpdate, transaction };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('acceptCheckout', () => {
  it('rejects an unexpected currency before writing anything', async () => {
    await acceptCheckout(checkoutSession({ currency: 'eur' }), 1_000);

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('does not apply a claim that was already completed', async () => {
    const { transaction } = setupCheckoutTransaction({
      claim: { id: 'claim-1', userId: 'user-1', showPublicly: true, completedAt: new Date() },
    });

    await acceptCheckout(checkoutSession(), 1_000);

    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('links a valid one-time payment without inventing a subscription', async () => {
    const { insertedValues, conflictUpdate } = setupCheckoutTransaction();

    await acceptCheckout(checkoutSession(), 1_000);

    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        showPublicly: true,
      }),
    );
    expect(conflictUpdate).toHaveBeenCalledOnce();
  });

  it('uses Stripe subscription state instead of assuming checkout means active', async () => {
    mockRetrieveSubscription.mockResolvedValue(subscription({ status: 'past_due', cancel_at_period_end: true }));
    const { insertedValues } = setupCheckoutTransaction();

    await acceptCheckout(checkoutSession({ subscription: 'sub_1' }), 1_000);

    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: 'sub_1',
        subscriptionStatus: 'past_due',
        cancelAtPeriodEnd: true,
      }),
    );
  });
});

describe('updateSubscription', () => {
  function setupSubscriptionUpdate(storedEventCreatedAt: Date | null) {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ stripeEventCreatedAt: storedEventCreatedAt }]),
        }),
      }),
    });
    mockDb.update.mockReturnValue({ set });
    return set;
  }

  it('ignores an event older than the stored subscription event', async () => {
    const set = setupSubscriptionUpdate(new Date(2_000 * 1000));

    await updateSubscription(subscription({ status: 'canceled' }), 1_000);

    expect(set).not.toHaveBeenCalled();
  });

  it('stores status and event time from a newer event', async () => {
    const set = setupSubscriptionUpdate(new Date(1_000 * 1000));

    await updateSubscription(subscription({ status: 'canceled', cancel_at_period_end: true }), 2_000);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionStatus: 'canceled',
        cancelAtPeriodEnd: true,
        stripeEventCreatedAt: new Date(2_000 * 1000),
      }),
    );
  });
});
