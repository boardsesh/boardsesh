// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const mockSetMoonboardLightAdjacentHolds = vi.fn();
const mockReassertWall = vi.fn();
const mockBluetooth = {
  isConnected: true,
  boardName: 'moonboard',
  autoDisconnectTimeoutSeconds: 30,
  moonboardLightAdjacentHolds: false,
  setMoonboardLightAdjacentHolds: mockSetMoonboardLightAdjacentHolds,
  reassertWall: mockReassertWall,
  armUndoWallChangeToast: vi.fn(),
  clearBoard: vi.fn(),
  turnOffAllLights: vi.fn(),
};
const mockBluetoothContext = vi.hoisted(() => ({
  current: null as typeof mockBluetooth | null,
}));
const mockBleControlSheet = vi.hoisted(() => ({
  props: null as {
    showLightAdjacentHolds: boolean;
    onToggleLightAdjacentHolds: (enabled: boolean) => void;
    onClearLights: () => void;
    onReassert: () => void;
    showLightingSwitches?: boolean;
    linked?: boolean;
    onDrive?: () => void;
    status?: unknown;
    keepLighting?: {
      label: string;
      choice: string;
      options: readonly { key: string; label: string }[];
      onChange: (choice: string) => void;
    };
    onToggleAutoDisconnect: (enabled: boolean) => void;
    onToggleLightOnSwipe: (enabled: boolean) => void;
    onToggleLightOnClimbTap: (enabled: boolean) => void;
  } | null,
}));
const settingsAnalytics = vi.hoisted(() => ({ trackSettingChanged: vi.fn() }));
vi.mock('../../../lib/settings-analytics', () => settingsAnalytics);

vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => mockBluetoothContext.current,
}));

vi.mock('../../../lib/ble/bluetooth-status-store', () => ({
  disconnectAllBluetooth: vi.fn(),
}));

const mockSettings = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock('../../../settings', () => ({
  useSetting: (key: string) => {
    mockSettings.setters[key] ??= vi.fn();
    return [key in mockSettings.values ? mockSettings.values[key] : false, mockSettings.setters[key]];
  },
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../use-auto-disconnect-timeout-labels', () => ({
  useAutoDisconnectTimeoutLabels: () => ({ 30: '30 seconds' }),
}));

vi.mock('../BleControlSheet', () => ({
  BleControlSheet: (props: NonNullable<typeof mockBleControlSheet.props>) => {
    mockBleControlSheet.props = props;
    return createElement(
      'button',
      { type: 'button', onClick: () => props.onToggleLightAdjacentHolds(true) },
      'toggle adjacent holds',
    );
  },
}));

import { BleControlSheetHost } from '../BleControlSheetHost';
import { QueueActiveClimbContext } from '../../../providers/queue/queue-contexts';
import { resetWallCleared, useWallClearedClimbUuid } from '../wall-cleared-store';
import { renderHook } from '@testing-library/react';

