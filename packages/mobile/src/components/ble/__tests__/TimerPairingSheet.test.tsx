// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
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

// What the sheet checks before it scans: the permission answer, the radio, and
// why the radio said no.
const radio = vi.hoisted(() => ({
  permission: 'granted' as 'granted' | 'denied' | 'blocked' | 'unsupported',
  poweredOn: true,
  unavailableReason: 'unknown' as 'unauthorized' | 'powered_off' | 'unsupported' | 'unknown',
  openAppSettings: vi.fn(async () => true),
}));
vi.mock('../../../lib/ble/use-ble-permissions', () => ({
  requestBleRuntimePermissionStatus: async () => radio.permission,
}));
vi.mock('../../../lib/ble/availability', () => ({ waitForBlePoweredOn: async () => radio.poweredOn }));
vi.mock('../../../lib/ble/bluetooth-unavailable', () => ({
  readBluetoothUnavailableReason: async () => radio.unavailableReason,
}));
vi.mock('../../../lib/ble/bluetooth-unavailable-alert', () => ({ bluetoothBlockedBody: () => 'ble.blockedBody' }));
vi.mock('../../../lib/open-app-settings', () => ({
  canOpenAppSettings: () => true,
  openAppSettings: radio.openAppSettings,
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { 'data-button': title, onClick: onPress }, title),
}));

type ChildrenProps = { children?: ReactNode };
type PressableProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('react-native', () => ({
  // Exposes the resolved background colour so the RSSI bars can be asserted.
  View: ({ children, style }: ChildrenProps & { style?: unknown }) => {
    const styleEntries = (Array.isArray(style) ? style : [style]) as Array<{ backgroundColor?: string } | undefined>;
    const backgroundColor = styleEntries.reduce<string | undefined>(
      (resolved, entry) => entry?.backgroundColor ?? resolved,
      undefined,
    );
    return createElement('div', backgroundColor ? { 'data-bg': backgroundColor } : {}, children);
  },
  Pressable: ({ children, onPress, accessibilityLabel }: PressableProps) =>
    createElement('button', { onClick: onPress, 'data-row': accessibilityLabel }, children),
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

type FlatListProps = { data?: DiscoveredDevice[]; renderItem?: (info: { item: DiscoveredDevice }) => ReactNode };
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({ data, renderItem }: FlatListProps) =>
    createElement(
      'div',
      { 'data-list': 'true', 'data-count': String(data?.length ?? 0) },
      data?.map((item) => renderItem?.({ item })),
    ),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
type SheetMockProps = { children?: ReactNode; header?: ReactNode; visible?: boolean };
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, header, visible }: SheetMockProps) =>
    createElement('div', { 'data-sheet': 'true', 'data-visible': String(visible) }, header, children),
}));
type TopBarMockProps = { title: string; leading?: { kind: string; onPress: () => void } };
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, leading }: TopBarMockProps) =>
    createElement(
      'div',
      { 'data-top-bar': title },
      leading ? createElement('button', { 'data-leading': leading.kind, onClick: leading.onPress }) : null,
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: { error: 'theme-error', fill: 'theme-fill' }, brandColors: { primary: '#000' } }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: new Proxy({}, { get: () => 0 }),
  borderRadius: new Proxy({}, { get: () => 0 }),
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGreen: '#34c759', systemYellow: '#ffcc00' } }));
vi.mock('../../Text', () => ({ Text: ({ children }: ChildrenProps) => createElement('span', {}, children) }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));

import { TimerPairingSheet } from '../TimerPairingSheet';
import { RogueTimerContext, type RogueTimerPairingScanStarter } from '../../../providers/rogue-timer-context';

const device = (id: string, name: string, rssi = -50): DiscoveredDevice => ({ deviceId: id, name, rssi });

function resetScan() {
  scan.scanForTimers.mockClear();
  scan.state.stop.mockClear();
  scan.state.onUpdate = undefined;
  scan.state.onScanStopped = undefined;
  radio.permission = 'granted';
  radio.poweredOn = true;
  radio.unavailableReason = 'unknown';
  radio.openAppSettings.mockClear();
}

