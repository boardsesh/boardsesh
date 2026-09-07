// @vitest-environment jsdom
import { act, render, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import { getMoonboardBluetoothPacket } from '@boardsesh/ble-protocol/moonboard';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import type { BleConnectionEnded, BleConnectionHandle, PickerState } from '../../lib/ble/use-board-bluetooth';
import { setHoldColorOverridesPreference } from '../../lib/hold-color-overrides';

type TestResolvedBoard = { boardId: number };

type BluetoothHookOptions = {
  onConnectSuccess?: (serial: string | null, connection: BleConnectionHandle) => void;
  onConnectionEnded?: (connection: BleConnectionEnded) => void;
  holdsData?: unknown;
  moonboardLightAdjacentHolds?: boolean;
  encodingSignature?: string;
};

function makeConnectionHandle(
  generation: number = 1,
  setIds: string = '1,20',
  setAnalyticsBoardId: (boardId: number) => boolean = () => true,
): BleConnectionHandle {
  return {
    generation,
    configIdentity: `kilter:1:10:${setIds}`,
    config: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds },
    setAnalyticsBoardId,
  };
}
type SendFramesToBoard = (
  frames: string,
  mirrored?: boolean,
  signal?: AbortSignal,
  sendContext?: unknown,
) => Promise<boolean | undefined>;

const wallConfirm = vi.hoisted(() => ({
  emitWallConfirm: vi.fn(),
}));

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
}));

const alert = vi.hoisted(() => ({
  alert: vi.fn(),
}));

const queue = vi.hoisted(() => ({
  currentClimbQueueItem: null as ClimbQueueItem | null,
  sessionId: 'session-1' as string | null,
  participantId: 'participant-self' as string | null,
  lastConnectedBoardSerial: null as string | null,
  confirmClimbOnWall: vi.fn(async () => {}),
  reportWallDisconnect: vi.fn(async (_sessionId?: string | null) => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
}));

const bluetooth = vi.hoisted(() => {
  const mock = {
    options: undefined as BluetoothHookOptions | undefined,
    sendFramesToBoardForOptions: null as ((options: BluetoothHookOptions) => SendFramesToBoard) | null,
    state: {
      isConnected: true,
      loading: false,
      connect: vi.fn(async () => true),
      disconnect: vi.fn(async () => {}),
      sendFramesToBoard: vi.fn<SendFramesToBoard>(async () => true),
      pickerState: null as PickerState | null,
      reconnectSerialForCurrentBoard: null,
      connectInitialSendRef: {
        current: null as {
          frames: string;
          mirrored: boolean;
          colorSignature: string;
          encodingSignature: string;
        } | null,
      },
    },
    useBoardBluetooth: vi.fn((options: BluetoothHookOptions) => {
      mock.options = options;
      if (mock.sendFramesToBoardForOptions) {
        return {
          ...mock.state,
          sendFramesToBoard: mock.sendFramesToBoardForOptions(options),
        };
      }
      return mock.state;
    }),
  };
  return mock;
});

const presence = vi.hoisted(() => ({
  enabled: false,
  boardId: null as number | null,
  currentClimb: null as BoardPresenceClimb | null,
  resolveAndBindBoard: vi.fn(async (): Promise<TestResolvedBoard | null> => null),
  resolveAndBindBoardByConfig: vi.fn(async (): Promise<TestResolvedBoard | null> => null),
  resolveAndBindBoardByUuid: vi.fn(async (): Promise<TestResolvedBoard | null> => null),
  reportClimbForBoard: vi.fn(async () => true),
  reportDisconnectForBoard: vi.fn(async () => true),
  showUndoWallChangeSnackbar: vi.fn(),
}));

type PickerSheetProps = {
  onSelect: (deviceId: string) => void;
};

const pickerSheet = vi.hoisted(() => ({
  props: null as PickerSheetProps | null,
}));

const resolvedBoards = vi.hoisted(() => ({
  value: new Map<string, ResolvedBoardEntry>(),
}));

vi.mock('react-native', () => ({
  Alert: { alert: alert.alert },
  // The provider's picker-telemetry read (getAndroidLocationPermissionState)
  // branches on Platform.OS; 'ios' short-circuits it to null without needing a
  // PermissionsAndroid stub here.
  Platform: { OS: 'ios', Version: 0 },
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
}));

vi.mock('../../settings', async () => {
  const { useState } = await import('react');
  return {
    useSetting: (key: string) => {
      // Mirror the real custom hook: every call owns one state slot. BluetoothProvider
      // invokes its settings unconditionally in a fixed order, so this setter can
      // rerender the provider without a test-only rerender seam.
      const initialValue = key === 'autoDisconnectBle' || key === 'moonboardLightAdjacentHolds' ? false : 30;
      return useState(initialValue);
    },
  };
});

vi.mock('@boardsesh/play-view', () => ({
  emitWallConfirm: wallConfirm.emitWallConfirm,
}));

vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceCurrent: () => ({
    currentClimb: presence.currentClimb,
    previousClimb: null,
    undoTarget: null,
    isLive: true,
  }),
}));

vi.mock('../board-presence-provider', () => ({
  useBoardPresenceControls: () => ({
    enabled: presence.enabled,
    boardId: presence.boardId,
    resolveAndBindBoard: presence.resolveAndBindBoard,
    resolveAndBindBoardByConfig: presence.resolveAndBindBoardByConfig,
    resolveAndBindBoardByUuid: presence.resolveAndBindBoardByUuid,
    reportClimbForBoard: presence.reportClimbForBoard,
    reportDisconnectForBoard: presence.reportDisconnectForBoard,
  }),
}));

vi.mock('../queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({ showUndoWallChangeSnackbar: presence.showUndoWallChangeSnackbar }),
}));

vi.mock('../../lib/climb-to-queue-item', () => ({
  toClimbInput: (climb: { uuid: string }) => ({ uuid: climb.uuid }),
}));

vi.mock('../../lib/ble/use-board-bluetooth', () => ({
  useBoardBluetooth: bluetooth.useBoardBluetooth,
}));

vi.mock('../../lib/ble/resolve-serials', () => ({
  useResolvedBleDeviceBoards: () => resolvedBoards.value,
}));

vi.mock('../../lib/ble/bluetooth-status-store', () => ({
  registerBluetoothConnection: vi.fn(() => vi.fn()),
  disconnectAllBluetooth: vi.fn(),
}));

vi.mock('../../lib/haptics', () => ({
  hapticSuccess: vi.fn(),
  hapticError: vi.fn(),
}));

vi.mock('../../lib/analytics', () => ({
  track: analytics.track,
}));

// The provider calls useSetActiveBoard for the "switch to correct config" flow.
// The real hook needs a QueryClientProvider this suite doesn't mount, so stub it.
vi.mock('../../lib/graphql/use-active-board', () => ({
  useSetActiveBoard: () => vi.fn(async () => {}),
}));

