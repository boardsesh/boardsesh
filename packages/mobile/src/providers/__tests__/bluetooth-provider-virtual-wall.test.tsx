// @vitest-environment jsdom
//
// A wall with no LED light kit. The provider gains a second commit backend —
// "settle, then report" instead of "write bytes, then report" — behind the same
// seam the BLE path uses, so everything downstream (the latest-wins drain loop,
// the confirm fan-out, the re-take dedup, the undo target) is reused verbatim.
//
// The invariants pinned here are the ones a wrong answer breaks quietly:
//   * a physical link always wins, even when both flags are momentarily true;
//   * a fast swipe coalesces, so the gym kiosk's history isn't polluted;
//   * a peer taking the server's holder slot ends this device's hold, because a
//     virtual hold has no radio enforcing exclusivity.
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import type { BleConnectionEnded, BleConnectionHandle, PickerState } from '../../lib/ble/use-board-bluetooth';
import { setHoldColorOverridesPreference } from '../../lib/hold-color-overrides';

type BluetoothHookOptions = {
  onConnectSuccess?: (serial: string | null, connection: BleConnectionHandle) => void;
  onConnectionEnded?: (connection: BleConnectionEnded) => void;
  holdsData?: unknown;
};

type SendFramesToBoard = (
  frames: string,
  mirrored?: boolean,
  signal?: AbortSignal,
  sendContext?: unknown,
) => Promise<boolean | undefined>;

const wallConfirm = vi.hoisted(() => ({ emitWallConfirm: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const haptics = vi.hoisted(() => ({ hapticLight: vi.fn(), hapticSuccess: vi.fn(), hapticError: vi.fn() }));

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
      isConnected: false,
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
  enabled: true,
  boardId: 42 as number | null,
  currentClimb: null as BoardPresenceClimb | null,
  holder: null as { userId?: string | null; displayName?: string | null } | null,
  resolveAndBindBoard: vi.fn(async () => null),
  resolveAndBindBoardByConfig: vi.fn(async () => null),
  resolveAndBindBoardByUuid: vi.fn(async () => null),
  restampBoardMembershipByUuid: vi.fn(async () => true),
  reportClimbForBoard: vi.fn(
    async (_boardId: number, _climb: { climb: { uuid: string } }, _angle: number | null) => true,
  ),
  reportDisconnectForBoard: vi.fn(async () => true),
  showUndoWallChangeSnackbar: vi.fn(),
}));

const viewer = vi.hoisted(() => ({ profile: { id: 'me' } as { id: string } | null }));

const resolvedBoards = vi.hoisted(() => ({ value: new Map<string, ResolvedBoardEntry>() }));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios', Version: 0 },
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
}));

vi.mock('@tanstack/react-query', () => ({
  // The provider reads the viewer's id off the shared ['profile'] cache entry.
  useQuery: () => ({ data: viewer.profile }),
}));

vi.mock('../../settings', () => ({
  useSetting: (key: string) => (key === 'autoDisconnectBle' ? [false, vi.fn()] : [30, vi.fn()]),
}));

vi.mock('@boardsesh/play-view', () => ({ emitWallConfirm: wallConfirm.emitWallConfirm }));

vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceCurrent: () => ({
    currentClimb: presence.currentClimb,
    previousClimb: null,
    undoTarget: null,
    holder: presence.holder,
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
    restampBoardMembershipByUuid: presence.restampBoardMembershipByUuid,
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

vi.mock('../../lib/ble/use-board-bluetooth', () => ({ useBoardBluetooth: bluetooth.useBoardBluetooth }));
vi.mock('../../lib/ble/resolve-serials', () => ({ useResolvedBleDeviceBoards: () => resolvedBoards.value }));
vi.mock('../../lib/ble/bluetooth-status-store', () => ({ registerBluetoothConnection: vi.fn(() => vi.fn()) }));
vi.mock('../../lib/haptics', () => haptics);
vi.mock('../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../lib/graphql/use-active-board', () => ({ useSetActiveBoard: () => vi.fn(async () => {}) }));
vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: vi.fn(async () => ({ board: null })) }),
}));

vi.mock('../../components/ble/DevicePickerSheet', () => ({
  DevicePickerSheet: () => createElement('div', { 'data-testid': 'device-picker' }),
}));

vi.mock('../queue-provider', () => ({
  useQueue: () => ({ state: { currentClimbQueueItem: queue.currentClimbQueueItem, queue: [] } }),
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

vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: toast.showToast }) }));

