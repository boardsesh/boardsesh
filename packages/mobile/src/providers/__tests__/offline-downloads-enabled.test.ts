import { describe, expect, it } from 'vitest';
import { isOfflineDownloadsEnabled as isNativeOfflineDownloadsEnabled } from '../offline-downloads-enabled';
import { isOfflineDownloadsEnabled as isWebOfflineDownloadsEnabled } from '../offline-downloads-enabled.web';

describe('offline downloads platform gate', () => {
  it('is on by default on native, including when the flag never resolved', () => {
    expect(isNativeOfflineDownloadsEnabled(true)).toBe(true);
    // The #4312 behaviour change: PostHog's /flags response never landing means
    // the user opened the app with no signal — this feature's audience.
    expect(isNativeOfflineDownloadsEnabled(undefined)).toBe(true);
  });

  it('still kills the engine on an explicit false (the kill switch)', () => {
    expect(isNativeOfflineDownloadsEnabled(false)).toBe(false);
  });

  it('stays disabled on web for every flag value', () => {
    expect(isWebOfflineDownloadsEnabled(true)).toBe(false);
    expect(isWebOfflineDownloadsEnabled(false)).toBe(false);
    expect(isWebOfflineDownloadsEnabled(undefined)).toBe(false);
  });
});
