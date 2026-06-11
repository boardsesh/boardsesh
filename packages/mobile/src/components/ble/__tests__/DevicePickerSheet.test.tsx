// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';
import type { DiscoveredDevice } from '../../../lib/ble/types';

// Controllable return for the shared "no listed board matches the selected
// type" rule so each test drives the hint / troubleshoot conditions directly,
// without hand-building device names that resolve through the real parser.
const stats = vi.hoisted(() => ({ noneMatchedSelectedType: false }));

type ViewMockProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '26.1' },
  View: ({ children }: ViewMockProps) => createElement('div', {}, children),
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

type SheetMockProps = { children?: ReactNode };
type SheetViewMockProps = { children?: ReactNode };
type FlatListMockProps = { data?: unknown[] };
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef(({ children }: SheetMockProps, _ref: Ref<unknown>) =>
    createElement('div', { 'data-sheet': 'true' }, children),
  ),
  BottomSheetView: ({ children }: SheetViewMockProps) => createElement('div', {}, children),
  BottomSheetFlatList: ({ data }: FlatListMockProps) =>
    createElement('div', { 'data-list': 'true', 'data-count': String(data?.length ?? 0) }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number; board?: string }) => {
      if (opts?.count != null) return `${key}:${opts.count}`;
      if (opts?.board != null) return `${key}:${opts.board}`;
      return key;
    },
  }),
}));

vi.mock('@boardsesh/ble-protocol', () => ({
  parseSerialNumber: (name: string) => name,
}));

vi.mock('@boardsesh/board-config', () => ({
  formatBoardDisplayName: (boardName: string) => boardName,
}));

vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({ onChange: () => {}, onFullyDismissed: () => {} }),
}));

vi.mock('../../sheet-snap-points', () => ({
  androidSafeSnapPoints: (points: string[]) => points,
}));

vi.mock('../../../lib/ble/picker-resolution-stats', () => ({
  noListedBoardMatchesSelectedType: () => stats.noneMatchedSelectedType,
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', {}, children),
}));

type ButtonMockProps = { title: string; onPress?: () => void };
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: ButtonMockProps) => createElement('button', { 'data-button': title, onClick: onPress }),
}));

vi.mock('../DeviceCard', () => ({
  DeviceCard: () => createElement('div', { 'data-device-card': 'true' }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111', secondaryLabel: '#666', tertiaryLabel: '#999' },
    brandColors: { primary: '#f00' },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 10: 40 },
}));

vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { separator: '#ccc' },
}));

import { DevicePickerSheet } from '../DevicePickerSheet';

const KILTER_CONFIG = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,20' };

function makeProps(over: Partial<Parameters<typeof DevicePickerSheet>[0]> = {}) {
  return {
    devices: [] as DiscoveredDevice[],
    onSelect: vi.fn(),
    onDismiss: vi.fn(),
    isScanning: false,
    resolvedBoards: new Map(),
    currentBoardConfig: KILTER_CONFIG,
    ...over,
  };
}

const device = (id: string): DiscoveredDevice => ({ deviceId: id, name: `Kilter Board#${id}@3`, rssi: -50 });

const hasText = (root: HTMLElement, text: string) => root.textContent?.includes(text) ?? false;

describe('DevicePickerSheet', () => {
  beforeEach(() => {
    stats.noneMatchedSelectedType = false;
  });

  it('shows the spinner and hides troubleshoot tips while the initial scan runs', () => {
    // Regression guard: the zero-device footer path must wait for the scan to
    // finish — tips flashing during the spinner is the reported bug.
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: true, devices: [] })} />);
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(hasText(container, 'ble.scanning')).toBe(true);
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(false);
  });

  it('shows the empty state and troubleshoot tips once the scan finishes with no devices', () => {
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);
    expect(container.querySelector('[data-spinner]')).toBeNull();
    expect(hasText(container, 'ble.noDevicesFound')).toBe(true);
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(true);
  });

  it('shows the type hint and troubleshoot tips when devices are found but none match', () => {
    stats.noneMatchedSelectedType = true;
    const { container } = render(
      <DevicePickerSheet {...makeProps({ devices: [device('a')], currentBoardConfig: KILTER_CONFIG })} />,
    );
    expect(hasText(container, 'ble.differentBoardType')).toBe(true);
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(true);
    expect(container.querySelector('[data-list]')).not.toBeNull();
  });

  it('still shows tips mid-scan once devices are present but none match', () => {
    // The type-mismatch path is intentionally independent of isScanning: once
    // devices are showing, a "none of these are your board" hint is useful even
    // while more may still arrive. Distinct from the zero-device path, which
    // waits for the scan to finish (the bug fixed here).
    stats.noneMatchedSelectedType = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: true, devices: [device('a')] })} />);
    expect(hasText(container, 'ble.differentBoardType')).toBe(true);
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(true);
  });

  it('hides the type hint and troubleshoot tips when a matching device is listed', () => {
    stats.noneMatchedSelectedType = false;
    const { container } = render(<DevicePickerSheet {...makeProps({ devices: [device('a'), device('b')] })} />);
    expect(hasText(container, 'ble.differentBoardType')).toBe(false);
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(false);
    expect(container.querySelector('[data-list]')?.getAttribute('data-count')).toBe('2');
  });
});
