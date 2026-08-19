import { describe, it, expect, vi, beforeEach } from 'vitest';

const linking = vi.hoisted(() => ({ openSettings: vi.fn() }));
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));

vi.mock('react-native', () => ({ Linking: linking, Platform: platform }));

import { canOpenAppSettings, openAppSettings } from '../open-app-settings';

beforeEach(() => {
  linking.openSettings.mockReset();
  platform.OS = 'ios';
});

describe('canOpenAppSettings', () => {
  it('is true on ios and android', () => {
    platform.OS = 'ios';
    expect(canOpenAppSettings()).toBe(true);
    platform.OS = 'android';
    expect(canOpenAppSettings()).toBe(true);
  });

  it('is false on web', () => {
    platform.OS = 'web';
    expect(canOpenAppSettings()).toBe(false);
  });
});

describe('openAppSettings', () => {
  it('calls Linking.openSettings on ios and resolves true', async () => {
    platform.OS = 'ios';
    linking.openSettings.mockResolvedValue(undefined);

    const opened = await openAppSettings();

    expect(opened).toBe(true);
    expect(linking.openSettings).toHaveBeenCalledTimes(1);
  });

  it('calls Linking.openSettings on android and resolves true', async () => {
    platform.OS = 'android';
    linking.openSettings.mockResolvedValue(undefined);

    const opened = await openAppSettings();

    expect(opened).toBe(true);
    expect(linking.openSettings).toHaveBeenCalledTimes(1);
  });

  // Regression guard for BOARDSESH-DT: react-native-web's Linking has no
  // openSettings, so it must never even be reached on web.
  it('returns false on web without touching Linking.openSettings', async () => {
    platform.OS = 'web';

    const opened = await openAppSettings();

    expect(opened).toBe(false);
    expect(linking.openSettings).not.toHaveBeenCalled();
  });

  it('resolves false (does not throw) when openSettings rejects', async () => {
    platform.OS = 'ios';
    linking.openSettings.mockRejectedValue(new Error('no settings activity'));

    const opened = await openAppSettings();

    expect(opened).toBe(false);
  });
});
