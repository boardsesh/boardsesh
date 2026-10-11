import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GET_CONSENT_REGION } from '@boardsesh/graphql/operations/analytics-consent';

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/app/lib/graphql/client', () => ({ executeGraphQL: transport.request }));

beforeEach(() => {
  vi.resetModules();
  transport.request.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('web lookUpConsentRegion', () => {
  it('asks the backend once per page load', async () => {
    transport.request.mockResolvedValue({ consentRegion: { countryCode: 'US', promptRequired: false } });
    const { lookUpConsentRegion } = await import('../consent-region');
    await expect(lookUpConsentRegion()).resolves.toBe(false);
    await expect(lookUpConsentRegion()).resolves.toBe(false);
    expect(transport.request).toHaveBeenCalledExactlyOnceWith(GET_CONSENT_REGION);
  });

  it('reports unknown when the request fails', async () => {
    transport.request.mockRejectedValue(new Error('offline'));
    const { lookUpConsentRegion } = await import('../consent-region');
    await expect(lookUpConsentRegion()).resolves.toBeNull();
  });

  it('reports unknown after five seconds without an answer', async () => {
    vi.useFakeTimers();
    transport.request.mockReturnValue(new Promise(() => {}));
    const { CONSENT_REGION_WAIT_MS, lookUpConsentRegion } = await import('../consent-region');
    const lookup = lookUpConsentRegion();
    await vi.advanceTimersByTimeAsync(CONSENT_REGION_WAIT_MS);
    await expect(lookup).resolves.toBeNull();
  });
});
