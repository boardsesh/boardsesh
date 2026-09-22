import type { ConnectionContext } from '@boardsesh/shared-schema';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { applyRateLimit, mockDb } = vi.hoisted(() => ({
  applyRateLimit: vi.fn().mockResolvedValue(undefined),
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../db/client', () => ({ db: mockDb }));
vi.mock('./shared/helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('./shared/helpers')>();
  return { ...original, applyRateLimit };
});

import { supportMutations } from './support';

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
  if (originalStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalStripeSecret;
});

describe('supportMutations', () => {
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
  });

  it('rate-limits billing portal creation before checking configuration', async () => {
    delete process.env.STRIPE_SECRET_KEY;

    await expect(
      supportMutations.createSupportBillingPortalSession({}, { locale: 'en-US' }, authContext()),
    ).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });
    expect(applyRateLimit).toHaveBeenCalledWith(authContext(), 10, 'createSupportBillingPortalSession');
  });
});
