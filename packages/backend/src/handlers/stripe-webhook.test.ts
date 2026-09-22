import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { mockConstructEvent, mockDb, mockRetrieveSubscription } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
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
      webhooks: { constructEvent: mockConstructEvent },
    }),
  };
});

import { acceptCheckout, handleStripeWebhook, updateSubscription } from './stripe-webhook';

const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const originalStripeSecret = process.env.STRIPE_SECRET_KEY;

function webhookRequest(headers: Record<string, string> = {}): IncomingMessage {
  const request = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage;
  Object.defineProperty(request, 'headers', { value: headers });
  return request;
}

function webhookResponse() {
  let statusCode = 0;
  let body = '';
  const response = {
    writeHead: vi.fn((status: number) => {
      statusCode = status;
      return response;
    }),
    end: vi.fn((chunk?: string) => {
      body = chunk ?? '';
      return response;
    }),
  } as unknown as ServerResponse;
  return { response, result: () => ({ statusCode, body }) };
}

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

function setupCheckoutTransaction(options?: {
  claim?: Record<string, unknown>;
  missingClaim?: boolean;
  supporter?: Record<string, unknown>;
}) {
  const insertedValues = vi.fn();
  const deleteClaim = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
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
                options?.missingClaim
                  ? []
                  : options?.claim === undefined
                    ? [{ id: 'claim-1', userId: 'user-1', showPublicly: true }]
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
    delete: deleteClaim,
  };
  mockDb.transaction.mockImplementation(async (callback: (database: typeof transaction) => Promise<void>) => {
    await callback(transaction);
  });
  return { deleteClaim, insertedValues, conflictUpdate, transaction };
}

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

beforeEach(() => {
  vi.clearAllMocks();
  if (originalWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
  if (originalStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalStripeSecret;
});

describe('acceptCheckout', () => {
  it('rejects an unexpected currency before writing anything', async () => {
    await acceptCheckout(checkoutSession({ currency: 'eur' }), 1_000);

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('does not apply a missing or previously consumed claim', async () => {
    const { transaction } = setupCheckoutTransaction({ missingClaim: true });

    await acceptCheckout(checkoutSession(), 1_000);

    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('links a valid one-time payment without inventing a subscription', async () => {
    const { deleteClaim, insertedValues, conflictUpdate } = setupCheckoutTransaction();

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
    expect(deleteClaim).toHaveBeenCalledOnce();
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

describe('handleStripeWebhook', () => {
  it('returns 503 when the webhook secret is not configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { response, result } = webhookResponse();

    await handleStripeWebhook(webhookRequest(), response);

    expect(result().statusCode).toBe(503);
  });

  it('returns 503 when Stripe Checkout is not configured', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    delete process.env.STRIPE_SECRET_KEY;
    const { response, result } = webhookResponse();

    await handleStripeWebhook(webhookRequest({ 'stripe-signature': 'valid' }), response);

    expect(result().statusCode).toBe(503);
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it('returns 400 when the Stripe signature is missing', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    const { response, result } = webhookResponse();

    await handleStripeWebhook(webhookRequest(), response);

    expect(result().statusCode).toBe(400);
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it('returns 400 when Stripe rejects the signature', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    mockConstructEvent.mockImplementation(() => {
      throw new Error('bad signature');
    });
    const { response, result } = webhookResponse();

    await handleStripeWebhook(webhookRequest({ 'stripe-signature': 'bad' }), response);

    expect(result().statusCode).toBe(400);
  });

  it('verifies and routes a subscription event before acknowledging it', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    const set = setupSubscriptionUpdate(null);
    mockConstructEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      created: 2_000,
      data: { object: subscription({ status: 'past_due' }) },
    });
    const { response, result } = webhookResponse();

    await handleStripeWebhook(webhookRequest({ 'stripe-signature': 'valid' }), response);

    expect(mockConstructEvent).toHaveBeenCalledWith('{}', 'valid', 'whsec_test');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ subscriptionStatus: 'past_due' }));
    expect(result().statusCode).toBe(200);
  });
});