vi.mock('../../lib/board-details', () => ({
  getBoardRenderData: vi.fn(() => ({ holdsData: [{ id: 100, mirroredHoldId: 200, cx: 0, cy: 0, r: 1 }] })),
}));

import { BluetoothProvider, useBluetoothContext } from '../bluetooth-provider';

// Must match VIRTUAL_WALL_SETTLE_MS in the provider.
const SETTLE_MS = 600;

function makeQueueItem(uuid: string, frames = `p1r12-${uuid}`): ClimbQueueItem {
  return {
    uuid: `queue-${uuid}`,
    climb: {
      uuid,
      name: `Climb ${uuid}`,
      frames,
      mirrored: false,
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

let capturedBluetooth: ReturnType<typeof useBluetoothContext> | null = null;

function BluetoothProbe() {
  capturedBluetooth = useBluetoothContext();
  return null;
}

function renderProvider({ hasLeds = false }: { hasLeds?: boolean } = {}) {
  return render(
    createElement(BluetoothProvider, {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      boardUuid: 'board-uuid-1',
      hasLeds,
      children: createElement(BluetoothProbe, null) as ReactNode,
    }),
  );
}

async function takeTheWall() {
  await act(async () => {
    capturedBluetooth?.takeVirtualWall();
  });
}

/** Let the settle window elapse and the drain loop's continuation run. */
async function settle(times = 1) {
  for (let pass = 0; pass < times; pass += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 50);
    });
  }
}

describe('BluetoothProvider — taking a wall with no LED light kit', () => {
  beforeEach(async () => {
    await setHoldColorOverridesPreference({});
    vi.useFakeTimers();
    queue.currentClimbQueueItem = makeQueueItem('climb-1');
    queue.sessionId = 'session-1';
    queue.confirmClimbOnWall.mockClear();
    queue.reportWallDisconnect.mockClear();
    wallConfirm.emitWallConfirm.mockClear();
    analytics.track.mockClear();
    toast.showToast.mockClear();
    haptics.hapticLight.mockClear();
    haptics.hapticSuccess.mockClear();
    bluetooth.state.isConnected = false;
    bluetooth.state.loading = false;
    bluetooth.state.sendFramesToBoard.mockReset();
    bluetooth.state.sendFramesToBoard.mockResolvedValue(true);
    bluetooth.state.connectInitialSendRef.current = null;
    presence.enabled = true;
    presence.boardId = 42;
    presence.currentClimb = null;
    presence.holder = null;
    presence.reportClimbForBoard.mockClear();
    presence.reportClimbForBoard.mockResolvedValue(true);
    presence.reportDisconnectForBoard.mockClear();
    presence.restampBoardMembershipByUuid.mockClear();
    presence.restampBoardMembershipByUuid.mockResolvedValue(true);
    viewer.profile = { id: 'me' };
    capturedBluetooth = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('reports the current climb with no Bluetooth write at all', async () => {
    renderProvider();
    expect(presence.reportClimbForBoard).not.toHaveBeenCalled();

    await takeTheWall();
    await settle();

    // The whole confirm fan-out fires — the same three things a BLE write does.
    expect(wallConfirm.emitWallConfirm).toHaveBeenCalledWith('climb-1');
    expect(queue.confirmClimbOnWall).toHaveBeenCalledWith('climb-1');
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
    expect(presence.reportClimbForBoard).toHaveBeenCalledWith(
      42,
      { uuid: 'queue-climb-1', climb: { uuid: 'climb-1' } },
      40,
    );
    // Zero bytes: nothing reached the radio.
    expect(bluetooth.state.sendFramesToBoard).not.toHaveBeenCalled();
  });

  it('coalesces a fast swipe, so the gym kiosk history gets two entries and not five', async () => {
    // The settle window stands in for the physical write's latency, which is the
    // only reason the existing drain loop coalesces at all. Without it every
    // climb a thumb passes through lands a durable board_climb_events row.
    const { rerender } = renderProvider();
    await takeTheWall();

    for (const index of [2, 3, 4, 5]) {
      queue.currentClimbQueueItem = makeQueueItem(`climb-${index}`);
      await act(async () => {
        rerender(
          createElement(BluetoothProvider, {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 10,
            setIds: '1,20',
            boardUuid: 'board-uuid-1',
            hasLeds: false,
            children: createElement(BluetoothProbe, null) as ReactNode,
          }),
        );
      });
    }

    await settle(3);

    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(2);
    const reportedUuids = presence.reportClimbForBoard.mock.calls.map((call) => call[1].climb.uuid);
    // The one it started on, and the one the thumb stopped on.
    expect(reportedUuids[0]).toBe('climb-1');
    expect(reportedUuids[reportedUuids.length - 1]).toBe('climb-5');
  });

  it('does not report the same climb twice', async () => {
    renderProvider();
    await takeTheWall();
    await settle(2);
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
  });

  it('releases the holder slot and stops reporting when the wall is handed back', async () => {
    const { rerender } = renderProvider();
    await takeTheWall();
    await settle();
    presence.reportClimbForBoard.mockClear();

    await act(async () => {
      capturedBluetooth?.releaseVirtualWall();
    });

    expect(queue.reportWallDisconnect).toHaveBeenCalled();
    expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(42);
    expect(capturedBluetooth?.virtualWallHeld).toBe(false);

    queue.currentClimbQueueItem = makeQueueItem('climb-after-release');
    await act(async () => {
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          boardUuid: 'board-uuid-1',
          hasLeds: false,
          children: createElement(BluetoothProbe, null) as ReactNode,
        }),
      );
    });
    await settle();
    expect(presence.reportClimbForBoard).not.toHaveBeenCalled();
  });

  it('takes the wall on a board that still claims to have lights', async () => {
    // The device picker offers this after a scan finds nothing, on a board whose
    // server flag has not been (and must not be) changed. Guarding the take on
    // `ledless` would make that offer inert on 99% of boards.
    renderProvider({ hasLeds: true });
    await takeTheWall();
    await settle();

    expect(capturedBluetooth?.virtualWallHeld).toBe(true);
    expect(capturedBluetooth?.ledless).toBe(false);
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
    expect(bluetooth.state.sendFramesToBoard).not.toHaveBeenCalled();
  });

  it('never confirms a climb the user navigated away from mid-settle', async () => {
    const view = renderProvider();
    await takeTheWall();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS / 2);
    });
    presence.reportClimbForBoard.mockClear();
    wallConfirm.emitWallConfirm.mockClear();

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    });

    expect(wallConfirm.emitWallConfirm).not.toHaveBeenCalled();
    expect(presence.reportClimbForBoard).not.toHaveBeenCalled();
  });
});

