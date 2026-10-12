import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { GET_CONSENT_REGION } from '@boardsesh/graphql/operations/analytics-consent';

const transport = vi.hoisted(() => ({ request: vi.fn(), clientThrows: false }));
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => {
    // getGraphQLHttpUrl throws on an unknown host when NEXT_PUBLIC_WS_URL is unset.
    if (transport.clientThrows) throw new Error('Unknown host');
    return { request: transport.request };
  },
}));

beforeEach(() => {
  vi.resetModules();
  transport.request.mockReset();
  transport.clientThrows = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('web lookUpConsentRegion', () => {
  it('asks the backend once per page load', async () => {
    transport.request.mockResolvedValue({ consentRegion: { countryCode: 'US', promptRequired: false } });
    const { lookUpConsentRegion } = await import('../consent-region');
    await expect(lookUpConsentRegion()).resolves.toEqual({ promptRequired: false, globalPrivacyControl: false });
    await expect(lookUpConsentRegion()).resolves.toEqual({ promptRequired: false, globalPrivacyControl: false });
    expect(transport.request).toHaveBeenCalledOnce();
    expect(transport.request.mock.calls[0]?.[0]).toMatchObject({ document: GET_CONSENT_REGION });
  });

  it('queues a fresh answer when resume occurs during an in-flight lookup', async () => {
    let answer!: (response: unknown) => void;
    transport.request.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { lookUpConsentRegion, expireConsentRegionLookup } = await import('../consent-region');
    expect(expireConsentRegionLookup()).toBe(false);
    const pending = lookUpConsentRegion();
    expect(expireConsentRegionLookup()).toBe(true);
    expect(expireConsentRegionLookup()).toBe(true);
    transport.request.mockResolvedValue({ consentRegion: { countryCode: 'DE', promptRequired: true } });
    await Promise.resolve();
    answer({ consentRegion: { countryCode: 'US', promptRequired: false } });
    await expect(pending).resolves.toEqual({ promptRequired: true, globalPrivacyControl: false });
    await expect(lookUpConsentRegion()).resolves.toEqual({ promptRequired: true, globalPrivacyControl: false });
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it('reports unknown when the request fails', async () => {
    transport.request.mockRejectedValue(new Error('offline'));
    const { lookUpConsentRegion } = await import('../consent-region');
    await expect(lookUpConsentRegion()).resolves.toEqual({ promptRequired: null, globalPrivacyControl: false });
  });

  it('reports unknown, and clears its deadline, when the HTTP client cannot be built', async () => {
    vi.useFakeTimers();
    transport.clientThrows = true;
    const { lookUpConsentRegion } = await import('../consent-region');
    await expect(lookUpConsentRegion()).resolves.toEqual({ promptRequired: null, globalPrivacyControl: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['the Sec-GPC header the backend saw', true, undefined],
    ['navigator.globalPrivacyControl', false, true],
  ])('reports Global Privacy Control from %s', async (_source, headerGpc, navigatorGpc) => {
    if (navigatorGpc !== undefined) vi.stubGlobal('navigator', { globalPrivacyControl: navigatorGpc });
    transport.request.mockResolvedValue({
      consentRegion: { countryCode: 'US', promptRequired: false, globalPrivacyControl: headerGpc },
    });
    const { lookUpConsentRegion } = await import('../consent-region');
    await expect(lookUpConsentRegion()).resolves.toEqual({ promptRequired: false, globalPrivacyControl: true });
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
    await expect(lookup).resolves.toEqual({ promptRequired: null, globalPrivacyControl: false });
    expect(signal?.aborted).toBe(true);
  });
});