// The recorded-config switch path imports the GraphQL HTTP client, which
// transitively pulls in expo-secure-store (via the auth interceptor) —
// unavailable in the test environment. Short-circuit it; this suite stubs
// useSetActiveBoard and never drives a real board fetch.
vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: vi.fn(async () => ({ board: null })) }),
}));

vi.mock('../../components/ble/DevicePickerSheet', () => ({
  DevicePickerSheet: (props: PickerSheetProps) => {
    pickerSheet.props = props;
    return createElement('div', { 'data-testid': 'device-picker' });
  },
}));

vi.mock('../../components/ble/BleControlSheet', () => ({
  BleControlSheet: ({
    lightAdjacentHoldsEnabled,
    onToggleLightAdjacentHolds,
  }: {
    lightAdjacentHoldsEnabled: boolean;
    onToggleLightAdjacentHolds: (enabled: boolean) => void;
  }) =>
    createElement(
      'button',
      { type: 'button', onClick: () => onToggleLightAdjacentHolds(!lightAdjacentHoldsEnabled) },
      'toggle adjacent holds',
    ),
}));

vi.mock('../queue-provider', () => ({
  useQueue: () => ({
    state: { currentClimbQueueItem: queue.currentClimbQueueItem, queue: [] },
  }),
  useQueueActions: () => ({ setCurrentClimb: vi.fn() }),
  useQueueSessionControls: () => {
    const activeSessionId = queue.sessionId;
    return {
      sessionId: activeSessionId,
      participantId: queue.participantId,
      lastConnectedBoardSerial: queue.lastConnectedBoardSerial,
      confirmClimbOnWall: queue.confirmClimbOnWall,
      reportWallDisconnect: () => queue.reportWallDisconnect(activeSessionId),
      setSessionBoardSerial: queue.setSessionBoardSerial,
    };
  },
}));

