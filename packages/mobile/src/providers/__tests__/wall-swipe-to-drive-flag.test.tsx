// @vitest-environment jsdom
//
// `wall-swipe-to-drive` (#7113): the kill switch for the wall button's swipe,
// its hints, its screen-reader action and the board sheet's row. A POSITIVE
// flag: a store build offers nothing until PostHog says on; a dev build offers
// it unless a tester turns it off; store hero captures opt in explicitly.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import {
  FEATURE_FLAG_DEFINITIONS,
  FeatureFlagsProvider,
  useWallSwipeToDriveEnabled,
  wallSwipeToDriveOffered,
} from '../feature-flags-provider';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the wall-swipe-to-drive flag', () => {
  it('is in the catalog, so PostHog is asked for it and testers can force it', () => {
    expect(FEATURE_FLAG_DEFINITIONS.map((definition) => definition.key as string)).toContain('wall-swipe-to-drive');
  });

  it('offers nothing in a store build until the flag is on', () => {
    vi.stubGlobal('__DEV__', false);
    expect(wallSwipeToDriveOffered(undefined)).toBe(false);
    expect(wallSwipeToDriveOffered(false)).toBe(false);
    expect(wallSwipeToDriveOffered('true')).toBe(false);
    expect(wallSwipeToDriveOffered(true)).toBe(true);
  });

  it('offers it in a dev build unless a tester turns it off', () => {
    vi.stubGlobal('__DEV__', true);
    expect(wallSwipeToDriveOffered(undefined)).toBe(true);
    expect(wallSwipeToDriveOffered(false)).toBe(false);
  });

  it('never offers it in screenshot mode', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubGlobal('__DEV__', true);
    expect(wallSwipeToDriveOffered(true)).toBe(false);
  });

  it('offers driving only to explicitly opted-in fake-Bluetooth captures', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_DRIVING', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    expect(wallSwipeToDriveOffered(undefined)).toBe(true);
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '0');
    expect(wallSwipeToDriveOffered(true)).toBe(false);
  });

  it('a screenshot opt-in never overrides the normal store rollout flag', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_DRIVING', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    vi.stubGlobal('__DEV__', false);
    expect(wallSwipeToDriveOffered(undefined)).toBe(false);
    expect(wallSwipeToDriveOffered(false)).toBe(false);
  });

  it('reads the provider’s value', () => {
    vi.stubGlobal('__DEV__', false);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={{ 'wall-swipe-to-drive': true }}>{children}</FeatureFlagsProvider>
    );
    expect(renderHook(() => useWallSwipeToDriveEnabled(), { wrapper }).result.current).toBe(true);
  });
});
