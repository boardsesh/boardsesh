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

vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => mockBluetooth,
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
  BleControlSheet: ({ onToggleLightAdjacentHolds }: { onToggleLightAdjacentHolds: (enabled: boolean) => void }) =>
    createElement(
      'button',
      { type: 'button', onClick: () => onToggleLightAdjacentHolds(true) },
      'toggle adjacent holds',
    ),
}));

import { BleControlSheetHost } from '../BleControlSheetHost';

describe('BleControlSheetHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
