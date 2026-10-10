import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeBoundary = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: nativeBoundary.resolve,
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('Apple Ads native boundary review', () => {
  it('lets an older binary without the native module continue safely', async () => {
    nativeBoundary.resolve.mockReturnValue(null);
    const { getAppleAdsAttributionToken } = await import('../../../modules/apple-ads-attribution/src');
    expect(await getAppleAdsAttributionToken()).toEqual({ status: 'unavailable' });
  });

  it('does not acquire a token while importing the module', async () => {
    const getAttributionToken = vi.fn(async () => ({ status: 'available', token: 'private-token-sentinel' }));
    nativeBoundary.resolve.mockReturnValue({ getAttributionToken });
    const { getAppleAdsAttributionToken } = await import('../../../modules/apple-ads-attribution/src');
    expect(getAttributionToken).not.toHaveBeenCalled();
    expect(await getAppleAdsAttributionToken()).toEqual({ status: 'available', token: 'private-token-sentinel' });
    expect(getAttributionToken).toHaveBeenCalledOnce();
  });

  it('swallows native errors that could contain sensitive details', async () => {
    const getAttributionToken = vi.fn().mockRejectedValue(new Error('Native exception private-token-sentinel'));
    nativeBoundary.resolve.mockReturnValue({ getAttributionToken });
    const { getAppleAdsAttributionToken } = await import('../../../modules/apple-ads-attribution/src');
    expect(await getAppleAdsAttributionToken()).toEqual({ status: 'retryable' });
  });
});
