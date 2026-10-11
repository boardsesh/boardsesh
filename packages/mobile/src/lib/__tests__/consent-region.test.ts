import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_CONSENT_REGION } from '@boardsesh/graphql/operations/analytics-consent';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../graphql/client', () => ({ getHttpClient: () => ({ request }) }));

import { CONSENT_REGION_WAIT_MS, lookUpConsentRegion, resetConsentRegionLookup } from '../consent-region';

beforeEach(() => {
  request.mockReset();
  resetConsentRegionLookup();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('lookUpConsentRegion', () => {
  it.each([
    [{ countryCode: 'US', promptRequired: false }, false],
    [{ countryCode: 'DE', promptRequired: true }, true],
    [{ countryCode: null, promptRequired: true }, true],
  ])('returns promptRequired from %j', async (consentRegion, expected) => {
    request.mockResolvedValue({ consentRegion });
    await expect(lookUpConsentRegion()).resolves.toBe(expected);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ document: GET_CONSENT_REGION }));
  });

  it('asks once per launch, even when called from several places', async () => {
    request.mockResolvedValue({ consentRegion: { countryCode: 'US', promptRequired: false } });
    await Promise.all([lookUpConsentRegion(), lookUpConsentRegion()]);
    await lookUpConsentRegion();
    expect(request).toHaveBeenCalledOnce();
  });

  it('reports unknown when the request fails, and does not retry in the same launch', async () => {
    request.mockRejectedValue(new Error('offline'));
    await expect(lookUpConsentRegion()).resolves.toBeNull();
    await expect(lookUpConsentRegion()).resolves.toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it('reports unknown for an answer without promptRequired (an older backend)', async () => {
    request.mockResolvedValue({ consentRegion: null });
    await expect(lookUpConsentRegion()).resolves.toBeNull();
  });

  it('gives up after five seconds and aborts the request', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    request.mockImplementation((options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const lookup = lookUpConsentRegion();
    await vi.advanceTimersByTimeAsync(CONSENT_REGION_WAIT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });
});
