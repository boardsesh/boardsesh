import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as Updates from 'expo-updates';
import { applyChannelOverride } from '../apply-channel-override';
import { OTA_APP_ID } from '../ota-app-id';

// setUpdateRequestHeadersOverride REPLACES the baked header set (it doesn't merge),
// so the override must re-send expo-app-id alongside expo-channel-name — otherwise
// header-less requests 400 on the V3 server and every channel switch (and the per-PR
// preview flow) silently fails. Guard that here so it can't regress to channel-only.
vi.mock('expo-updates', () => ({ setUpdateRequestHeadersOverride: vi.fn() }));

describe('applyChannelOverride', () => {
  beforeEach(() => {
    vi.mocked(Updates.setUpdateRequestHeadersOverride).mockClear();
  });

  it('re-sends BOTH baked headers (expo-app-id + expo-channel-name), not just the channel', () => {
    applyChannelOverride('pr-123');
    expect(Updates.setUpdateRequestHeadersOverride).toHaveBeenCalledWith({
      'expo-app-id': OTA_APP_ID,
      'expo-channel-name': 'pr-123',
    });
  });

  it('clears the override with null (reverts to the build-time headers)', () => {
    applyChannelOverride(null);
    expect(Updates.setUpdateRequestHeadersOverride).toHaveBeenCalledWith(null);
  });
});
