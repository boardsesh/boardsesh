// @vitest-environment jsdom
import { act, render, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import type { PickerState } from '../../lib/ble/use-board-bluetooth';
import { setHoldColorOverridesPreference } from '../../lib/hold-color-overrides';

type TestResolvedBoard = { boardId: number };

type BluetoothHookOptions = {
  onConnectSuccess?: (serial: string | null) => void;
  holdsData?: unknown;
};
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
  reportWallDisconnect: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
}));

const bluetooth = vi.hoisted(() => {
  const mock = {
    options: undefined as BluetoothHookOptions | undefined,
    state: {
      isConnected: true,
      loading: false,
      connect: vi.fn(async () => true),
      disconnect: vi.fn(async () => {}),
      sendFramesToBoard: vi.fn<SendFramesToBoard>(async () => true),
      pickerState: null as PickerState | null,
      reconnectSerialForCurrentBoard: null,
      connectInitialSendRef: { current: null as { frames: string; mirrored: boolean; colorSignature: string } | null },
    },
    useBoardBluetooth: vi.fn((options: BluetoothHookOptions) => {
      mock.options = options;
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
}));

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

vi.mock('../queue-provider', () => ({
  useQueue: () => ({
    state: { currentClimbQueueItem: queue.currentClimbQueueItem, queue: [] },
  }),
  useQueueActions: () => ({ setCurrentClimb: vi.fn() }),
  useQueueSessionControls: () => ({
    sessionId: queue.sessionId,
    participantId: queue.participantId,
    lastConnectedBoardSerial: queue.lastConnectedBoardSerial,
    confirmClimbOnWall: queue.confirmClimbOnWall,
    reportWallDisconnect: queue.reportWallDisconnect,
    setSessionBoardSerial: queue.setSessionBoardSerial,
  }),
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
    bluetooth.state.isConnected = true;
    bluetooth.state.loading = false;
    bluetooth.state.pickerState = null;
    bluetooth.state.reconnectSerialForCurrentBoard = null;
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

  it('skips the duplicate send when connect() already wrote the same frames, but still confirms', async () => {
    // connect(initialFrames) wrote the current climb before the AutoSender
    // mounted; the seed must suppress the byte-identical re-send (and its
    // doubled haptic) while still confirming the wall state.
    bluetooth.state.connectInitialSendRef.current = { frames: 'p1r12', mirrored: false, colorSignature: 'default' };

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
    bluetooth.state.connectInitialSendRef.current = { frames: 'p9r15', mirrored: false, colorSignature: 'default' };

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

    await waitFor(() => {
      expect(analytics.track).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ climbUuid: 'climb-1' }),
      );
    });
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);

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

    bluetooth.options?.onConnectSuccess?.('SERIAL-1');

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

    bluetooth.options?.onConnectSuccess?.('SERIAL-1');
    expect(queue.setSessionBoardSerial).not.toHaveBeenCalled();

    queue.sessionId = 'session-1';
    queue.lastConnectedBoardSerial = 'SERIAL-1';
    cleanup();
    renderProvider();

    bluetooth.options?.onConnectSuccess?.('SERIAL-1');
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

      bluetooth.options?.onConnectSuccess?.('SERIAL-1');

      expect(presence.resolveAndBindBoard).toHaveBeenCalledWith({
        serial: 'SERIAL-1',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,20',
      });
    });

    it('does NOT resolve the board on connect when the flag is off', () => {
      presence.enabled = false;
      renderProvider();

      bluetooth.options?.onConnectSuccess?.('SERIAL-1');

      expect(presence.resolveAndBindBoard).not.toHaveBeenCalled();
    });

    it('uses config fallback when connect succeeds without a serial', () => {
      presence.enabled = true;
      renderProvider();

      bluetooth.options?.onConnectSuccess?.(null);

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
      bluetooth.options?.onConnectSuccess?.('SERIAL-PENDING');

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
      bluetooth.options?.onConnectSuccess?.('SERIAL-PENDING');
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
      bluetooth.options?.onConnectSuccess?.('SERIAL-PENDING');
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

      bluetooth.options?.onConnectSuccess?.('SERIAL-SECRET-123');

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

      await act(async () => {
        await capturedBluetooth?.disconnect();
      });

      expect(queue.reportWallDisconnect).toHaveBeenCalled();
    });

    it('reports wall disconnect to the session on an unexpected BLE drop', async () => {
      const { rerender } = renderProvider();

      await waitFor(() => {
        expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalled();
      });
      queue.reportWallDisconnect.mockClear();

      // Simulate an involuntary drop: isConnected flips true -> false with no
      // user-initiated disconnect in flight. The drop effect frees the board
      // hold and broadcasts WallDisconnected to the session.
      bluetooth.state.isConnected = false;
      await act(async () => {
        rerender(
          createElement(BluetoothProvider, {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,20',
            children: createElement('div', null),
          }),
        );
      });

      expect(queue.reportWallDisconnect).toHaveBeenCalled();
    });
  });
});
