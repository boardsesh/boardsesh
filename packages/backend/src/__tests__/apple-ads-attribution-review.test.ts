import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeAppleAdsAttributionPayload } from '@boardsesh/shared-schema/apple-ads-attribution';
import { exchangeAppleAdsToken } from '../services/apple-ads-attribution';

const attributedPayload = {
  attribution: true,
  orgId: 71,
  campaignId: 72,
  adGroupId: 73,
  conversionType: 'Download',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Apple Ads independent privacy review', () => {
  it.each([Number.MAX_SAFE_INTEGER + 1, '9007199254740993', '0', '-1', '07', 1.5])(
    'never publishes an ambiguous campaign identifier: %s',
    (campaignId) => {
      expect(normalizeAppleAdsAttributionPayload({ ...attributedPayload, campaignId }).status).toBe('RETRYABLE');
    },
  );

  it('drops unsupported optional fields and every unrecognized payload field', () => {
    const result = normalizeAppleAdsAttributionPayload({
      ...attributedPayload,
      keywordId: 'invalid',
      adId: Number.MAX_SAFE_INTEGER + 1,
      claimType: 'unknown',
      countryOrRegion: 'US-extra',
      supplyPlacement: 'unsupported',
      clickDate: '2026-10-10T00:00:00Z',
      token: 'private-token-sentinel',
    });
    expect(result.attribution).toEqual({ orgId: '71', campaignId: '72', adGroupId: '73', conversionType: 'Download' });
    expect(JSON.stringify(result)).not.toContain('private-token-sentinel');
  });

  it('never includes a raw token or exception details when fetch fails', async () => {
    const token = 'private-token-sentinel';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`Upstream failure with ${token}`)));
    expect(await exchangeAppleAdsToken(token)).toEqual({
      status: 'RETRYABLE',
      attribution: null,
      retryAfterSeconds: 5,
      retryReason: 'unavailable',
    });
  });

  it('bounds an undeclared response stream and cancels it on overflow', async () => {
    const cancel = vi.fn();
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 + 1));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(oversizedBody)));
    expect((await exchangeAppleAdsToken('opaque-token')).status).toBe('RETRYABLE');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not consume error bodies that might echo the token', async () => {
    const cancel = vi.fn();
    const sensitiveBody = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sensitiveBody, { status: 400 })));
    expect((await exchangeAppleAdsToken('opaque-token')).status).toBe('INVALID_TOKEN');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns no campaign properties from an explicitly unattributed response', () => {
    expect(normalizeAppleAdsAttributionPayload({ ...attributedPayload, attribution: false }).attribution).toBeNull();
  });
});
