import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// --- Mocks ---

const {
  mockAdapter,
  mockCreateBluetoothAdapter,
  mockGetAuroraBluetoothPacket,
  mockGetMoonboardBluetoothPacket,
  mockGetLedPlacements,
  mockShowMessage,
} = vi.hoisted(() => {
  const mockAdapter = {
    isAvailable: vi.fn(),
    requestAndConnect: vi.fn(),
    disconnect: vi.fn(),
    write: vi.fn(),
    onDisconnect: vi.fn(() => vi.fn()),
  };

  return {
    mockAdapter,
    mockCreateBluetoothAdapter: vi.fn<(boardName: string) => Promise<typeof mockAdapter>>(
      () => Promise.resolve(mockAdapter),
    ),
    mockGetAuroraBluetoothPacket: vi.fn<
      (frames: string, placementPositions: Record<number, number>, boardName: string) => Uint8Array
    >(() => new Uint8Array([1, 2, 3])),
    mockGetMoonboardBluetoothPacket: vi.fn<(frames: string) => Uint8Array>(
      () => new Uint8Array([9, 8, 7]),
    ),
    mockGetLedPlacements: vi.fn<
      (boardName: string, layoutId: number, sizeId: number) => Record<number, number>
    >(() => ({ 4131: 39 })),
    mockShowMessage: vi.fn(),
  };
});

vi.mock('@/app/lib/ble/adapter-factory', () => ({
  createBluetoothAdapter: mockCreateBluetoothAdapter,
  _resetFactoryCache: vi.fn(),
}));

vi.mock('../bluetooth-aurora', () => ({
  getAuroraBluetoothPacket: mockGetAuroraBluetoothPacket,
  parseApiLevel: vi.fn(() => 3),
}));

vi.mock('../bluetooth-moonboard', () => ({
  getMoonboardBluetoothPacket: mockGetMoonboardBluetoothPacket,
}));

vi.mock('@boardsesh/board-constants/led-placements', () => ({
  getLedPlacements: mockGetLedPlacements,
}));

