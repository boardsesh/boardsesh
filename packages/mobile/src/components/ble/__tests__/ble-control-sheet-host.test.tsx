// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

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
  } | null,
}));

vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => mockBluetoothContext.current,
}));

vi.mock('../../../lib/ble/bluetooth-status-store', () => ({
  disconnectAllBluetooth: vi.fn(),
}));

vi.mock('../../../settings', () => ({
  useSetting: () => [false, vi.fn()],
}));

vi.mock('../use-auto-disconnect-timeout-labels', () => ({
  useAutoDisconnectTimeoutLabels: () => ({ 30: '30 seconds' }),
}));

vi.mock('../BleControlSheet', () => ({
  BleControlSheet: (props: {
    showLightAdjacentHolds: boolean;
    onToggleLightAdjacentHolds: (enabled: boolean) => void;
    onClearLights: () => void;
    onReassert: () => void;
  }) => {
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
