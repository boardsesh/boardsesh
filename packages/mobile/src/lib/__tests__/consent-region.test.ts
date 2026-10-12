import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET_CONSENT_REGION } from '@boardsesh/graphql/operations/analytics-consent';

const { request, client } = vi.hoisted(() => ({ request: vi.fn(), client: { throws: false } }));
vi.mock('../graphql/client', () => ({
  getHttpClient: () => {
    if (client.throws) throw new Error('no backend URL');
    return { request };
  },
}));

import {
  CONSENT_REGION_WAIT_MS,
  expireConsentRegionLookup,
  isGlobalPrivacyControlEnabled,
  lookUpConsentRegion,
  resetConsentRegionLookup,
} from '../consent-region';

beforeEach(() => {
  request.mockReset();
  client.throws = false;
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

describe('expireConsentRegionLookup', () => {
  it('refreshes even a just-completed answer on foreground resume', async () => {
    request.mockResolvedValue({ consentRegion: { countryCode: 'US', promptRequired: false } });
    await lookUpConsentRegion();
    expect(expireConsentRegionLookup()).toBe(true);
    request.mockResolvedValue({ consentRegion: { countryCode: 'DE', promptRequired: true } });
    await expect(lookUpConsentRegion()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('queues a fresh lookup after a pending request fails on resume', async () => {
    let fail!: (error: Error) => void;
    request
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      )
      .mockResolvedValueOnce({ consentRegion: { countryCode: 'DE', promptRequired: true } });
    const pending = lookUpConsentRegion();
    expect(expireConsentRegionLookup()).toBe(true);
    expect(expireConsentRegionLookup()).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    fail(new Error('offline on old network'));
    await expect(pending).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('lookUpConsentRegion failures', () => {
  it('reports unknown when the HTTP client cannot be built, instead of rejecting', async () => {
    client.throws = true;
    await expect(lookUpConsentRegion()).resolves.toBeNull();
  });
});

describe('isGlobalPrivacyControlEnabled', () => {
  it('is off in the native app, which sends no Sec-GPC', async () => {
    request.mockResolvedValue({
      consentRegion: { countryCode: 'US', promptRequired: false, globalPrivacyControl: false },
    });
    await lookUpConsentRegion();
    expect(isGlobalPrivacyControlEnabled()).toBe(false);
  });

  it('follows the Sec-GPC header the backend saw from the browser app', async () => {
    request.mockResolvedValue({
      consentRegion: { countryCode: 'US', promptRequired: false, globalPrivacyControl: true },
    });
    await lookUpConsentRegion();
    expect(isGlobalPrivacyControlEnabled()).toBe(true);
  });

  it('follows navigator.globalPrivacyControl in a browser', () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    try {
      expect(isGlobalPrivacyControlEnabled()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