describe('BleControlSheetHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBluetooth.boardName = 'moonboard';
    mockBluetoothContext.current = mockBluetooth;
    mockBleControlSheet.props = null;
    mockSettings.values = {};
    mockSettings.setters = {};
  });

  // 2.7, spec B4: the timer at the wall in two taps, on both sheets.
  it.each([
    ['the app-wide sheet', undefined],
    ['the player’s sheet', false],
  ] as const)('%s leads with Keep lighting after Put on board', (_host, showLightingSwitches) => {
    mockBluetooth.boardName = 'kilter';
    mockSettings.values = { putOnBoardKeepsLighting: '30', moonboardPutOnBoardKeepsLighting: 'off' };
    render(<BleControlSheetHost visible onClose={vi.fn()} showLightingSwitches={showLightingSwitches} />);
    const row = mockBleControlSheet.props?.keepLighting;
    expect(row).toMatchObject({ label: 'settings:ble.lighting.keep.label', choice: '30' });
    expect(row?.options.map((option) => option.key)).toEqual(['off', '30', '45', '60', 'until_stopped']);
    expect(row?.options.map((option) => option.label)).toEqual([
      'settings:ble.lighting.keep.off',
      'settings:ble.autoDisconnect.timeoutOptions.30',
      'settings:ble.autoDisconnect.timeoutOptions.45',
      'settings:ble.autoDisconnect.timeoutOptions.60',
      'settings:ble.lighting.keep.untilStopped',
    ]);
    row?.onChange('off');
    expect(settingsAnalytics.trackSettingChanged).toHaveBeenCalledExactlyOnceWith(
      'boardControls',
      'putOnBoardKeepsLighting',
      'off',
    );
    expect(mockSettings.setters.putOnBoardKeepsLighting).toHaveBeenCalledWith('off');
    expect(mockSettings.setters.moonboardPutOnBoardKeepsLighting).not.toHaveBeenCalled();
  });

  it('takes the MoonBoard’s own choice on a connected MoonBoard', () => {
    mockSettings.values = { putOnBoardKeepsLighting: '30', moonboardPutOnBoardKeepsLighting: '60' };
    render(<BleControlSheetHost visible onClose={vi.fn()} />);
    const row = mockBleControlSheet.props?.keepLighting;
    expect(row).toMatchObject({ label: 'settings:ble.lighting.keep.sheetMoonboardLabel', choice: '60' });
    row?.onChange('until_stopped');
    expect(settingsAnalytics.trackSettingChanged).toHaveBeenCalledExactlyOnceWith(
      'boardControls',
      'moonboardPutOnBoardKeepsLighting',
      'until_stopped',
    );
    expect(mockSettings.setters.moonboardPutOnBoardKeepsLighting).toHaveBeenCalledWith('until_stopped');
    expect(mockSettings.setters.putOnBoardKeepsLighting).not.toHaveBeenCalled();
  });

  it('reads an unknown stored choice as the default: 45 s, Until I stop on a MoonBoard', () => {
    render(<BleControlSheetHost visible onClose={vi.fn()} />);
    expect(mockBleControlSheet.props?.keepLighting?.choice).toBe('until_stopped');
    cleanup();
    mockBluetooth.boardName = 'kilter';
    render(<BleControlSheetHost visible onClose={vi.fn()} />);
    expect(mockBleControlSheet.props?.keepLighting?.choice).toBe('45');
  });

  it('passes the player’s status line through', () => {
    const status = createElement('span', null, 'On the wall');
    render(<BleControlSheetHost visible onClose={vi.fn()} status={status} />);
    expect(mockBleControlSheet.props?.status).toBe(status);
  });

  // #7000: only the player's sheet drops auto-disconnect and the two
  // lighting switches; the app-wide sheet keeps them whatever the QA switch says.
  it.each([
    ['the app-wide sheet', undefined, true],
    ['the player’s sheet', false, false],
  ] as const)('%s shows the lighting switches: %s', (_host, showLightingSwitches, shown) => {
    render(<BleControlSheetHost visible onClose={vi.fn()} showLightingSwitches={showLightingSwitches} />);

    expect(mockBleControlSheet.props?.showLightingSwitches).toBe(shown);
    // The MoonBoard-only switch lives nowhere else, so it stays.
    expect(mockBleControlSheet.props?.showLightAdjacentHolds).toBe(true);
  });

  it('re-lights the current climb after changing the MoonBoard adjacent-hold setting', () => {
    const { getByText } = render(<BleControlSheetHost visible onClose={vi.fn()} />);

    fireEvent.click(getByText('toggle adjacent holds'));

    expect(mockSetMoonboardLightAdjacentHolds).toHaveBeenCalledWith(true);
    expect(mockReassertWall).toHaveBeenCalledTimes(1);
    expect(mockSetMoonboardLightAdjacentHolds.mock.invocationCallOrder[0]).toBeLessThan(
      mockReassertWall.mock.invocationCallOrder[0],
    );
  });

  // 2.7: the lightbulb's sheet is the quickest place to turn Light on tap
  // back on, so its switches report like the Board page's rows.
  it.each([
    ['onToggleLightOnClimbTap', 'lightOnClimbTap'],
    ['onToggleLightOnSwipe', 'lightOnSwipe'],
    ['onToggleAutoDisconnect', 'autoDisconnectBle'],
  ] as const)('%s reports Setting Changed and saves the setting', (handler, key) => {
    render(<BleControlSheetHost visible onClose={vi.fn()} />);

    mockBleControlSheet.props?.[handler](true);

    expect(settingsAnalytics.trackSettingChanged).toHaveBeenCalledExactlyOnceWith('boardControls', key, true);
    expect(mockSettings.setters[key]).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('reports the MoonBoard adjacent-hold switch too', () => {
    const { getByText } = render(<BleControlSheetHost visible onClose={vi.fn()} />);

    fireEvent.click(getByText('toggle adjacent holds'));

    expect(settingsAnalytics.trackSettingChanged).toHaveBeenCalledExactlyOnceWith(
      'boardControls',
      'moonboardLightAdjacentHolds',
      true,
    );
  });

  it('shows the adjacent-hold control for MoonBoard', () => {
    render(<BleControlSheetHost visible onClose={vi.fn()} />);

    expect(mockBleControlSheet.props?.showLightAdjacentHolds).toBe(true);
  });

  it('hides the adjacent-hold control for a non-MoonBoard board', () => {
    mockBluetooth.boardName = 'kilter';

    render(<BleControlSheetHost visible onClose={vi.fn()} />);

    expect(mockBleControlSheet.props?.showLightAdjacentHolds).toBe(false);
  });

  // #6939: the player's wall status line learns the wall went dark from here.
  it('remembers which climb Turn off all lights darkened, and Re-light forgets it', () => {
    resetWallCleared();
    render(
      createElement(
        QueueActiveClimbContext.Provider,
        { value: { activeClimbUuid: 'climb-on-the-wall' } },
        createElement(BleControlSheetHost, { visible: true, onClose: vi.fn() }),
      ),
    );
    const cleared = renderHook(() => useWallClearedClimbUuid());

    mockBleControlSheet.props?.onClearLights();
    cleared.rerender();
    // #7015: through the path that also tells every other viewer.
    expect(mockBluetooth.turnOffAllLights).toHaveBeenCalledTimes(1);
    expect(mockBluetooth.clearBoard).not.toHaveBeenCalled();
    expect(cleared.result.current).toBe('climb-on-the-wall');

    mockBleControlSheet.props?.onReassert();
    cleared.rerender();
    expect(cleared.result.current).toBeNull();
    expect(mockReassertWall).toHaveBeenCalledTimes(1);
  });

  // #7000: the player passes the climb it shows, so Turn off all lights from a
  // lit preview marks that climb dark rather than the queue's head.
  it('marks the climb the player names, not the queue head', () => {
    resetWallCleared();
    render(
      createElement(
        QueueActiveClimbContext.Provider,
        { value: { activeClimbUuid: 'queue-head' } },
        createElement(BleControlSheetHost, { visible: true, onClose: vi.fn(), clearedClimbUuid: 'lit-preview' }),
      ),
    );
    const cleared = renderHook(() => useWallClearedClimbUuid());

    mockBleControlSheet.props?.onClearLights();
    cleared.rerender();
    expect(cleared.result.current).toBe('lit-preview');
  });

  it('renders no sheet without a Bluetooth context', () => {
    mockBluetoothContext.current = null;
    const onClose = vi.fn();

    const { container } = render(<BleControlSheetHost visible onClose={onClose} />);

    expect(container.firstChild).toBeNull();
    expect(mockBleControlSheet.props).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  // #7113: a sheet offering Light every climb opens with no link, showing that row.
  it('stays open with no link while it offers Light every climb, and closes without it', () => {
    mockBluetoothContext.current = { ...mockBluetooth, isConnected: false };
    const onDrive = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<BleControlSheetHost visible onClose={onClose} onDrive={onDrive} />);
    expect(onClose).not.toHaveBeenCalled();
    expect(mockBleControlSheet.props).toMatchObject({ linked: false, onDrive });
    rerender(<BleControlSheetHost visible onClose={onClose} />);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
