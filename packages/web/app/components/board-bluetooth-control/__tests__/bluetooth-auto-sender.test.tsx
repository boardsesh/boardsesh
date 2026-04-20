import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks — declared before the SUT import
// ---------------------------------------------------------------------------

vi.mock('@vercel/analytics', () => ({
  track: vi.fn(),
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
  uuid: string;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * BoardDetails with real hold data. `canAddClimbToBoard` runs the per-hold
 * containment check only when `holdsData` is a non-empty array, so this
 * fixture is what triggers the holds_out_of_range branch.
 */
const boardWithHolds: BoardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: '1,2',
  images_to_holds: {},
  holdsData: [{ id: 12 }, { id: 13 }] as unknown as BoardDetails['holdsData'],
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

function createWrapper(boardDetails: BoardDetails) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(BluetoothProvider, { boardDetails, children });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BluetoothAutoSender — multi-board send gate', () => {
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

  it('calls sendFramesToBoard when the current climb matches the connected board', async () => {
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
        frames: 'p12r12p13r13',
        mirrored: false,
        boardType: 'kilter',
        layoutId: 1,
      },
    };
    mockBluetoothState.isConnected = true;

    renderHook(() => useBluetoothContext(), { wrapper: createWrapper(boardWithHolds) });

    await act(async () => {
      await vi.waitFor(() => {
        expect(mockSendFramesToBoard).toHaveBeenCalledTimes(1);
      });
    });
    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('does NOT call sendFramesToBoard and emits one snackbar when boardConfig is for a different board', async () => {
    mockCurrentClimbQueueItem = {
      uuid: 'qi-mismatch',
      boardConfig: {
        boardName: 'tension', // mismatch with connected kilter board
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

    renderHook(() => useBluetoothContext(), { wrapper: createWrapper(boardWithHolds) });

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

  it('does NOT call sendFramesToBoard and emits one snackbar when a hold is out of range', async () => {
    mockCurrentClimbQueueItem = {
      uuid: 'qi-oor',
      boardConfig: {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: [1, 2],
        angle: 40,
      },
      climb: {
        uuid: 'c-3',
        // Hold ID 999 is NOT in boardWithHolds.holdsData (only 12, 13).
        frames: 'p12r12p999r15',
        mirrored: false,
        boardType: 'kilter',
        layoutId: 1,
      },
    };
    mockBluetoothState.isConnected = true;

    renderHook(() => useBluetoothContext(), { wrapper: createWrapper(boardWithHolds) });

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
        boardName: 'tension',
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

    // Force two more re-renders — same queue item UUID, snackbar MUST stay at 1.
    rerender();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    rerender();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockShowMessage).toHaveBeenCalledTimes(1);
    expect(mockSendFramesToBoard).not.toHaveBeenCalled();
  });
});
