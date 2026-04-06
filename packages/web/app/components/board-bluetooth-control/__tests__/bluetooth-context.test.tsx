import { describe, it, expect, vi, beforeEach } from 'vitest';
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

let mockCurrentClimbQueueItem: { climb: { uuid: string; frames: string; mirrored: boolean } } | null = null;

vi.mock('../../graphql-queue', () => ({
  useCurrentClimb: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
  }),
  useQueueContext: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
  }),
  useQueueData: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
  }),
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
          expect(mockSendFramesToBoard).toHaveBeenCalledWith('p1r12p2r13', false);
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
          expect(mockSendFramesToBoard).toHaveBeenCalledWith('p3r14p4r15', true);
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

      expect(consoleSpy).toHaveBeenCalledWith(
        'Error sending climb to board:',
        expect.any(Error),
      );
      consoleSpy.mockRestore();
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
});
