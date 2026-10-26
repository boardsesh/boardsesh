import { describe, it, expect, vi, beforeEach } from 'vitest';

const device = vi.hoisted(() => ({ nativeRootHeader: true, glassCapable: true, isPad: false }));

vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    get isPad() {
      return device.isPad;
    },
  },
}));
vi.mock('../use-native-root-header', () => ({ useNativeRootHeader: () => device.nativeRootHeader }));
vi.mock('../use-glass-capability', () => ({ useGlassCapability: () => device.glassCapable }));

import { useNativeRootBarItems } from '../use-native-root-bar-items';

describe('useNativeRootBarItems', () => {
  beforeEach(() => {
    device.nativeRootHeader = true;
    device.glassCapable = true;
    device.isPad = false;
  });

  it('puts the root actions in native bar items on an iOS 26 iPhone', () => {
    expect(useNativeRootBarItems()).toBe(true);
  });

  it('does the same on an iPad, where UIKit lays them out beside the sidebar button', () => {
    device.isPad = true;
    expect(useNativeRootBarItems()).toBe(true);
  });

  it('keeps the glass capsules before iOS 26, where a native item has no glass', () => {
    device.glassCapable = false;
    expect(useNativeRootBarItems()).toBe(false);
    device.isPad = true;
    expect(useNativeRootBarItems()).toBe(false);
  });

  it('stays off without the native root header (Material, Android)', () => {
    device.nativeRootHeader = false;
    expect(useNativeRootBarItems()).toBe(false);
  });
});
