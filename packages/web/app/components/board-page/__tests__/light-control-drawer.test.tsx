import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import type { BoardDetails } from '@/app/lib/types';

// Mocks must be hoisted; declare the function refs first so mock factories can capture them.
const sendFramesToBoardMock = vi.fn(async () => true as boolean | undefined);
const clearBoardMock = vi.fn(async () => true as boolean | undefined);
const setPartyActiveMock = vi.fn();
const showMessageMock = vi.fn();

let mockIsConnected = true;
let mockPartyActive = false;
let mockBoardName: BoardDetails['board_name'] = 'kilter';

function makeBoardDetails(): BoardDetails {
  return {
    board_name: mockBoardName,
    layout_id: 1,
    size_id: 10,
    set_ids: [1],
    image_filename: 'kilter.png',
    layout_name: 'Kilter Original',
    holdsData: {},
    edge_left: 0,
    edge_right: 144,
    edge_bottom: 0,
    edge_top: 156,
    boardWidth: 144,
    boardHeight: 156,
    supportsMirroring: false,
  } as unknown as BoardDetails;
}

vi.mock('@/app/components/board-bluetooth-control/bluetooth-context', () => ({
  useBluetoothContext: () => ({
    isConnected: mockIsConnected,
    sendFramesToBoard: sendFramesToBoardMock,
    clearBoard: clearBoardMock,
    boardDetails: makeBoardDetails(),
    partyActive: mockPartyActive,
    setPartyActive: setPartyActiveMock,
  }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: showMessageMock }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

vi.mock('@/app/components/swipeable-drawer/swipeable-drawer', () => ({
  default: ({ open, children, title }: { open: boolean; children: React.ReactNode; title: React.ReactNode }) =>
    open ? (
      <div data-testid="drawer">
        <div data-testid="drawer-title">{title}</div>
        {children}
      </div>
    ) : null,
}));

import { LightControlDrawer } from '../light-control-drawer';

describe('LightControlDrawer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendFramesToBoardMock.mockClear();
    sendFramesToBoardMock.mockResolvedValue(true);
    clearBoardMock.mockClear();
    clearBoardMock.mockResolvedValue(true);
    setPartyActiveMock.mockClear();
    showMessageMock.mockClear();
    mockIsConnected = true;
    mockPartyActive = false;
    mockBoardName = 'kilter';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('party loop lifecycle', () => {
    it('sends a frame immediately when party becomes active and ticks on the interval', () => {
      mockPartyActive = false;
      const { rerender } = render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      expect(sendFramesToBoardMock).not.toHaveBeenCalled();

      // Flip partyActive on
      mockPartyActive = true;
      act(() => {
        rerender(<LightControlDrawer open={true} onClose={vi.fn()} />);
      });

      // First letter sent immediately
      expect(sendFramesToBoardMock).toHaveBeenCalledTimes(1);

      // Each subsequent tick (600ms) sends the next letter
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(sendFramesToBoardMock).toHaveBeenCalledTimes(2);

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(sendFramesToBoardMock).toHaveBeenCalledTimes(4);
    });

    it('does not start the interval when the board is disconnected', () => {
      mockIsConnected = false;
      mockPartyActive = true;

      render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(sendFramesToBoardMock).not.toHaveBeenCalled();
    });

    it('does not start the interval on moonboard', () => {
      mockBoardName = 'moonboard';
      mockPartyActive = true;

      render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(sendFramesToBoardMock).not.toHaveBeenCalled();
    });

    it('clears the board exactly once when partyActive flips from true to false', async () => {
      mockPartyActive = true;
      const { rerender } = render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      // Drain the immediate send so we're past startup.
      expect(sendFramesToBoardMock).toHaveBeenCalledTimes(1);

      // Flip party off
      mockPartyActive = false;
      act(() => {
        rerender(<LightControlDrawer open={true} onClose={vi.fn()} />);
      });

      // Allow the microtask from `void clearBoard()` to settle.
      await act(async () => {
        await Promise.resolve();
      });

      expect(clearBoardMock).toHaveBeenCalledTimes(1);

      // No interval ticks after the stop.
      sendFramesToBoardMock.mockClear();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(sendFramesToBoardMock).not.toHaveBeenCalled();
    });

    it('does not call clearBoard on the very first render when partyActive starts false', () => {
      mockPartyActive = false;
      render(<LightControlDrawer open={true} onClose={vi.fn()} />);
      expect(clearBoardMock).not.toHaveBeenCalled();
    });

    it('stops the interval on unmount', () => {
      mockPartyActive = true;
      const { unmount } = render(<LightControlDrawer open={true} onClose={vi.fn()} />);
      expect(sendFramesToBoardMock).toHaveBeenCalledTimes(1);

      unmount();
      sendFramesToBoardMock.mockClear();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(sendFramesToBoardMock).not.toHaveBeenCalled();
    });
  });

  describe('handleClearAll', () => {
    it('flips partyActive off without calling clearBoard directly when party is running', () => {
      mockPartyActive = true;
      render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      // Drain the immediate party send
      sendFramesToBoardMock.mockClear();
      clearBoardMock.mockClear();

      fireEvent.click(screen.getByText('lightControl.turnOffAll'));

      expect(setPartyActiveMock).toHaveBeenCalledWith(false);
      expect(clearBoardMock).not.toHaveBeenCalled();
    });

    it('calls clearBoard and shows no message on success', async () => {
      mockPartyActive = false;
      render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      await act(async () => {
        fireEvent.click(screen.getByText('lightControl.turnOffAll'));
        await Promise.resolve();
      });

      expect(clearBoardMock).toHaveBeenCalledTimes(1);
      expect(showMessageMock).not.toHaveBeenCalled();
    });

    it('shows the failure snackbar when clearBoard returns false', async () => {
      mockPartyActive = false;
      clearBoardMock.mockResolvedValueOnce(false);

      render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      await act(async () => {
        fireEvent.click(screen.getByText('lightControl.turnOffAll'));
        await Promise.resolve();
      });

      expect(showMessageMock).toHaveBeenCalledWith('lightControl.clearFailed', 'error');
    });

    it('shows the failure snackbar when clearBoard returns undefined (early-bail)', async () => {
      // sendFramesToBoard returns `undefined` (not `false`) when the BLE
      // adapter or boardDetails is missing — handleClearAll must treat that
      // as a failure too, otherwise the user gets no feedback.
      mockPartyActive = false;
      clearBoardMock.mockResolvedValueOnce(undefined);

      render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      await act(async () => {
        fireEvent.click(screen.getByText('lightControl.turnOffAll'));
        await Promise.resolve();
      });

      expect(showMessageMock).toHaveBeenCalledWith('lightControl.clearFailed', 'error');
    });

    it('catches thrown BLE errors and shows the failure snackbar', async () => {
      mockPartyActive = false;
      clearBoardMock.mockRejectedValueOnce(new Error('GATT disconnect'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      await act(async () => {
        fireEvent.click(screen.getByText('lightControl.turnOffAll'));
        await Promise.resolve();
      });

      expect(showMessageMock).toHaveBeenCalledWith('lightControl.clearFailed', 'error');
      consoleSpy.mockRestore();
    });
  });

  describe('handlePartyToggle', () => {
    it('toggles partyActive on a supported board', () => {
      mockPartyActive = false;
      render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('lightControl.partyMode'));

      expect(setPartyActiveMock).toHaveBeenCalledWith(true);
    });

    it('shows the unsupported hint and does not toggle on moonboard', () => {
      mockBoardName = 'moonboard';
      mockPartyActive = false;
      render(<LightControlDrawer open={true} onClose={vi.fn()} />);

      // The party row is rendered but disabled on moonboard. The drawer
      // surfaces the unsupported state via secondary text.
      const button = screen.getByText('lightControl.partyMode').closest('[role="button"]');
      expect(button?.getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByText('lightControl.partyUnsupported')).toBeTruthy();
      expect(setPartyActiveMock).not.toHaveBeenCalled();
    });
  });
});
