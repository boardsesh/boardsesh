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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import type { QuickstartScanDevice } from '../../../lib/ble/quickstart-scan-device';

const scan = vi.hoisted(() => ({
  status: 'done' as 'idle' | 'scanning' | 'done' | 'unavailable',
  unavailableReason: null as
    | 'permission_denied'
    | 'unauthorized'
    | 'powered_off'
    | 'unsupported'
    | 'unknown'
    | 'not_asked'
    | null,
  serials: [] as string[],
  advertisedTypes: new Map<string, string>(),
  devices: [] as QuickstartScanDevice[],
  start: vi.fn(async () => {}),
  reset: vi.fn(),
}));

const boards = vi.hoisted(() => ({
  data: [] as unknown[] | undefined,
  isLoading: false,
  isError: false,
  fetchStatus: 'idle' as 'idle' | 'fetching' | 'paused',
  refetch: vi.fn(async () => undefined),
}));

const actions = vi.hoisted(() => ({ onFindAtGym: vi.fn(), onOwnBoard: vi.fn() }));

const serialConfigs = vi.hoisted(() => ({ data: [] as BoardSerialConfig[], isResolving: false }));

const { resolveCalls } = vi.hoisted(() => ({
  resolveCalls: [] as Array<{ serialNumbers: string[]; advertisedTypes?: ReadonlyMap<string, string> }>,
}));

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

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' | 'web' }));

type ChildrenProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ChildrenProps) => createElement('div', {}, children),
  Pressable: ({ children, onPress }: ChildrenProps & { onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  Platform: platform,
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

// The interpolated board name rides along after the key, so a row can be
// checked for the board type it names.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { board?: string }) => (params?.board ? `${key}[${params.board}]` : key),
  }),
}));

vi.mock('../../../lib/ble/use-board-scan', () => ({
  useBoardScan: () => scan,
}));

const appSettings = vi.hoisted(() => ({
  canOpen: true,
  openAppSettings: vi.fn(async () => true),
}));
vi.mock('../../../lib/open-app-settings', () => ({
  canOpenAppSettings: () => appSettings.canOpen,
  openAppSettings: appSettings.openAppSettings,
}));

// The platform wording is covered in bluetooth-unavailable.test.ts; here it only
// has to reach the screen.
vi.mock('../../../lib/ble/bluetooth-unavailable-alert', () => ({
  bluetoothBlockedBody: () => 'blocked-body-for-this-platform',
}));

vi.mock('../../../lib/ble/use-android-scan-location-hint', () => ({
  useAndroidScanLocationHint: (active: boolean) => {
    locationHint.lastActive = active;
    return locationHint;
  },
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  useBoardsBySerialNumbers: (serialNumbers: string[], advertisedTypes?: ReadonlyMap<string, string>) => {
    // Recorded so the sheet is pinned to passing the scan's advertised types
    // through. Without them the hook resolves a serial to whichever board type
    // carries it, and this sheet makes that board active.
    resolveCalls.push({ serialNumbers, advertisedTypes });
    return boards;
  },
}));

vi.mock('../../../lib/ble/use-my-board-serial-configs', () => ({
  useMyBoardSerialConfigs: () => serialConfigs,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { label: '#111', secondaryLabel: '#666', tertiaryLabel: '#999', separator: '#ccc' },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 2: 8, 3: 12, 4: 16, 8: 32 },
  borderRadius: { lg: 12 },
}));

const sheetProps = vi.hoisted(() => ({ scrollable: undefined as boolean | undefined }));
// The sheet closes itself before handing a next step to the screen; each test
// decides when (and whether) that dismissal settles.
const sheetDismiss = vi.hoisted(() => ({
  wait: vi.fn(async (): Promise<{ status: 'dismissed' | 'aborted' }> => ({ status: 'dismissed' })),
}));
vi.mock('../../Sheet', () => ({
  Sheet: forwardRef(({ children, scrollable }: ChildrenProps & { scrollable?: boolean }, _ref: Ref<unknown>) => {
    sheetProps.scrollable = scrollable;
    return createElement('div', {}, children);
  }),
  dismissSheetAndWait: sheetDismiss.wait,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: ChildrenProps) => createElement('span', {}, children),
}));

