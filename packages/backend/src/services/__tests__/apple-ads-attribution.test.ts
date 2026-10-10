import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  APPLE_ADS_EXCHANGE_TIMEOUT_MS,
  APPLE_ADS_TOKEN_MAX_BYTES,
  exchangeAppleAdsToken,
} from '../apple-ads-attribution';

const TEST_TOKEN = 'opaque-adservices-token';
const applePayload = {
  attribution: true,
  orgId: 101,
  campaignId: 202,
  adGroupId: 303,
  conversionType: 'Download',
};

describe('AdServices token exchange', () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends exactly one text/plain request to the fixed Apple endpoint', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(applePayload)));
    expect(await exchangeAppleAdsToken(TEST_TOKEN)).toEqual({
      status: 'ATTRIBUTED',
      attribution: { orgId: '101', campaignId: '202', adGroupId: '303', conversionType: 'Download' },
      retryAfterSeconds: null,
      retryReason: null,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://api-adservices.apple.com/api/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Accept: 'application/json' },
      body: TEST_TOKEN,
      signal: expect.any(AbortSignal),
      redirect: 'error',
    });
  });

  it.each([
    { httpStatus: 400, status: 'INVALID_TOKEN', retryReason: null, retryAfterSeconds: null },
    { httpStatus: 404, status: 'RETRYABLE', retryReason: 'not_ready', retryAfterSeconds: 5 },
    { httpStatus: 500, status: 'RETRYABLE', retryReason: 'unavailable', retryAfterSeconds: 5 },
    { httpStatus: 429, status: 'RETRYABLE', retryReason: 'unavailable', retryAfterSeconds: 5 },
  ])('maps Apple HTTP $httpStatus without retrying or reflecting its error body', async (outcome) => {
    mockFetch.mockResolvedValue(new Response(TEST_TOKEN, { status: outcome.httpStatus }));
    expect(await exchangeAppleAdsToken(TEST_TOKEN)).toEqual({
      status: outcome.status,
      attribution: null,
      retryAfterSeconds: outcome.retryAfterSeconds,
      retryReason: outcome.retryReason,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'token\nwith-newline', 'x'.repeat(APPLE_ADS_TOKEN_MAX_BYTES + 1)])(
    'rejects malformed or oversized tokens before contacting Apple',
    async (token) => {
      expect(await exchangeAppleAdsToken(token)).toMatchObject({ status: 'INVALID_TOKEN', attribution: null });
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it('returns a safe retry outcome for a fetch error containing the token', async () => {
    mockFetch.mockRejectedValue(new Error(`Request body was ${TEST_TOKEN}`));
    const result = await exchangeAppleAdsToken(TEST_TOKEN);
    expect(result).toMatchObject({ status: 'RETRYABLE', attribution: null, retryReason: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  });

  it('applies the five-second deadline to a body that never finishes', async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    mockFetch.mockResolvedValue(new Response(stream));
    const pending = exchangeAppleAdsToken(TEST_TOKEN);
    await vi.advanceTimersByTimeAsync(APPLE_ADS_EXCHANGE_TIMEOUT_MS);
    expect(await pending).toMatchObject({ status: 'RETRYABLE', attribution: null, retryReason: 'unavailable' });
    expect(mockFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