vi.mock('../toast-provider', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const boardDetails = vi.hoisted(() => ({
  getBoardRenderData: vi.fn(() => ({
    holdsData: [{ id: 100, mirroredHoldId: 200, cx: 0, cy: 0, r: 1 }],
  })),
}));

vi.mock('../../lib/board-details', () => ({
  getBoardRenderData: boardDetails.getBoardRenderData,
}));

import { BluetoothProvider, useBluetoothContext } from '../bluetooth-provider';
import { BleControlSheetHost } from '../../components/ble/BleControlSheetHost';

function makeQueueItem(uuid: string, frames = 'p1r12', mirrored = false): ClimbQueueItem {
  return {
    uuid: `queue-${uuid}`,
    climb: {
      uuid,
      name: `Climb ${uuid}`,
      frames,
      mirrored,
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
  };
}

function makePresenceClimb(overrides: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb {
  return {
    climbUuid: 'previous-climb',
    queueItemUuid: 'queue-previous-climb',
    name: 'Previous climb',
    grade: 'V4',
    frames: 'previous-frames',
    angle: 35,
    setter: 'setter',
    sentAt: '2026-06-10T00:00:00.000Z',
    seq: 7,
    ...overrides,
  };
}

function renderProvider(children?: ReactNode) {
  return render(
    createElement(BluetoothProvider, {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      children: children ?? createElement('div', null),
    }),
  );
}

function renderMoonboardProvider(children?: ReactNode) {
  return render(
    createElement(BluetoothProvider, {
      boardName: 'moonboard',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      children: children ?? createElement('div', null),
    }),
  );
}

let capturedBluetooth: ReturnType<typeof useBluetoothContext> | null = null;

function BluetoothProbe() {
  capturedBluetooth = useBluetoothContext();
  return null;
}

function makeSerialConfig(overrides: Partial<BoardSerialConfig> = {}): BoardSerialConfig {
  return {
    serialNumber: 'SN-1',
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    apiLevel: 3,
    updatedAt: '2026-01-02T00:00:00.000Z',
    boardUuid: null,
    boardSlug: null,
    ...overrides,
  };
}

describe('BluetoothProvider wall-confirm integration', () => {
  beforeEach(async () => {
    await setHoldColorOverridesPreference({});
    queue.currentClimbQueueItem = makeQueueItem('climb-1');
    queue.sessionId = 'session-1';
    queue.participantId = 'participant-self';
    queue.lastConnectedBoardSerial = null;
    queue.confirmClimbOnWall.mockClear();
    queue.reportWallDisconnect.mockClear();
    queue.setSessionBoardSerial.mockClear();
    wallConfirm.emitWallConfirm.mockClear();
    analytics.track.mockClear();
    alert.alert.mockClear();
    pickerSheet.props = null;
    resolvedBoards.value = new Map();
    bluetooth.options = undefined;
    bluetooth.sendFramesToBoardForOptions = null;
    bluetooth.state.isConnected = true;
    bluetooth.state.loading = false;
    bluetooth.state.pickerState = null;
    bluetooth.state.reconnectSerialForCurrentBoard = null;
    bluetooth.state.disconnect.mockReset();
    bluetooth.state.disconnect.mockResolvedValue(undefined);
    bluetooth.state.sendFramesToBoard.mockReset();
    bluetooth.state.sendFramesToBoard.mockResolvedValue(true);
    bluetooth.state.connectInitialSendRef.current = null;
    bluetooth.useBoardBluetooth.mockClear();
    presence.enabled = false;
    presence.boardId = null;
    presence.currentClimb = null;
    presence.resolveAndBindBoard.mockClear();
    presence.resolveAndBindBoard.mockResolvedValue(null);
    presence.resolveAndBindBoardByConfig.mockClear();
    presence.resolveAndBindBoardByConfig.mockResolvedValue(null);
    presence.resolveAndBindBoardByUuid.mockClear();
    presence.resolveAndBindBoardByUuid.mockResolvedValue(null);
    presence.reportClimbForBoard.mockClear();
    presence.reportClimbForBoard.mockResolvedValue(true);
    presence.reportDisconnectForBoard.mockClear();
    presence.reportDisconnectForBoard.mockResolvedValue(true);
    presence.showUndoWallChangeSnackbar.mockClear();
    capturedBluetooth = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('emits a local wall confirm and notifies party peers after a successful send', async () => {
    renderProvider();

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith(
        'p1r12',
        false,
        expect.any(AbortSignal),
        expect.objectContaining({ sendSource: 'auto' }),
      );
    });

    expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
    expect(queue.confirmClimbOnWall).toHaveBeenCalledWith('climb-1');
  });

  it('writes updated MoonBoard packets when the control sheet toggles adjacent holds', async () => {
    queue.currentClimbQueueItem = makeQueueItem('moon-climb', 'p1r42');
    const adapterWrite = vi.fn(async (_packet: Uint8Array) => {});
    bluetooth.sendFramesToBoardForOptions = (options) => async (frames) => {
      const { packet } = getMoonboardBluetoothPacket(frames, 18, {
        lightAdjacentHolds: options.moonboardLightAdjacentHolds,
      });
      await adapterWrite(packet);
      return true;
    };

    const { getByText } = renderMoonboardProvider(
      createElement(BleControlSheetHost, { visible: true, onClose: vi.fn() }),
    );

    await waitFor(() => {
      expect(adapterWrite).toHaveBeenCalledTimes(1);
    });
    expect(new TextDecoder().decode(adapterWrite.mock.calls[0]?.[0])).toBe('l#S0#');

    fireEvent.click(getByText('toggle adjacent holds'));

    await waitFor(() => {
      expect(adapterWrite).toHaveBeenCalledTimes(2);
    });
    expect(bluetooth.options?.moonboardLightAdjacentHolds).toBe(true);
    expect(new TextDecoder().decode(adapterWrite.mock.calls[1]?.[0])).toBe('~Dl#S0#');

    fireEvent.click(getByText('toggle adjacent holds'));

    await waitFor(() => {
      expect(adapterWrite).toHaveBeenCalledTimes(3);
    });
    expect(bluetooth.options?.moonboardLightAdjacentHolds).toBe(false);
    expect(new TextDecoder().decode(adapterWrite.mock.calls[2]?.[0])).toBe('l#S0#');
  });

  it('re-sends an unchanged MoonBoard climb when the encoding preference changes without a reassert', async () => {
    queue.currentClimbQueueItem = makeQueueItem('moon-climb', 'p1r42');
    const adapterWrite = vi.fn(async (_packet: Uint8Array) => {});
    bluetooth.sendFramesToBoardForOptions = (options) => async (frames) => {
      const { packet } = getMoonboardBluetoothPacket(frames, 18, {
        lightAdjacentHolds: options.moonboardLightAdjacentHolds,
      });
      await adapterWrite(packet);
      return true;
    };

    renderMoonboardProvider(createElement(BluetoothProbe));

    await waitFor(() => {
      expect(adapterWrite).toHaveBeenCalledTimes(1);
    });
    expect(new TextDecoder().decode(adapterWrite.mock.calls[0]?.[0])).toBe('l#S0#');

    act(() => {
      capturedBluetooth?.setMoonboardLightAdjacentHolds(true);
    });

    await waitFor(() => {
      expect(adapterWrite).toHaveBeenCalledTimes(2);
    });
    expect(new TextDecoder().decode(adapterWrite.mock.calls[1]?.[0])).toBe('~Dl#S0#');
  });

  it('queues the new MoonBoard encoding while the previous write is still in flight', async () => {
    queue.currentClimbQueueItem = makeQueueItem('moon-climb', 'p1r42');
    const encodingAttempts: boolean[] = [];
    let resolveFirstWrite: ((writeSucceeded: boolean) => void) | undefined;
    bluetooth.sendFramesToBoardForOptions = (options) => async () => {
      encodingAttempts.push(options.moonboardLightAdjacentHolds ?? false);
      if (encodingAttempts.length === 1) {
        return new Promise<boolean>((resolve) => {
          resolveFirstWrite = resolve;
        });
      }
      return true;
    };

    renderMoonboardProvider(createElement(BluetoothProbe));

    await waitFor(() => {
      expect(encodingAttempts).toEqual([false]);
    });

    act(() => {
      capturedBluetooth?.setMoonboardLightAdjacentHolds(true);
    });
    expect(encodingAttempts).toEqual([false]);

    await act(async () => {
      resolveFirstWrite?.(true);
    });

    await waitFor(() => {
      expect(encodingAttempts).toEqual([false, true]);
    });

    act(() => {
      capturedBluetooth?.setMoonboardLightAdjacentHolds(false);
    });

    await waitFor(() => {
      expect(encodingAttempts).toEqual([false, true, false]);
    });
  });

  it('does not re-send an Aurora climb when the MoonBoard-only preference changes', async () => {
    bluetooth.sendFramesToBoardForOptions = () => async (frames, mirrored, signal, sendContext) =>
      bluetooth.state.sendFramesToBoard(frames, mirrored, signal, sendContext);

    renderProvider(createElement(BluetoothProbe));

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);
    });

    act(() => {
      capturedBluetooth?.setMoonboardLightAdjacentHolds(true);
    });

    await waitFor(() => {
      expect(bluetooth.options?.moonboardLightAdjacentHolds).toBe(true);
    });
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);
  });

  // ── Mirror intent (#5217) ────────────────────────────────────────────────
  // The play drawer's flip is drawer-local state — it never writes
  // `climb.mirrored`. It hands the provider an intent instead, so the flip rides
  // the AutoSender's normal write and the dedup record follows it.

  it('re-pushes the current climb mirrored when the drawer flips it', async () => {
    bluetooth.sendFramesToBoardForOptions = () => async (frames, mirrored, signal, sendContext) =>
      bluetooth.state.sendFramesToBoard(frames, mirrored, signal, sendContext);

    renderProvider(createElement(BluetoothProbe));

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);
    });
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenLastCalledWith(
      'p1r12',
      false,
      expect.anything(),
      expect.anything(),
    );

    act(() => {
      capturedBluetooth?.setMirrorIntent('climb-1', true);
    });

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(2);
    });
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenLastCalledWith(
      'p1r12',
      true,
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps the wall mirrored when the same climb is re-broadcast after a flip', async () => {
    // The bug this guards: a direct sendFramesToBoard left the dedup record
    // describing the un-mirrored orientation, so the next byte-identical
    // re-broadcast re-pushed un-mirrored frames and silently un-flipped the wall.
    bluetooth.sendFramesToBoardForOptions = () => async (frames, mirrored, signal, sendContext) =>
      bluetooth.state.sendFramesToBoard(frames, mirrored, signal, sendContext);

    const { rerender } = renderProvider(createElement(BluetoothProbe));

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);
    });

    act(() => {
      capturedBluetooth?.setMirrorIntent('climb-1', true);
    });
    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(2);
    });

    // A byte-identical re-broadcast of the same climb.
    queue.currentClimbQueueItem = makeQueueItem('climb-1');
    act(() => {
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );
    });
    await waitFor(() => {
      expect(queue.confirmClimbOnWall).toHaveBeenCalled();
    });

    // No third write, and nothing un-mirrored went out.
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(2);
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenLastCalledWith(
      'p1r12',
      true,
      expect.anything(),
      expect.anything(),
    );
  });

  it('falls back to the queue item once the current climb changes', async () => {
    bluetooth.sendFramesToBoardForOptions = () => async (frames, mirrored, signal, sendContext) =>
      bluetooth.state.sendFramesToBoard(frames, mirrored, signal, sendContext);

    const { rerender } = renderProvider(createElement(BluetoothProbe));
    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);
    });

    act(() => {
      capturedBluetooth?.setMirrorIntent('climb-1', true);
    });
    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(2);
    });

    // Navigating to another climb must not carry the previous climb's flip.
    queue.currentClimbQueueItem = makeQueueItem('climb-2', 'p2r12');
    act(() => {
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );
    });

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(3);
    });
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenLastCalledWith(
      'p2r12',
      false,
      expect.anything(),
      expect.anything(),
    );
  });

  it('skips the duplicate send when connect() already wrote the same frames, but still confirms', async () => {
    // connect(initialFrames) wrote the current climb before the AutoSender
    // mounted; the seed must suppress the byte-identical re-send (and its
    // doubled haptic) while still confirming the wall state.
    bluetooth.state.connectInitialSendRef.current = {
      frames: 'p1r12',
      mirrored: false,
      colorSignature: 'default',
      encodingSignature: 'default',
    };

    renderProvider();

    await waitFor(() => {
      expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
    });

    expect(bluetooth.state.sendFramesToBoard).not.toHaveBeenCalled();
    // One-shot: the seed is consumed on first pickup.
    expect(bluetooth.state.connectInitialSendRef.current).toBeNull();
  });

  it('still sends when connect() wrote different frames than the current climb', async () => {
    // e.g. the create-climb editor connected with its in-progress frames; the
    // queue's current climb differs, so the AutoSender must not be suppressed.
    bluetooth.state.connectInitialSendRef.current = {
      frames: 'p9r15',
      mirrored: false,
      colorSignature: 'default',
      encodingSignature: 'default',
    };

    renderProvider();

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith(
        'p1r12',
        false,
        expect.any(AbortSignal),
        expect.objectContaining({ sendSource: 'auto' }),
      );
    });
    expect(bluetooth.state.connectInitialSendRef.current).toBeNull();
  });

  it('does not suppress a MoonBoard send when the connect seed used different encoding', async () => {
    queue.currentClimbQueueItem = makeQueueItem('moon-climb', 'p1r42');
    bluetooth.state.connectInitialSendRef.current = {
      frames: 'p1r42',
      mirrored: false,
      colorSignature: 'default',
      encodingSignature: 'moonboard:adjacent-holds',
    };

    renderMoonboardProvider();

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith(
        'p1r42',
        false,
        expect.any(AbortSignal),
        expect.objectContaining({ sendSource: 'auto' }),
      );
    });
    expect(bluetooth.state.connectInitialSendRef.current).toBeNull();
  });

  it('keeps the local wall confirm in solo mode without sending a session mutation', async () => {
    queue.sessionId = null;

    renderProvider();

    await waitFor(() => {
      expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
    });

    expect(queue.confirmClimbOnWall).not.toHaveBeenCalled();
  });

  it('auto-sends shared climb updates while connected regardless of party role', async () => {
    // Holder model (always-take): the auto-sender mounts on isConnected alone —
    // there is no driver/preview write-gate. Any connected member writes the wall
    // and becomes the board's connection holder. (Replaces the old "non-driver
    // does not auto-send" / "starts on becoming driver" / "aborts on losing wall
    // control" driver-gated tests.)

    renderProvider();

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith(
        'p1r12',
        false,
        expect.any(AbortSignal),
        expect.objectContaining({ sendSource: 'auto' }),
      );
    });
    expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
    expect(queue.confirmClimbOnWall).toHaveBeenCalledWith('climb-1');
  });

  it('re-sends the current climb when hold colours change during an in-flight auto-send', async () => {
    let resolveWrite: ((value: boolean) => void) | undefined;
    bluetooth.state.sendFramesToBoard
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveWrite = resolve;
          }),
      )
      .mockResolvedValue(true);

    renderProvider();

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await setHoldColorOverridesPreference({ HAND: '#123456' });
    });
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveWrite?.(true);
    });

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(2);
    });
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenNthCalledWith(
      2,
      'p1r12',
      false,
      expect.any(AbortSignal),
      expect.objectContaining({ sendSource: 'auto' }),
    );
  });

  it('keeps auto-sending while a restored session is waiting for JOIN to resolve identity', async () => {
    // Simulate the pre-JOIN window: sessionId is restored from storage (truthy)
    // but participantId is still null because JOIN hasn't returned yet. The
    // auto-sender mounts on isConnected alone (always-live), so it writes the
    // wall immediately without waiting on identity.
    queue.sessionId = 'session-1';
    queue.participantId = null;

    renderProvider();

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith(
        'p1r12',
        false,
        expect.any(AbortSignal),
        expect.objectContaining({ sendSource: 'auto' }),
      );
    });
    expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
    expect(queue.confirmClimbOnWall).toHaveBeenCalledWith('climb-1');
  });

  it('does not confirm the wall when the BLE write fails', async () => {
    bluetooth.state.sendFramesToBoard.mockResolvedValue(false);

    renderProvider();

    await waitFor(() => {
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledOnce();
    });

    expect(wallConfirm.emitWallConfirm).not.toHaveBeenCalled();
    expect(queue.confirmClimbOnWall).not.toHaveBeenCalled();
  });

  it('re-emits wall confirm on byte-identical duplicate broadcasts without another BLE write', async () => {
    const firstItem = makeQueueItem('climb-1');
    queue.currentClimbQueueItem = firstItem;
    const { rerender } = renderProvider();

    await waitFor(() => {
      expect(wallConfirm.emitWallConfirm).toHaveBeenCalledTimes(1);
    });

    queue.currentClimbQueueItem = { ...firstItem };
    rerender(
      createElement(BluetoothProvider, {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        children: createElement('div', null),
      }),
    );

    await waitFor(() => {
      expect(wallConfirm.emitWallConfirm).toHaveBeenCalledTimes(2);
    });

    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);
    expect(queue.confirmClimbOnWall).toHaveBeenCalledTimes(2);
  });

  it('does not double-report byte-identical wall confirms while the first report is pending', async () => {
    presence.enabled = true;
    presence.boardId = 99;
    queue.sessionId = null;
    const firstItem = makeQueueItem('climb-1');
    queue.currentClimbQueueItem = firstItem;
    let resolveReport: (value: boolean) => void = () => {};
    presence.reportClimbForBoard.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveReport = resolve;
      }),
    );

    const { rerender } = renderProvider();

    await waitFor(() => {
      expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
    });

    queue.currentClimbQueueItem = { ...firstItem };
    rerender(
      createElement(BluetoothProvider, {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
        children: createElement('div', null),
      }),
    );

    await waitFor(() => {
      expect(wallConfirm.emitWallConfirm).toHaveBeenCalledTimes(2);
    });
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReport(true);
    });
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
  });

  it('does not re-report a byte-identical wall confirm after acceptance while waiting for the live echo', async () => {
    presence.enabled = true;
    presence.boardId = 99;
    presence.currentClimb = null;
    queue.sessionId = null;
    const firstItem = makeQueueItem('climb-1');
    queue.currentClimbQueueItem = firstItem;
    const { rerender } = renderProvider();

    // Wait on the report itself (like the pending-report test above) — the
    // BoardClimbReported track call this used to wait on was removed in the
    // PostHog noise cleanup (054be4d55).
    await waitFor(() => {
      expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
    });

    queue.currentClimbQueueItem = { ...firstItem };
    rerender(
      createElement(BluetoothProvider, {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
        children: createElement('div', null),
      }),
    );

    await waitFor(() => {
      expect(wallConfirm.emitWallConfirm).toHaveBeenCalledTimes(2);
    });
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledTimes(1);
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
  });

  it('stores a newly connected board serial on active sessions', () => {
    renderProvider();

    bluetooth.options?.onConnectSuccess?.('SERIAL-1', makeConnectionHandle());

    expect(queue.setSessionBoardSerial).toHaveBeenCalledWith('SERIAL-1');
    expect(analytics.track).toHaveBeenCalledWith('Session Board Serial Set', {
      mode: 'party',
      previousSerialKnown: false,
      boardLayout: 'kilter',
      boardId: undefined,
    });
  });

  it('suppresses board serial writes outside sessions or when the serial is unchanged', () => {
    queue.sessionId = null;
    renderProvider();

    bluetooth.options?.onConnectSuccess?.('SERIAL-1', makeConnectionHandle());
    expect(queue.setSessionBoardSerial).not.toHaveBeenCalled();

    queue.sessionId = 'session-1';
    queue.lastConnectedBoardSerial = 'SERIAL-1';
    cleanup();
    renderProvider();

    bluetooth.options?.onConnectSuccess?.('SERIAL-1', makeConnectionHandle());
    expect(queue.setSessionBoardSerial).not.toHaveBeenCalled();
  });

  it('threads the active board holds into the hook so mirrored sends can convert', () => {
    render(
      createElement(BluetoothProvider, {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '26, 27',
        children: createElement('div', null),
      }),
    );

    expect(boardDetails.getBoardRenderData).toHaveBeenCalledWith({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [26, 27],
    });
    expect((bluetooth.options as { holdsData?: unknown } | undefined)?.holdsData).toEqual([
      { id: 100, mirroredHoldId: 200, cx: 0, cy: 0, r: 1 },
    ]);
  });

  describe('board-presence wiring (flag on)', () => {
    it('resolves+binds the board on connect with the active board config', () => {
      presence.enabled = true;
      renderProvider();

      bluetooth.options?.onConnectSuccess?.('SERIAL-1', makeConnectionHandle());

      expect(presence.resolveAndBindBoard).toHaveBeenCalledWith({
        serial: 'SERIAL-1',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
      });
    });

    it('resolves against the immutable connection snapshot after the rendered route changes', () => {
      presence.enabled = true;
      const connection = makeConnectionHandle();
      const { rerender } = renderProvider();
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'tension',
          layoutId: 8,
          sizeId: 12,
          setIds: '3,4',
          children: createElement('div', null),
        }),
      );

      act(() => {
        bluetooth.options?.onConnectSuccess?.('SERIAL-1', connection);
      });

      expect(presence.resolveAndBindBoard).toHaveBeenCalledWith({
        serial: 'SERIAL-1',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
      });
    });

    it('attaches a cached board binding to a reconnect generation and releases that holder on disconnect', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      presence.resolveAndBindBoard.mockResolvedValueOnce({ boardId: 99 });
      bluetooth.state.isConnected = false;
      let attachedBoardId: number | undefined;
      const connection = makeConnectionHandle(2, '1,20', (boardId) => {
        attachedBoardId = boardId;
        return true;
      });
      const { rerender } = renderProvider();

      act(() => {
        bluetooth.options?.onConnectSuccess?.('SERIAL-1', connection);
      });
      await waitFor(() => {
        expect(attachedBoardId).toBe(99);
      });

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement('div', null),
        }),
      );
      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledWith(
          99,
          { uuid: 'queue-climb-1', climb: { uuid: 'climb-1' } },
          40,
        );
      });

      act(() => {
        bluetooth.options?.onConnectionEnded?.({
          reason: 'unexpected',
          disconnectTrigger: 'link_drop',
          connectionDurationSec: 8,
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          boardId: attachedBoardId,
          inSession: true,
        });
      });

      expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(99);
    });

    it('does not attach a rendered board id when the connection resolver returns null', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      let finishResolve: (binding: TestResolvedBoard | null) => void = () => {};
      presence.resolveAndBindBoard.mockReturnValueOnce(
        new Promise((resolve) => {
          finishResolve = resolve;
        }),
      );
      const setAnalyticsBoardId = vi.fn(() => true);
      renderProvider();

      act(() => {
        bluetooth.options?.onConnectSuccess?.('DIFFERENT-SERIAL', makeConnectionHandle(2, '1,20', setAnalyticsBoardId));
      });
      await act(async () => {
        finishResolve(null);
      });

      expect(setAnalyticsBoardId).not.toHaveBeenCalled();
      act(() => {
        bluetooth.options?.onConnectionEnded?.({
          reason: 'unexpected',
          disconnectTrigger: 'link_drop',
          connectionDurationSec: 3,
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          inSession: false,
        });
      });
      expect(presence.reportDisconnectForBoard).not.toHaveBeenCalled();
    });

    it('does NOT resolve the board on connect when the flag is off', () => {
      presence.enabled = false;
      renderProvider();

      bluetooth.options?.onConnectSuccess?.('SERIAL-1', makeConnectionHandle());

      expect(presence.resolveAndBindBoard).not.toHaveBeenCalled();
    });

    it('uses config fallback when connect succeeds without a serial', () => {
      presence.enabled = true;
      renderProvider();

      bluetooth.options?.onConnectSuccess?.(null, makeConnectionHandle());

      expect(presence.resolveAndBindBoard).not.toHaveBeenCalled();
      expect(presence.resolveAndBindBoardByConfig).toHaveBeenCalledWith({
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
      });
      expect(queue.setSessionBoardSerial).not.toHaveBeenCalled();
    });

    it('reports the lit climb to the wall on wall-confirm in a SOLO flow without showing an unarmed Undo snackbar', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      presence.currentClimb = makePresenceClimb();
      queue.sessionId = null;

      renderProvider();

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });
      expect(presence.reportClimbForBoard).toHaveBeenCalledWith(
        99,
        { uuid: 'queue-climb-1', climb: { uuid: 'climb-1' } },
        40,
      );
      expect(queue.confirmClimbOnWall).not.toHaveBeenCalled();

      expect(presence.showUndoWallChangeSnackbar).not.toHaveBeenCalled();
    });

    it('maps an unexpected hook end record to analytics and releases its snapshotted board', () => {
      renderProvider(createElement(BluetoothProbe));
      analytics.track.mockClear();
      queue.reportWallDisconnect.mockClear();
      presence.reportDisconnectForBoard.mockClear();

      bluetooth.options?.onConnectionEnded?.({
        reason: 'unexpected',
        disconnectTrigger: 'link_drop',
        connectionDurationSec: 151,
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
        boardId: 99,
        inSession: true,
        disconnectInfo: {
          source: 'native-ios',
          iosErrorCode: 7,
          errorDomain: 'CBErrorDomain',
          description: 'The specified device has disconnected from us.',
        },
      });

      expect(queue.reportWallDisconnect).toHaveBeenCalledOnce();
      expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(99);
      expect(analytics.track).toHaveBeenCalledWith('Bluetooth Disconnected', {
        reason: 'unexpected',
        disconnectTrigger: 'link_drop',
        connectionDurationSec: 151,
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
        boardId: 99,
        inSession: true,
        disconnectSource: 'native-ios',
        disconnectReason: 'The specified device has disconnected from us.',
        disconnectContext: undefined,
        disconnectIosCode: 7,
        disconnectAndroidCode: undefined,
        disconnectBleCode: undefined,
        disconnectErrorDomain: 'CBErrorDomain',
        disconnectCategory: 'peer_terminated',
      });
    });

    it('uses old-board attribution for a deliberate config switch and omits transport fields', () => {
      presence.boardId = 222;
      renderProvider(createElement(BluetoothProbe));
      analytics.track.mockClear();
      presence.reportDisconnectForBoard.mockClear();

      bluetooth.options?.onConnectionEnded?.({
        reason: 'user',
        disconnectTrigger: 'config_switch',
        connectionDurationSec: 12,
        boardName: 'tension',
        layoutId: 8,
        sizeId: 12,
        setIds: '3,4',
        boardId: 111,
        inSession: false,
      });

      expect(queue.reportWallDisconnect).toHaveBeenCalledWith('session-1');
      expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(111);
      const disconnectProperties = analytics.track.mock.calls.find(
        ([event]) => event === 'Bluetooth Disconnected',
      )?.[1];
      expect(disconnectProperties).toEqual(
        expect.objectContaining({
          reason: 'user',
          disconnectTrigger: 'config_switch',
          boardName: 'tension',
          boardId: 111,
          connectionDurationSec: 12,
        }),
      );
      expect(disconnectProperties).not.toHaveProperty('disconnectCategory');
      expect(disconnectProperties).not.toHaveProperty('disconnectSource');
    });

    it('coalesces repeated user disconnects while the adapter teardown is pending', async () => {
      let resolveAdapterDisconnect: () => void = () => {};
      bluetooth.state.disconnect.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveAdapterDisconnect = resolve;
        }),
      );
      bluetooth.state.isConnected = true;
      renderProvider(createElement(BluetoothProbe));

      let firstDisconnect: Promise<void> | undefined;
      let secondDisconnect: Promise<void> | undefined;
      act(() => {
        firstDisconnect = capturedBluetooth?.disconnect();
        secondDisconnect = capturedBluetooth?.disconnect();
      });

      expect(bluetooth.state.disconnect).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveAdapterDisconnect();
        await Promise.all([firstDisconnect, secondDisconnect]);
      });
      expect(bluetooth.state.disconnect).toHaveBeenCalledTimes(1);
    });

    it('shows the Undo snackbar once after an armed control gain reports a wall change', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      presence.currentClimb = makePresenceClimb();
      queue.sessionId = null;
      bluetooth.state.isConnected = false;

      const { rerender } = renderProvider(createElement(BluetoothProbe));
      capturedBluetooth?.armUndoWallChangeToast();

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });
      expect(presence.showUndoWallChangeSnackbar).toHaveBeenCalledTimes(1);

      presence.currentClimb = makePresenceClimb({ climbUuid: 'reported-first', frames: 'p1r12', seq: 8 });
      queue.currentClimbQueueItem = makeQueueItem('climb-2', 'p2r12');
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(2);
      });
      expect(presence.showUndoWallChangeSnackbar).toHaveBeenCalledTimes(1);
    });

    it('keeps the armed Undo snackbar for a retry after the first wall report is rejected', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      presence.currentClimb = makePresenceClimb();
      presence.reportClimbForBoard.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      queue.sessionId = null;
      bluetooth.state.isConnected = false;
      const firstItem = makeQueueItem('climb-1');
      queue.currentClimbQueueItem = firstItem;

      const { rerender } = renderProvider(createElement(BluetoothProbe));
      capturedBluetooth?.armUndoWallChangeToast();

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });
      expect(presence.showUndoWallChangeSnackbar).not.toHaveBeenCalled();

      queue.currentClimbQueueItem = { ...firstItem };
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(2);
      });
      expect(presence.showUndoWallChangeSnackbar).toHaveBeenCalledTimes(1);
    });

    it('does not show the Undo snackbar after the control-gain arm expires', async () => {
      vi.useFakeTimers();
      presence.enabled = true;
      presence.boardId = 99;
      presence.currentClimb = makePresenceClimb();
      queue.sessionId = null;
      bluetooth.state.isConnected = false;

      const { rerender } = renderProvider(createElement(BluetoothProbe));
      capturedBluetooth?.armUndoWallChangeToast();

      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      vi.useRealTimers();

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });
      expect(presence.showUndoWallChangeSnackbar).not.toHaveBeenCalled();
    });

    it('does not show the Undo snackbar when the armed report has no restorable frames', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      presence.currentClimb = makePresenceClimb({ frames: null });
      queue.sessionId = null;
      bluetooth.state.isConnected = false;

      const { rerender } = renderProvider(createElement(BluetoothProbe));
      capturedBluetooth?.armUndoWallChangeToast();

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });
      expect(presence.showUndoWallChangeSnackbar).not.toHaveBeenCalled();
    });

    it('does NOT report to the wall when no board is bound', async () => {
      presence.enabled = true;
      presence.boardId = null;

      renderProvider();

      await waitFor(() => {
        expect(wallConfirm.emitWallConfirm).toHaveBeenCalled();
      });
      expect(presence.reportClimbForBoard).not.toHaveBeenCalled();
      expect(presence.showUndoWallChangeSnackbar).not.toHaveBeenCalled();
    });

    it('does NOT report to the wall when the flag is off', async () => {
      presence.enabled = false;
      presence.boardId = 99;

      renderProvider();

      await waitFor(() => {
        expect(wallConfirm.emitWallConfirm).toHaveBeenCalled();
      });
      expect(presence.reportClimbForBoard).not.toHaveBeenCalled();
    });

    it('buffers the first wall-confirm while connect board resolution is pending, ignoring stale board ids', async () => {
      presence.enabled = true;
      presence.boardId = 88;
      bluetooth.state.isConnected = false;
      let resolveBoard: (value: { boardId: number }) => void = () => {};
      presence.resolveAndBindBoard.mockReturnValue(
        new Promise((resolve) => {
          resolveBoard = resolve;
        }),
      );

      const { rerender } = renderProvider();
      bluetooth.options?.onConnectSuccess?.('SERIAL-PENDING', makeConnectionHandle());

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          children: createElement('div', null),
        }),
      );

      await waitFor(() => {
        expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
      });
      expect(presence.reportClimbForBoard).not.toHaveBeenCalled();

      resolveBoard({ boardId: 123 });

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledWith(
          123,
          { uuid: 'queue-climb-1', climb: { uuid: 'climb-1' } },
          40,
        );
      });
    });

    it('ignores a generation-one resolve that lands during generation two, then accepts generation two', async () => {
      presence.enabled = true;
      presence.boardId = null;
      bluetooth.state.isConnected = false;
      let resolveGenerationOne: (value: { boardId: number }) => void = () => {};
      let resolveGenerationTwo: (value: { boardId: number }) => void = () => {};
      presence.resolveAndBindBoard
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveGenerationOne = resolve;
          }),
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveGenerationTwo = resolve;
          }),
        );
      const setGenerationOneBoardId = vi.fn(() => false);
      const setGenerationTwoBoardId = vi.fn(() => true);
      const generationOne = makeConnectionHandle(1, '1,20', setGenerationOneBoardId);
      const generationTwo = makeConnectionHandle(2, '1,20', setGenerationTwoBoardId);

      const { rerender } = renderProvider();
      bluetooth.options?.onConnectSuccess?.('SERIAL-ONE', generationOne);
      bluetooth.options?.onConnectSuccess?.('SERIAL-TWO', generationTwo);

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement('div', null),
        }),
      );
      await waitFor(() => {
        expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
      });

      await act(async () => {
        resolveGenerationOne({ boardId: 111 });
      });
      expect(setGenerationOneBoardId).toHaveBeenCalledWith(111);
      expect(presence.reportClimbForBoard).not.toHaveBeenCalled();

      await act(async () => {
        resolveGenerationTwo({ boardId: 222 });
      });
      expect(setGenerationTwoBoardId).toHaveBeenCalledWith(222);
      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledWith(
          222,
          { uuid: 'queue-climb-1', climb: { uuid: 'climb-1' } },
          40,
        );
      });
    });

    it('attaches a shared pending same-wall resolve to generation two and releases its holder', async () => {
      presence.enabled = true;
      presence.boardId = null;
      bluetooth.state.isConnected = false;
      let resolveSharedBinding: (value: { boardId: number }) => void = () => {};
      const sharedBindingPromise = new Promise<{ boardId: number }>((resolve) => {
        resolveSharedBinding = resolve;
      });
      presence.resolveAndBindBoard.mockReturnValue(sharedBindingPromise);
      const setGenerationOneBoardId = vi.fn(() => false);
      let generationTwoBoardId: number | undefined;
      const setGenerationTwoBoardId = vi.fn((boardId: number) => {
        generationTwoBoardId = boardId;
        return true;
      });
      const generationOne = makeConnectionHandle(1, '1,20', setGenerationOneBoardId);
      const generationTwo = makeConnectionHandle(2, '1,20', setGenerationTwoBoardId);

      const { rerender } = renderProvider();
      bluetooth.options?.onConnectSuccess?.('SAME-SERIAL', generationOne);
      bluetooth.options?.onConnectSuccess?.('SAME-SERIAL', generationTwo);
      expect(presence.resolveAndBindBoard).toHaveBeenCalledTimes(2);

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement('div', null),
        }),
      );
      await waitFor(() => {
        expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
      });
      expect(presence.reportClimbForBoard).not.toHaveBeenCalled();

      await act(async () => {
        resolveSharedBinding({ boardId: 321 });
      });
      expect(setGenerationOneBoardId).toHaveBeenCalledWith(321);
      expect(setGenerationTwoBoardId).toHaveBeenCalledWith(321);
      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledWith(
          321,
          { uuid: 'queue-climb-1', climb: { uuid: 'climb-1' } },
          40,
        );
      });

      presence.reportDisconnectForBoard.mockClear();
      act(() => {
        bluetooth.options?.onConnectionEnded?.({
          reason: 'unexpected',
          disconnectTrigger: 'link_drop',
          connectionDurationSec: 6,
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          boardId: generationTwoBoardId,
          inSession: true,
        });
      });
      expect(generationTwoBoardId).toBe(321);
      expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(321);
    });

    it('preserves the armed Undo snackbar while a wall report waits for board resolution', async () => {
      presence.enabled = true;
      presence.boardId = null;
      presence.currentClimb = makePresenceClimb();
      bluetooth.state.isConnected = false;
      let resolveBoard: (value: { boardId: number }) => void = () => {};
      presence.resolveAndBindBoard.mockReturnValue(
        new Promise((resolve) => {
          resolveBoard = resolve;
        }),
      );

      const { rerender } = renderProvider(createElement(BluetoothProbe));
      bluetooth.options?.onConnectSuccess?.('SERIAL-PENDING', makeConnectionHandle());
      capturedBluetooth?.armUndoWallChangeToast();

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );

      await waitFor(() => {
        expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
      });
      expect(presence.reportClimbForBoard).not.toHaveBeenCalled();

      resolveBoard({ boardId: 123 });

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });
      expect(presence.showUndoWallChangeSnackbar).toHaveBeenCalledTimes(1);
    });

    it('drops an armed pending wall report when the board disconnects before resolution completes', async () => {
      presence.enabled = true;
      presence.boardId = null;
      presence.currentClimb = makePresenceClimb();
      bluetooth.state.isConnected = false;
      let resolveBoard: (value: { boardId: number }) => void = () => {};
      presence.resolveAndBindBoard.mockReturnValue(
        new Promise((resolve) => {
          resolveBoard = resolve;
        }),
      );

      const { rerender } = renderProvider(createElement(BluetoothProbe));
      bluetooth.options?.onConnectSuccess?.('SERIAL-PENDING', makeConnectionHandle());
      capturedBluetooth?.armUndoWallChangeToast();

      bluetooth.state.isConnected = true;
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement(BluetoothProbe),
        }),
      );

      await waitFor(() => {
        expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
      });
      expect(presence.reportClimbForBoard).not.toHaveBeenCalled();

      await act(async () => {
        await capturedBluetooth?.disconnect();
      });

      await act(async () => {
        resolveBoard({ boardId: 123 });
      });

      expect(presence.reportClimbForBoard).not.toHaveBeenCalled();
      expect(presence.showUndoWallChangeSnackbar).not.toHaveBeenCalled();
    });

    it('does not poison same-climb retries when a report is rejected', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      presence.reportClimbForBoard.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const firstItem = makeQueueItem('climb-1');
      queue.currentClimbQueueItem = firstItem;
      const { rerender } = renderProvider();

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });

      queue.currentClimbQueueItem = { ...firstItem };
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          children: createElement('div', null),
        }),
      );

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(2);
      });
      expect(presence.showUndoWallChangeSnackbar).not.toHaveBeenCalled();
    });

    it('re-reports the same uuid after an external wall change', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      const firstItem = makeQueueItem('climb-1');
      queue.currentClimbQueueItem = firstItem;
      const { rerender } = renderProvider();

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });

      presence.currentClimb = makePresenceClimb({
        climbUuid: 'other-phone-climb',
        frames: 'p9r9',
        seq: 2,
      });
      queue.currentClimbQueueItem = { ...firstItem };
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          children: createElement('div', null),
        }),
      );

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(2);
      });
    });

    it('undo resends the captured wall climb over BLE before re-reporting it', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      presence.currentClimb = makePresenceClimb();

      renderProvider(createElement(BluetoothProbe));

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });

      const undoResult = await capturedBluetooth?.undoWallChange();

      expect(undoResult).toBe(true);
      expect(bluetooth.state.sendFramesToBoard).toHaveBeenNthCalledWith(
        2,
        'previous-frames',
        false,
        undefined,
        expect.objectContaining({ sendSource: 'undo' }),
      );
      expect(presence.reportClimbForBoard).toHaveBeenNthCalledWith(
        2,
        99,
        {
          uuid: 'queue-previous-climb',
          climb: {
            uuid: 'previous-climb',
            setter_username: 'setter',
            name: 'Previous climb',
            frames: 'previous-frames',
            angle: 35,
            ascensionist_count: 0,
            difficulty: 'V4',
            quality_average: '',
            stars: 0,
            difficulty_error: '',
          },
        },
        35,
      );
    });

    it('does not include raw serial values in board-presence analytics', async () => {
      presence.enabled = true;
      presence.boardId = 99;
      presence.resolveAndBindBoard.mockResolvedValueOnce({ boardId: 99 });
      renderProvider();

      bluetooth.options?.onConnectSuccess?.('SERIAL-SECRET-123', makeConnectionHandle());

      await waitFor(() => {
        expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
      });

      const allTrackedValues = analytics.track.mock.calls.flatMap(([, properties]) => Object.values(properties ?? {}));
      expect(allTrackedValues).not.toContain('SERIAL-SECRET-123');
    });
  });

  it('forwards picker selection immediately when the resolved board config matches', () => {
    const handleSelect = vi.fn();
    bluetooth.state.pickerState = {
      devices: [{ deviceId: 'device-1', name: 'Kilter Board#SN-1@3', rssi: -40 }],
      isScanning: false,
      handleSelect,
      handleCancel: vi.fn(),
    };
    resolvedBoards.value = new Map([['SN-1', { kind: 'recorded', config: makeSerialConfig({ setIds: '20,1' }) }]]);

    renderProvider();
    pickerSheet.props?.onSelect('device-1');

    expect(handleSelect).toHaveBeenCalledWith('device-1');
    expect(alert.alert).not.toHaveBeenCalled();
  });

  it('asks before forwarding picker selection when the resolved board config mismatches', () => {
    const handleSelect = vi.fn();
    bluetooth.state.pickerState = {
      devices: [{ deviceId: 'device-2', name: 'Tension Board#SN-2@2', rssi: -50 }],
      isScanning: false,
      handleSelect,
      handleCancel: vi.fn(),
    };
    resolvedBoards.value = new Map([
      ['SN-2', { kind: 'recorded', config: makeSerialConfig({ serialNumber: 'SN-2', boardName: 'tension' }) }],
    ]);

    renderProvider();
    pickerSheet.props?.onSelect('device-2');

    expect(handleSelect).not.toHaveBeenCalled();
    expect(alert.alert).toHaveBeenCalledOnce();

    const buttons = alert.alert.mock.calls[0]?.[2] as Array<{ onPress?: () => void }> | undefined;
    buttons?.[1]?.onPress?.();
    expect(handleSelect).toHaveBeenCalledWith('device-2');
  });

  describe('wall disconnect on BLE drop', () => {
    it('reports wall disconnect to the session on an explicit user disconnect', async () => {
      renderProvider(createElement(BluetoothProbe));

      await waitFor(() => {
        expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalled();
      });
      queue.reportWallDisconnect.mockClear();
      bluetooth.state.disconnect.mockImplementation(async () => {
        bluetooth.options?.onConnectionEnded?.({
          reason: 'user',
          disconnectTrigger: 'explicit_user',
          connectionDurationSec: 4,
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          inSession: true,
        });
      });

      await act(async () => {
        await capturedBluetooth?.disconnect();
      });

      expect(queue.reportWallDisconnect).toHaveBeenCalled();
    });

    it('reports wall disconnect to the session on an unexpected BLE drop', async () => {
      renderProvider();

      await waitFor(() => {
        expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalled();
      });
      queue.reportWallDisconnect.mockClear();

      act(() => {
        bluetooth.options?.onConnectionEnded?.({
          reason: 'unexpected',
          disconnectTrigger: 'link_drop',
          connectionDurationSec: 4,
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          inSession: true,
          disconnectInfo: { source: 'ble-plx' },
        });
      });

      expect(queue.reportWallDisconnect).toHaveBeenCalled();
    });

    it('clears the current session when the BLE connection opened solo and joined later', () => {
      queue.sessionId = null;
      const { rerender } = renderProvider();
      queue.sessionId = 'session-B';
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement('div', null),
        }),
      );
      queue.reportWallDisconnect.mockClear();

      act(() => {
        bluetooth.options?.onConnectionEnded?.({
          reason: 'unexpected',
          disconnectTrigger: 'link_drop',
          connectionDurationSec: 8,
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          inSession: false,
        });
      });

      expect(queue.reportWallDisconnect).toHaveBeenCalledWith('session-B');
    });

    it('clears session B rather than stale session A after the active session changes', () => {
      queue.sessionId = 'session-A';
      const { rerender } = renderProvider();
      queue.sessionId = 'session-B';
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          children: createElement('div', null),
        }),
      );
      queue.reportWallDisconnect.mockClear();

      act(() => {
        bluetooth.options?.onConnectionEnded?.({
          reason: 'user',
          disconnectTrigger: 'explicit_user',
          connectionDurationSec: 8,
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          inSession: true,
        });
      });

      expect(queue.reportWallDisconnect).toHaveBeenCalledOnce();
      expect(queue.reportWallDisconnect).toHaveBeenCalledWith('session-B');
      expect(queue.reportWallDisconnect).not.toHaveBeenCalledWith('session-A');
    });
  });
});
