import type { ConnectionContext } from '@boardsesh/shared-schema';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { applyRateLimit, checkoutSessionCreate, billingPortalSessionCreate, mockDb } = vi.hoisted(() => ({
  applyRateLimit: vi.fn().mockResolvedValue(undefined),
  checkoutSessionCreate: vi.fn(),
  billingPortalSessionCreate: vi.fn(),
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
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
      checkout: { sessions: { create: checkoutSessionCreate } },
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
  applyRateLimit.mockResolvedValue(undefined);
  if (originalStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalStripeSecret;
});

describe('supportMutations', () => {
  function selectRows(rows: unknown[]) {
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    };
  }

  function setupCheckoutDatabase(supporterRows: unknown[] = []) {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    mockDb.select.mockImplementation((columns?: Record<string, unknown>) =>
      selectRows(columns && 'email' in columns ? [{ email: 'climber@example.com' }] : supporterRows),
    );
    mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockDb.insert.mockReturnValue({ values: insertValues });
    mockDb.update.mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhere }) });
    return { insertValues, updateWhere };
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
    );
    expect(updateWhere).toHaveBeenCalledOnce();
    expect(insertValues.mock.invocationCallOrder[0]).toBeLessThan(checkoutSessionCreate.mock.invocationCallOrder[0]);
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

    expect(checkoutSessionCreate).toHaveBeenCalledWith(expect.objectContaining({ customer_creation: 'always' }));
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

    expect(checkoutSessionCreate).toHaveBeenCalledWith(expect.objectContaining({ client_reference_id: undefined }));
    expect(mockDb.insert).not.toHaveBeenCalled();
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

  it('updates visibility for completed linked support', async () => {
    const supporter = { userId: 'user-1', supportedAt: new Date(), showPublicly: true };
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([supporter]) }),
      }),
    });

    await expect(
      supportMutations.updateSupporterVisibility({}, { showPublicly: true }, authContext()),
    ).resolves.toMatchObject({ linked: true, hasSupported: true, showPublicly: true });
  });
});

describe('supportQueries', () => {
  it('rate-limits the public supporter page query', async () => {
    const offset = vi.fn().mockResolvedValue([]);
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({ offset }),
              }),
            }),
          }),
        }),
      }),
    });
    const context = authContext();

    await expect(supportQueries.publicSupporters({}, { limit: 500, offset: 0 }, context)).resolves.toEqual([]);
    expect(applyRateLimit).toHaveBeenCalledWith(context, 120, 'publicSupporters');
  });
});
