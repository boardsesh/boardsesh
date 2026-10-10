import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { AppleAdsAttributionResult, AppleAdsConsentInput, ConnectionContext } from '@boardsesh/shared-schema';
import { RateLimitError } from '../../../../utils/rate-limiter';

const { mockReadConsent, mockExchange, mockRateLimit } = vi.hoisted(() => ({
  mockReadConsent: vi.fn(),
  mockExchange: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock('../analytics-consent', () => ({ readAnalyticsConsentForUser: mockReadConsent }));
vi.mock('../../../../services/apple-ads-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/apple-ads-attribution')>();
  return { ...actual, exchangeAppleAdsToken: mockExchange };
});
vi.mock('../../../../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: mockRateLimit }));

import { appleAdsAttributionMutations } from '../apple-ads-attribution';

const grant: AppleAdsConsentInput = {
  analytics: 'granted',
  version: 1,
  source: 'ios',
  decidedAt: '2026-10-10T00:00:00.000Z',
};
const attributed: AppleAdsAttributionResult = {
  status: 'ATTRIBUTED',
  attribution: { orgId: '101', campaignId: '202', adGroupId: '303', conversionType: 'Download' },
  retryAfterSeconds: null,
  retryReason: null,
};
const anonymous: ConnectionContext = {
  connectionId: 'anonymous-http-request',
  transport: 'http',
  clientIp: '192.0.2.1',
  socketPeerIp: '10.0.0.1',
  isAuthenticated: false,
  authCredentialProvided: false,
};
const authenticated: ConnectionContext = {
  ...anonymous,
  isAuthenticated: true,
  authCredentialProvided: true,
  userId: 'signed-in-account',
};

function exchange(consent: AppleAdsConsentInput = grant, context: ConnectionContext = anonymous) {
  return appleAdsAttributionMutations.exchangeAppleAdsAttribution(null, { token: 'opaque-token', consent }, context);
}

describe('exchangeAppleAdsAttribution consent and abuse boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadConsent.mockResolvedValue(grant);
    mockExchange.mockResolvedValue(attributed);
    mockRateLimit.mockResolvedValue(undefined);
  });

  it('exchanges for an anonymous current grant using distributed IP and peer buckets', async () => {
    expect(await exchange()).toEqual(attributed);
    expect(mockReadConsent).not.toHaveBeenCalled();
    expect(mockRateLimit.mock.calls).toEqual([
      ['ip:192.0.2.1', 'apple-ads-attribution', 20, 60_000],
      ['socket-peer:10.0.0.1', 'apple-ads-attribution-peer', 600, 60_000],
    ]);
  });

  it.each([
    { ...grant, analytics: 'denied' as const },
    { ...grant, version: 0 },
    { ...grant, decidedAt: 'not-an-iso-timestamp' },
  ])('refuses denied, obsolete or malformed device consent without an Apple request', async (consent) => {
    expect(await exchange(consent)).toMatchObject({ status: 'CONSENT_REQUIRED', attribution: null });
    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
  });

  it('refuses invalid supplied credentials rather than using anonymous device consent', async () => {
    expect(await exchange(grant, { ...anonymous, authCredentialProvided: true })).toMatchObject({
      status: 'CONSENT_REQUIRED',
    });
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('checks the current account grant before and after exchanging under its user bucket', async () => {
    expect(await exchange(grant, authenticated)).toEqual(attributed);
    expect(mockReadConsent.mock.calls).toEqual([['signed-in-account'], ['signed-in-account']]);
    expect(mockRateLimit.mock.calls[0]).toEqual(['signed-in-account', 'apple-ads-attribution', 20, 60_000]);
  });

  it('respects the shared merge rule when a new account has not synced its grant yet', async () => {
    mockReadConsent.mockResolvedValue(null);
    expect(await exchange(grant, authenticated)).toEqual(attributed);
  });

  it('suppresses attribution when the account withdraws while Apple responds', async () => {
    mockReadConsent.mockResolvedValueOnce(grant).mockResolvedValueOnce({ ...grant, analytics: 'denied' });
    expect(await exchange(grant, authenticated)).toMatchObject({ status: 'CONSENT_REQUIRED', attribution: null });
    expect(mockExchange).toHaveBeenCalledTimes(1);
  });

  it('never contacts Apple when the account already declined', async () => {
    mockReadConsent.mockResolvedValue({ ...grant, analytics: 'denied' });
    expect(await exchange(grant, authenticated)).toMatchObject({ status: 'CONSENT_REQUIRED' });
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('fails closed when the account answer cannot be read', async () => {
    mockReadConsent.mockRejectedValue(new Error('database unavailable'));
    expect(await exchange(grant, authenticated)).toMatchObject({ status: 'RETRYABLE', attribution: null });
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('suppresses a result when the authenticated credential expires during the exchange', async () => {
    mockExchange.mockImplementation(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000);
      return attributed;
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(999);
    try {
      expect(await exchange(grant, { ...authenticated, credentialExpiresAt: 1_000 })).toMatchObject({
        status: 'CONSENT_REQUIRED',
        attribution: null,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it('returns safe structured throttling without contacting Apple', async () => {
    mockRateLimit.mockRejectedValue(new RateLimitError(42));
    expect(await exchange()).toEqual({
      status: 'RETRYABLE',
      attribution: null,
      retryAfterSeconds: 42,
      retryReason: 'rate_limited',
    });
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('does not admit tokens over the WebSocket or cron paths', async () => {
    expect(await exchange(grant, { ...anonymous, transport: 'ws' })).toMatchObject({ status: 'CONSENT_REQUIRED' });
    expect(await exchange(grant, { ...anonymous, isCronAuthenticated: true })).toMatchObject({
      status: 'CONSENT_REQUIRED',
    });
    expect(mockExchange).not.toHaveBeenCalled();
  });
});