vi.mock('../../Icon', () => ({ Icon: () => createElement('div', { 'data-icon': 'true' }) }));

vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

type ButtonMockProps = { title: string; onPress?: () => void };
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: ButtonMockProps) => createElement('button', { 'data-button': title, onClick: onPress }),
}));

import { BluetoothQuickstartSheet } from '../BluetoothQuickstartSheet';

const hasText = (root: HTMLElement, text: string) => root.textContent?.includes(text) ?? false;

function sheet(onSelect: (board: unknown) => void = vi.fn()) {
  return <BluetoothQuickstartSheet active onClose={vi.fn()} onSelect={onSelect} {...actions} />;
}

function renderSheet() {
  return render(sheet());
}

describe('BluetoothQuickstartSheet', () => {
  beforeEach(() => {
    scan.status = 'done';
    scan.unavailableReason = null;
    appSettings.canOpen = true;
    appSettings.openAppSettings.mockClear();
    scan.serials = [];
    scan.advertisedTypes = new Map();
    scan.devices = [];
    resolveCalls.length = 0;
    scan.start.mockClear();
    scan.reset.mockReset();
    boards.data = [];
    boards.isLoading = false;
    boards.isError = false;
    boards.fetchStatus = 'idle';
    boards.refetch.mockClear();
    actions.onFindAtGym.mockClear();
    actions.onOwnBoard.mockClear();
    serialConfigs.data = [];
    serialConfigs.isResolving = false;
    locationHint.shouldOfferLocationGrant = false;
    locationHint.wasGranted = false;
    locationHint.isRequesting = false;
    locationHint.shouldOfferLocationServicesEnable = false;
    locationHint.servicesWereEnabled = false;
    locationHint.isPromptingServices = false;
    locationHint.lastActive = null;
    locationHint.requestLocationPermission.mockClear();
    locationHint.requestLocationPermission.mockResolvedValue(true);
    locationHint.promptEnableLocationServices.mockClear();
    locationHint.promptEnableLocationServices.mockResolvedValue(true);
  });

  it('gives the zero-result state something to try — it used to end at "no boards in range"', () => {
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.noResults')).toBe(true);
    expect(hasText(container, 'settings:ble.troubleshootTips')).toBe(true);
  });

  // The scan lists MoonBoards and boxes with no serial now, so the caveat that
  // it can't see them is gone.
  it.each(['scanning', 'done'] as const)('no longer warns that the scan misses MoonBoards while %s', (status) => {
    scan.status = status;
    const { container } = renderSheet();

    expect(hasText(container, 'scanFootnote')).toBe(false);
  });

  // #5654: the Android empty scan's recovery buttons run past a 55% sheet on a
  // small phone at large text.
  it('scrolls, so the recovery buttons are never cut off', () => {
    locationHint.shouldOfferLocationGrant = true;
    renderSheet();
    expect(sheetProps.scrollable).toBe(true);
  });

  it('shows the location hint instead of the hardware tips when Android is suppressing results', () => {
    locationHint.shouldOfferLocationGrant = true;
    const { container } = renderSheet();

    expect(hasText(container, 'settings:ble.locationHintTitle')).toBe(true);
    expect(hasText(container, 'settings:ble.locationHintBody')).toBe(true);
    expect(hasText(container, 'settings:ble.troubleshootTips')).toBe(false);
  });

  it('restarts the scan after the user grants location', async () => {
    // This sheet owns its scan lifecycle (unlike the device picker), so a grant
    // should get the user a fresh scan without them reopening the sheet. The
    // whole chain has to hold: grant -> reset() -> status back to 'idle' -> the
    // mount effect fires start() again. Asserting only that reset() was called
    // would stay green if that effect stopped watching `status`, which is the
    // half that actually restarts the scan.
    scan.reset.mockImplementation(() => {
      scan.status = 'idle';
    });
    locationHint.shouldOfferLocationGrant = true;
    const { container, rerender } = renderSheet();

    // The scan already finished ('done'), so nothing has restarted it yet.
    expect(scan.start).not.toHaveBeenCalled();

    const grantButton = container.querySelector('[data-button="settings:ble.locationHintGrant"]');
    expect(grantButton).not.toBeNull();
    (grantButton as HTMLButtonElement).click();

    await waitFor(() => {
      expect(scan.reset).toHaveBeenCalledOnce();
    });

    // useBoardScan is mocked, so the status flip can't re-render on its own the
    // way the real hook's state update would.
    rerender(sheet());

    await waitFor(() => {
      expect(scan.start).toHaveBeenCalledOnce();
    });
  });

  it('does not restart the scan when the grant is declined', async () => {
    locationHint.shouldOfferLocationGrant = true;
    locationHint.requestLocationPermission.mockResolvedValue(false);
    const { container } = renderSheet();

    (container.querySelector('[data-button="settings:ble.locationHintGrant"]') as HTMLButtonElement).click();

    await waitFor(() => {
      expect(locationHint.requestLocationPermission).toHaveBeenCalledOnce();
    });
    expect(scan.reset).not.toHaveBeenCalled();
  });

  it('asks the hint hook only about a scan that finished with no boards', () => {
    scan.status = 'scanning';
    renderSheet();
    expect(locationHint.lastActive).toBe(false);

    scan.status = 'done';
    // A lookup only runs for heard serials.
    scan.serials = ['1234'];
    boards.data = [{ uuid: 'board-1', name: 'Home wall', boardType: 'kilter', sizeName: 'Small' }];
    renderSheet();
    expect(locationHint.lastActive).toBe(false);
  });

  it('waits out serial resolution before calling the scan empty', () => {
    // The radio work finishes ('done') well before GraphQL turns the serials
    // into boards. Treating that window as "no boards in range" would flash the
    // empty state — and, on Android, a location hint — over a scan that in fact
    // found several.
    scan.status = 'done';
    scan.serials = ['1234'];
    boards.data = [];
    boards.isLoading = true;

    const { container } = renderSheet();

    expect(locationHint.lastActive).toBe(false);
    expect(hasText(container, 'mobile.bluetooth.noResults')).toBe(false);
    expect(hasText(container, 'settings:ble.troubleshootTips')).toBe(false);
    expect(hasText(container, 'mobile.bluetooth.resolving')).toBe(true);
  });

  it('shows the services hint instead of the hardware tips on Android 11 and below', () => {
    locationHint.shouldOfferLocationServicesEnable = true;
    const { container } = renderSheet();

    expect(hasText(container, 'settings:ble.locationServicesHintTitle')).toBe(true);
    expect(hasText(container, 'settings:ble.locationServicesHintBody')).toBe(true);
    expect(hasText(container, 'settings:ble.troubleshootTips')).toBe(false);
  });

  it('restarts the scan after the user enables Location services', async () => {
    scan.reset.mockImplementation(() => {
      scan.status = 'idle';
    });
    locationHint.shouldOfferLocationServicesEnable = true;
    const { container, rerender } = renderSheet();

    expect(scan.start).not.toHaveBeenCalled();

    const enableButton = container.querySelector('[data-button="settings:ble.locationServicesHintEnable"]');
    expect(enableButton).not.toBeNull();
    (enableButton as HTMLButtonElement).click();

    await waitFor(() => {
      expect(scan.reset).toHaveBeenCalledOnce();
    });

    rerender(sheet());

    await waitFor(() => {
      expect(scan.start).toHaveBeenCalledOnce();
    });
  });

  it('does not restart the scan when enabling Location services fails', async () => {
    locationHint.shouldOfferLocationServicesEnable = true;
    locationHint.promptEnableLocationServices.mockResolvedValue(false);
    const { container } = renderSheet();

    (container.querySelector('[data-button="settings:ble.locationServicesHintEnable"]') as HTMLButtonElement).click();

    await waitFor(() => {
      expect(locationHint.promptEnableLocationServices).toHaveBeenCalledOnce();
    });
    expect(scan.reset).not.toHaveBeenCalled();
  });
});

