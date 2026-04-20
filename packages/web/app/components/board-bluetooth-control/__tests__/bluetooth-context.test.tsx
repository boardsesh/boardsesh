import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

// Mock dependencies before importing the module
const mockTrack = vi.fn();
vi.mock('@vercel/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

const mockSendFramesToBoard = vi.fn().mockResolvedValue(true);
const mockConnect = vi.fn().mockResolvedValue(true);
const mockDisconnect = vi.fn();

let mockBluetoothState = {
  isConnected: false,
  loading: false,
  connect: mockConnect,
  disconnect: mockDisconnect,
  sendFramesToBoard: mockSendFramesToBoard,
};

vi.mock('../use-board-bluetooth', () => ({
  useBoardBluetooth: () => mockBluetoothState,
}));

type TestBoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: number[];
  angle: number;
};
type TestQueueItem = {
  uuid?: string;
  boardConfig?: TestBoardConfig | null;
  climb: {
    uuid: string;
    frames: string;
    mirrored: boolean;
    boardType?: string;
    layoutId?: number | null;
  };
};
let mockCurrentClimbQueueItem: TestQueueItem | null = null;

vi.mock('../../graphql-queue', () => ({
  useQueueContext: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
  }),
  useQueueData: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
  }),
  useCurrentClimb: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
    currentClimb: mockCurrentClimbQueueItem?.climb ?? null,
  }),
}));

const mockShowMessage = vi.fn();
vi.mock('../../providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

import { BluetoothProvider, useBluetoothContext } from '../bluetooth-context';
import type { BoardDetails } from '@/app/lib/types';

function createTestBoardDetails(overrides?: Partial<BoardDetails>): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: '1,2',
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Full Size',
    set_names: ['Standard', 'Extended'],
    ...overrides,
  } as BoardDetails;
}

function createWrapper(boardDetails?: BoardDetails) {
  const details = boardDetails ?? createTestBoardDetails();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(BluetoothProvider, { boardDetails: details, children });
  };
}

