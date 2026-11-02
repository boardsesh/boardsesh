// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, useState, type ReactNode, type Ref } from 'react';
import type { DiscoveredDevice } from '../../../lib/ble/types';
import type { ResolvedBoardEntry } from '../../../lib/ble/resolve-serials';

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
// The connect-step test's (#5654) ear on the no-lights tap. Its own rules are
// covered by device-picker-no-lights.test.ts.
const recordNoLightsMock = vi.hoisted(() => vi.fn());

type ViewMockProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '26.1' },
  View: ({ children }: ViewMockProps) => createElement('div', {}, children),
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

// The last `data` array the list was handed, so a test can tell a list that kept
// its identity from one rebuilt with the same rows. The list renders its footer
// and the scroll view its children, so a test can tell which scroller holds
// the hints.
const flatList = vi.hoisted(() => ({ lastData: undefined as DiscoveredDevice[] | undefined }));
type FlatListMockProps = { data?: DiscoveredDevice[]; ListFooterComponent?: ReactNode };
type ScrollViewMockProps = { children?: ReactNode };
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({ data, ListFooterComponent }: FlatListMockProps) => {
    flatList.lastData = data;
    return createElement(
      'div',
      {
        'data-list': 'true',
        'data-count': String(data?.length ?? 0),
        'data-device-ids': JSON.stringify(data?.map((device) => device.deviceId) ?? []),
      },
      ListFooterComponent ?? null,
    );
  },
  BottomSheetScrollView: ({ children }: ScrollViewMockProps) =>
    createElement('div', { 'data-scroll': 'true' }, children),
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

vi.mock('@boardsesh/board-config', () => ({
  formatBoardDisplayName: (boardName: string) => boardName,
  toBoardName: (boardName: string) => boardName,
}));

// The ModalSheet wrapper, recording what the sheet asks of the coordinator
// through it. `dismissAndWait` hands back a promise the test settles, standing in
// for the native dismissal.
type ManagedSheetOptionsSeen = { open?: boolean; onClose?: () => void; onDisplaced?: () => void };
const managedSheet = vi.hoisted(() => ({
  lastOptions: null as ManagedSheetOptionsSeen | null,
  settleDismiss: () => {},
  dismissAndWait: vi.fn(),
}));
type ModalSheetMockProps = {
  children?: ReactNode;
  header?: ReactNode;
  visible?: boolean;
  onClose?: () => void;
  onDisplaced?: () => void;
};
vi.mock('../../ModalSheet', () => ({
  ModalSheet: forwardRef(function ModalSheetMock(
    { children, header, visible, onClose, onDisplaced }: ModalSheetMockProps,
    ref: Ref<unknown>,
  ) {
    managedSheet.lastOptions = { open: visible, onClose, onDisplaced };
    useImperativeHandle(ref, () => ({ dismissAndWait: managedSheet.dismissAndWait }), []);
    return createElement('div', { 'data-sheet': 'true' }, header, children);
  }),
}));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  dismissManagedSheetAndWait: (handle: { dismissAndWait: () => Promise<unknown> } | null) =>
    handle ? handle.dismissAndWait() : Promise.resolve({ status: 'dismissed' }),
}));
type TopBarMockProps = { title: string; subtitle?: string; leading?: { kind: string; onPress: () => void } };
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ title, subtitle, leading }: TopBarMockProps) =>
    createElement(
      'div',
      { 'data-top-bar': title },
      subtitle,
      leading ? createElement('button', { 'data-leading': leading.kind, onClick: leading.onPress }) : null,
    ),
}));

vi.mock('../../../lib/ble/picker-resolution-stats', () => ({
  noListedBoardMatchesSelectedType: () => stats.noneMatchedSelectedType,
}));

vi.mock('../../../lib/haptics', () => ({
  hapticSelection: haptics.hapticSelection,
}));

