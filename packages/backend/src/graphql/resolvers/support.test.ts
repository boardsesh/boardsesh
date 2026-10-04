import Stripe from 'stripe';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const {
  applyRateLimit,
  checkoutSessionCreate,
  billingPortalSessionCreate,
  subscriptionRetrieve,
  stripeOn,
  stripeOff,
  requestListeners,
  emitRequest,
  mockDb,
} = vi.hoisted(() => ({
  applyRateLimit: vi.fn().mockResolvedValue(undefined),
  checkoutSessionCreate: vi.fn(),
  billingPortalSessionCreate: vi.fn(),
  subscriptionRetrieve: vi.fn().mockResolvedValue({ status: 'active' }),
  requestListeners: new Set<(request: { idempotency_key?: string }) => void>(),
  stripeOn: vi.fn(),
  stripeOff: vi.fn(),
  emitRequest: vi.fn(),
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../services/stripe-support-operation', () => ({
  withSupportOperation: async (
    _userId: string,
    _kind: string,
    prepare: (transaction: unknown, intent: null) => Promise<unknown>,
    perform: (prepared: unknown, operationId: string) => Promise<unknown>,
    finish: (transaction: unknown, prepared: unknown, networkResult: unknown) => Promise<unknown>,
  ) => {
    const prepared = await mockDb.transaction(async (transaction: unknown) => prepare(transaction, null));
    const networkResult = await perform(prepared, 'operation-1');
    return mockDb.transaction(async (transaction: unknown) => finish(transaction, prepared, networkResult));
  },
}));
vi.mock('../../services/reconcile-support-claims', () => ({
  reconcileExpiredSupportClaims: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/client', () => ({ db: mockDb }));
vi.mock('./shared/helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('./shared/helpers')>();
  return { ...original, applyRateLimit };
});
vi.mock('../../services/stripe-support', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/stripe-support')>();
  return {
    ...original,
    getStripeClient: () => ({
      on: stripeOn,
      off: stripeOff,
      subscriptions: { retrieve: subscriptionRetrieve },
      checkout: {
        sessions: {
          create: async (parameters: unknown, options: { idempotencyKey?: string }) => {
            emitRequest({ idempotency_key: options.idempotencyKey });
            return checkoutSessionCreate(parameters, options);
          },
        },
      },
      billingPortal: { sessions: { create: billingPortalSessionCreate } },
    }),
  };
});
vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn() } }));

import { supportMutations, supportQueries } from './support';

const originalStripeSecret = process.env.STRIPE_SECRET_KEY;