describe('BluetoothProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShowMessage.mockClear();
    mockCurrentClimbQueueItem = null;
    mockBluetoothState = {
      isConnected: false,
      loading: false,
      connect: mockConnect,
      disconnect: mockDisconnect,
      sendFramesToBoard: mockSendFramesToBoard,
    };
  });

  describe('useBluetoothContext', () => {
    it('throws when used outside BluetoothProvider', () => {
      // Suppress React error boundary console output
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => {
        renderHook(() => useBluetoothContext());
      }).toThrow('useBluetoothContext must be used within a BluetoothProvider');
      consoleSpy.mockRestore();
    });

    it('returns context values when used inside BluetoothProvider', () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(result.current).toHaveProperty('isConnected');
      expect(result.current).toHaveProperty('loading');
      expect(result.current).toHaveProperty('connect');
      expect(result.current).toHaveProperty('disconnect');
      expect(result.current).toHaveProperty('sendFramesToBoard');
      expect(result.current).toHaveProperty('isBluetoothSupported');
      expect(result.current).toHaveProperty('isIOS');
    });

    it('provides correct initial connection state', () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.loading).toBe(false);
    });
  });

  describe('auto-send on climb change', () => {
    it('does not send when not connected', () => {
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12p2r13', mirrored: false },
      };
      mockBluetoothState.isConnected = false;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(mockSendFramesToBoard).not.toHaveBeenCalled();
    });

    it('does not send when connected but no current climb', () => {
      mockCurrentClimbQueueItem = null;
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(mockSendFramesToBoard).not.toHaveBeenCalled();
    });

    it('sends frames when connected and climb is available', async () => {
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12p2r13', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      // The useEffect triggers async sendClimb
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledWith('p1r12p2r13', false, expect.any(AbortSignal));
        });
      });
    });

    it('sends with mirrored=true when climb is mirrored', async () => {
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-2', frames: 'p3r14p4r15', mirrored: true },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledWith('p3r14p4r15', true, expect.any(AbortSignal));
        });
      });
    });

    it('tracks success analytics when send succeeds', async () => {
      mockSendFramesToBoard.mockResolvedValue(true);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Success', {
            climbUuid: 'climb-1',
            boardLayout: 'Original',
          });
        });
      });
    });

    it('tracks failure analytics when send fails', async () => {
      mockSendFramesToBoard.mockResolvedValue(false);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Failure', {
            climbUuid: 'climb-1',
            boardLayout: 'Original',
          });
        });
      });
    });

    it('does not track analytics when send returns undefined (not attempted)', async () => {
      mockSendFramesToBoard.mockResolvedValue(undefined);
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalled();
        });
      });

      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('catches exception and tracks failure when sendFramesToBoard throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockSendFramesToBoard.mockRejectedValue(new Error('Bluetooth write failed'));
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Failure', {
            climbUuid: 'climb-1',
            boardLayout: 'Original',
          });
        });
      });

      expect(consoleSpy).toHaveBeenCalledWith('Error sending climb to board:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  describe('rapid-swiping cancellation', () => {
    it('passes AbortSignal to sendFramesToBoard and aborts on unmount', async () => {
      // Simulate a slow send that doesn't resolve
      let resolveFirstSend: (value: boolean) => void;
      mockSendFramesToBoard.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstSend = resolve;
          }),
      );
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      const { unmount } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      // Wait for the first send to start
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
        });
      });

      // Verify an AbortSignal was passed as the third argument
      const signal = mockSendFramesToBoard.mock.calls[0][2] as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);

      // Unmount triggers effect cleanup which aborts the controller
      unmount();
      expect(signal.aborted).toBe(true);

      // Resolve the send — since signal is aborted, analytics should not be tracked
      resolveFirstSend!(true);
      // Give microtasks a chance to flush
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it('does not track analytics when send throws after abort', async () => {
      // When signal is already aborted, the send throws AbortError
      // The catch block should check signal.aborted and skip analytics
      mockSendFramesToBoard.mockImplementation((_frames: string, _mirrored: boolean, signal?: AbortSignal) => {
        if (signal?.aborted) {
          return Promise.reject(new DOMException('Write aborted', 'AbortError'));
        }
        return Promise.resolve(true);
      });
      mockCurrentClimbQueueItem = {
        climb: { uuid: 'climb-1', frames: 'p1r12', mirrored: false },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
        });
      });

      // The signal was NOT aborted, so analytics should track success
      await act(async () => {
        await vi.waitFor(() => {
          expect(mockTrack).toHaveBeenCalledWith('Climb Sent to Board Success', {
            climbUuid: 'climb-1',
            boardLayout: 'Original',
          });
        });
      });
    });
  });

  describe('disconnect', () => {
    it('exposes disconnect from the hook', () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      result.current.disconnect();

      expect(mockDisconnect).toHaveBeenCalledOnce();
    });
  });

  describe('connect', () => {
    it('exposes connect from the hook', async () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        const success = await result.current.connect('p1r12', false);
        expect(success).toBe(true);
      });

      expect(mockConnect).toHaveBeenCalledWith('p1r12', false);
    });

    it('returns false when connect fails', async () => {
      mockConnect.mockResolvedValue(false);

      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        const success = await result.current.connect();
        expect(success).toBe(false);
      });
    });
  });

  describe('context value stability', () => {
    it('exposes connect and disconnect functions from the hook', () => {
      const { result } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(),
      });

      expect(result.current.connect).toBe(mockConnect);
      expect(result.current.disconnect).toBe(mockDisconnect);
      expect(result.current.sendFramesToBoard).toBe(mockSendFramesToBoard);
    });
  });

  // --------------------------------------------------------------------
  // BluetoothAutoSender — multi-board send gate
  //
  // The sender must skip `sendFramesToBoard` (and surface a one-shot
  // snackbar) when the current queue item either:
  //   (a) carries a boardConfig that doesn't match the connected board, or
  //   (b) references hold IDs that aren't on the connected board.
  // It must also avoid re-firing the snackbar on re-renders of the same
  // item — only once per item.uuid change.
  // --------------------------------------------------------------------
  describe('multi-board send gate', () => {
    // BoardDetails with a known hold set so canAddClimbToBoard runs the
    // per-hold containment check (returning holds_out_of_range when a
    // frame references an ID not in the set).
    const boardWithHolds: BoardDetails = {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 10,
      set_ids: '1,2',
      images_to_holds: {},
      holdsData: [
        // Minimum useful fields — canAddClimbToBoard only reads .id
        { id: 12 },
        { id: 13 },
      ] as unknown as BoardDetails['holdsData'],
      edge_left: 0,
      edge_right: 100,
      edge_bottom: 0,
      edge_top: 100,
      boardHeight: 100,
      boardWidth: 100,
      layout_name: 'Original',
      size_name: '12x12',
      size_description: 'Full Size',
      set_names: ['Standard', 'Extended'],
    } as unknown as BoardDetails;

    it('sends frames when the current climb matches the connected board', async () => {
      mockCurrentClimbQueueItem = {
        uuid: 'qi-1',
        boardConfig: {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: [1, 2],
          angle: 40,
        },
        climb: {
          uuid: 'c-1',
          frames: 'p12r12p13r13', // all hold IDs present on boardWithHolds
          mirrored: false,
          boardType: 'kilter',
          layoutId: 1,
        },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(boardWithHolds),
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
        });
      });
      expect(mockShowMessage).not.toHaveBeenCalled();
    });

    it('does NOT send and emits a snackbar when current climb boardConfig is on a different board', async () => {
      mockCurrentClimbQueueItem = {
        uuid: 'qi-mismatch',
        boardConfig: {
          boardName: 'tension', // mismatch with boardWithHolds.board_name = 'kilter'
          layoutId: 2,
          sizeId: 10,
          setIds: [1, 2],
          angle: 40,
        },
        climb: {
          uuid: 'c-2',
          frames: 'p12r12',
          mirrored: false,
          boardType: 'tension',
          layoutId: 2,
        },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(boardWithHolds),
      });

      // Give the effect a chance to run
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(mockSendFramesToBoard).not.toHaveBeenCalled();
      expect(mockShowMessage).toHaveBeenCalledTimes(1);
      expect(mockShowMessage).toHaveBeenCalledWith(
        'Not sent — this climb is on another board.',
        'info',
      );
    });

    it('does NOT send and emits a snackbar when a climb\'s hold is out of range for the connected board', async () => {
      mockCurrentClimbQueueItem = {
        uuid: 'qi-oor',
        // boardConfig matches — trigger hits the holds-out-of-range branch.
        boardConfig: {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: [1, 2],
          angle: 40,
        },
        climb: {
          uuid: 'c-3',
          // Hold ID 999 is NOT in boardWithHolds (only 12, 13)
          frames: 'p12r12p999r15',
          mirrored: false,
          boardType: 'kilter',
          layoutId: 1,
        },
      };
      mockBluetoothState.isConnected = true;

      renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(boardWithHolds),
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(mockSendFramesToBoard).not.toHaveBeenCalled();
      expect(mockShowMessage).toHaveBeenCalledTimes(1);
      const [msg, severity] = mockShowMessage.mock.calls[0];
      expect(msg).toMatch(/Not sent/);
      expect(msg).toMatch(/holds/);
      expect(severity).toBe('info');
    });

    it('does not re-emit the snackbar on re-renders of the same queue item', async () => {
      mockCurrentClimbQueueItem = {
        uuid: 'qi-dup',
        boardConfig: {
          boardName: 'tension', // mismatch
          layoutId: 2,
          sizeId: 10,
          setIds: [1, 2],
          angle: 40,
        },
        climb: {
          uuid: 'c-dup',
          frames: 'p12r12',
          mirrored: false,
          boardType: 'tension',
          layoutId: 2,
        },
      };
      mockBluetoothState.isConnected = true;

      const { rerender } = renderHook(() => useBluetoothContext(), {
        wrapper: createWrapper(boardWithHolds),
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(mockShowMessage).toHaveBeenCalledTimes(1);

      // Force a re-render — same underlying queue item (same UUID)
      rerender();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      rerender();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      // Snackbar should still have been fired just once
      expect(mockShowMessage).toHaveBeenCalledTimes(1);
      expect(mockSendFramesToBoard).not.toHaveBeenCalled();
    });
  });
});