vi.mock('../../../lib/onboarding/device-picker-no-lights', () => ({
  recordDevicePickerNoLights: recordNoLightsMock,
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

function recordedBoard(boardUuid: string, boardName = 'kilter'): ResolvedBoardEntry {
  return {
    kind: 'recorded',
    config: {
      serialNumber: 'SN-1',
      boardName,
      boardUuid,
      boardSlug: null,
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      apiLevel: 3,
      updatedAt: '2026-10-30T00:00:00Z',
    },
  };
}

function listedIds(container: HTMLElement): string[] {
  return JSON.parse(container.querySelector('[data-list]')?.getAttribute('data-device-ids') ?? '[]');
}

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
    expect(hasText(container, 'ble.scanTipPower')).toBe(false);
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

  it('asks the hint hook only about a scan that has heard nothing, from 5 s in or once it ends', () => {
    // Guards the hint against firing a PermissionsAndroid.check on every scan
    // tick, and against showing location copy while boards are listed.
    vi.useFakeTimers();
    try {
      render(<DevicePickerSheet {...makeProps({ isScanning: true, devices: [] })} />);
      expect(locationHint.lastActive).toBe(false);
      // 5 s in, nothing heard: Android may be hiding the results, so ask now
      // rather than blame the board until the scan ends.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(locationHint.lastActive).toBe(true);
    } finally {
      vi.useRealTimers();
    }

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
    expect(hasText(container, 'ble.scanTipPower')).toBe(false);
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

  it('cancels from the top bar and counts the boards found in its subtitle', () => {
    const onDismiss = vi.fn();
    const { container } = render(<DevicePickerSheet {...makeProps({ devices: [device('a')], onDismiss })} />);
    expect(container.querySelector('[data-top-bar="ble.selectBoard"]')?.textContent).toContain('ble.devicesFound:1');
    act(() => (container.querySelector('[data-leading="cancel"]') as HTMLButtonElement).click());
    expect(onDismiss).toHaveBeenCalledOnce();
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

    it('hands the action to its surviving host after dismissal even when the picker unmounts', () => {
      vi.useFakeTimers();
      try {
        const calls: string[] = [];
        function PickerHost() {
          const [visible, setVisible] = useState(true);
          return visible ? (
            <DevicePickerSheet
              {...makeProps()}
              onDismiss={() => {
                calls.push('dismiss');
                setVisible(false);
              }}
              onNoLeds={() => {
                calls.push('schedule');
                setTimeout(bluetooth.takeVirtualWall, 550);
              }}
            />
          ) : null;
        }
        const { container } = render(<PickerHost />);
        const cta = container.querySelector('[data-button="ble.noLedsCta"]') as HTMLButtonElement;

        recordNoLightsMock.mockClear();
        act(() => cta.click());
        expect(haptics.hapticSelection).toHaveBeenCalledTimes(1);
        expect(calls).toEqual(['dismiss', 'schedule']);
        // Heard from the tap itself, once, for the connect-step test.
        expect(recordNoLightsMock).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[data-sheet]')).toBeNull();
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

// #5654: an empty scan used to end in an OK-only alert, with no way to try again
// short of finding the bulb again. The adapters now leave the picker up in this
// state (see use-board-bluetooth.test.ts, "when the picker scan finds nothing").
describe('DevicePickerSheet Scan again', () => {
  beforeEach(() => {
    stats.noneMatchedSelectedType = false;
    locationHint.shouldOfferLocationGrant = false;
    locationHint.wasGranted = false;
    locationHint.shouldOfferLocationServicesEnable = false;
    locationHint.servicesWereEnabled = false;
  });

  const scanAgainButton = (root: HTMLElement) =>
    root.querySelector('[data-button="ble.scanAgain"]') as HTMLButtonElement | null;

  it('offers Scan again next to "No boards found nearby" and the tips', () => {
    const onScanAgain = vi.fn();
    const { container } = render(<DevicePickerSheet {...makeProps({ onScanAgain })} />);

    expect(hasText(container, 'ble.noDevicesFound')).toBe(true);
    expect(hasText(container, 'ble.scanTipPower')).toBe(true);
    act(() => scanAgainButton(container)?.click());
    expect(onScanAgain).toHaveBeenCalledTimes(1);
  });

  it('keeps it alongside the location hint, whose "granted" copy asks for a fresh scan', () => {
    locationHint.wasGranted = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ onScanAgain: vi.fn() })} />);

    expect(hasText(container, 'ble.locationHintGranted')).toBe(true);
    expect(scanAgainButton(container)).not.toBeNull();
  });

  it('hides it while the first scan is still running', () => {
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: true, onScanAgain: vi.fn() })} />);
    expect(scanAgainButton(container)).toBeNull();
  });

  // The location hints come in 5 s into the scan now, so their "connect again"
  // copy can show while the scan still runs, up to 25 s before it would end.
  it('offers it mid-scan once location is granted, as the hint asks', () => {
    locationHint.wasGranted = true;
    const onScanAgain = vi.fn();
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: true, onScanAgain })} />);

    expect(hasText(container, 'ble.locationHintGranted')).toBe(true);
    act(() => scanAgainButton(container)?.click());
    expect(onScanAgain).toHaveBeenCalledTimes(1);
  });

  it('offers it mid-scan once Location services are on, as the hint asks', () => {
    locationHint.servicesWereEnabled = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: true, onScanAgain: vi.fn() })} />);

    expect(hasText(container, 'ble.locationServicesHintEnabled')).toBe(true);
    expect(scanAgainButton(container)).not.toBeNull();
  });

  it('holds it back mid-scan while the hint still asks for location', () => {
    locationHint.shouldOfferLocationGrant = true;
    // Services were turned on earlier, but the permission hint is the one on
    // screen, and it asks for the grant, not a fresh connect.
    locationHint.servicesWereEnabled = true;
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: true, onScanAgain: vi.fn() })} />);

    expect(hasText(container, 'ble.locationHintBody')).toBe(true);
    expect(scanAgainButton(container)).toBeNull();
  });

  it('hides it once boards are listed', () => {
    const { container } = render(
      <DevicePickerSheet {...makeProps({ devices: [device('a')], onScanAgain: vi.fn() })} />,
    );
    expect(scanAgainButton(container)).toBeNull();
  });

  it('renders nothing where no host wires a rescan', () => {
    const { container } = render(<DevicePickerSheet {...makeProps({ onScanAgain: undefined })} />);
    expect(scanAgainButton(container)).toBeNull();
  });
});

