// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';
import type { DiscoveredDevice } from '../../../lib/ble/types';

// Controllable return for the shared "no listed board matches the selected
// type" rule so each test drives the hint / troubleshoot conditions directly,
// without hand-building device names that resolve through the real parser.
const stats = vi.hoisted(() => ({ noneMatchedSelectedType: false }));

// The Android 12+ location-suppression hint. Mocked at the hook boundary so the
// sheet tests stay free of PermissionsAndroid plumbing; the
// hook's own rules are covered by android-scan-location-gate.test.ts.
const locationHint = vi.hoisted(() => ({
  shouldOfferLocationGrant: false,
  wasGranted: false,
  isRequesting: false,
  requestLocationPermission: vi.fn(async () => true),
  shouldOfferLocationServicesEnable: false,
  servicesWereEnabled: false,
  isPromptingServices: false,
  promptEnableLocationServices: vi.fn(async () => true),
  lastActive: null as boolean | null,
}));

// The take-the-wall action, supplied by the host as a prop. It is the ONLY thing
// the no-lights offer is allowed to call — see the source guard at the bottom of
// this file.
const bluetooth = vi.hoisted(() => ({
  onNoLeds: undefined as (() => void) | undefined,
  takeVirtualWall: vi.fn(),
}));

const haptics = vi.hoisted(() => ({ hapticSelection: vi.fn() }));

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
  // The real value is Platform-derived; the sheet only needs a number to defer by.
  SHEET_SETTLE_MS: 550,
}));

vi.mock('../../sheet-snap-points', () => ({
  androidSafeSnapPoints: (points: string[]) => points,
}));

vi.mock('../../../lib/ble/picker-resolution-stats', () => ({
  noListedBoardMatchesSelectedType: () => stats.noneMatchedSelectedType,
}));

vi.mock('../../../lib/haptics', () => ({
  hapticSelection: haptics.hapticSelection,
}));

