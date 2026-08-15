import { describe, expect, it } from 'vitest';
import { isOfflineDownloadsEnabled as isNativeOfflineDownloadsEnabled } from '../offline-downloads-enabled';
import { isOfflineDownloadsEnabled as isWebOfflineDownloadsEnabled } from '../offline-downloads-enabled.web';

describe('offline downloads platform gate', () => {
  it('is permanently on on native, regardless of legacy flag input', () => {
    expect(isNativeOfflineDownloadsEnabled(true)).toBe(true);
    expect(isNativeOfflineDownloadsEnabled(undefined)).toBe(true);
    expect(isNativeOfflineDownloadsEnabled(false)).toBe(true);
  });

  it('stays disabled on web for every flag value', () => {
    expect(isWebOfflineDownloadsEnabled(true)).toBe(false);
    expect(isWebOfflineDownloadsEnabled(false)).toBe(false);
    expect(isWebOfflineDownloadsEnabled(undefined)).toBe(false);
  });
});
