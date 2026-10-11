import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GET_CONSENT_REGION } from '@boardsesh/graphql/operations/analytics-consent';

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: transport.request }) }));

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
    expect(transport.request).toHaveBeenCalledOnce();
    expect(transport.request.mock.calls[0]?.[0]).toMatchObject({ document: GET_CONSENT_REGION });
  });

  it('reports unknown when the request fails', async () => {
    transport.request.mockRejectedValue(new Error('offline'));
    const { lookUpConsentRegion } = await import('../consent-region');
    await expect(lookUpConsentRegion()).resolves.toBeNull();
  });

  it('reports unknown after five seconds without an answer, and aborts the request', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    transport.request.mockImplementation((options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const { CONSENT_REGION_WAIT_MS, lookUpConsentRegion } = await import('../consent-region');
    const lookup = lookUpConsentRegion();
    await vi.advanceTimersByTimeAsync(CONSENT_REGION_WAIT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });
});
