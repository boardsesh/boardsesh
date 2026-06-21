import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { useBoardBluetooth } from '../use-board-bluetooth';
import { _resetFactoryCache } from '@/app/lib/ble/adapter-factory';

// --- Mocks ---

const {
  mockAdapter,
  mockCreateBluetoothAdapter,
  mockGetAuroraBluetoothPacket,
  mockGetMoonboardBluetoothPacket,
  mockGetLedPlacements,
  mockShowMessage,
  mockParseSerialNumber,
  mockFetch,
  mockGraphqlRequest,
  mockTrack,
} = vi.hoisted(() => {
  const mockAdapter = {
    isAvailable: vi.fn(),
    requestAndConnect: vi.fn(),
    disconnect: vi.fn(),
    write: vi.fn(),
    configureBoard: vi.fn(),
    onDisconnect: vi.fn<(handler: () => void) => () => void>(() => () => {}),
  };

  return {
    mockAdapter,
    mockCreateBluetoothAdapter: vi.fn<(boardName: string) => Promise<typeof mockAdapter>>(() =>
      Promise.resolve(mockAdapter),
    ),
    mockGetAuroraBluetoothPacket: vi.fn<
      (
        frames: string,
        placementPositions: Record<number, number>,
        boardName: string,
      ) => {
        packet: Uint8Array;
        skippedPositionCount: number;
        skippedRoleCount: number;
        totalPlacements: number;
      }
    >(() => ({
      packet: new Uint8Array([1, 2, 3]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    })),
    mockGetMoonboardBluetoothPacket: vi.fn<
      (frames: string) => {
        packet: Uint8Array;
        skippedRoleCount: number;
        skippedPositionCount: number;
        totalPlacements: number;
      }
    >(() => ({
      packet: new Uint8Array([9, 8, 7]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 3,
    })),
    mockGetLedPlacements: vi.fn<(boardName: string, layoutId: number, sizeId: number) => Record<number, number>>(
      () => ({ 4131: 39 }),
    ),
    mockShowMessage: vi.fn(),
    mockParseSerialNumber: vi.fn<(name: string) => string | undefined>(() => undefined),
    mockFetch: vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 }))),
    mockGraphqlRequest: vi.fn<(document: unknown, variables?: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ recordBoardSerial: null }),
    ),
    mockTrack: vi.fn(),
  };
});

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: vi.fn(() => ({ request: mockGraphqlRequest })),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null }),
}));

vi.mock('@/app/lib/ble/adapter-factory', () => ({
  createBluetoothAdapter: mockCreateBluetoothAdapter,
  _resetFactoryCache: vi.fn(),
}));

vi.mock('../bluetooth-aurora', () => ({
  getAuroraBluetoothPacket: mockGetAuroraBluetoothPacket,
  parseApiLevel: vi.fn(() => 3),
  parseSerialNumber: mockParseSerialNumber,
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

// Echo the i18n key so assertions can match on the key directly.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: mockTrack,
}));