/** Render the sheet and let its permission and radio checks answer. */
async function renderSheet(onSelect = vi.fn(), onDismiss = vi.fn()) {
  const rendered = render(<TimerPairingSheet onSelect={onSelect} onDismiss={onDismiss} />);
  await act(async () => {});
  return rendered;
}

describe('TimerPairingSheet', () => {
  beforeEach(resetScan);
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a scan on mount and shows the scanning state', async () => {
    const { container } = render(<TimerPairingSheet onSelect={vi.fn()} onDismiss={vi.fn()} />);
    // Looking, while the permission and radio checks answer.
    expect(container.textContent).toContain('mobile.timerPair.scanning');
    await act(async () => {});
    expect(scan.scanForTimers).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('mobile.timerPair.scanning');
  });

  it('stops the scan on unmount', async () => {
    const { unmount } = await renderSheet();
    expect(scan.state.stop).not.toHaveBeenCalled();
    unmount();
    expect(scan.state.stop).toHaveBeenCalledTimes(1);
  });

  it('never scans when closed before the checks answer', async () => {
    const { unmount } = render(<TimerPairingSheet onSelect={vi.fn()} onDismiss={vi.fn()} />);
    unmount();
    await act(async () => {});
    expect(scan.scanForTimers).not.toHaveBeenCalled();
  });

  it('asks for Bluetooth instead of spinning when the radio is off', async () => {
    radio.poweredOn = false;
    radio.unavailableReason = 'powered_off';
    const { container } = await renderSheet();
    expect(scan.scanForTimers).not.toHaveBeenCalled();
    expect(container.textContent).toContain('mobile.bluetooth.unavailable');
    expect(container.textContent).not.toContain('mobile.timerPair.scanning');
    expect(container.textContent).not.toContain('mobile.timerPair.empty');
  });

  it('asks for Bluetooth on a phone with none, like the simulator', async () => {
    radio.poweredOn = false;
    radio.unavailableReason = 'unsupported';
    const { container } = await renderSheet();
    expect(container.textContent).toContain('mobile.bluetooth.unavailable');
  });

  it('asks for the permission when the Android dialog was answered no', async () => {
    radio.permission = 'denied';
    const { container } = await renderSheet();
    expect(scan.scanForTimers).not.toHaveBeenCalled();
    expect(container.textContent).toContain('mobile.timerPair.permissionDenied');
  });

  it('points to Settings when Bluetooth is blocked for the app', async () => {
    radio.poweredOn = false;
    radio.unavailableReason = 'unauthorized';
    const { container } = await renderSheet();
    expect(container.textContent).toContain('ble.blockedTitle');
    expect(container.textContent).toContain('ble.blockedBody');
    act(() => (container.querySelector('[data-button="ble.openSettings"]') as HTMLButtonElement).click());
    expect(radio.openAppSettings).toHaveBeenCalledTimes(1);
  });

  it('points to Settings when Android stopped asking', async () => {
    radio.permission = 'blocked';
    const { container } = await renderSheet();
    expect(container.textContent).toContain('ble.blockedTitle');
  });

  it('stops looking a little after the scan window when the scan ended without saying so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container } = await renderSheet();
    expect(scan.scanForTimers).toHaveBeenCalledTimes(1);
    // The scan errored: the radio went off, and no stop callback came.
    radio.unavailableReason = 'powered_off';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(32_999);
    });
    expect(container.textContent).toContain('mobile.timerPair.scanning');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.textContent).toContain('mobile.bluetooth.unavailable');
  });

  it('shows the empty state after a quiet stop with the radio fine', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container } = await renderSheet();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(33_000);
    });
    expect(container.textContent).toContain('mobile.timerPair.empty');
  });

  it('keeps the timers it found when the radio goes off mid-scan', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container } = await renderSheet();
    act(() => scan.state.onUpdate?.([device('a', 'Rogue Home Timer')]));
    radio.unavailableReason = 'powered_off';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(33_000);
    });
    expect(container.querySelector('[data-list="true"]')?.getAttribute('data-count')).toBe('1');
    expect(container.textContent).not.toContain('mobile.bluetooth.unavailable');
  });

  it('lists discovered timers and reports the picked timer name on tap', async () => {
    const onSelect = vi.fn();
    const { container } = await renderSheet(onSelect);

    act(() => scan.state.onUpdate?.([device('a', 'Rogue Home Timer', -40), device('b', 'Rogue Echo Gym Timer', -70)]));

    const list = container.querySelector('[data-list="true"]');
    expect(list?.getAttribute('data-count')).toBe('2');
    // Strongest RSSI first.
    const rows = container.querySelectorAll('[data-row]');
    expect(rows[0]?.getAttribute('data-row')).toBe('Rogue Home Timer');

    act(() => (rows[0] as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith('Rogue Home Timer');
  });

  it('shows the empty state when the scan stops with no timers', async () => {
    const { container } = await renderSheet();
    act(() => scan.state.onScanStopped?.());
    expect(container.textContent).toContain('mobile.timerPair.empty');
  });

  it('dismisses via the top bar Cancel', async () => {
    const onDismiss = vi.fn();
    const { container } = await renderSheet(vi.fn(), onDismiss);
    expect(container.querySelector('[data-top-bar="mobile.timerPair.title"]')).not.toBeNull();
    const cancel = container.querySelector('[data-leading="cancel"]') as HTMLButtonElement;
    act(() => cancel.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('draws a weak timer signal in the theme error role', async () => {
    const { container } = await renderSheet();
    act(() => scan.state.onUpdate?.([device('weak', 'Rogue Far Timer', -90)]));

    expect(container.querySelectorAll('[data-bg="theme-error"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-bg="theme-fill"]').length).toBeGreaterThanOrEqual(2);
  });
});

describe('TimerPairingSheet inside the Rogue provider', () => {
  beforeEach(resetScan);

  /** A provider whose scan slot the test opens by hand. */
  function renderInProvider() {
    const slot = {
      starter: undefined as RogueTimerPairingScanStarter | undefined,
      stopScheduled: vi.fn(),
      releaseSlot: vi.fn(),
    };
    const schedulePairingScan = vi.fn((startScan: RogueTimerPairingScanStarter) => {
      slot.starter = startScan;
      return slot.stopScheduled;
    });
    const value = { status: 'connected' as const, isConnected: true, deviceName: undefined, schedulePairingScan };
    const rendered = render(
      <RogueTimerContext.Provider value={value}>
        <TimerPairingSheet onSelect={vi.fn()} onDismiss={vi.fn()} />
      </RogueTimerContext.Provider>,
    );
    return { ...rendered, slot, schedulePairingScan };
  }

  it('asks the provider for the scan slot instead of scanning straight away', () => {
    const { container, schedulePairingScan } = renderInProvider();
    expect(schedulePairingScan).toHaveBeenCalledTimes(1);
    expect(scan.scanForTimers).not.toHaveBeenCalled();
    // Waiting for the slot reads as looking, not as nothing found.
    expect(container.textContent).toContain('mobile.timerPair.scanning');
  });

  it('scans once the slot is free, and hands it back when the scan stops by itself', async () => {
    const { container, slot } = renderInProvider();
    await act(async () => {
      slot.starter?.(slot.releaseSlot);
    });
    expect(scan.scanForTimers).toHaveBeenCalledTimes(1);

    act(() => scan.state.onScanStopped?.());
    expect(slot.releaseSlot).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('mobile.timerPair.empty');
  });

  it('stops through the provider when the sheet closes', () => {
    const { unmount, slot } = renderInProvider();
    unmount();
    expect(slot.stopScheduled).toHaveBeenCalledTimes(1);
  });

  it('hands the slot back when Bluetooth is off, so a held reconnect can run', async () => {
    radio.poweredOn = false;
    radio.unavailableReason = 'powered_off';
    const { container, slot } = renderInProvider();
    await act(async () => {
      slot.starter?.(slot.releaseSlot);
    });
    expect(scan.scanForTimers).not.toHaveBeenCalled();
    expect(slot.releaseSlot).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('mobile.bluetooth.unavailable');
  });

  it('hands the slot back after a scan that ended without saying so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { slot } = renderInProvider();
    await act(async () => {
      slot.starter?.(slot.releaseSlot);
    });
    expect(scan.scanForTimers).toHaveBeenCalledTimes(1);
    expect(slot.releaseSlot).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(33_000);
    });
    expect(slot.releaseSlot).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