describe('BluetoothProvider — a real link always wins over a virtual hold', () => {
  beforeEach(async () => {
    await setHoldColorOverridesPreference({});
    vi.useFakeTimers();
    queue.currentClimbQueueItem = makeQueueItem('climb-1');
    queue.sessionId = null;
    bluetooth.state.isConnected = false;
    bluetooth.state.sendFramesToBoard.mockReset();
    bluetooth.state.sendFramesToBoard.mockResolvedValue(true);
    bluetooth.state.connectInitialSendRef.current = null;
    presence.enabled = true;
    presence.boardId = 42;
    presence.holder = null;
    presence.reportClimbForBoard.mockClear();
    presence.reportClimbForBoard.mockResolvedValue(true);
    presence.reportDisconnectForBoard.mockClear();
    wallConfirm.emitWallConfirm.mockClear();
    viewer.profile = { id: 'me' };
    capturedBluetooth = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function rerenderWith(rerender: (element: React.ReactElement) => void) {
    return act(async () => {
      rerender(
        createElement(BluetoothProvider, {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,20',
          boardUuid: 'board-uuid-1',
          hasLeds: false,
          children: createElement(BluetoothProbe, null) as ReactNode,
        }),
      );
    });
  }

  it('writes real bytes the moment BLE connects, even while the hold is still set', async () => {
    // The commit seam tests `isConnected` BEFORE the virtual hold, so the branch
    // is decided by the radio and not by whether the auto-release effect has run
    // yet. Both flags true for one commit must still reach the wall.
    const { rerender } = renderProvider();
    await takeTheWall();
    await settle();
    expect(bluetooth.state.sendFramesToBoard).not.toHaveBeenCalled();

    bluetooth.state.isConnected = true;
    queue.currentClimbQueueItem = makeQueueItem('climb-connected');
    await rerenderWith(rerender);
    await settle();

    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith(
      'p1r12-climb-connected',
      false,
      expect.any(AbortSignal),
      expect.objectContaining({ sendSource: 'auto' }),
    );
  });

  it('drops the virtual hold when BLE connects', async () => {
    const { rerender } = renderProvider();
    await takeTheWall();
    expect(capturedBluetooth?.virtualWallHeld).toBe(true);

    bluetooth.state.isConnected = true;
    await rerenderWith(rerender);

    expect(capturedBluetooth?.virtualWallHeld).toBe(false);
    expect(capturedBluetooth?.canDriveWall).toBe(true);
  });

  it('gives the wall up when another signed-in climber takes the holder slot', async () => {
    // A virtual hold has no radio enforcing exclusivity: the server keeps one
    // last-write-wins holder, so the phone that lost it must stop reporting.
    const { rerender } = renderProvider();
    await takeTheWall();
    expect(capturedBluetooth?.virtualWallHeld).toBe(true);

    presence.holder = { userId: 'someone-else' };
    await rerenderWith(rerender);

    expect(capturedBluetooth?.virtualWallHeld).toBe(false);
    expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(42);
  });

  it('watches the holder on a ledless board even when nothing is held here', async () => {
    // The bystander case: a climber who never took the wall still needs to see
    // that someone else is driving it, and the boards where that happens mostly
    // have no party session to carry the signal.
    presence.holder = { userId: 'someone-else' };
    renderProvider();
    await act(async () => {});
    expect(capturedBluetooth?.virtualWallHeld).toBe(false);
    expect(capturedBluetooth?.wallHeldByOtherUser).toBe(true);
  });

  it('keeps the hold when the holder slot is this device, or anonymous', async () => {
    const { rerender } = renderProvider();
    await takeTheWall();

    presence.holder = { userId: 'me' };
    await rerenderWith(rerender);
    expect(capturedBluetooth?.virtualWallHeld).toBe(true);

    // An anonymous holder carries no userId to compare — accepted, not guessed at.
    presence.holder = { userId: null };
    await rerenderWith(rerender);
    expect(capturedBluetooth?.virtualWallHeld).toBe(true);
  });
});

describe('BluetoothProvider — a rejected report re-stamps membership once', () => {
  beforeEach(async () => {
    await setHoldColorOverridesPreference({});
    vi.useFakeTimers();
    queue.currentClimbQueueItem = makeQueueItem('climb-1');
    queue.sessionId = null;
    bluetooth.state.isConnected = false;
    bluetooth.state.sendFramesToBoard.mockReset();
    bluetooth.state.sendFramesToBoard.mockResolvedValue(true);
    bluetooth.state.connectInitialSendRef.current = null;
    presence.enabled = true;
    presence.boardId = 42;
    presence.holder = null;
    presence.reportClimbForBoard.mockClear();
    presence.reportDisconnectForBoard.mockClear();
    presence.restampBoardMembershipByUuid.mockClear();
    presence.restampBoardMembershipByUuid.mockResolvedValue(true);
    viewer.profile = { id: 'me' };
    capturedBluetooth = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('retries exactly once and leaves the board binding intact', async () => {
    // Anonymous emitters are keyed conn:{connectionId} and lose membership on a
    // socket reconnect. The re-stamp must NOT go through beginResolution, which
    // would clear boardId and blank the wall screen mid-hold.
    presence.reportClimbForBoard.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    renderProvider();
    await takeTheWall();
    await settle();

    expect(presence.restampBoardMembershipByUuid).toHaveBeenCalledTimes(1);
    expect(presence.restampBoardMembershipByUuid).toHaveBeenCalledWith({ boardUuid: 'board-uuid-1' });
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(2);
    expect(capturedBluetooth?.virtualWallHeld).toBe(true);
  });

  it('gives up when the re-stamp itself throws', async () => {
    // The websocket dropped, or the resolve failed outright. One retry attempt,
    // no report, and the hold survives so the next climb change can try again.
    presence.reportClimbForBoard.mockResolvedValue(false);
    presence.restampBoardMembershipByUuid.mockRejectedValue(new Error('socket closed'));

    renderProvider();
    await takeTheWall();
    await settle(2);

    expect(presence.restampBoardMembershipByUuid).toHaveBeenCalledTimes(1);
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
    expect(capturedBluetooth?.virtualWallHeld).toBe(true);
  });

  it('gives up rather than hammering when the re-stamp says the board moved', async () => {
    presence.reportClimbForBoard.mockResolvedValue(false);
    presence.restampBoardMembershipByUuid.mockResolvedValue(false);

    renderProvider();
    await takeTheWall();
    await settle(2);

    expect(presence.restampBoardMembershipByUuid).toHaveBeenCalledTimes(1);
    expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
  });
});
