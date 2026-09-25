// @vitest-environment jsdom
// Regression coverage for the Android hexagon-shadow bug (see
// BleLightbulbButton-elevation.test.tsx): BoardControlIndicator shares the exact
// same "connected" halo pattern, so it needs the same iOS-only elevation guard.
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

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#8e8e93' },
    brandColors: { warning: '#ffcc00', primary: '#7c5cff' },
  }),
}));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({
  useBleControlSheet: () => ({ open: vi.fn() }),
}));
vi.mock('../use-accessory-climb-tap', () => ({
  useAccessoryClimbTap: () => ({ openPlay: vi.fn() }),
}));
vi.mock('../../ble/use-lightbulb-control', () => ({
  useLightbulbControl: () => ({ onPress: vi.fn() }),
}));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    bluetooth: {},
    localConnected: true,
    inAppBoardConnection: 'connectedByMe',
    ledless: false,
    holderDisplayName: null,
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

afterEach(() => {
  vi.resetModules();
});

describe('BoardControlIndicator connected halo elevation', () => {
  it('keeps the native drop shadow on iOS', async () => {
    mockReactNative('ios');
    const { BoardControlIndicator } = await import('../BoardControlIndicator');
    const view = render(createElement(BoardControlIndicator));
    expect(view.getByRole('button').getAttribute('data-elevation')).toBe('2');
  });

  it('drops the native drop shadow on Android, where it renders as a hexagon on a fully-rounded view', async () => {
    mockReactNative('android');
    const { BoardControlIndicator } = await import('../BoardControlIndicator');
    const view = render(createElement(BoardControlIndicator));
    expect(view.getByRole('button').getAttribute('data-elevation')).toBe('0');
  });
});
