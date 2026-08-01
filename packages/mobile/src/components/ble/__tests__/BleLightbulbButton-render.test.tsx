// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PressableMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: { busy?: boolean; selected?: boolean };
  style?: unknown;
};

vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    onLongPress,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
  }: PressableMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        onDoubleClick: onLongPress,
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint ?? '',
        'data-busy': String(accessibilityState?.busy ?? false),
        'data-selected': String(accessibilityState?.selected ?? false),
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  cancelAnimation: vi.fn(),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initial: unknown) => ({ value: initial }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

const haptics = vi.hoisted(() => ({ light: vi.fn(), medium: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light, hapticMedium: haptics.medium }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#8e8e93' },
    brandColors: { warning: '#ffcc00' },
  }),
}));
vi.mock('../../../theme/animations', () => ({ timing: { slow: 400, fast: 100 } }));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: ({ color }: { color?: string }) =>
    createElement('span', { 'data-spinner': 'true', 'data-color': color }),
}));

import { createBleWriteActivityStore } from '../../../lib/ble/write-activity-store';
import { BluetoothWriteActivityProvider } from '../../../providers/bluetooth-write-activity';
import { BleLightbulbButton } from '../BleLightbulbButton';

describe('BleLightbulbButton write activity', () => {
  beforeEach(() => {
    haptics.light.mockClear();
    haptics.medium.mockClear();
  });

  it('shows a busy native spinner while writing without disabling either press action', () => {
    const store = createBleWriteActivityStore();
    const onPress = vi.fn();
    const onLongPress = vi.fn();
    const view = render(
      createElement(
        BluetoothWriteActivityProvider,
        { store },
        createElement(BleLightbulbButton, {
          isConnected: true,
          isScanning: false,
          onPress,
          onLongPress,
          accessibilityLabel: 'Disconnect board',
          writingAccessibilityHint: 'Lighting the board',
          longPressAccessibilityHint: 'Hold for controls',
        }),
      ),
    );

    let release = () => {};
    act(() => {
      release = store.begin();
    });

    const button = view.getByRole('button');
    expect(view.container.querySelector('[data-spinner="true"]')).toBeTruthy();
    expect(view.container.querySelector('[data-icon]')).toBeNull();
    expect(button.getAttribute('data-busy')).toBe('true');
    expect(button.getAttribute('data-label')).toBe('Disconnect board');
    expect(button.getAttribute('data-hint')).toBe('Lighting the board');

    fireEvent.click(button);
    fireEvent.doubleClick(button);
    expect(onPress).toHaveBeenCalledOnce();
    expect(onLongPress).toHaveBeenCalledOnce();
    expect(haptics.light).toHaveBeenCalledOnce();
    expect(haptics.medium).toHaveBeenCalledOnce();

    act(() => release());
    expect(view.container.querySelector('[data-spinner="true"]')).toBeNull();
    expect(view.container.querySelector('[data-icon="lightbulb.fill"]')).toBeTruthy();
    expect(button.getAttribute('data-busy')).toBe('false');
    expect(button.getAttribute('data-hint')).toBe('Hold for controls');
  });

  it('keeps the scanning pulse/icon and hint ahead of write feedback', () => {
    const store = createBleWriteActivityStore();
    const view = render(
      createElement(
        BluetoothWriteActivityProvider,
        { store },
        createElement(BleLightbulbButton, {
          isConnected: true,
          isScanning: true,
          onPress: vi.fn(),
          accessibilityLabel: 'Disconnect board',
          scanningAccessibilityHint: 'Scanning for boards nearby',
          writingAccessibilityHint: 'Lighting the board',
        }),
      ),
    );
    let release = () => {};
    act(() => {
      release = store.begin();
    });

    const button = view.getByRole('button');
    expect(view.container.querySelector('[data-spinner="true"]')).toBeNull();
    expect(view.container.querySelector('[data-icon="lightbulb.fill"]')).toBeTruthy();
    expect(button.getAttribute('data-busy')).toBe('true');
    expect(button.getAttribute('data-hint')).toBe('Scanning for boards nearby');

    act(() => release());
  });
});
