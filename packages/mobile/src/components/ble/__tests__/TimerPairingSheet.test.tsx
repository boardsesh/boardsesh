// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';
import type { DiscoveredDevice } from '../../../lib/ble/types';

// Capture the scan callbacks + expose a stop spy so tests can drive discovered
// devices and assert the scan is torn down, without real BLE / ble-plx.
const scan = vi.hoisted(() => {
  const state = {
    onUpdate: undefined as undefined | ((devices: DiscoveredDevice[]) => void),
    onScanStopped: undefined as undefined | (() => void),
    stop: vi.fn(),
  };
  return {
    state,
    scanForTimers: vi.fn((onUpdate: (devices: DiscoveredDevice[]) => void, onScanStopped?: () => void) => {
      state.onUpdate = onUpdate;
      state.onScanStopped = onScanStopped;
      return state.stop;
    }),
  };
});

vi.mock('../../../lib/ble/rogue-timer-ble', () => ({
  RogueTimerController: class {
    scanForTimers = scan.scanForTimers;
  },
}));

type ChildrenProps = { children?: ReactNode };
type PressableProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('react-native', () => ({
  View: ({ children }: ChildrenProps) => createElement('div', {}, children),
  Pressable: ({ children, onPress, accessibilityLabel }: PressableProps) =>
    createElement('button', { onClick: onPress, 'data-row': accessibilityLabel }, children),
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

type FlatListProps = { data?: DiscoveredDevice[]; renderItem?: (info: { item: DiscoveredDevice }) => ReactNode };
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef(({ children }: ChildrenProps, _ref: Ref<unknown>) =>
    createElement('div', { 'data-sheet': 'true' }, children),
  ),
  BottomSheetView: ({ children }: ChildrenProps) => createElement('div', {}, children),
  BottomSheetFlatList: ({ data, renderItem }: FlatListProps) =>
    createElement(
      'div',
      { 'data-list': 'true', 'data-count': String(data?.length ?? 0) },
      data?.map((item) => renderItem?.({ item })),
    ),
}));

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({ onChange: () => {}, onFullyDismissed: () => {} }),
}));
vi.mock('../../sheet-snap-points', () => ({ androidSafeSnapPoints: (points: string[]) => points }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#000' } }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 0 }),
  borderRadius: new Proxy({}, { get: () => 0 }),
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../Text', () => ({ Text: ({ children }: ChildrenProps) => createElement('span', {}, children) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { 'data-button': title, onClick: onPress }),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));

import { TimerPairingSheet } from '../TimerPairingSheet';

const device = (id: string, name: string, rssi = -50): DiscoveredDevice => ({ deviceId: id, name, rssi });

describe('TimerPairingSheet', () => {
  beforeEach(() => {
    scan.scanForTimers.mockClear();
    scan.state.stop.mockClear();
    scan.state.onUpdate = undefined;
    scan.state.onScanStopped = undefined;
  });

  it('starts a scan on mount and shows the scanning state', () => {
    const { container } = render(<TimerPairingSheet onSelect={vi.fn()} onDismiss={vi.fn()} />);
    expect(scan.scanForTimers).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('mobile.timerPair.scanning');
  });

  it('stops the scan on unmount', () => {
    const { unmount } = render(<TimerPairingSheet onSelect={vi.fn()} onDismiss={vi.fn()} />);
    expect(scan.state.stop).not.toHaveBeenCalled();
    unmount();
    expect(scan.state.stop).toHaveBeenCalledTimes(1);
  });

  it('lists discovered timers and reports the picked timer name on tap', () => {
    const onSelect = vi.fn();
    const { container } = render(<TimerPairingSheet onSelect={onSelect} onDismiss={vi.fn()} />);

    act(() => scan.state.onUpdate?.([device('a', 'Rogue Home Timer', -40), device('b', 'Rogue Echo Gym Timer', -70)]));

    const list = container.querySelector('[data-list="true"]');
    expect(list?.getAttribute('data-count')).toBe('2');
    // Strongest RSSI first.
    const rows = container.querySelectorAll('[data-row]');
    expect(rows[0]?.getAttribute('data-row')).toBe('Rogue Home Timer');

    act(() => (rows[0] as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith('Rogue Home Timer');
  });

  it('shows the empty state when the scan stops with no timers', () => {
    const { container } = render(<TimerPairingSheet onSelect={vi.fn()} onDismiss={vi.fn()} />);
    act(() => scan.state.onScanStopped?.());
    expect(container.textContent).toContain('mobile.timerPair.empty');
  });

  it('dismisses via the cancel button', () => {
    const onDismiss = vi.fn();
    const { container } = render(<TimerPairingSheet onSelect={vi.fn()} onDismiss={onDismiss} />);
    const cancel = container.querySelector('[data-button="mobile.timerPair.cancel"]') as HTMLButtonElement;
    act(() => cancel.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
