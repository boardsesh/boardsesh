// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';

const scan = vi.hoisted(() => ({
  status: 'done' as 'idle' | 'scanning' | 'done' | 'unavailable',
  serials: [] as string[],
  advertisedTypes: new Map<string, string>(),
  start: vi.fn(async () => {}),
  reset: vi.fn(),
}));

const boards = vi.hoisted(() => ({ data: [] as unknown[], isLoading: false }));

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

type ChildrenProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ChildrenProps) => createElement('div', {}, children),
  Pressable: ({ children }: ChildrenProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../lib/ble/use-board-scan', () => ({
  useBoardScan: () => scan,
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

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#111', secondaryLabel: '#666', tertiaryLabel: '#999' } }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 8: 32 },
  borderRadius: { lg: 12 },
}));

vi.mock('../../Sheet', () => ({
  Sheet: forwardRef(({ children }: ChildrenProps, _ref: Ref<unknown>) => createElement('div', {}, children)),
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

function renderSheet() {
  return render(<BluetoothQuickstartSheet active onClose={vi.fn()} onSelect={vi.fn()} />);
}

describe('BluetoothQuickstartSheet', () => {
  beforeEach(() => {
    scan.status = 'done';
    scan.serials = [];
    scan.advertisedTypes = new Map();
    resolveCalls.length = 0;
    scan.start.mockClear();
    scan.reset.mockReset();
    boards.data = [];
    boards.isLoading = false;
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
    rerender(<BluetoothQuickstartSheet active onClose={vi.fn()} onSelect={vi.fn()} />);

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

    rerender(<BluetoothQuickstartSheet active onClose={vi.fn()} onSelect={vi.fn()} />);

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
    boards.isLoading = false;
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

    render(createElement(BluetoothQuickstartSheet, { active: true, onClose: () => {}, onSelect: () => {} }));

    expect(resolveCalls.at(-1)).toMatchObject({ serialNumbers: ['12345'] });
    expect([...(resolveCalls.at(-1)?.advertisedTypes ?? [])]).toEqual([['12345', 'tension']]);
  });
});