vi.mock('../use-wake-lock', () => ({
  useWakeLock: vi.fn(),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('@vercel/analytics', () => ({
  track: vi.fn(),
}));

import { useBoardBluetooth } from '../use-board-bluetooth';
import { _resetFactoryCache } from '@/app/lib/ble/adapter-factory';

const mockBoardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: '1,2',
  layout_name: 'Original',
  size_name: '12x12',
  size_description: 'Full',
  set_names: ['Standard'],
  supportsMirroring: true,
} as unknown as Parameters<typeof useBoardBluetooth>[0]['boardDetails'];

const mockMoonboardDetails = {
  board_name: 'moonboard',
  layout_id: 2,
  size_id: 1,
  set_ids: '2,3,4',
  layout_name: 'MoonBoard 2016',
  size_name: 'Standard',
  size_description: '11x18 Grid',
  set_names: ['Hold Set A', 'Hold Set B', 'Original School Holds'],
  supportsMirroring: false,
} as unknown as Parameters<typeof useBoardBluetooth>[0]['boardDetails'];

describe('useBoardBluetooth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetFactoryCache();
    mockCreateBluetoothAdapter.mockResolvedValue(mockAdapter);
    mockAdapter.isAvailable.mockResolvedValue(true);
    mockAdapter.requestAndConnect.mockResolvedValue({
      deviceId: 'test-device',
      deviceName: 'Test Board',
    });
    mockAdapter.disconnect.mockResolvedValue(undefined);
    mockAdapter.write.mockResolvedValue(undefined);
    mockAdapter.onDisconnect.mockReturnValue(vi.fn());
    mockGetAuroraBluetoothPacket.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockGetMoonboardBluetoothPacket.mockReturnValue(new Uint8Array([9, 8, 7]));
    mockGetLedPlacements.mockReturnValue({ 4131: 39 });
  });

  it('initial state: not connected, not loading', () => {
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails }),
    );

    expect(result.current.isConnected).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('shows error when bluetooth not available', async () => {
    mockAdapter.isAvailable.mockResolvedValue(false);

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails }),
    );

    let connectResult: boolean | undefined;
    await act(async () => {
      connectResult = await result.current.connect();
    });

    expect(connectResult).toBe(false);
    expect(mockShowMessage).toHaveBeenCalledWith(
      'Bluetooth is not available on this device.',
      'error',
    );
  });

  it('returns false when no boardDetails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: undefined }),
    );

    let connectResult: boolean | undefined;
    await act(async () => {
      connectResult = await result.current.connect();
    });

    expect(connectResult).toBe(false);
    errorSpy.mockRestore();
  });

  it('sets loading during connect', async () => {
    let resolveConnect: (value: unknown) => void;
    const connectPromise = new Promise((resolve) => {
      resolveConnect = resolve;
    });
    mockAdapter.requestAndConnect.mockReturnValue(connectPromise);

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails }),
    );

    // Start connection
    let hookConnectPromise: Promise<boolean>;
    act(() => {
      hookConnectPromise = result.current.connect();
    });

    // Should be loading
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveConnect!({ deviceId: 'test', deviceName: 'Board' });
      await hookConnectPromise;
    });

    expect(result.current.loading).toBe(false);
  });

  it('sets isConnected on successful connection', async () => {
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails }),
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.isConnected).toBe(true);
  });

  it('creates a board-aware adapter for the active board', async () => {
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockMoonboardDetails }),
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(mockCreateBluetoothAdapter).toHaveBeenCalledWith('moonboard', undefined);
  });

  it('handles connect failure', async () => {
    mockAdapter.requestAndConnect.mockRejectedValue(new Error('Connection failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails }),
    );

    let connectResult: boolean | undefined;
    await act(async () => {
      connectResult = await result.current.connect();
    });

    expect(connectResult).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.loading).toBe(false);
    errorSpy.mockRestore();
  });

  it('disconnect calls adapter.disconnect', async () => {
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails }),
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.isConnected).toBe(true);

    act(() => {
      result.current.disconnect();
    });

    expect(mockAdapter.disconnect).toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it('uses the Aurora encoder and LED placements for Aurora boards', async () => {
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails }),
    );

    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p4131r42');
    });

    expect(sendResult).toBe(true);
    expect(mockGetLedPlacements).toHaveBeenCalledWith('kilter', 1, 10);
    expect(mockGetAuroraBluetoothPacket).toHaveBeenCalledWith(
      'p4131r42',
      { 4131: 39 },
      'kilter',
      3,
    );
    expect(mockGetMoonboardBluetoothPacket).not.toHaveBeenCalled();
    expect(mockAdapter.write).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), undefined);
  });

  it('uses the Moonboard encoder without loading LED placements', async () => {
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockMoonboardDetails }),
    );

    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p1r42p2r43p198r44');
    });

    expect(sendResult).toBe(true);
    expect(mockGetMoonboardBluetoothPacket).toHaveBeenCalledWith('p1r42p2r43p198r44');
    expect(mockGetAuroraBluetoothPacket).not.toHaveBeenCalled();
    expect(mockGetLedPlacements).not.toHaveBeenCalled();
    expect(mockAdapter.write).toHaveBeenCalledWith(new Uint8Array([9, 8, 7]), undefined);
  });

  it('calls onConnectionChange callback', async () => {
    const onConnectionChange = vi.fn();

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails, onConnectionChange }),
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(onConnectionChange).toHaveBeenCalledWith(true);

    act(() => {
      result.current.disconnect();
    });

    expect(onConnectionChange).toHaveBeenCalledWith(false);
  });

  it('cleans up adapter on unmount', async () => {
    const { result, unmount } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails }),
    );

    await act(async () => {
      await result.current.connect();
    });

    unmount();

    expect(mockAdapter.disconnect).toHaveBeenCalled();
  });

  it('shows an error when Aurora LED placement data is missing', async () => {
    mockGetLedPlacements.mockReturnValueOnce({});

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: mockBoardDetails }),
    );

    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p4131r42');
    });

    expect(sendResult).toBe(false);
    expect(mockShowMessage).toHaveBeenCalledWith(
      'Could not send to board — LED data missing for this board configuration.',
      'error',
    );
    expect(mockAdapter.write).not.toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), undefined);
  });
});
