// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Drives the REAL useEffectiveSurfaceMode through its inputs, so Reduce
// Transparency and the Material variant are tested as the settings they are and
// not as a surface mode this file made up.
const device = vi.hoisted(() => ({
  os: 'ios' as string,
  liquidGlass: true,
  reduceTransparency: false,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  increaseContrast: 'off' as 'on' | 'off' | 'unknown',
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return device.os;
    },
  },
}));
vi.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => device.liquidGlass,
  isGlassEffectAPIAvailable: () => device.liquidGlass,
}));
vi.mock('../use-reduce-transparency', () => ({ useReduceTransparency: () => device.reduceTransparency }));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ variant: device.variant }) }));
vi.mock('../use-os-accessibility-signals', () => ({
  useOsAccessibilitySignals: () => ({
    increaseContrast: device.increaseContrast,
    grayscale: 'off',
    differentiateWithoutColor: 'off',
    ready: device.increaseContrast !== 'unknown',
  }),
}));

import { useFloatingHeaderControls } from '../use-floating-header-controls';

const floats = () => renderHook(() => useFloatingHeaderControls()).result.current;

describe('useFloatingHeaderControls', () => {
  beforeEach(() => {
    device.os = 'ios';
    device.liquidGlass = true;
    device.reduceTransparency = false;
    device.variant = 'liquidGlass';
    device.increaseContrast = 'off';
  });

  it('floats the controls on iOS 26 Liquid Glass', () => {
    expect(floats()).toBe(true);
  });

  it('keeps the band with Reduce Transparency on', () => {
    device.reduceTransparency = true;
    expect(floats()).toBe(false);
  });

  it('keeps the band with Increase Contrast on', () => {
    device.increaseContrast = 'on';
    expect(floats()).toBe(false);
  });

  // The read is async, and a blur that appears and then firms up into a band is
  // the wrong way round for someone who asked for more contrast.
  it('keeps the band until the Increase Contrast setting is known', () => {
    device.increaseContrast = 'unknown';
    expect(floats()).toBe(false);
  });

  it('keeps the band on the Material variant, even on an iOS 26 phone', () => {
    device.variant = 'material';
    expect(floats()).toBe(false);
  });

  it('keeps the band before iOS 26, where the bar above is a blur and not glass', () => {
    device.liquidGlass = false;
    expect(floats()).toBe(false);
  });

  it('keeps the band on Android opted into Liquid Glass', () => {
    device.os = 'android';
    device.liquidGlass = false;
    expect(floats()).toBe(false);
  });
});