describe('DevicePickerSheet while searching for the saved board (#5658)', () => {
  beforeEach(() => {
    stats.noneMatchedSelectedType = false;
    locationHint.shouldOfferLocationGrant = false;
    locationHint.wasGranted = false;
    locationHint.shouldOfferLocationServicesEnable = false;
    locationHint.servicesWereEnabled = false;
    managedSheet.lastOptions = null;
    managedSheet.dismissAndWait.mockReset();
    managedSheet.dismissAndWait.mockImplementation(
      () =>
        new Promise((resolve) => {
          managedSheet.settleDismiss = () => resolve({ status: 'dismissed' });
        }),
    );
  });

  it('shows a spinner, the board it is looking for and "Search for any board", with no list or tips', () => {
    const onSearchAnyBoard = vi.fn();
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({ mode: 'searching', isScanning: true, onSearchAnyBoard, onScanAgain: vi.fn() })}
      />,
    );

    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    // The product name, never a serial.
    expect(hasText(container, 'ble.searchingForBoard:kilter aurora.card.boardSuffix')).toBe(true);
    expect(hasText(container, 'ble.scanning')).toBe(false);
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(false);
    expect(container.querySelector('[data-button="ble.scanAgain"]')).toBeNull();

    act(() => (container.querySelector('[data-button="ble.searchAnyBoard"]') as HTMLButtonElement).click());
    expect(onSearchAnyBoard).toHaveBeenCalledOnce();
  });

  it('keeps its searching state even when the scan has stopped', () => {
    const { container } = render(<DevicePickerSheet {...makeProps({ mode: 'searching', isScanning: false })} />);
    expect(hasText(container, 'ble.searchingForBoard:kilter aurora.card.boardSuffix')).toBe(true);
    expect(hasText(container, 'ble.noDevicesFound')).toBe(false);
  });

  it('asks the coordinator for the open state the session wants, and passes displacement through', () => {
    const onDisplaced = vi.fn();
    const { rerender } = render(<DevicePickerSheet {...makeProps({ mode: 'searching', open: false, onDisplaced })} />);
    expect(managedSheet.lastOptions?.open).toBe(false);
    expect(managedSheet.lastOptions?.onDisplaced).toBe(onDisplaced);

    rerender(<DevicePickerSheet {...makeProps({ mode: 'list', open: true, onDisplaced })} />);
    expect(managedSheet.lastOptions?.open).toBe(true);
  });

  it('closes by dismissal and reports closed only after the dismissal settles', async () => {
    const onClosed = vi.fn();
    const onDismiss = vi.fn();
    render(<DevicePickerSheet {...makeProps({ mode: 'searching', closing: true, onClosed, onDismiss })} />);

    expect(managedSheet.lastOptions?.open).toBe(false);
    expect(managedSheet.dismissAndWait).toHaveBeenCalledOnce();
    await act(async () => {
      await Promise.resolve();
    });
    // Still presenting or dismissing: the host must not unmount it yet.
    expect(onClosed).not.toHaveBeenCalled();

    await act(async () => {
      managedSheet.settleDismiss();
      await Promise.resolve();
    });
    expect(onClosed).toHaveBeenCalledOnce();
    // A close without a choice is not the climber cancelling.
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('DevicePickerSheet for a known gym board (#7125)', () => {
  const targetBoard = { boardUuid: 'qa-kilter', boardName: 'kilter' };
  const kilter = { deviceId: 'kilter', name: 'Kilter Board#K-1@3', rssi: -70 };
  const tension = { deviceId: 'tension', name: 'Tension Board#T-1@3', rssi: -35 };
  const otherKilter = { deviceId: 'other-kilter', name: 'Kilter Board#K-2@3', rssi: -25 };
  const unknown = { deviceId: 'unknown', name: 'Kilter Board', rssi: -40 };
  const resolutions = new Map([
    ['K-1', recordedBoard('qa-kilter')],
    ['K-2', recordedBoard('other-kilter')],
    ['T-1', recordedBoard('qa-tension', 'tension')],
  ]);

  beforeEach(() => {
    stats.noneMatchedSelectedType = false;
    locationHint.shouldOfferLocationGrant = false;
    locationHint.wasGranted = false;
    locationHint.shouldOfferLocationServicesEnable = false;
    locationHint.servicesWereEnabled = false;
  });

  it('lists the intended board first, then unidentified boxes, and hides boards that are elsewhere', () => {
    // The gym's Tension (-35) and a stranger's Kilter (-25) out-shout both rows
    // and stay hidden. The bare-name box (-40) is louder than the intended
    // Kilter (-70) but still sorts after it.
    const onSearchAnyBoard = vi.fn();
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({
          devices: [tension, otherKilter, unknown, kilter],
          resolvedBoards: resolutions,
          targetBoard,
          onSearchAnyBoard,
        })}
      />,
    );
    expect(listedIds(container)).toEqual(['kilter', 'unknown']);
    expect(hasText(container, 'ble.devicesFound:2')).toBe(true);
    expect(hasText(container, 'ble.selectedBoardNotFound')).toBe(false);
    act(() => (container.querySelector('[data-button="ble.searchAnyBoard"]') as HTMLButtonElement).click());
    expect(onSearchAnyBoard).toHaveBeenCalledOnce();
  });

  it('sorts unidentified boxes by signal among themselves', () => {
    const quietBare = { deviceId: 'quiet-bare', name: 'Kilter Board', rssi: -80 };
    const unrecorded = { deviceId: 'unrecorded', name: 'Kilter Board#K-9@3', rssi: -60 };
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({ devices: [quietBare, kilter, unknown, unrecorded], resolvedBoards: resolutions, targetBoard })}
      />,
    );
    expect(listedIds(container)).toEqual(['kilter', 'unknown', 'unrecorded', 'quiet-bare']);
  });

  it('sorts controllers that are both the intended board by signal among themselves', () => {
    // A gym wall can carry two boxes recorded against the one board.
    const twin = { deviceId: 'kilter-twin', name: 'Kilter Board#K-3@3', rssi: -30 };
    const twinResolutions = new Map([...resolutions, ['K-3', recordedBoard('qa-kilter')]]);
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({ devices: [kilter, unknown, twin], resolvedBoards: twinResolutions, targetBoard })}
      />,
    );
    expect(listedIds(container)).toEqual(['kilter-twin', 'kilter', 'unknown']);
  });

  it('lists a bare-name Kilter box with no "not found" copy when the intended board never resolves', () => {
    // Kilter-built boxes advertise no serial, so nothing can resolve them and
    // nothing remembers them: hiding them meant "not found" on every connect.
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({
          devices: [tension, unknown],
          resolvedBoards: resolutions,
          targetBoard,
          onSearchAnyBoard: vi.fn(),
        })}
      />,
    );
    expect(listedIds(container)).toEqual(['unknown']);
    expect(hasText(container, 'ble.selectedBoardNotFound')).toBe(false);
    expect(container.querySelector('[data-button="ble.searchAnyBoard"]')).not.toBeNull();
  });

  it('lists a stock MoonBoard, which advertises no serial, at a MoonBoard connect', () => {
    const moonTarget = { boardUuid: 'qa-moon', boardName: 'moonboard' };
    const moonboard = { deviceId: 'moon', name: 'MoonBoard', rssi: -60 };
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({
          devices: [kilter, moonboard],
          resolvedBoards: resolutions,
          targetBoard: moonTarget,
          currentBoardConfig: { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1' },
          onSearchAnyBoard: vi.fn(),
        })}
      />,
    );
    expect(listedIds(container)).toEqual(['moon']);
    expect(hasText(container, 'ble.selectedBoardNotFound')).toBe(false);
  });

  it('reveals every device on the explicit escape and keeps RSSI ordering', () => {
    const { container, rerender } = render(
      <DevicePickerSheet
        {...makeProps({ devices: [kilter, tension, unknown], resolvedBoards: resolutions, targetBoard })}
      />,
    );
    rerender(
      <DevicePickerSheet
        {...makeProps({
          devices: [kilter, tension, unknown],
          resolvedBoards: resolutions,
          targetBoard,
          showAllBoards: true,
        })}
      />,
    );
    expect(listedIds(container)).toEqual(['tension', 'unknown', 'kilter']);
    expect(container.querySelector('[data-button="ble.searchAnyBoard"]')).toBeNull();
  });

  it('regroups rows when resolution arrives without selecting a device', () => {
    // Before the lookup lands both Kilters are unidentified, louder first. Once
    // it lands the intended one is claimed and the stranger's is set apart.
    const props = makeProps({ devices: [tension, otherKilter, kilter], targetBoard, isScanning: true });
    const { container, rerender } = render(<DevicePickerSheet {...props} />);
    expect(listedIds(container)).toEqual(['other-kilter', 'kilter']);
    rerender(<DevicePickerSheet {...props} resolvedBoards={resolutions} />);
    expect(listedIds(container)).toEqual(['kilter']);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  // The scan cache refreshes RSSI in place between pushes, so a list re-sorted
  // when a lookup lands could swap two rows under the climber's thumb.
  it.each([
    { label: 'with no intended board', scope: {} },
    { label: 'after the escape', scope: { targetBoard, showAllBoards: true } },
  ])('keeps the full list in place when a lookup lands $label', ({ scope }) => {
    const quiet = { deviceId: 'quiet', name: 'Kilter Board#K-1@3', rssi: -70 };
    const loud = { deviceId: 'loud', name: 'Kilter Board#K-2@3', rssi: -30 };
    const props = makeProps({ devices: [quiet, loud], ...scope });
    const { container, rerender } = render(<DevicePickerSheet {...props} />);
    expect(listedIds(container)).toEqual(['loud', 'quiet']);
    const listedBeforeLookup = flatList.lastData;

    quiet.rssi = -20;
    rerender(<DevicePickerSheet {...props} resolvedBoards={resolutions} />);
    expect(listedIds(container)).toEqual(['loud', 'quiet']);
    expect(flatList.lastData).toBe(listedBeforeLookup);
  });

  it('moves a row on a lookup only when the lookup changes its group', () => {
    const bare = { deviceId: 'bare', name: 'Kilter Board', rssi: -40 };
    const unrecorded = { deviceId: 'unrecorded', name: 'Kilter Board#K-9@3', rssi: -60 };
    const props = makeProps({ devices: [unrecorded, bare], targetBoard });
    const { container, rerender } = render(<DevicePickerSheet {...props} />);
    expect(listedIds(container)).toEqual(['bare', 'unrecorded']);

    unrecorded.rssi = -10;
    rerender(<DevicePickerSheet {...props} resolvedBoards={resolutions} />);
    expect(listedIds(container)).toEqual(['bare', 'unrecorded']);
  });

  it('keeps searching while every controller heard so far is another board', () => {
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({ devices: [tension], targetBoard, isScanning: true, onSearchAnyBoard: vi.fn() })}
      />,
    );
    expect(listedIds(container)).toEqual([]);
    expect(hasText(container, 'ble.searchingForSavedBoard')).toBe(true);
    expect(hasText(container, 'ble.selectedBoardNotFound')).toBe(false);
  });

  it('keeps unresolved and serial-less devices available after escape despite later resolutions', () => {
    const props = makeProps({ devices: [tension, unknown], targetBoard, showAllBoards: true });
    const { container, rerender } = render(<DevicePickerSheet {...props} />);
    expect(listedIds(container)).toEqual(['tension', 'unknown']);
    rerender(<DevicePickerSheet {...props} resolvedBoards={resolutions} />);
    expect(listedIds(container)).toEqual(['tension', 'unknown']);
  });

  it('says "not found" and offers the escape, with the tips but no empty-scan advice, when every board heard is elsewhere', () => {
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({
          devices: [tension, otherKilter],
          resolvedBoards: resolutions,
          targetBoard,
          onSearchAnyBoard: vi.fn(),
        })}
      />,
    );
    expect(listedIds(container)).toEqual([]);
    expect(hasText(container, 'ble.selectedBoardNotFound')).toBe(true);
    expect(container.querySelector('[data-button="ble.searchAnyBoard"]')).not.toBeNull();
    expect(hasText(container, 'ble.noDevicesFound')).toBe(false);
    // The intended board was not heard, so the hardware tips stay once the scan
    // ends. Boards were heard, so nothing is hiding them (no location hint) and
    // there is LED hardware here (no "this wall has no lights").
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(true);
    expect(locationHint.lastActive).toBe(false);
    expect(container.querySelector('[data-button="ble.noLedsCta"]')).toBeNull();
  });

  it('retains genuine empty-scan troubleshooting for a known target', () => {
    const { container } = render(
      <DevicePickerSheet {...makeProps({ devices: [], targetBoard, onSearchAnyBoard: vi.fn(), onNoLeds: vi.fn() })} />,
    );
    expect(hasText(container, 'ble.noDevicesFound')).toBe(true);
    expect(hasText(container, 'ble.troubleshootTitle')).toBe(true);
    expect(locationHint.lastActive).toBe(true);
    expect(container.querySelector('[data-button="ble.noLedsCta"]')).not.toBeNull();
  });

  // 2.7 release watch: the sheet says what it showed, once each, while on
  // screen (BLE Picker Devices Resolved's targetNotListedSeen and tipsSeen).
  describe('what it reports seeing', () => {
    it('reports the target not listed once, and nothing for tips it never showed', () => {
      const onSeen = vi.fn();
      // Still in the scan's first 5 s, so the tips are not up yet.
      const props = makeProps({ devices: [tension], targetBoard, isScanning: true, onSearchAnyBoard: vi.fn(), onSeen });
      const { rerender } = render(<DevicePickerSheet {...props} />);
      expect(onSeen.mock.calls).toEqual([['target_not_listed']]);
      // Another scan push with the same state says nothing new.
      rerender(<DevicePickerSheet {...props} devices={[tension, unknown]} />);
      expect(onSeen).toHaveBeenCalledOnce();
    });

    it('reports the tips after an empty scan', () => {
      const onSeen = vi.fn();
      render(<DevicePickerSheet {...makeProps({ devices: [], targetBoard, onSeen })} />);
      expect(onSeen.mock.calls).toEqual([['tips']]);
    });

    it('reports nothing while the sheet is off screen, then what shows once it is', () => {
      const onSeen = vi.fn();
      const props = makeProps({ devices: [], open: false, onSeen });
      const { rerender } = render(<DevicePickerSheet {...props} />);
      expect(onSeen).not.toHaveBeenCalled();
      rerender(<DevicePickerSheet {...props} open />);
      expect(onSeen.mock.calls).toEqual([['tips']]);
    });

    it('reports nothing with the target board listed', () => {
      const onSeen = vi.fn();
      render(
        <DevicePickerSheet {...makeProps({ devices: [kilter], resolvedBoards: resolutions, targetBoard, onSeen })} />,
      );
      expect(onSeen).not.toHaveBeenCalled();
    });
  });

  it.each([undefined, { boardUuid: '', boardName: 'kilter' }])(
    'keeps the broad list when intended identity is absent: %s',
    (anonymousTarget) => {
      const { container } = render(
        <DevicePickerSheet {...makeProps({ devices: [kilter, tension], targetBoard: anonymousTarget })} />,
      );
      expect(listedIds(container)).toEqual(['tension', 'kilter']);
    },
  );
});