vi.mock('../../../lib/ble/use-android-scan-location-hint', () => ({
  useAndroidScanLocationHint: (active: boolean) => {
    locationHint.lastActive = active;
    return locationHint;
  },
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
    onNoLeds: bluetooth.onNoLeds,
    ...over,
  };
}

const device = (id: string): DiscoveredDevice => ({ deviceId: id, name: `Kilter Board#${id}@3`, rssi: -50 });

const hasText = (root: HTMLElement, text: string) => root.textContent?.includes(text) ?? false;

describe('DevicePickerSheet', () => {
  beforeEach(() => {
    stats.noneMatchedSelectedType = false;
    locationHint.shouldOfferLocationGrant = false;
    locationHint.wasGranted = false;
    locationHint.isRequesting = false;
    locationHint.shouldOfferLocationServicesEnable = false;
    locationHint.servicesWereEnabled = false;
    locationHint.isPromptingServices = false;
    locationHint.lastActive = null;
    locationHint.requestLocationPermission.mockClear();
    locationHint.promptEnableLocationServices.mockClear();
    bluetooth.takeVirtualWall.mockClear();
    bluetooth.onNoLeds = bluetooth.takeVirtualWall;
    haptics.hapticSelection.mockClear();
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

  it('replaces the hardware tips with the location hint when Android is suppressing results', () => {
    // The reported bug: a user who declined the "boards near you" prompt gets an
    // empty picker and is told to check their board's power. Blaming hardware for
    // an OS permission gate is the thing this PR fixes.
    locationHint.shouldOfferLocationGrant = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);

    expect(hasText(container, 'ble.locationHintTitle')).toBe(true);
    expect(hasText(container, 'ble.locationHintBody')).toBe(true);
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(false);
    expect(hasText(container, 'ble.troubleshootTips')).toBe(false);
  });

  it('offers a grant button that fires the permission request', () => {
    locationHint.shouldOfferLocationGrant = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);

    const grantButton = container.querySelector('[data-button="ble.locationHintGrant"]');
    expect(grantButton).not.toBeNull();
    (grantButton as HTMLButtonElement).click();
    expect(locationHint.requestLocationPermission).toHaveBeenCalledOnce();
  });

  it('swaps to the rescan prompt once location is granted, with no grant button left', () => {
    locationHint.shouldOfferLocationGrant = false;
    locationHint.wasGranted = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);

    expect(hasText(container, 'ble.locationHintGranted')).toBe(true);
    expect(hasText(container, 'ble.locationHintBody')).toBe(false);
    expect(container.querySelector('[data-button="ble.locationHintGrant"]')).toBeNull();
  });

  it('asks the hint hook only about a scan that finished empty', () => {
    // Guards the hint against firing a PermissionsAndroid.check on every scan
    // tick, and against showing location copy while boards are listed.
    render(<DevicePickerSheet {...makeProps({ isScanning: true, devices: [] })} />);
    expect(locationHint.lastActive).toBe(false);

    render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [device('a')] })} />);
    expect(locationHint.lastActive).toBe(false);

    render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);
    expect(locationHint.lastActive).toBe(true);
  });

  it('replaces the hardware tips with the services hint on Android 11 and below', () => {
    // The API<31 half of this bug: permission is granted, the system Location
    // toggle is off. Distinct hint, distinct copy, same "don't blame the board".
    locationHint.shouldOfferLocationServicesEnable = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);

    expect(hasText(container, 'ble.locationServicesHintTitle')).toBe(true);
    expect(hasText(container, 'ble.locationServicesHintBody')).toBe(true);
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(false);
    expect(hasText(container, 'ble.troubleshootTips')).toBe(false);
  });

  it('offers an enable button that fires the services prompt', () => {
    locationHint.shouldOfferLocationServicesEnable = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);

    const enableButton = container.querySelector('[data-button="ble.locationServicesHintEnable"]');
    expect(enableButton).not.toBeNull();
    (enableButton as HTMLButtonElement).click();
    expect(locationHint.promptEnableLocationServices).toHaveBeenCalledOnce();
  });

  it('swaps to the services-enabled rescan prompt, with no enable button left', () => {
    locationHint.shouldOfferLocationServicesEnable = false;
    locationHint.servicesWereEnabled = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);

    expect(hasText(container, 'ble.locationServicesHintEnabled')).toBe(true);
    expect(hasText(container, 'ble.locationServicesHintBody')).toBe(false);
    expect(container.querySelector('[data-button="ble.locationServicesHintEnable"]')).toBeNull();
  });

  it('prefers the permission hint over the services hint if both were ever true', () => {
    // Belt-and-braces: the hook keeps these mutually exclusive by API level, but
    // the sheet's own render order should still resolve deterministically.
    locationHint.shouldOfferLocationGrant = true;
    locationHint.shouldOfferLocationServicesEnable = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);

    expect(hasText(container, 'ble.locationHintTitle')).toBe(true);
    expect(hasText(container, 'ble.locationServicesHintTitle')).toBe(false);
  });

  describe('the "this wall has no lights" offer', () => {
    it('appears once the scan has genuinely finished with zero devices', () => {
      const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);
      expect(hasText(container, 'ble.noLedsBody')).toBe(true);
      expect(container.querySelector('[data-button="ble.noLedsCta"]')).not.toBeNull();
    });

    it('stays hidden while the initial scan is still running', () => {
      const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: true, devices: [] })} />);
      expect(container.querySelector('[data-button="ble.noLedsCta"]')).toBeNull();
    });

    it('stays hidden when boards were found but none match the selected type', () => {
      // Boards ARE in the room, so there is LED hardware nearby — offering "this
      // wall has no lights" here would be flatly wrong.
      stats.noneMatchedSelectedType = true;
      const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [device('a')] })} />);
      expect(hasText(container, 'ble.troubleshootTitle')).toBe(true);
      expect(container.querySelector('[data-button="ble.noLedsCta"]')).toBeNull();
    });

    it('stays hidden behind the Android location-permission hint', () => {
      // The OS is withholding scan results — the board's light kit is not the
      // question yet.
      locationHint.shouldOfferLocationGrant = true;
      const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);
      expect(container.querySelector('[data-button="ble.noLedsCta"]')).toBeNull();
    });

    it('stays hidden behind the Android location-services hint', () => {
      locationHint.shouldOfferLocationServicesEnable = true;
      const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);
      expect(container.querySelector('[data-button="ble.noLedsCta"]')).toBeNull();
    });

    it('stays hidden when the host supplies no take-the-wall action', () => {
      bluetooth.onNoLeds = undefined;
      const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);
      expect(container.querySelector('[data-button="ble.noLedsCta"]')).toBeNull();
    });

    it('dismisses the sheet FIRST, then takes the wall once the dismissal has settled', () => {
      // The picker is a native modal sheet and the "You've got the wall" toast is
      // a root-level JS view, so it renders behind it. Taking the wall before the
      // sheet is gone means the user never sees the confirmation.
      vi.useFakeTimers();
      try {
        const props = makeProps({ isScanning: false, devices: [] });
        const { container } = render(<DevicePickerSheet {...props} />);
        const cta = container.querySelector('[data-button="ble.noLedsCta"]') as HTMLButtonElement;

        act(() => cta.click());
        expect(haptics.hapticSelection).toHaveBeenCalledTimes(1);
        expect(props.onDismiss).toHaveBeenCalledTimes(1);
        expect(bluetooth.takeVirtualWall).not.toHaveBeenCalled();

        act(() => void vi.runAllTimers());
        expect(bluetooth.takeVirtualWall).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('takes the wall SESSION-LOCALLY and never writes the board record', () => {
      // Blocking safety constraint from the Bluetooth review: an empty scan is
      // weak evidence (box powered off, out of range, the Android RN 0.86 scan
      // regression). Persisting `hasLeds: false` here would strip the Bluetooth
      // connect affordance from every climber at that gym. The server flag is set
      // only through the board edit form.
      const source = readFileSync(join(__dirname, '../DevicePickerSheet.tsx'), 'utf8');

      // No GraphQL / board-record module reaches this sheet at all.
      const importLines = source.match(/^import[\s\S]*?;$/gm)?.join('\n') ?? '';
      expect(importLines).not.toMatch(/graphql|mutation|use-active-board/i);

      // And the sheet must not reach back up into BluetoothProvider, which
      // renders it — that would be a static import cycle.
      expect(importLines).not.toMatch(/bluetooth-provider/);

      // And nothing in the code itself (comments stripped, since they discuss
      // the flag by name) touches the server flag or a board write.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/hasLeds|updateBoard|setActiveBoard/i);
    });
  });
});
