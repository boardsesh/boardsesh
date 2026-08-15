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
};
const mockBluetoothContext = vi.hoisted(() => ({
  current: null as typeof mockBluetooth | null,
}));
const mockBleControlSheet = vi.hoisted(() => ({
  props: null as {
    showLightAdjacentHolds: boolean;
    onToggleLightAdjacentHolds: (enabled: boolean) => void;
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

describe('BleControlSheetHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBluetooth.boardName = 'moonboard';
    mockBluetoothContext.current = mockBluetooth;
    mockBleControlSheet.props = null;
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

  it('renders no sheet without a Bluetooth context', () => {
    mockBluetoothContext.current = null;
    const onClose = vi.fn();

    const { container } = render(<BleControlSheetHost visible onClose={onClose} />);

    expect(container.firstChild).toBeNull();
    expect(mockBleControlSheet.props).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
