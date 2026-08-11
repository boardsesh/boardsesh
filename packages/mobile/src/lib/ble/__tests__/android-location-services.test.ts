import { describe, it, expect, vi, beforeEach } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'android' as string }));
const sendIntent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('react-native', () => ({
  get Platform() {
    return { OS: platform.OS };
  },
  Linking: { sendIntent },
}));

const location = vi.hoisted(() => ({
  hasServicesEnabledAsync: vi.fn(async () => true),
  enableNetworkProviderAsync: vi.fn(async () => {}),
}));
vi.mock('expo-location', () => location);

import { getAndroidLocationServicesState, promptEnableAndroidLocationServices } from '../android-location-services';

describe('getAndroidLocationServicesState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.OS = 'android';
    location.hasServicesEnabledAsync.mockResolvedValue(true);
  });

  it('returns true when Location services are on', async () => {
    location.hasServicesEnabledAsync.mockResolvedValue(true);
    await expect(getAndroidLocationServicesState()).resolves.toBe(true);
  });

  it('returns false when Location services are off', async () => {
    location.hasServicesEnabledAsync.mockResolvedValue(false);
    await expect(getAndroidLocationServicesState()).resolves.toBe(false);
  });

  it('returns null off Android without touching expo-location', async () => {
    platform.OS = 'ios';
    await expect(getAndroidLocationServicesState()).resolves.toBeNull();
    expect(location.hasServicesEnabledAsync).not.toHaveBeenCalled();
  });

  it('returns null when the read throws', async () => {
    location.hasServicesEnabledAsync.mockRejectedValue(new Error('native module unavailable'));
    await expect(getAndroidLocationServicesState()).resolves.toBeNull();
  });
});

describe('promptEnableAndroidLocationServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.OS = 'android';
    location.enableNetworkProviderAsync.mockResolvedValue(undefined);
    sendIntent.mockResolvedValue(undefined);
  });

  it('resolves true when the in-app dialog succeeds', async () => {
    await expect(promptEnableAndroidLocationServices()).resolves.toBe(true);
    expect(sendIntent).not.toHaveBeenCalled();
  });

  it('falls back to the system settings intent when the dialog throws (e.g. no Play services)', async () => {
    location.enableNetworkProviderAsync.mockRejectedValue(new Error('no Play services'));
    await expect(promptEnableAndroidLocationServices()).resolves.toBe(false);
    expect(sendIntent).toHaveBeenCalledWith('android.settings.LOCATION_SOURCE_SETTINGS');
  });

  it('never throws even when both the dialog and the settings intent fail', async () => {
    location.enableNetworkProviderAsync.mockRejectedValue(new Error('no Play services'));
    sendIntent.mockRejectedValue(new Error('no activity to handle intent'));
    await expect(promptEnableAndroidLocationServices()).resolves.toBe(false);
  });

  it('resolves false off Android without touching expo-location', async () => {
    platform.OS = 'ios';
    await expect(promptEnableAndroidLocationServices()).resolves.toBe(false);
    expect(location.enableNetworkProviderAsync).not.toHaveBeenCalled();
  });
});