describe('BluetoothQuickstartSheet board rows', () => {
  beforeEach(() => {
    scan.status = 'done';
    scan.serials = ['1234'];
    scan.devices = [];
    boards.data = [];
    boards.isLoading = false;
    boards.isError = false;
    boards.fetchStatus = 'idle';
    serialConfigs.data = [];
    serialConfigs.isResolving = false;
  });

  // The row used to render `{board.boardType} · {board.sizeName ?? ''}`, and the
  // server sends sizeName as null on every board — so every hit read "kilter · "
  // with a dangling separator.
  it('shows where a resolved board is, not a dangling board type', () => {
    boards.data = [
      {
        uuid: 'board-1',
        name: 'Home wall',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 7,
        gymName: 'Bergen Klatresenter',
        sizeName: null,
      },
    ];
    const { container } = renderSheet();

    expect(hasText(container, 'Bergen Klatresenter')).toBe(true);
    expect(hasText(container, 'kilter · ')).toBe(false);
  });

  it('falls back to the board config when it has no gym or location', () => {
    boards.data = [{ uuid: 'board-1', name: 'Garage', boardType: 'kilter', layoutId: 1, sizeId: 7, sizeName: null }];
    const { container } = renderSheet();

    expect(hasText(container, 'Original 12×14')).toBe(true);
  });

  it('resolves scanned serials scoped to the type each controller advertised', () => {
    // The Benchmark bug on this surface: Aurora reuses a serial across board
    // apps, so an unscoped lookup can offer a stranger's Kilter board for an
    // in-range Tension controller — and this sheet makes the pick active.
    scan.serials = ['12345'];
    scan.advertisedTypes = new Map([['12345', 'tension']]);

    render(sheet());

    const lastCall = resolveCalls.at(-1);
    expect({ serialNumbers: lastCall?.serialNumbers, advertisedTypes: [...(lastCall?.advertisedTypes ?? [])] }).toEqual(
      {
        serialNumbers: ['12345'],
        advertisedTypes: [['12345', 'tension']],
      },
    );
  });

  it("shows and selects only the climber's saved board when a serial is reused", () => {
    const garage = {
      uuid: 'garage',
      serialNumber: '751945',
      name: 'Garage',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 7,
      sizeName: null,
    };
    const miles = { ...garage, uuid: 'miles', name: 'MILES' };
    boards.data = [miles, garage];
    serialConfigs.data = [
      {
        serialNumber: '751945',
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 7,
        setIds: '1,20',
        apiLevel: 3,
        updatedAt: '2026-01-02T00:00:00.000Z',
        boardUuid: garage.uuid,
        boardSlug: garage.uuid,
      },
    ];
    const onSelect = vi.fn();

    const { container } = render(sheet(onSelect));

    expect(hasText(container, 'Garage')).toBe(true);
    expect(hasText(container, 'MILES')).toBe(false);
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith(garage);
  });

  it('keeps resolving while the saved-board lookup waits for authentication', () => {
    const garage = {
      uuid: 'garage',
      serialNumber: '751945',
      name: 'Garage',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 7,
      sizeName: null,
    };
    const miles = { ...garage, uuid: 'miles', name: 'MILES' };
    boards.data = [garage, miles];
    serialConfigs.isResolving = true;

    const { container, rerender } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.noResults')).toBe(false);
    expect(hasText(container, 'mobile.bluetooth.resolving')).toBe(true);
    expect(hasText(container, 'Garage')).toBe(false);
    expect(hasText(container, 'MILES')).toBe(false);

    serialConfigs.data = [
      {
        serialNumber: '751945',
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 7,
        setIds: '1,20',
        apiLevel: 3,
        updatedAt: '2026-01-02T00:00:00.000Z',
        boardUuid: garage.uuid,
        boardSlug: garage.uuid,
      },
    ];
    serialConfigs.isResolving = false;
    rerender(sheet());

    expect(hasText(container, 'Garage')).toBe(true);
    expect(hasText(container, 'MILES')).toBe(false);
  });

  // #6392: a signed-out scan resolves a hidden board to geometry with uuid ''.
  // Keyed on that, two of them shared one React key and the second row could
  // stand in for the first.
  it('lists and picks two hidden boards found by serial, each under its own key', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hidden = {
      uuid: '',
      slug: '',
      boardId: null,
      name: 'kilter',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 7,
      setIds: '1,20',
      angle: 40,
      sizeName: null,
    };
    const first = { ...hidden, serialNumber: '751945' };
    const second = { ...hidden, serialNumber: '812002' };
    boards.data = [first, second];
    const onSelect = vi.fn();

    try {
      const { container } = render(
        createElement(BluetoothQuickstartSheet, { active: true, onClose: () => {}, onSelect, ...actions }),
      );

      const rows = container.querySelectorAll('button');
      expect(rows).toHaveLength(2);
      (rows[1] as HTMLButtonElement).click();
      expect(onSelect).toHaveBeenCalledWith(second);
      const duplicateKeyWarnings = consoleError.mock.calls.filter((call) =>
        call.some((part) => typeof part === 'string' && part.includes('same key')),
      );
      expect(duplicateKeyWarnings).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// #5654: every stop read "Turn on Bluetooth to scan", including a climber whose
// Bluetooth was on but blocked for Boardsesh, and nothing offered a retry.
describe('BluetoothQuickstartSheet when the scan cannot run (#5654)', () => {
  beforeEach(() => {
    platform.OS = 'android';
    scan.status = 'unavailable';
    scan.unavailableReason = null;
    scan.serials = [];
    scan.devices = [];
    scan.reset.mockReset();
    boards.data = [];
    boards.isLoading = false;
    boards.isError = false;
    boards.fetchStatus = 'idle';
    appSettings.canOpen = true;
    appSettings.openAppSettings.mockClear();
  });

  const button = (root: HTMLElement, title: string) =>
    root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

  it('says Bluetooth is blocked and links to Settings', () => {
    scan.unavailableReason = 'unauthorized';
    const { container } = renderSheet();

    expect(hasText(container, 'ble.blockedTitle')).toBe(true);
    expect(hasText(container, 'blocked-body-for-this-platform')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.unavailable')).toBe(false);

    button(container, 'ble.openSettings')?.click();
    expect(appSettings.openAppSettings).toHaveBeenCalledTimes(1);
  });

  it('drops the Settings button where the platform has no Settings link', () => {
    scan.unavailableReason = 'unauthorized';
    appSettings.canOpen = false;
    const { container } = renderSheet();

    expect(hasText(container, 'ble.blockedTitle')).toBe(true);
    expect(button(container, 'ble.openSettings')).toBeNull();
  });

  it('asks for the permission again after a dialog "Don\'t allow"', () => {
    scan.unavailableReason = 'permission_denied';
    const { container } = renderSheet();

    expect(hasText(container, 'ble.errorPermissionDenied')).toBe(true);
    expect(button(container, 'ble.openSettings')).toBeNull();
  });

  // An alert left unanswered is not a refusal: say what Bluetooth is for, not
  // that it was denied, and keep Scan again, which asks again.
  it('asks without blaming the climber when the Bluetooth question went unanswered', () => {
    scan.unavailableReason = 'not_asked';
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.notAsked')).toBe(true);
    expect(hasText(container, 'ble.errorPermissionDenied')).toBe(false);
    expect(button(container, 'ble.scanAgain')).not.toBeNull();
  });

  it.each(['powered_off', 'unsupported', 'unknown'] as const)('keeps "Turn on Bluetooth to scan" for %s', (reason) => {
    scan.unavailableReason = reason;
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.unavailable')).toBe(true);
    expect(hasText(container, 'ble.blockedTitle')).toBe(false);
  });

  it.each(['unauthorized', 'permission_denied', 'powered_off', 'unknown'] as const)(
    'offers Scan again for %s on Android, which restarts the scan',
    (reason) => {
      scan.unavailableReason = reason;
      const { container } = renderSheet();

      button(container, 'ble.scanAgain')?.click();
      expect(scan.reset).toHaveBeenCalledOnce();
    },
  );

  it('leaves blocked on iOS at Open Settings: nothing else can change it, and the switch relaunches the app', () => {
    platform.OS = 'ios';
    scan.unavailableReason = 'unauthorized';
    const { container } = renderSheet();

    expect(hasText(container, 'ble.blockedTitle')).toBe(true);
    expect(button(container, 'ble.openSettings')).not.toBeNull();
    expect(button(container, 'ble.scanAgain')).toBeNull();
  });

  it('keeps Scan again on iOS where the radio can come back without a relaunch', () => {
    platform.OS = 'ios';
    scan.unavailableReason = 'powered_off';
    const { container } = renderSheet();

    expect(button(container, 'ble.scanAgain')).not.toBeNull();
  });

  it('offers no Scan again without Bluetooth LE, such as a browser with no Web Bluetooth', () => {
    platform.OS = 'web';
    scan.unavailableReason = 'unsupported';
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.unavailable')).toBe(true);
    expect(hasText(container, 'ble.errorPermissionDenied')).toBe(false);
    expect(button(container, 'ble.scanAgain')).toBeNull();
  });

  it('offers no Scan again in a browser that has Web Bluetooth, whose radio always reads as off', () => {
    platform.OS = 'web';
    scan.unavailableReason = 'powered_off';
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.unavailable')).toBe(true);
    expect(button(container, 'ble.scanAgain')).toBeNull();
  });

  it('offers Scan again when the scan finished with no boards in range', () => {
    scan.status = 'done';
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.noResults')).toBe(true);
    button(container, 'ble.scanAgain')?.click();
    expect(scan.reset).toHaveBeenCalledOnce();
  });

  it('shows no Scan again while boards are listed', () => {
    scan.status = 'done';
    // A lookup only runs for heard serials.
    scan.serials = ['1234'];
    boards.data = [{ uuid: 'board-1', name: 'Gym Kilter', boardType: 'kilter', sizeName: 'Small' }];
    const { container } = renderSheet();

    expect(button(container, 'ble.scanAgain')).toBeNull();
  });
});

// Slice 1 of the first-run redesign: every board the scan hears gets a row and
// a next step. MoonBoards and Kilter-built boxes advertise no serial, a serial
// can belong to a board nobody saved, and a lookup can fail offline. Each of
// those used to read "No boards in range".
describe('BluetoothQuickstartSheet boards it cannot name', () => {
  const moonboard: QuickstartScanDevice = {
    key: 'device:mb-1',
    deviceId: 'mb-1',
    name: 'MoonBoard A',
    kind: 'moonboard',
    serial: null,
    boardType: 'moonboard',
    rssi: -80,
  };
  const bareKilter: QuickstartScanDevice = {
    key: 'device:kb-1',
    deviceId: 'kb-1',
    name: 'Kilter Board',
    kind: 'bare_name',
    serial: null,
    boardType: 'kilter',
    rssi: -60,
  };
  const kilterSerial: QuickstartScanDevice = {
    key: 'serial:751737',
    deviceId: 'ks-1',
    name: 'Kilter Board#751737@3',
    kind: 'serial',
    serial: '751737',
    boardType: 'kilter',
    rssi: -50,
  };
  const tensionSerial: QuickstartScanDevice = {
    key: 'serial:12345',
    deviceId: 'ts-1',
    name: 'Tension Board#12345@3',
    kind: 'serial',
    serial: '12345',
    boardType: 'tension',
    rssi: -70,
  };
  const gymKilter = {
    uuid: 'gym-kilter',
    serialNumber: '751737',
    name: 'Crux Kilter',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 7,
    sizeName: null,
  };

  const button = (root: HTMLElement, title: string) =>
    root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

  beforeEach(() => {
    scan.status = 'done';
    scan.unavailableReason = null;
    scan.serials = [];
    scan.advertisedTypes = new Map();
    scan.devices = [];
    boards.data = [];
    boards.isLoading = false;
    boards.isError = false;
    boards.fetchStatus = 'idle';
    boards.refetch.mockClear();
    serialConfigs.data = [];
    serialConfigs.isResolving = false;
    locationHint.shouldOfferLocationGrant = false;
    locationHint.shouldOfferLocationServicesEnable = false;
    locationHint.lastActive = null;
    actions.onFindAtGym.mockClear();
    actions.onOwnBoard.mockClear();
    sheetDismiss.wait.mockClear();
  });

  it('says it found a MoonBoard, and offers the gym list and the builder for it', async () => {
    scan.devices = [moonboard];
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.moonboardTitle')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.moonboardBody')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.noResults')).toBe(false);
    expect(locationHint.lastActive).toBe(false);

    button(container, 'mobile.bluetooth.findAtGym')?.click();
    await waitFor(() => expect(actions.onFindAtGym).toHaveBeenCalledWith('moonboard'));
    button(container, 'mobile.bluetooth.ownBoard')?.click();
    await waitFor(() => expect(actions.onOwnBoard).toHaveBeenCalledWith('moonboard'));
  });

  // The location prompt or the builder push must not start under a sheet that
  // is still sliding away.
  it('hands a next step over only once the sheet has slid away', async () => {
    scan.devices = [moonboard];
    let settle: (result: { status: 'dismissed' | 'aborted' }) => void = () => {};
    sheetDismiss.wait.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { container } = renderSheet();

    button(container, 'mobile.bluetooth.ownBoard')?.click();
    // A second tap while it slides changes nothing.
    button(container, 'mobile.bluetooth.findAtGym')?.click();
    expect(sheetDismiss.wait).toHaveBeenCalledTimes(1);
    expect(actions.onOwnBoard).not.toHaveBeenCalled();

    settle({ status: 'dismissed' });
    await waitFor(() => expect(actions.onOwnBoard).toHaveBeenCalledWith('moonboard'));
    expect(actions.onFindAtGym).not.toHaveBeenCalled();
  });

  it('hands nothing over when the sheet was opened again before it settled', async () => {
    scan.devices = [moonboard];
    sheetDismiss.wait.mockResolvedValueOnce({ status: 'aborted' });
    const { container } = renderSheet();

    button(container, 'mobile.bluetooth.findAtGym')?.click();
    await waitFor(() => expect(sheetDismiss.wait).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(actions.onFindAtGym).not.toHaveBeenCalled();
  });

  it('shows two MoonBoards in range as one row: both would say the same thing', () => {
    scan.devices = [moonboard, { ...moonboard, key: 'device:mb-2', deviceId: 'mb-2', rssi: -55 }];
    const { container } = renderSheet();

    expect(container.querySelectorAll('[data-button="mobile.bluetooth.findAtGym"]')).toHaveLength(1);
  });

  it('says it found a Kilter box that does not say which board it is', async () => {
    scan.devices = [bareKilter];
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.bareNameTitle[Kilter]')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.bareNameBody')).toBe(true);

    button(container, 'mobile.bluetooth.findAtGym')?.click();
    await waitFor(() => expect(actions.onFindAtGym).toHaveBeenCalledWith('kilter'));
    button(container, 'mobile.bluetooth.ownBoard')?.click();
    await waitFor(() => expect(actions.onOwnBoard).toHaveBeenCalledWith('kilter'));
  });

  it('names the type of a serial nobody has saved a board for', async () => {
    scan.serials = ['12345'];
    scan.advertisedTypes = new Map([['12345', 'tension']]);
    scan.devices = [tensionSerial];
    boards.data = [];
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.unknownSetupTitle[Tension]')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.unknownSetupBody')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.noResults')).toBe(false);

    button(container, 'mobile.bluetooth.ownBoard')?.click();
    await waitFor(() => expect(actions.onOwnBoard).toHaveBeenCalledWith('tension'));
  });

  it('lists a saved board and an unknown serial side by side', () => {
    scan.serials = ['751737', '12345'];
    scan.devices = [kilterSerial, tensionSerial];
    boards.data = [gymKilter];
    const { container } = renderSheet();

    expect(hasText(container, 'Crux Kilter')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.unknownSetupTitle[Tension]')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.unknownSetupTitle[Kilter]')).toBe(false);
  });

  it('lists every board closest first', () => {
    scan.serials = ['751737'];
    scan.devices = [moonboard, bareKilter, kilterSerial];
    boards.data = [gymKilter];
    const text = renderSheet().container.textContent ?? '';

    const savedBoard = text.indexOf('Crux Kilter');
    const bareBox = text.indexOf('mobile.bluetooth.bareNameTitle');
    const moonboardRow = text.indexOf('mobile.bluetooth.moonboardTitle');
    expect(savedBoard).toBeGreaterThanOrEqual(0);
    expect(savedBoard).toBeLessThan(bareBox);
    expect(bareBox).toBeLessThan(moonboardRow);
  });

  it('shows a MoonBoard straight away while serials are still being looked up', () => {
    scan.status = 'scanning';
    scan.serials = ['751737'];
    scan.devices = [kilterSerial, moonboard];
    boards.data = undefined;
    boards.isLoading = true;
    boards.fetchStatus = 'fetching';
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.moonboardTitle')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.unknownSetupTitle')).toBe(false);
    expect(hasText(container, 'mobile.bluetooth.needSignalTitle')).toBe(false);
  });

  // Offline the lookup pauses rather than failing, and the sheet used to
  // read that as "No boards in range".
  it.each([
    ['paused for want of a network', { isError: false, fetchStatus: 'paused' as const }],
    ['failed after its retries', { isError: true, fetchStatus: 'idle' as const }],
  ])('says it heard a board but needs signal when the lookup is %s, and tries again', (_label, lookup) => {
    scan.serials = ['751737'];
    scan.devices = [kilterSerial];
    boards.data = undefined;
    boards.isError = lookup.isError;
    boards.fetchStatus = lookup.fetchStatus;
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.needSignalTitle')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.needSignalBody')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.noResults')).toBe(false);
    expect(locationHint.lastActive).toBe(false);
    expect(button(container, 'mobile.bluetooth.findAtGym')).toBeNull();

    button(container, 'mobile.errorRetry')?.click();
    expect(boards.refetch).toHaveBeenCalledTimes(1);
  });

  // With no answer from the lookup, the saved-choices lookup still loading
  // must not hold the sheet on "Loading boards…".
  it('says it needs signal while the saved-choices lookup is still waiting', () => {
    scan.serials = ['751737'];
    scan.devices = [kilterSerial];
    boards.data = undefined;
    boards.fetchStatus = 'paused';
    serialConfigs.isResolving = true;
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.needSignalTitle')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.resolving')).toBe(false);
  });

  it('keeps the MoonBoard row next to the need-signal row', () => {
    scan.serials = ['751737'];
    scan.devices = [kilterSerial, moonboard];
    boards.data = undefined;
    boards.fetchStatus = 'paused';
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.needSignalTitle')).toBe(true);
    expect(hasText(container, 'mobile.bluetooth.moonboardTitle')).toBe(true);
  });

  it('still says "No boards in range" when the scan heard nothing', () => {
    const { container } = renderSheet();

    expect(hasText(container, 'mobile.bluetooth.noResults')).toBe(true);
    expect(locationHint.lastActive).toBe(true);
  });
});
