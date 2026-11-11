// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const mockSetMoonboardLightAdjacentHolds = vi.fn();
const mockReassertWall = vi.fn();
const mockBluetooth = {
  isConnected: true,
  canDriveWall: false,
  boardName: 'moonboard',
  moonboardLightAdjacentHolds: false,
  setMoonboardLightAdjacentHolds: mockSetMoonboardLightAdjacentHolds,
  reassertWall: mockReassertWall,
  armUndoWallChangeToast: vi.fn(),
  clearBoard: vi.fn(),
  turnOffAllLights: vi.fn((): Promise<boolean> | undefined => undefined),
  releaseVirtualWall: vi.fn(),
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
    showDisconnectWhenDrivingEnds?: boolean;
    onDisconnect?: () => void;
    linked?: boolean;
    onDrive?: () => void;
    status?: unknown;
    keepLighting?: {
      label: string;
      choice: string;
      options: readonly { key: string; label: string }[];
      onChange: (choice: string) => void;
    };
    onToggleDisconnectWhenDrivingEnds: (enabled: boolean) => void;
    onToggleAlwaysDrive: (enabled: boolean) => void;
    alwaysDrive: boolean;
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
  getSetting: (key: string) => (key in mockSettings.values ? mockSettings.values[key] : false),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
const announceQueued = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/announce-queued', () => ({ announceQueued }));
vi.mock('../../../lib/analytics-wall-control', () => ({
  trackDriveModeEnded: vi.fn(),
  trackDriveModeStarted: vi.fn(),
}));
vi.mock('../../../providers/queue-provider', () => ({ useIsSharedSession: () => false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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
import {
  enterDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  markDriveLive,
  resetDriveModeForTests,
  subscribeDriveEnded,
  type DriveEnded,
} from '../../play-drawer/drive-mode-store';
import { isDrivingWall } from '../../play-drawer/use-climb-change-lights';

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
  ] as const)('%s leads with Stop driving after', (_host, showLightingSwitches) => {
    mockBluetooth.boardName = 'kilter';
    mockSettings.values = { putOnBoardKeepsLighting: '30' };
    render(<BleControlSheetHost visible onClose={vi.fn()} showLightingSwitches={showLightingSwitches} />);
    const row = mockBleControlSheet.props?.keepLighting;
    expect(row).toMatchObject({ label: 'settings:ble.lighting.keep.label', choice: '30' });
    expect(row?.options.map((option) => option.key)).toEqual(['off', '30', '45', '60', '120', '300', 'until_stopped']);
    expect(row?.options.map((option) => option.label)).toEqual([
      'settings:ble.lighting.keep.off',
      'settings:ble.lighting.keep.options.30',
      'settings:ble.lighting.keep.options.45',
      'settings:ble.lighting.keep.options.60',
      'settings:ble.lighting.keep.options.120',
      'settings:ble.lighting.keep.options.300',
      'settings:ble.lighting.keep.untilStopped',
    ]);
    row?.onChange('off');
    expect(settingsAnalytics.trackSettingChanged).toHaveBeenCalledExactlyOnceWith(
      'boardControls',
      'putOnBoardKeepsLighting',
      'off',
    );
    expect(mockSettings.setters.putOnBoardKeepsLighting).toHaveBeenCalledWith('off');
  });

  // One Stop driving after for every board (2026-11): a connected MoonBoard's
  // sheet shows and writes the same choice, whatever the retired MoonBoard one says.
  it('takes the one Stop driving after choice on a connected MoonBoard', () => {
    mockSettings.values = { putOnBoardKeepsLighting: '30', moonboardPutOnBoardKeepsLighting: '60' };
    render(<BleControlSheetHost visible onClose={vi.fn()} />);
    const row = mockBleControlSheet.props?.keepLighting;
    expect(row).toMatchObject({ label: 'settings:ble.lighting.keep.label', choice: '30' });
    row?.onChange('until_stopped');
    expect(settingsAnalytics.trackSettingChanged).toHaveBeenCalledExactlyOnceWith(
      'boardControls',
      'putOnBoardKeepsLighting',
      'until_stopped',
    );
    expect(mockSettings.setters.putOnBoardKeepsLighting).toHaveBeenCalledWith('until_stopped');
    expect(mockSettings.setters.moonboardPutOnBoardKeepsLighting).toBeUndefined();
  });

  // Always drive the wall drives with no end: no timer applies, so no row.
  it('leaves Stop driving after out while Always drive the wall is on', () => {
    mockBluetooth.boardName = 'kilter';
    mockSettings.values = { alwaysDrive: true, putOnBoardKeepsLighting: '30' };
    render(<BleControlSheetHost visible onClose={vi.fn()} />);
    expect(mockBleControlSheet.props?.keepLighting).toBeUndefined();
    expect(mockBleControlSheet.props?.alwaysDrive).toBe(true);
  });

  it('reads an unknown stored choice as the default: 45 s, on a MoonBoard too', () => {
    render(<BleControlSheetHost visible onClose={vi.fn()} />);
    expect(mockBleControlSheet.props?.keepLighting?.choice).toBe('45');
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

  // #7000: only the player's sheet drops Disconnect Bluetooth when driving
  // ends and Always drive the wall; the app-wide sheet keeps them whatever the QA switch says.
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
    // A toggle, not a press: it never carries to the next connect's link, so a
    // bulb connect right after it keeps the #4979 hold.
    expect(mockReassertWall).toHaveBeenCalledWith();
    expect(mockSetMoonboardLightAdjacentHolds.mock.invocationCallOrder[0]).toBeLessThan(
      mockReassertWall.mock.invocationCallOrder[0],
    );
  });

  // 2.7: the lightbulb's sheet is the quickest place to turn Light
  // automatically on, so its switches report like the Board page's rows.
  it.each([
    ['onToggleAlwaysDrive', 'alwaysDrive'],
    ['onToggleDisconnectWhenDrivingEnds', 'disconnectWhenDrivingEnds'],
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

  // 2.7: a dark wall is the climber stopping. A drive left running behind a
  // button that reads Put on board would light the next pick.
  it.each([
    ['a timed drive', 45_000],
    ['an open-ended drive', null],
  ] as const)('Turn off all lights ends %s and says so', (_drive, windowMs) => {
    resetDriveModeForTests();
    mockBluetooth.boardName = 'kilter';
    enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: null, windowMs, windowSetting: null });
    markDriveLive();
    expect(isDrivingWall()).toBe(true);
    render(<BleControlSheetHost visible onClose={vi.fn()} />);

    mockBleControlSheet.props?.onClearLights();

    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingWall()).toBe(false);
    expect(announceQueued).toHaveBeenCalledExactlyOnceWith('session:playView.wallControl.stoppedDriving');
    expect(mockBluetooth.turnOffAllLights).toHaveBeenCalledTimes(1);
  });

  // Disconnect Bluetooth when driving ends lets go on this `stopped` end, but
  // only once the lights-off write has gone: never mid-write.
  it('hands on a stopped end that waits for the lights-off write', async () => {
    resetDriveModeForTests();
    mockBluetooth.boardName = 'kilter';
    let finishWrite: (ok: boolean) => void = () => {};
    mockBluetooth.turnOffAllLights.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const ends: DriveEnded[] = [];
    const unsubscribe = subscribeDriveEnded((ended) => ends.push(ended));
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
    markDriveLive();
    render(<BleControlSheetHost visible onClose={vi.fn()} />);

    mockBleControlSheet.props?.onClearLights();

    expect(ends).toHaveLength(1);
    expect(ends[0]?.reason).toBe('stopped');
    let waited = false;
    void ends[0]?.disconnectAfter?.().then(() => {
      waited = true;
    });
    await Promise.resolve();
    expect(waited).toBe(false);
    finishWrite(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(waited).toBe(true);
    unsubscribe();
  });

  it('Turn off all lights with nothing driving leaves the lighting settings alone', () => {
    resetDriveModeForTests();
    mockSettings.values = { alwaysDrive: true };
    render(<BleControlSheetHost visible onClose={vi.fn()} />);

    mockBleControlSheet.props?.onClearLights();

    expect(announceQueued).not.toHaveBeenCalled();
    expect(mockSettings.setters.alwaysDrive).not.toHaveBeenCalled();
    expect(mockBluetooth.turnOffAllLights).toHaveBeenCalledTimes(1);
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

  it('keeps LAN controls open, hides the Bluetooth timer and releases its virtual hold', () => {
    mockBluetoothContext.current = { ...mockBluetooth, boardName: 'spray', isConnected: false, canDriveWall: true };
    const onClose = vi.fn();
    render(<BleControlSheetHost visible onClose={onClose} />);
    expect(onClose).not.toHaveBeenCalled();
    expect(mockBleControlSheet.props?.linked).toBe(true);
    expect(mockBleControlSheet.props?.showDisconnectWhenDrivingEnds).toBe(false);
    mockBleControlSheet.props?.onDisconnect?.();
    expect(mockBluetooth.releaseVirtualWall).toHaveBeenCalledOnce();
  });

  it('marks a LAN wall dark only after a successful physical clear', async () => {
    resetWallCleared();
    mockBluetoothContext.current = { ...mockBluetooth, boardName: 'spray', isConnected: false, canDriveWall: true };
    mockBluetooth.turnOffAllLights.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<BleControlSheetHost visible onClose={vi.fn()} clearedClimbUuid="lan-route" />);
    const cleared = renderHook(() => useWallClearedClimbUuid());
    await act(async () => mockBleControlSheet.props?.onClearLights());
    expect(cleared.result.current).toBeNull();
    await act(async () => mockBleControlSheet.props?.onClearLights());
    expect(cleared.result.current).toBe('lan-route');
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
