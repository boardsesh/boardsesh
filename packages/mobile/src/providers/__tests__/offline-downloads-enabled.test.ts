import { describe, expect, it } from 'vitest';
import { isOfflineDownloadsEnabled as isNativeOfflineDownloadsEnabled } from '../offline-downloads-enabled';
import { isOfflineDownloadsEnabled as isWebOfflineDownloadsEnabled } from '../offline-downloads-enabled.web';

describe('offline downloads platform gate', () => {
  it('follows the rollout flag on native', () => {
    expect(isNativeOfflineDownloadsEnabled(true)).toBe(true);
    expect(isNativeOfflineDownloadsEnabled(false)).toBe(false);
    expect(isNativeOfflineDownloadsEnabled(undefined)).toBe(false);
  });

  it('stays disabled on web even when the rollout flag is enabled', () => {
    expect(isWebOfflineDownloadsEnabled(true)).toBe(false);
  });
});
