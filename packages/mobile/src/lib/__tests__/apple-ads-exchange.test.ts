import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('../../../modules/apple-ads-attribution/src', () => ({ getAppleAdsAttributionToken: vi.fn() }));
vi.mock('../analytics', () => ({ capture: vi.fn(), getAnalyticsIdentity: vi.fn(), setPersonProperties: vi.fn() }));
vi.mock('../consent-state', () => ({
  getConsentSnapshot: vi.fn(),
  isConsentAuthorityGranted: vi.fn(),
  isProductAnalyticsGranted: vi.fn(),
}));
vi.mock('../preference-store', () => ({ getPreference: vi.fn(), setPreference: vi.fn() }));
vi.mock('../verified-auth-result', () => ({ getVerifiedAuthResult: vi.fn() }));

import { exchangeAppleAdsAttribution } from '../apple-ads-attribution';

const consent = {
  analytics: 'granted' as const,
  version: 1,
  source: 'ios' as const,
  decidedAt: '2026-10-10T00:00:00.000Z',
};

describe('Apple Ads mobile transport boundary', () => {
  beforeEach(() => {
    request.mockReset();
  });

  it('discards a ClientError containing the secret request variables', async () => {
    request.mockRejectedValue(new Error('ClientError: token=SENSITIVE_TOKEN'));
    const outcome = await exchangeAppleAdsAttribution('SENSITIVE_TOKEN', consent, new AbortController().signal);
    expect(outcome).toEqual({
      status: 'RETRYABLE',
      attribution: null,
      retryAfterSeconds: 5,
      retryReason: 'unavailable',
    });
    expect(JSON.stringify(outcome)).not.toContain('SENSITIVE_TOKEN');
  });

  it('revalidates attributed responses and drops unknown sensitive fields', async () => {
    request.mockResolvedValue({
      exchangeAppleAdsAttribution: {
        status: 'ATTRIBUTED',
        attribution: {
          orgId: '41',
          campaignId: '42',
          adGroupId: '43',
          conversionType: 'Download',
          token: 'SENSITIVE_TOKEN',
        },
      },
    });
    const outcome = await exchangeAppleAdsAttribution('SENSITIVE_TOKEN', consent, new AbortController().signal);
    expect(outcome.status).toBe('ATTRIBUTED');
    expect(outcome.attribution?.campaignId).toBe('42');
    expect(JSON.stringify(outcome)).not.toContain('SENSITIVE_TOKEN');
  });

  it('refuses dummy attribution and forwards cancellation to the HTTP client', async () => {
    request.mockResolvedValue({
      exchangeAppleAdsAttribution: {
        status: 'ATTRIBUTED',
        attribution: { orgId: '1234567890', campaignId: '42', adGroupId: '43', conversionType: 'Download' },
      },
    });
    const controller = new AbortController();
    const outcome = await exchangeAppleAdsAttribution('SENSITIVE_TOKEN', consent, controller.signal);
    expect(outcome.status).toBe('TEST');
    expect(outcome.attribution).toBeNull();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
});
