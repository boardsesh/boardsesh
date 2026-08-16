// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

type AppbarActionMockProps = {
  icon: string | (() => ReactNode);
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityState?: { busy?: boolean };
};

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-paper', () => ({
  Appbar: {
    Action: ({ icon, onPress, onLongPress, accessibilityLabel, accessibilityState }: AppbarActionMockProps) =>
      createElement(
        'button',
        {
          onClick: onPress,
          onDoubleClick: onLongPress,
          'data-label': accessibilityLabel,
          'data-busy': String(accessibilityState?.busy ?? false),
        },
        typeof icon === 'function' ? icon() : createElement('span', { 'data-icon': icon }),
      ),
  },
}));

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000000' },
    brandColors: { warning: '#ffcc00' },
  }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: ({ color }: { color?: string }) =>
    createElement('span', { 'data-spinner': 'true', 'data-color': color }),
}));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../play-drawer/AngleSelectorSheet', () => ({ AngleSelectorSheet: () => null }));
vi.mock('../use-material-angle-control', () => ({ useMaterialAngleControl: () => ({}) }));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({
  useBleControlSheet: () => ({ open: vi.fn(), close: vi.fn() }),
}));

const lightbulbControl = vi.hoisted(() => ({
  bluetooth: { connected: true },
  lit: true,
  localConnected: true,
  onPress: vi.fn(),
  onLongPress: vi.fn(),
}));
vi.mock('../../ble/use-lightbulb-control', () => ({
  useLightbulbControl: () => lightbulbControl,
}));

import { createBleWriteActivityStore } from '../../../lib/ble/write-activity-store';
import { BluetoothWriteActivityProvider } from '../../../providers/bluetooth-write-activity';
import { MaterialLightbulbAction } from '../MaterialBoardActions';

describe('MaterialLightbulbAction write activity', () => {
  it('swaps the app-bar icon for a spinner while a BLE write is in flight', () => {
    const store = createBleWriteActivityStore();
    const view = render(
      createElement(BluetoothWriteActivityProvider, { store }, createElement(MaterialLightbulbAction)),
    );

    // Idle: renders the lightbulb glyph, not busy.
    expect(view.container.querySelector('[data-spinner="true"]')).toBeNull();
    expect(view.container.querySelector('[data-icon]')).toBeTruthy();
    expect(view.getByRole('button').getAttribute('data-busy')).toBe('false');

    let release = () => {};
    act(() => {
      release = store.begin();
    });

    // Writing (e.g. a "Re-light board" tap): spinner replaces the glyph and the
    // button reports busy, so the app-bar icon is never silent about the write.
    expect(view.container.querySelector('[data-spinner="true"]')).toBeTruthy();
    expect(view.container.querySelector('[data-icon]')).toBeNull();
    expect(view.getByRole('button').getAttribute('data-busy')).toBe('true');

    act(() => release());
    expect(view.container.querySelector('[data-spinner="true"]')).toBeNull();
    expect(view.container.querySelector('[data-icon]')).toBeTruthy();
    expect(view.getByRole('button').getAttribute('data-busy')).toBe('false');
  });
});