function authContext(): ConnectionContext {
  return {
    connectionId: 'http-user-1',
    isAuthenticated: true,
    sessionId: undefined,
    userId: 'user-1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requestListeners.clear();
  stripeOn.mockImplementation((_event: string, listener: (request: { idempotency_key?: string }) => void) => {
    requestListeners.add(listener);
  });
  stripeOff.mockImplementation((_event: string, listener: (request: { idempotency_key?: string }) => void) => {
    requestListeners.delete(listener);
  });
  emitRequest.mockImplementation((request: { idempotency_key?: string }) => {
    for (const listener of requestListeners) listener(request);
  });
  applyRateLimit.mockResolvedValue(undefined);
  if (originalStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalStripeSecret;
});

describe('supportMutations', () => {
  function selectRows(rows: unknown[]) {
    return {
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue(rows), for: vi.fn().mockResolvedValue(rows) }),
      }),
    };
  }

  function setupCheckoutDatabase(supporterRows: unknown[] = []) {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    mockDb.select.mockImplementation((columns?: Record<string, unknown>) =>
      selectRows(
        columns && 'email' in columns
          ? [{ id: 'user-1', email: 'climber@example.com' }]
          : columns && 'id' in columns
            ? []
            : supporterRows,
      ),
    );
    mockDb.transaction.mockImplementation(async (callback: (transaction: typeof mockDb) => Promise<unknown>) =>
      callback(mockDb),
    );
    mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockDb.insert.mockReturnValue({ values: insertValues });
    mockDb.update.mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhere }) });
    return { insertValues, updateWhere };
  }

  function setupVisibilityDatabase(operationRows: unknown[] = []) {
    mockDb.transaction.mockImplementation(async (callback: (transaction: typeof mockDb) => Promise<unknown>) =>
      callback(mockDb),
    );
    mockDb.select.mockImplementation((columns?: Record<string, unknown>) =>
      selectRows(
        columns && 'leaseExpiresAt' in columns ? operationRows : [{ id: 'user-1', email: 'climber@example.com' }],
      ),
    );
  }

  it('returns SERVICE_UNAVAILABLE when Checkout is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;

    await expect(
      supportMutations.createSupportCheckoutSession(
        {},
        { input: { amount: 500, cadence: 'ONE_TIME', publicCredit: false } },
        authContext(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('does not update visibility without completed linked support', async () => {
    setupVisibilityDatabase();
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where }),
    });

    await expect(
      supportMutations.updateSupporterVisibility({}, { showPublicly: true }, authContext()),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(where).toHaveBeenCalledOnce();
    expect(applyRateLimit).toHaveBeenCalledWith(authContext(), 10, 'updateSupporterVisibility');
  });

  it('rate-limits billing portal creation before checking configuration', async () => {
    delete process.env.STRIPE_SECRET_KEY;

    await expect(
      supportMutations.createSupportBillingPortalSession({}, { locale: 'en-US' }, authContext()),
    ).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });
    expect(applyRateLimit).toHaveBeenCalledWith(authContext(), 10, 'createSupportBillingPortalSession');
  });

  it('creates linked Checkout after persisting its claim', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    const { insertValues, updateWhere } = setupCheckoutDatabase();
    checkoutSessionCreate.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.test/session' });

    await expect(
      supportMutations.createSupportCheckoutSession(
        {},
        { input: { amount: 500, cadence: 'MONTHLY', publicCredit: true, locale: 'fr' } },
        authContext(),
      ),
    ).resolves.toEqual({ url: 'https://checkout.stripe.test/session' });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', cadence: 'monthly', showPublicly: true }),
    );
    expect(checkoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer_email: 'climber@example.com',
        success_url: 'http://localhost:3000/fr/support?support=thanks',
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String), maxNetworkRetries: 0 }),
    );
    expect(updateWhere).toHaveBeenCalledOnce();
    expect(insertValues.mock.invocationCallOrder[0]).toBeLessThan(checkoutSessionCreate.mock.invocationCallOrder[0]);
    expect(stripeOff).toHaveBeenCalledWith('request', stripeOn.mock.calls[0][1]);
    expect(requestListeners.size).toBe(0);
  });

  it('creates a reusable Stripe customer for first-time one-time support', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    setupCheckoutDatabase();
    checkoutSessionCreate.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.test/session' });

    await supportMutations.createSupportCheckoutSession(
      {},
      { input: { amount: 500, cadence: 'ONE_TIME', publicCredit: false } },
      authContext(),
    );

    expect(checkoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer_creation: 'always' }),
      expect.objectContaining({ idempotencyKey: expect.any(String), maxNetworkRetries: 0 }),
    );
  });

  it('keeps anonymous support intentionally unlinked', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    checkoutSessionCreate.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.test/session' });
    const anonymousContext = { ...authContext(), isAuthenticated: false, userId: undefined };

    await supportMutations.createSupportCheckoutSession(
      {},
      { input: { amount: 500, cadence: 'ONE_TIME', publicCredit: false } },
      anonymousContext,
    );

    expect(checkoutSessionCreate).toHaveBeenCalledWith(expect.objectContaining({ client_reference_id: undefined }), {
      maxNetworkRetries: 0,
    });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('removes a linked claim when Stripe session creation fails', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    const { insertValues } = setupCheckoutDatabase();
    checkoutSessionCreate.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'Stripe unavailable' }),
    );

    await expect(
      supportMutations.createSupportCheckoutSession(
        {},
        { input: { amount: 500, cadence: 'ONE_TIME', publicCredit: false } },
        authContext(),
      ),
    ).rejects.toThrow('Stripe unavailable');

    expect(insertValues).toHaveBeenCalledOnce();
    expect(mockDb.delete).toHaveBeenCalledOnce();
  });

  it('retains the claim when the Stripe creation outcome is uncertain', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    setupCheckoutDatabase();
    checkoutSessionCreate.mockRejectedValue(
      new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'Response lost' }),
    );
    await expect(
      supportMutations.createSupportCheckoutSession(
        {},
        { input: { amount: 500, cadence: 'MONTHLY', publicCredit: false } },
        authContext(),
      ),
    ).rejects.toThrow('Response lost');
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(checkoutSessionCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxNetworkRetries: 0, idempotencyKey: expect.any(String) }),
    );
    expect(stripeOff).toHaveBeenCalledWith('request', stripeOn.mock.calls[0][1]);
    expect(requestListeners.size).toBe(0);
  });

  it('releases a linked claim after a first-request Stripe rate limit rejection', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    const { insertValues } = setupCheckoutDatabase();
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      type: 'rate_limit_error',
      message: 'Too many requests',
      statusCode: 429,
    });
    checkoutSessionCreate.mockRejectedValue(rateLimitError);

    await expect(
      supportMutations.createSupportCheckoutSession(
        {},
        { input: { amount: 500, cadence: 'MONTHLY', publicCredit: false } },
        authContext(),
      ),
    ).rejects.toBe(rateLimitError);

    expect(insertValues).toHaveBeenCalledOnce();
    expect(checkoutSessionCreate).toHaveBeenCalledOnce();
    expect(checkoutSessionCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxNetworkRetries: 0, idempotencyKey: expect.any(String) }),
    );
    expect(mockDb.delete).toHaveBeenCalledOnce();
    expect(stripeOff).toHaveBeenCalledWith('request', stripeOn.mock.calls[0][1]);
    expect(requestListeners.size).toBe(0);
  });

  it('retains a claim if a closed-connection retry ends in a rate limit rejection', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    setupCheckoutDatabase();
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      type: 'rate_limit_error',
      message: 'Too many requests',
    });
    checkoutSessionCreate.mockImplementationOnce(async (_parameters: unknown, options: { idempotencyKey: string }) => {
      emitRequest({ idempotency_key: options.idempotencyKey });
      throw rateLimitError;
    });

    await expect(
      supportMutations.createSupportCheckoutSession(
        {},
        { input: { amount: 500, cadence: 'MONTHLY', publicCredit: false } },
        authContext(),
      ),
    ).rejects.toBe(rateLimitError);

    expect(emitRequest).toHaveBeenCalledTimes(2);
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(requestListeners.size).toBe(0);
  });

  it('ignores another claim request while determining a first-attempt rejection', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    setupCheckoutDatabase();
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      type: 'rate_limit_error',
      message: 'Too many requests',
    });
    checkoutSessionCreate.mockImplementationOnce(async () => {
      emitRequest({ idempotency_key: 'another-concurrent-claim' });
      throw rateLimitError;
    });

    await expect(
      supportMutations.createSupportCheckoutSession(
        {},
        { input: { amount: 500, cadence: 'MONTHLY', publicCredit: false } },
        authContext(),
      ),
    ).rejects.toBe(rateLimitError);

    expect(emitRequest).toHaveBeenCalledTimes(2);
    expect(mockDb.delete).toHaveBeenCalledOnce();
    expect(requestListeners.size).toBe(0);
  });

  it('rejects a second monthly checkout for a live subscription', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    setupCheckoutDatabase([{ stripeSubscriptionId: 'sub_1', subscriptionStatus: 'active' }]);

    await expect(
      supportMutations.createSupportCheckoutSession(
        {},
        { input: { amount: 500, cadence: 'MONTHLY', publicCredit: false } },
        authContext(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'ACTIVE_SUBSCRIPTION_EXISTS' } });
    expect(checkoutSessionCreate).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('creates a billing portal session for a linked customer', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    mockDb.select.mockReturnValue(selectRows([{ stripeCustomerId: 'cus_1' }]));
    billingPortalSessionCreate.mockResolvedValue({ url: 'https://billing.stripe.test/session' });

    await expect(
      supportMutations.createSupportBillingPortalSession({}, { locale: 'de' }, authContext()),
    ).resolves.toEqual({ url: 'https://billing.stripe.test/session' });
    expect(billingPortalSessionCreate).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: 'http://localhost:3000/de/support',
    });
  });

  it('rejects an unauthenticated billing portal request before reading its forged account', async () => {
    const anonymousContext = { ...authContext(), isAuthenticated: false };

    await expect(supportMutations.createSupportBillingPortalSession({}, {}, anonymousContext)).rejects.toThrow(
      'Authentication required',
    );

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(billingPortalSessionCreate).not.toHaveBeenCalled();
  });

  it('rejects billing portal creation when the account has no linked Stripe customer', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    mockDb.select.mockReturnValue(selectRows([]));

    await expect(supportMutations.createSupportBillingPortalSession({}, {}, authContext())).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });

    expect(billingPortalSessionCreate).not.toHaveBeenCalled();
  });

  it('updates visibility for completed linked support', async () => {
    setupVisibilityDatabase();
    const supporter = { userId: 'user-1', supportedAt: new Date(), showPublicly: true };
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([supporter]) }),
      }),
    });

    await expect(
      supportMutations.updateSupporterVisibility({}, { showPublicly: true }, authContext()),
    ).resolves.toMatchObject({ linked: true, hasSupported: true, showPublicly: true });
    expect(mockDb.update).toHaveBeenCalledTimes(2);
  });

  it('does not change visibility while a live Checkout check can issue a claim', async () => {
    setupVisibilityDatabase([{ state: 'checking_checkout', leaseExpiresAt: new Date(Date.now() + 60_000) }]);

    await expect(
      supportMutations.updateSupporterVisibility({}, { showPublicly: false }, authContext()),
    ).rejects.toMatchObject({ extensions: { code: 'SUPPORT_OPERATION_PENDING' } });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe('supportQueries', () => {
  function setupPublicSupporterQuery() {
    const offset = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockReturnValue({ offset });
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit,
              }),
            }),
          }),
        }),
      }),
    });
    return { offset, limit };
  }

  it('rate-limits the public supporter page query', async () => {
    setupPublicSupporterQuery();
    const context = authContext();

    await expect(supportQueries.publicSupporters({}, { limit: 500, offset: 0 }, context)).resolves.toEqual([]);
    expect(applyRateLimit).toHaveBeenCalledWith(context, 120, 'publicSupporters');
  });

  it.each([
    { limit: 50_000, offset: -1, pageLimit: 500, pageOffset: 0 },
    { limit: 0, offset: 3, pageLimit: 1, pageOffset: 3 },
  ])('bounds public pagination for limit $limit and offset $offset', async (pagination) => {
    const query = setupPublicSupporterQuery();

    await supportQueries.publicSupporters({}, pagination, authContext());

    expect(query.limit).toHaveBeenCalledWith(pagination.pageLimit);
    expect(query.offset).toHaveBeenCalledWith(pagination.pageOffset);
  });

  it('returns unlinked status for anonymous requests carrying a forged user ID', async () => {
    await expect(
      supportQueries.mySupporterStatus({}, {}, { ...authContext(), isAuthenticated: false }),
    ).resolves.toMatchObject({ linked: false, hasSupported: false, showPublicly: false, hasActiveSubscription: false });

    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