vi.mock('@/app/lib/ble/capacitor-utils', () => ({
  supportsCapacitorBleManualScan: vi.fn(() => false),
  supportsNativeIosBoardBle: vi.fn(() => false),
  isNativeApp: vi.fn(() => false),
}));

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
    mockParseSerialNumber.mockReturnValue(undefined);
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', mockFetch);
    mockGraphqlRequest.mockResolvedValue({ recordBoardSerial: null });
    mockCreateBluetoothAdapter.mockResolvedValue(mockAdapter);
    mockAdapter.isAvailable.mockResolvedValue(true);
    mockAdapter.requestAndConnect.mockResolvedValue({
      deviceId: 'test-device',
      deviceName: 'Test Board',
    });
    mockAdapter.disconnect.mockResolvedValue(undefined);
    mockAdapter.write.mockResolvedValue(undefined);
    mockAdapter.configureBoard.mockResolvedValue(undefined);
    mockAdapter.onDisconnect.mockReturnValue(vi.fn());
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([1, 2, 3]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    });
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([9, 8, 7]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 3,
    });
    mockGetLedPlacements.mockReturnValue({ 4131: 39 });
  });

  it('initial state: not connected, not loading', () => {
    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

    expect(result.current.isConnected).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('shows error when bluetooth not available', async () => {
    mockAdapter.isAvailable.mockResolvedValue(false);

    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

    let connectResult: boolean | undefined;
    await act(async () => {
      connectResult = await result.current.connect();
    });

    expect(connectResult).toBe(false);
    expect(mockShowMessage).toHaveBeenCalledWith('bluetooth.unavailable', 'error');
  });

  it('returns false when no boardDetails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: undefined }));

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

    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

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
    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.isConnected).toBe(true);
  });

  it('configures the native board once when connect flips isConnected', async () => {
    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

    await act(async () => {
      await result.current.connect();
    });

    expect(mockAdapter.configureBoard).toHaveBeenCalledOnce();
    expect(mockAdapter.configureBoard).toHaveBeenCalledWith({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      apiLevel: 3,
      deviceName: 'Test Board',
      colorOverrides: undefined,
    });
  });

  it('creates a board-aware adapter for the active board', async () => {
    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockMoonboardDetails }));

    await act(async () => {
      await result.current.connect();
    });

    expect(mockCreateBluetoothAdapter).toHaveBeenCalledWith('moonboard', undefined);
  });

  it('handles connect failure', async () => {
    mockAdapter.requestAndConnect.mockRejectedValue(new Error('Connection failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

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
    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.isConnected).toBe(true);

    act(() => {
      void result.current.disconnect();
    });

    expect(mockAdapter.disconnect).toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it('uses the Aurora encoder and LED placements for Aurora boards', async () => {
    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p4131r42');
    });

    expect(sendResult).toBe(true);
    expect(mockGetLedPlacements).toHaveBeenCalledWith('kilter', 1, 10);
    expect(mockGetAuroraBluetoothPacket).toHaveBeenCalledWith('p4131r42', { 4131: 39 }, 'kilter', 3, undefined);
    expect(mockGetMoonboardBluetoothPacket).not.toHaveBeenCalled();
    expect(mockAdapter.write).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), undefined);
  });

  it('uses the Moonboard encoder without loading LED placements', async () => {
    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockMoonboardDetails }));

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

    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails, onConnectionChange }));

    await act(async () => {
      await result.current.connect();
    });

    expect(onConnectionChange).toHaveBeenCalledWith(true);

    act(() => {
      void result.current.disconnect();
    });

    expect(onConnectionChange).toHaveBeenCalledWith(false);
  });

  it('cleans up adapter on unmount', async () => {
    const { result, unmount } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

    await act(async () => {
      await result.current.connect();
    });

    unmount();

    expect(mockAdapter.disconnect).toHaveBeenCalled();
  });

  it('shows an error when Aurora LED placement data is missing', async () => {
    mockGetLedPlacements.mockReturnValueOnce({});

    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p4131r42');
    });

    expect(sendResult).toBe(false);
    expect(result.current.lastSendFailureReasonRef.current).toBe('missing_led_placements');
    expect(mockShowMessage).toHaveBeenCalledWith(
      'Could not send to board — LED data missing for this board configuration.',
      'error',
    );
    expect(mockAdapter.write).not.toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), undefined);
  });

  it('records incompatible_climb when every Aurora placement is skipped', async () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Empty packet + skipped placements => the climb is for a different board.
    mockGetAuroraBluetoothPacket.mockReturnValueOnce({
      packet: new Uint8Array([]),
      skippedPositionCount: 3,
      skippedRoleCount: 0,
      totalPlacements: 3,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));
    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p4131r42');
    });

    expect(sendResult).toBe(false);
    expect(result.current.lastSendFailureReasonRef.current).toBe('incompatible_climb');
    expect(mockShowMessage).toHaveBeenCalledWith('This climb is for a different board configuration.', 'error');
    warnSpy.mockRestore();
  });

  it('records missing_mirror_data when a mirrored send has no holdsData', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // mockBoardDetails advertises supportsMirroring but carries no holdsData,
    // so a mirrored send can't build the mirror and bails before the write.
    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));
    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p4131r42', true);
    });

    expect(sendResult).toBe(false);
    expect(result.current.lastSendFailureReasonRef.current).toBe('missing_mirror_data');
    errorSpy.mockRestore();
  });

  // Traditional `[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/...` routes
  // don't carry a boardUuid — the recorded serial mapping should reflect that
  // (the recording row gets a NULL board_uuid). The /b/{slug}/... case sends a UUID.
  it('records traditional-route serial with no boardUuid when prop is omitted', async () => {
    mockParseSerialNumber.mockReturnValueOnce('AB1234');
    const traditionalRouteDetails = {
      ...mockBoardDetails,
      set_ids: [1, 2],
    } as unknown as Parameters<typeof useBoardBluetooth>[0]['boardDetails'];

    const { result } = renderHook(() => useBoardBluetooth({ boardDetails: traditionalRouteDetails }));

    await act(async () => {
      await result.current.connect();
    });

    const recordCall = mockGraphqlRequest.mock.calls.find(
      ([, variables]) => !!(variables as { input?: unknown })?.input,
    );
    expect(recordCall).toBeDefined();
    const { input } = recordCall![1] as { input: Record<string, unknown> };
    expect(input.serialNumber).toBe('AB1234');
    expect(input.apiLevel).toBe(3);
    expect(input.boardUuid).toBeUndefined();
  });

  it('records saved-board serial with boardUuid when prop is provided', async () => {
    mockParseSerialNumber.mockReturnValueOnce('CD5678');
    const savedBoardDetails = {
      ...mockBoardDetails,
      set_ids: [1, 2],
    } as unknown as Parameters<typeof useBoardBluetooth>[0]['boardDetails'];

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardDetails: savedBoardDetails, boardUuid: 'board-uuid-xyz' }),
    );

    await act(async () => {
      await result.current.connect();
    });

    const recordCall = mockGraphqlRequest.mock.calls.find(
      ([, variables]) => !!(variables as { input?: unknown })?.input,
    );
    expect(recordCall).toBeDefined();
    const { input } = recordCall![1] as { input: Record<string, unknown> };
    expect(input.boardUuid).toBe('board-uuid-xyz');
  });

  describe('connect failure messaging', () => {
    it('surfaces an actionable message on a GATT connect failure', async () => {
      mockAdapter.requestAndConnect.mockRejectedValue(new Error('GATT connect failed'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));
      await act(async () => {
        await result.current.connect();
      });

      expect(mockShowMessage).toHaveBeenCalledWith('bluetooth.connectFailed', 'error');
      errorSpy.mockRestore();
    });

    it('maps a scan-not-found failure to the board-not-found message', async () => {
      mockAdapter.requestAndConnect.mockRejectedValue(new Error('Target board not found during scan'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));
      await act(async () => {
        await result.current.connect();
      });

      expect(mockShowMessage).toHaveBeenCalledWith('bluetooth.boardNotFound', 'error');
      errorSpy.mockRestore();
    });

    it('stays silent when the user cancels the picker', async () => {
      mockAdapter.requestAndConnect.mockRejectedValue(new Error('Device selection cancelled'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));
      await act(async () => {
        await result.current.connect();
      });

      expect(mockShowMessage).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('unexpected disconnect take-back', () => {
    it('prompts "take it back" and reconnects to the remembered board', async () => {
      let capturedHandler: (() => void) | null = null;
      mockAdapter.onDisconnect.mockImplementation((handler: () => void) => {
        capturedHandler = handler;
        return vi.fn();
      });
      // Real BoardDetails carry a number[] set_ids; the shared mock lies with a
      // string, so use array set_ids so the serial gets remembered on connect.
      const arraySetIdsDetails = {
        ...mockBoardDetails,
        set_ids: [1, 2],
      } as unknown as Parameters<typeof useBoardBluetooth>[0]['boardDetails'];
      mockParseSerialNumber.mockReturnValue('AB1234');

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: arraySetIdsDetails }));
      await act(async () => {
        await result.current.connect();
      });

      mockShowMessage.mockClear();
      mockAdapter.requestAndConnect.mockClear();

      act(() => {
        capturedHandler?.();
      });

      const promptCall = mockShowMessage.mock.calls.find(([text]) => text === 'bluetooth.boardTaken') as
        | [string, string, { label: string; onClick: () => void }, number]
        | undefined;
      expect(promptCall).toBeDefined();
      expect(promptCall![1]).toBe('warning');
      expect(promptCall![2].label).toBe('bluetooth.takeItBack');

      // Tapping "take it back" reconnects to the board we were on — silently on
      // native (the adapter falls back to the picker if it's gone), matching the
      // lightbulb tap.
      await act(async () => {
        promptCall![2].onClick();
        await Promise.resolve();
      });

      expect(mockAdapter.requestAndConnect).toHaveBeenCalledWith('AB1234');
    });

    it('does not stack prompts when the connection flaps (several drops in a row)', async () => {
      let capturedHandler: (() => void) | null = null;
      mockAdapter.onDisconnect.mockImplementation((handler: () => void) => {
        capturedHandler = handler;
        return vi.fn();
      });

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));
      await act(async () => {
        await result.current.connect();
      });

      mockShowMessage.mockClear();

      // Three drops before any reconnect — only the first should prompt.
      act(() => {
        capturedHandler?.();
        capturedHandler?.();
        capturedHandler?.();
      });

      const promptCalls = mockShowMessage.mock.calls.filter(([text]) => text === 'bluetooth.boardTaken');
      expect(promptCalls).toHaveLength(1);
    });

    it('re-arms the prompt after a failed take-back so a later drop prompts again', async () => {
      let capturedHandler: (() => void) | null = null;
      mockAdapter.onDisconnect.mockImplementation((handler: () => void) => {
        capturedHandler = handler;
        return vi.fn();
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));
      await act(async () => {
        await result.current.connect();
      });

      // First drop → prompt.
      act(() => {
        capturedHandler?.();
      });
      const firstPrompt = mockShowMessage.mock.calls.find(([text]) => text === 'bluetooth.boardTaken') as
        | [string, string, { label: string; onClick: () => void }, number]
        | undefined;
      expect(firstPrompt).toBeDefined();

      // Tap "take it back" but make the reconnect fail.
      mockAdapter.requestAndConnect.mockRejectedValueOnce(new Error('Connection failed'));
      await act(async () => {
        firstPrompt![2].onClick();
        await Promise.resolve();
      });

      mockShowMessage.mockClear();

      // A subsequent genuine drop must prompt again — the guard re-armed despite
      // the failed reconnect.
      act(() => {
        capturedHandler?.();
      });
      const reprompts = mockShowMessage.mock.calls.filter(([text]) => text === 'bluetooth.boardTaken');
      expect(reprompts).toHaveLength(1);
      errorSpy.mockRestore();
    });

    it('does not prompt after a user-initiated disconnect', async () => {
      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));
      await act(async () => {
        await result.current.connect();
      });

      mockShowMessage.mockClear();

      await act(async () => {
        await result.current.disconnect();
      });

      expect(mockShowMessage).not.toHaveBeenCalledWith(
        'bluetooth.boardTaken',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('write failure marks the link lost', () => {
    // Real BoardDetails carry a number[] set_ids; the shared mock lies with a
    // string, so use array set_ids here (boardIdentityKey joins the array).
    const arraySetIdsDetails = {
      ...mockBoardDetails,
      set_ids: [1, 2],
    } as unknown as Parameters<typeof useBoardBluetooth>[0]['boardDetails'];

    it('flips isConnected false when a write fails with a disconnect-shaped error', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: arraySetIdsDetails }));

      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.isConnected).toBe(true);

      // The board was grabbed by another device — the write throws the GATT
      // "disconnected" error and no gattserverdisconnected event fires.
      mockAdapter.write.mockRejectedValueOnce(new DOMException('GATT Server is disconnected.', 'NetworkError'));

      let sendResult: boolean | undefined;
      await act(async () => {
        sendResult = await result.current.sendFramesToBoard('p4131r42');
      });

      expect(sendResult).toBe(false);
      expect(result.current.isConnected).toBe(false);
      // The real cause is recorded for the AutoSender to label, and the
      // tug-of-war is tracked (mirrors mobile) instead of staying silent.
      expect(result.current.lastSendFailureReasonRef.current).toBe('disconnected');
      expect(mockTrack).toHaveBeenCalledWith('Bluetooth Connection Stolen', {
        boardLayout: 'Original',
        boardId: undefined,
      });
      errorSpy.mockRestore();
    });

    it("flips isConnected false on the Capacitor adapter's plain Error('Not connected')", async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: arraySetIdsDetails }));

      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.isConnected).toBe(true);

      // The Capacitor / native-iOS adapters reject a write after the link drops
      // with a plain Error('Not connected') rather than a DOMException.
      mockAdapter.write.mockRejectedValueOnce(new Error('Not connected'));

      let sendResult: boolean | undefined;
      await act(async () => {
        sendResult = await result.current.sendFramesToBoard('p4131r42');
      });

      expect(sendResult).toBe(false);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.lastSendFailureReasonRef.current).toBe('disconnected');
      expect(mockTrack).toHaveBeenCalledWith('Bluetooth Connection Stolen', {
        boardLayout: 'Original',
        boardId: undefined,
      });
      errorSpy.mockRestore();
    });

    it('keeps isConnected true when a write fails with a non-disconnect error', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: arraySetIdsDetails }));

      await act(async () => {
        await result.current.connect();
      });

      mockAdapter.write.mockRejectedValueOnce(new Error('transient write hiccup'));

      let sendResult: boolean | undefined;
      await act(async () => {
        sendResult = await result.current.sendFramesToBoard('p4131r42');
      });

      expect(sendResult).toBe(false);
      expect(result.current.isConnected).toBe(true);
      // A live-link write failure is `write_failed`, NOT a stolen-board signal.
      expect(result.current.lastSendFailureReasonRef.current).toBe('write_failed');
      expect(mockTrack).not.toHaveBeenCalledWith('Bluetooth Connection Stolen', expect.anything());
      errorSpy.mockRestore();
    });
  });

  describe('reconnectSerialForCurrentBoard (solo silent reconnect)', () => {
    const arraySetIdsDetails = {
      ...mockBoardDetails,
      set_ids: [1, 2],
    } as unknown as Parameters<typeof useBoardBluetooth>[0]['boardDetails'];

    it('remembers the serial on connect and keeps it through an involuntary drop', async () => {
      let capturedHandler: (() => void) | null = null;
      mockAdapter.onDisconnect.mockImplementation((handler: () => void) => {
        capturedHandler = handler;
        return vi.fn();
      });
      mockParseSerialNumber.mockReturnValue('AB1234');

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: arraySetIdsDetails }));
      await act(async () => {
        await result.current.connect();
      });

      expect(result.current.reconnectSerialForCurrentBoard).toBe('AB1234');

      // Another device grabs the board — the serial must survive so a tap can
      // silently reconnect to it.
      act(() => {
        capturedHandler?.();
      });
      expect(result.current.isConnected).toBe(false);
      expect(result.current.reconnectSerialForCurrentBoard).toBe('AB1234');
    });

    it('forgets the serial after an explicit user disconnect', async () => {
      mockParseSerialNumber.mockReturnValue('AB1234');
      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: arraySetIdsDetails }));
      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.reconnectSerialForCurrentBoard).toBe('AB1234');

      await act(async () => {
        await result.current.disconnect();
      });
      expect(result.current.reconnectSerialForCurrentBoard).toBeNull();
    });

    it('returns null once the user is viewing a different board config', async () => {
      mockParseSerialNumber.mockReturnValue('AB1234');
      const otherBoardDetails = {
        ...mockBoardDetails,
        set_ids: [3, 4],
      } as unknown as Parameters<typeof useBoardBluetooth>[0]['boardDetails'];

      const { result, rerender } = renderHook(
        ({ boardDetails }: { boardDetails: Parameters<typeof useBoardBluetooth>[0]['boardDetails'] }) =>
          useBoardBluetooth({ boardDetails }),
        { initialProps: { boardDetails: arraySetIdsDetails } },
      );
      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.reconnectSerialForCurrentBoard).toBe('AB1234');

      // Switch to a different board (different set_ids) — the remembered serial
      // no longer applies, so callers fall back to the picker.
      rerender({ boardDetails: otherBoardDetails });
      expect(result.current.reconnectSerialForCurrentBoard).toBeNull();
    });
  });

  describe('Bluetooth Disconnected analytics', () => {
    function findDisconnectCall(): [string, Record<string, unknown>] | undefined {
      return mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Disconnected') as
        | [string, Record<string, unknown>]
        | undefined;
    }

    it("fires reason='user' on explicit disconnect() with the connection duration", async () => {
      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

      await act(async () => {
        await result.current.connect();
      });

      mockTrack.mockClear();

      await act(async () => {
        await result.current.disconnect();
      });

      const call = findDisconnectCall();
      expect(call).toBeDefined();
      expect(call![1].reason).toBe('user');
      expect(typeof call![1].duration_connected_ms).toBe('number');
      expect(call![1].duration_connected_ms as number).toBeGreaterThanOrEqual(0);
    });

    it("fires reason='lost' when the adapter reports an unexpected disconnect", async () => {
      let capturedHandler: (() => void) | null = null;
      mockAdapter.onDisconnect.mockImplementation((handler: () => void) => {
        capturedHandler = handler;
        return vi.fn();
      });

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

      await act(async () => {
        await result.current.connect();
      });

      mockTrack.mockClear();

      act(() => {
        capturedHandler?.();
      });

      const call = findDisconnectCall();
      expect(call).toBeDefined();
      expect(call![1].reason).toBe('lost');
      expect(typeof call![1].duration_connected_ms).toBe('number');
    });

    it("fires reason='reconnect' when connect() tears down an existing adapter", async () => {
      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

      await act(async () => {
        await result.current.connect();
      });

      mockTrack.mockClear();

      await act(async () => {
        await result.current.connect();
      });

      const call = findDisconnectCall();
      expect(call).toBeDefined();
      expect(call![1].reason).toBe('reconnect');
      expect(typeof call![1].duration_connected_ms).toBe('number');
    });

    it("fires reason='navigation' when the component unmounts while still connected", async () => {
      const { result, unmount } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

      await act(async () => {
        await result.current.connect();
      });

      mockTrack.mockClear();

      unmount();

      const call = findDisconnectCall();
      expect(call).toBeDefined();
      expect(call![1].reason).toBe('navigation');
      expect(typeof call![1].duration_connected_ms).toBe('number');
    });

    it('does not double-fire when disconnect() is followed by unmount', async () => {
      const { result, unmount } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

      await act(async () => {
        await result.current.connect();
      });

      await act(async () => {
        await result.current.disconnect();
      });

      mockTrack.mockClear();
      unmount();

      const call = findDisconnectCall();
      expect(call).toBeUndefined();
    });
  });

  describe('re-entrant connect guard', () => {
    it('ignores a second connect() while the first is still in flight (picker open)', async () => {
      // Hold the first attempt at the scan/picker stage: requestAndConnect never
      // resolves until we say so, mirroring a user still choosing a board.
      let resolveConnect: (value: { deviceId: string; deviceName: string }) => void;
      const pending = new Promise<{ deviceId: string; deviceName: string }>((resolve) => {
        resolveConnect = resolve;
      });
      mockAdapter.requestAndConnect.mockReturnValue(pending);

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

      let firstPromise!: Promise<boolean>;
      act(() => {
        firstPromise = result.current.connect();
      });

      // A second tap — or the 2-second wall-confirm fallback firing while the
      // picker is open — must NOT start a second native scan ("Already scanning.
      // Stopping now." on iOS). It returns false and creates no extra adapter.
      let secondResult: boolean | undefined;
      await act(async () => {
        secondResult = await result.current.connect();
      });

      expect(secondResult).toBe(false);
      expect(mockCreateBluetoothAdapter).toHaveBeenCalledTimes(1);
      expect(mockAdapter.requestAndConnect).toHaveBeenCalledTimes(1);

      // Let the first attempt finish.
      await act(async () => {
        resolveConnect!({ deviceId: 'test', deviceName: 'Board' });
        await firstPromise;
      });
      expect(result.current.isConnected).toBe(true);

      // Guard released: a later deliberate connect runs normally.
      mockAdapter.requestAndConnect.mockResolvedValue({ deviceId: 'test-2', deviceName: 'Board 2' });
      await act(async () => {
        await result.current.connect();
      });
      expect(mockCreateBluetoothAdapter).toHaveBeenCalledTimes(2);
    });

    it('releases the guard after the user cancels the picker so a re-tap connects', async () => {
      // The most common real re-entry: the user dismisses the picker, then taps
      // the lightbulb again. The cancel rejects requestAndConnect → connect()'s
      // finally clears the guard, so the re-tap is not swallowed.
      mockAdapter.requestAndConnect.mockRejectedValueOnce(new Error('Device selection cancelled'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.isConnected).toBe(false);
      // Cancelling stays silent (not a failure toast).
      expect(mockShowMessage).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.isConnected).toBe(true);
      expect(mockCreateBluetoothAdapter).toHaveBeenCalledTimes(2);
      errorSpy.mockRestore();
    });

    it('releases the guard after a failed attempt so the next connect can run', async () => {
      mockAdapter.requestAndConnect.mockRejectedValueOnce(new Error('GATT connect failed'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useBoardBluetooth({ boardDetails: mockBoardDetails }));

      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.isConnected).toBe(false);

      // The failed attempt cleared the in-flight guard in `finally`, so a retry
      // is not swallowed.
      await act(async () => {
        await result.current.connect();
      });
      expect(result.current.isConnected).toBe(true);
      expect(mockCreateBluetoothAdapter).toHaveBeenCalledTimes(2);
      errorSpy.mockRestore();
    });
  });
});