// Plan item 6: the tips come in 5 s into the scan while there is nothing to
// pick, instead of after the 30 s scan ends empty, with "Browse for now".
describe('DevicePickerSheet tips from 5 s into the scan', () => {
  const targetBoard = { boardUuid: 'qa-kilter', boardName: 'kilter' };
  const kilter = { deviceId: 'kilter', name: 'Kilter Board#K-1@3', rssi: -70 };
  const tension = { deviceId: 'tension', name: 'Tension Board#T-1@3', rssi: -35 };
  const unknown = { deviceId: 'unknown', name: 'Kilter Board', rssi: -40 };
  const resolutions = new Map([
    ['K-1', recordedBoard('qa-kilter')],
    ['T-1', recordedBoard('qa-tension', 'tension')],
  ]);
  const MOONBOARD_CONFIG = { boardName: 'moonboard' as const, layoutId: 1, sizeId: 1, setIds: '1' };

  beforeEach(() => {
    vi.useFakeTimers();
    bluetooth.takeVirtualWall.mockClear();
    recordNoLightsMock.mockClear();
    stats.noneMatchedSelectedType = false;
    locationHint.shouldOfferLocationGrant = false;
    locationHint.wasGranted = false;
    locationHint.shouldOfferLocationServicesEnable = false;
    locationHint.servicesWereEnabled = false;
    locationHint.lastActive = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tipsShown = (root: HTMLElement) => hasText(root, 'ble.troubleshootTitle');
  const browseButton = (root: HTMLElement) =>
    root.querySelector('[data-button="ble.browseForNow"]') as HTMLButtonElement | null;
  // Where each tip sits in the sheet's text, to read their order.
  const tipOrder = (root: HTMLElement) => {
    const text = root.textContent ?? '';
    return ['ble.scanTipPower', 'ble.scanTipCloser', 'ble.scanTipBluetooth', 'ble.scanTipOtherPhone']
      .map((key) => ({ key, at: text.indexOf(`${key}`) }))
      .filter(({ at }) => at >= 0)
      .sort((tipA, tipB) => tipA.at - tipB.at)
      .map(({ key }) => key);
  };

  it('shows the tips 5 s into a scan that has heard nothing, not before, and keeps scanning', () => {
    const onSeen = vi.fn();
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: true, devices: [], onSeen })} />);

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(tipsShown(container)).toBe(false);
    expect(onSeen).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tipsShown(container)).toBe(true);
    expect(onSeen.mock.calls).toEqual([['tips']]);
    // Still scanning: the spinner stays, and none of the scan-ended actions show.
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(hasText(container, 'ble.scanning')).toBe(true);
    expect(hasText(container, 'ble.noDevicesFound')).toBe(false);
    expect(container.querySelector('[data-button="ble.noLedsCta"]')).toBeNull();
  });

  it('takes the tips down when a board turns up in an open list', () => {
    const props = makeProps({ isScanning: true, devices: [] });
    const { container, rerender } = render(<DevicePickerSheet {...props} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(tipsShown(container)).toBe(true);

    rerender(<DevicePickerSheet {...props} devices={[device('a')]} />);
    expect(tipsShown(container)).toBe(false);
  });

  // Every unknown box may be the climber's. A box with no serial can only be
  // told apart by its BLE id; a serial is recorded only on a connect, so on the
  // first Boardsesh connect at a board its box sits unknown too, and so does any
  // box while its lookup is still out. "Don't see your board?" under the row
  // they are about to tap would be wrong in each case.
  it.each([
    [
      'a MoonBoard, whose box advertises no serial',
      { boardUuid: 'qa-moon', boardName: 'moonboard' },
      { deviceId: 'moon', name: 'MoonBoard', rssi: -60 },
      new Map<string, ResolvedBoardEntry>(),
    ],
    ['a Kilter-built box, which advertises no serial', targetBoard, unknown, new Map<string, ResolvedBoardEntry>()],
    [
      'a Kilter box whose serial nobody recorded yet',
      targetBoard,
      { deviceId: 'unrecorded', name: 'Kilter Board#K-9@3', rssi: -45 },
      resolutions,
    ],
    ['a Kilter box whose lookup is still out', targetBoard, kilter, new Map<string, ResolvedBoardEntry>()],
    [
      'a box that advertises no board type',
      { boardUuid: 'qa-moon', boardName: 'moonboard' },
      { deviceId: 'nameless', name: 'LED Controller', rssi: -50 },
      new Map<string, ResolvedBoardEntry>(),
    ],
  ])('keeps them off with only %s listed', (_label, target, box, resolvedBoards) => {
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({ isScanning: true, devices: [tension, box], resolvedBoards, targetBoard: target })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(listedIds(container)).toEqual([box.deviceId]);
    expect(tipsShown(container)).toBe(false);
    expect(hasText(container, 'ble.searchingForSavedBoard')).toBe(false);
  });

  it('never shows them while the target board is listed', () => {
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({
          isScanning: true,
          devices: [kilter, tension, unknown],
          resolvedBoards: resolutions,
          targetBoard,
          onBrowseForNow: vi.fn(),
        })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(tipsShown(container)).toBe(false);
    expect(browseButton(container)).toBeNull();
  });

  it('brings them when a lookup names the only listed box as another board', () => {
    const props = makeProps({ isScanning: true, devices: [kilter], targetBoard, onSearchAnyBoard: vi.fn() });
    const { container, rerender } = render(<DevicePickerSheet {...props} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(listedIds(container)).toEqual(['kilter']);
    expect(tipsShown(container)).toBe(false);

    rerender(<DevicePickerSheet {...props} resolvedBoards={new Map([['K-1', recordedBoard('qa-other-kilter')]])} />);
    expect(listedIds(container)).toEqual([]);
    expect(tipsShown(container)).toBe(true);
  });

  it('counts a box this phone remembers for the board as its own', () => {
    const remembered = { deviceId: 'remembered-box', name: 'Kilter Board', rssi: -60 };
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({
          isScanning: true,
          devices: [remembered],
          targetBoard: { ...targetBoard, rememberedDeviceId: 'remembered-box' },
        })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(tipsShown(container)).toBe(false);
  });

  it('shows nothing while still searching for the saved board, and the tips at once when the list takes over', () => {
    const props = makeProps({ isScanning: true, devices: [], mode: 'searching' as const, onSearchAnyBoard: vi.fn() });
    const { container, rerender } = render(<DevicePickerSheet {...props} />);
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(tipsShown(container)).toBe(false);

    // The 10 s search ran out: the list comes up already past 5 s.
    rerender(<DevicePickerSheet {...props} mode="list" />);
    expect(tipsShown(container)).toBe(true);
  });

  it('orders them power, distance, Bluetooth, then another phone', () => {
    const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);
    expect(tipOrder(container)).toEqual([
      'ble.scanTipPower',
      'ble.scanTipCloser',
      'ble.scanTipBluetooth',
      'ble.scanTipOtherPhone',
    ]);
    expect(hasText(container, 'ble.scanTipOtherPhoneMoonBoard')).toBe(false);
  });

  it('moves another phone to second on a MoonBoard, with the MoonBoard wording', () => {
    const { container } = render(
      <DevicePickerSheet
        {...makeProps({
          isScanning: false,
          devices: [],
          targetBoard: { boardUuid: 'qa-moon', boardName: 'moonboard' },
          currentBoardConfig: MOONBOARD_CONFIG,
        })}
      />,
    );
    // `ble.scanTipOtherPhone` is a prefix of the MoonBoard key, so it reads the MoonBoard line.
    expect(tipOrder(container)).toEqual([
      'ble.scanTipPower',
      'ble.scanTipOtherPhone',
      'ble.scanTipCloser',
      'ble.scanTipBluetooth',
    ]);
    expect(hasText(container, 'ble.scanTipOtherPhoneMoonBoard')).toBe(true);
  });

  it('orders them for a MoonBoard with no board identity too (the active board)', () => {
    const { container } = render(
      <DevicePickerSheet {...makeProps({ isScanning: false, devices: [], currentBoardConfig: MOONBOARD_CONFIG })} />,
    );
    expect(hasText(container, 'ble.scanTipOtherPhoneMoonBoard')).toBe(true);
  });

  describe('Browse for now', () => {
    it('comes with the tips, and not before', () => {
      const { container } = render(
        <DevicePickerSheet {...makeProps({ isScanning: true, devices: [], onBrowseForNow: vi.fn() })} />,
      );
      expect(browseButton(container)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(browseButton(container)).not.toBeNull();
    });

    it('records the tap, then closes the picker without connecting', () => {
      const calls: string[] = [];
      const onBrowseForNow = vi.fn(() => calls.push('browse'));
      const onDismiss = vi.fn(() => calls.push('dismiss'));
      const props = makeProps({ isScanning: true, devices: [], onBrowseForNow, onDismiss });
      const { container } = render(<DevicePickerSheet {...props} />);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      act(() => browseButton(container)?.click());
      expect(calls).toEqual(['browse', 'dismiss']);
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(bluetooth.takeVirtualWall).not.toHaveBeenCalled();
      expect(recordNoLightsMock).not.toHaveBeenCalled();
    });

    it('sits beside "This wall has no lights" after an empty scan, as its own action', () => {
      const onBrowseForNow = vi.fn();
      const onNoLeds = vi.fn();
      const { container } = render(
        <DevicePickerSheet {...makeProps({ isScanning: false, devices: [], onBrowseForNow, onNoLeds })} />,
      );
      expect(browseButton(container)).not.toBeNull();
      expect(container.querySelector('[data-button="ble.noLedsCta"]')).not.toBeNull();
      act(() => browseButton(container)?.click());
      expect(onBrowseForNow).toHaveBeenCalledOnce();
      expect(onNoLeds).not.toHaveBeenCalled();
    });

    it('renders nothing where no host wires it', () => {
      const { container } = render(<DevicePickerSheet {...makeProps({ isScanning: false, devices: [] })} />);
      expect(tipsShown(container)).toBe(true);
      expect(browseButton(container)).toBeNull();
    });
  });

  // The sheet opens at a medium detent with no room to spare. A block of hints
  // pinned under the list or the empty state squeezed them to nothing, so the
  // hints share one scroller with whatever is above them.
  describe('room at a medium detent', () => {
    const scroller = (root: HTMLElement) => root.querySelector('[data-scroll]');

    it('scrolls the empty scan, Scan again, the tips and Browse for now together', () => {
      const { container } = render(
        <DevicePickerSheet
          {...makeProps({ isScanning: false, devices: [], onScanAgain: vi.fn(), onBrowseForNow: vi.fn() })}
        />,
      );
      const scroll = scroller(container);
      expect(scroll).not.toBeNull();
      expect(hasText(scroll as HTMLElement, 'ble.noDevicesFound')).toBe(true);
      expect(scroll?.querySelector('[data-button="ble.scanAgain"]')).not.toBeNull();
      expect(hasText(scroll as HTMLElement, 'ble.troubleshootTitle')).toBe(true);
      expect(scroll?.querySelector('[data-button="ble.browseForNow"]')).not.toBeNull();
      expect(container.querySelector('[data-list]')).toBeNull();
    });

    it('scrolls "not found" for a known board, its escape and the tips together', () => {
      const { container } = render(
        <DevicePickerSheet
          {...makeProps({
            devices: [tension],
            resolvedBoards: resolutions,
            targetBoard,
            onSearchAnyBoard: vi.fn(),
          })}
        />,
      );
      const scroll = scroller(container);
      expect(hasText(scroll as HTMLElement, 'ble.selectedBoardNotFound')).toBe(true);
      expect(scroll?.querySelector('[data-button="ble.searchAnyBoard"]')).not.toBeNull();
      expect(hasText(scroll as HTMLElement, 'ble.troubleshootTitle')).toBe(true);
    });

    it('puts the tips at the foot of the list when boards are listed', () => {
      stats.noneMatchedSelectedType = true;
      const { container } = render(
        <DevicePickerSheet {...makeProps({ isScanning: false, devices: [device('a')], onBrowseForNow: vi.fn() })} />,
      );
      const list = container.querySelector('[data-list]') as HTMLElement;
      expect(hasText(list, 'ble.troubleshootTitle')).toBe(true);
      expect(list.querySelector('[data-button="ble.browseForNow"]')).not.toBeNull();
      expect(scroller(container)).toBeNull();
    });
  });
});
