// @vitest-environment jsdom
// Regression coverage for the Android hexagon-shadow bug: a fully-rounded small
// view's native `elevation` shadow renders as a hexagon rather than a circle on
// real Android hardware, so the connected halo's elevation must be iOS-only.
// Platform.OS is read once at module scope (inside StyleSheet.create), so each
// platform needs its own react-native mock + fresh dynamic import.
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type PressableMockProps = {
  children?: ReactNode;
  style?: unknown;
};

function flattenStyle(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style;
  const layers = Array.isArray(resolved) ? resolved : [resolved];
  return Object.assign({}, ...layers.filter(Boolean));
}

function mockReactNative(platformOS: 'ios' | 'android') {
  vi.doMock('react-native', () => ({
    Platform: { OS: platformOS },
    Pressable: ({ children, style }: PressableMockProps) =>
      createElement('button', { 'data-elevation': String(flattenStyle(style).elevation) }, children),
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  }));
}

vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  cancelAnimation: vi.fn(),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initial: unknown) => ({ value: initial }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticMedium: vi.fn() }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#8e8e93' },
    brandColors: { warning: '#ffcc00' },
  }),
}));
vi.mock('../../../providers/bluetooth-write-activity', () => ({
  useBluetoothWriteInProgress: () => false,
}));
vi.mock('../../../theme/animations', () => ({ timing: { slow: 400, fast: 100 } }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));

afterEach(() => {
  vi.resetModules();
});

describe('BleLightbulbButton connected halo elevation', () => {
  it('keeps the native drop shadow on iOS', async () => {
    mockReactNative('ios');
    const { BleLightbulbButton } = await import('../BleLightbulbButton');
    const view = render(
      createElement(BleLightbulbButton, {
        isConnected: true,
        isScanning: false,
        onPress: vi.fn(),
        accessibilityLabel: 'Disconnect board',
      }),
    );
    expect(view.getByRole('button').getAttribute('data-elevation')).toBe('2');
  });

  it('drops the native drop shadow on Android, where it renders as a hexagon on a fully-rounded view', async () => {
    mockReactNative('android');
    const { BleLightbulbButton } = await import('../BleLightbulbButton');
    const view = render(
      createElement(BleLightbulbButton, {
        isConnected: true,
        isScanning: false,
        onPress: vi.fn(),
        accessibilityLabel: 'Disconnect board',
      }),
    );
    expect(view.getByRole('button').getAttribute('data-elevation')).toBe('0');
  });
});
