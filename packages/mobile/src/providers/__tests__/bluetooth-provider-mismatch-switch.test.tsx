// @vitest-environment jsdom
import { render, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import type { BoardPresenceClimb, UserBoard } from '@boardsesh/shared-schema';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import type { PickerState } from '../../lib/ble/use-board-bluetooth';

type BluetoothHookOptions = {
  onConnectSuccess?: (serial: string | null) => void;
  holdsData?: unknown;
};

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
}));

const alert = vi.hoisted(() => ({
  alert: vi.fn(),
}));

const queue = vi.hoisted(() => ({
  currentClimbQueueItem: null as ClimbQueueItem | null,
  queue: [] as ClimbQueueItem[],
  sessionId: null as string | null,
  lastConnectedBoardSerial: null as string | null,
  confirmClimbOnWall: vi.fn(async () => {}),
  reportWallDisconnect: vi.fn(async () => {}),
  setSessionBoardSerial: vi.fn(async () => {}),
  setCurrentClimb: vi.fn(),
}));

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

const bluetooth = vi.hoisted(() => {
  const mock = {
    options: undefined as BluetoothHookOptions | undefined,
    state: {
      isConnected: false,
      loading: false,
      connect: vi.fn(async () => true),
      disconnect: vi.fn(async () => {}),
      sendFramesToBoard: vi.fn(async () => true as boolean | undefined),
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

const activeBoard = vi.hoisted(() => ({
  setActiveBoard: vi.fn(async (_board: unknown) => {}),
}));

const graphql = vi.hoisted(() => ({
  request: vi.fn(async () => ({ board: null as unknown })),
}));

vi.mock('react-native', () => ({
  Alert: { alert: alert.alert },
}));

vi.mock('@boardsesh/play-view', () => ({
  emitWallConfirm: vi.fn(),
}));

vi.mock('../../lib/ble/use-board-bluetooth', () => ({
  // Mirror the real pure helper so the provider's config-key comparisons work
  // without importing the hook module (which pulls in expo native modules).
  boardConfigKey: (boardName: string, layoutId: number, sizeId: number) => `${boardName}::${layoutId}::${sizeId}`,
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

vi.mock('../../lib/graphql/use-active-board', () => ({
  useSetActiveBoard: () => activeBoard.setActiveBoard,
}));

vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: graphql.request }),
}));

vi.mock('../../components/ble/DevicePickerSheet', () => ({
  DevicePickerSheet: (props: PickerSheetProps) => {
    pickerSheet.props = props;
    return createElement('div', { 'data-testid': 'device-picker' });
  },
}));

vi.mock('../queue-provider', () => ({
  useQueue: () => ({
    state: { currentClimbQueueItem: queue.currentClimbQueueItem, queue: queue.queue },
  }),
  useQueueActions: () => ({
    setCurrentClimb: queue.setCurrentClimb,
  }),
  useQueueSessionControls: () => ({
    sessionId: queue.sessionId,
    lastConnectedBoardSerial: queue.lastConnectedBoardSerial,
    confirmClimbOnWall: queue.confirmClimbOnWall,
    reportWallDisconnect: queue.reportWallDisconnect,
    setSessionBoardSerial: queue.setSessionBoardSerial,
  }),
}));

vi.mock('../toast-provider', () => ({
  useToast: () => ({ showToast: toast.showToast }),
}));

vi.mock('../../lib/board-details', () => ({
  getBoardRenderData: vi.fn(() => ({
    holdsData: [{ id: 100, mirroredHoldId: 200, cx: 0, cy: 0, r: 1 }],
  })),
}));

// BluetoothProvider reads board presence; mock it (and the wall context + undo
// snackbar) so the suite doesn't pull in the ws-client → expo-secure-store
// chain. Most tests keep board presence off; the auto-connect undo regression
// opts into the mocked state below.
vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceCurrent: () => ({
    currentClimb: presence.currentClimb,
    previousClimb: null,
    undoTarget: null,
    isLive: false,
  }),
}));
vi.mock('../board-presence-provider', () => ({
  useBoardPresenceControls: () => ({
    enabled: presence.enabled,
    boardId: presence.boardId,
    resolveAndBindBoard: vi.fn(async () => null),
    resolveAndBindBoardByConfig: vi.fn(async () => null),
    reportClimbForBoard: presence.reportClimbForBoard,
    reportDisconnectForBoard: presence.reportDisconnectForBoard,
  }),
}));
vi.mock('../queue-snackbar-provider', () => ({
  useQueueSnackbar: () => ({ showUndoWallChangeSnackbar: presence.showUndoWallChangeSnackbar }),
}));
// toClimbInput pulls in expo-crypto (randomUUID); stub it (board presence is off here).
vi.mock('../../lib/climb-to-queue-item', () => ({
  toClimbInput: (climb: { uuid: string }) => ({ uuid: climb.uuid }),
}));

import { BluetoothProvider, useBluetoothContext } from '../bluetooth-provider';

let capturedBluetooth: ReturnType<typeof useBluetoothContext> | null = null;

function BluetoothProbe() {
  capturedBluetooth = useBluetoothContext();
  return null;
}

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

function makeBoard(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board-tension',
    slug: 'garage-tension',
    ownerId: 'owner-1',
    boardType: 'tension',
    layoutId: 1,
    sizeId: 10,
    setIds: '1',
    name: 'Garage Tension',
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    serialNumber: 'SN-2',
    ...overrides,
  };
}

function makeSerialConfig(overrides: Partial<BoardSerialConfig> = {}): BoardSerialConfig {
  return {
    serialNumber: 'SN-2',
    boardName: 'tension',
    layoutId: 1,
    sizeId: 10,
    setIds: '1',
    apiLevel: 3,
    updatedAt: '2026-01-02T00:00:00.000Z',
    boardUuid: null,
    boardSlug: null,
    ...overrides,
  };
}

function makeMismatchingPickerState(): PickerState {
  return {
    devices: [{ deviceId: 'device-2', name: 'Tension Board#SN-2@2', rssi: -50 }],
    isScanning: false,
    handleSelect: vi.fn(),
    handleCancel: vi.fn(),
  };
}

type BoardProps = {
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
};

const KILTER_PROPS: BoardProps = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' };
const TENSION_PROPS: BoardProps = { boardName: 'tension', layoutId: 1, sizeId: 10, setIds: '1' };

function renderProvider(props: BoardProps, children?: ReactNode) {
  return render(
    createElement(BluetoothProvider, {
      ...props,
      children: children ?? createElement('div', null),
    }),
  );
}

type AlertButton = { text: string; style?: string; onPress?: () => void };

function lastAlertButtons(): AlertButton[] {
  const calls = alert.alert.mock.calls;
  const lastCall = calls[calls.length - 1];
  return (lastCall?.[2] as AlertButton[]) ?? [];
}

describe('BluetoothProvider mismatch switch', () => {
  beforeEach(() => {
    queue.currentClimbQueueItem = null;
    queue.sessionId = null;
    queue.lastConnectedBoardSerial = null;
    analytics.track.mockClear();
    alert.alert.mockClear();
    pickerSheet.props = null;
    resolvedBoards.value = new Map();
    activeBoard.setActiveBoard.mockClear();
    activeBoard.setActiveBoard.mockResolvedValue(undefined);
    graphql.request.mockClear();
    graphql.request.mockResolvedValue({ board: null });
    bluetooth.options = undefined;
    bluetooth.state.isConnected = false;
    bluetooth.state.loading = false;
    bluetooth.state.pickerState = null;
    bluetooth.state.reconnectSerialForCurrentBoard = null;
    bluetooth.state.connect.mockClear();
    bluetooth.state.connect.mockResolvedValue(true);
    bluetooth.state.sendFramesToBoard.mockClear();
    bluetooth.state.sendFramesToBoard.mockResolvedValue(true);
    bluetooth.state.connectInitialSendRef.current = null;
    bluetooth.useBoardBluetooth.mockClear();
    presence.enabled = false;
    presence.boardId = null;
    presence.currentClimb = null;
    presence.reportClimbForBoard.mockClear();
    presence.reportClimbForBoard.mockResolvedValue(true);
    presence.showUndoWallChangeSnackbar.mockClear();
    capturedBluetooth = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows three buttons for a mismatching saved board (Cancel / Connect anyway / Switch)', () => {
    bluetooth.state.pickerState = makeMismatchingPickerState();
    resolvedBoards.value = new Map([['SN-2', { kind: 'saved', board: makeBoard() }]]);

    renderProvider(KILTER_PROPS);
    pickerSheet.props?.onSelect('device-2');

    expect(alert.alert).toHaveBeenCalledOnce();
    const buttons = lastAlertButtons();
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.style).toBe('cancel');
    // "Connect anyway" is a warning now, not a destructive (red) action.
    expect(buttons[1]?.style).toBeUndefined();
    expect(buttons[2]?.text).toBeTruthy();
  });

  it('tracks the mismatch dialog shown, and resolved with the action taken', () => {
    bluetooth.state.pickerState = makeMismatchingPickerState();
    resolvedBoards.value = new Map([['SN-2', { kind: 'saved', board: makeBoard() }]]);

    renderProvider(KILTER_PROPS);
    pickerSheet.props?.onSelect('device-2');

    const shown = analytics.track.mock.calls.find(([name]) => name === 'BLE Board Config Mismatch Shown');
    expect(shown?.[1]).toMatchObject({ serial: 'SN-2', canSwitch: true, recordedEntryKind: 'saved' });

    // Connect anyway → resolved:connect_anyway, no destructive styling, proceeds.
    lastAlertButtons()[1]?.onPress?.();
    const resolved = analytics.track.mock.calls.find(([name]) => name === 'BLE Board Config Mismatch Resolved');
    expect(resolved?.[1]).toMatchObject({ action: 'connect_anyway', serial: 'SN-2' });
  });

  it('switches the active board and silently auto-connects once after the config matches', async () => {
    const pickerState = makeMismatchingPickerState();
    bluetooth.state.pickerState = pickerState;
    const savedBoard = makeBoard();
    resolvedBoards.value = new Map([['SN-2', { kind: 'saved', board: savedBoard }]]);

    const { rerender } = renderProvider(KILTER_PROPS);
    pickerSheet.props?.onSelect('device-2');

    const switchButton = lastAlertButtons()[2];
    expect(switchButton).toBeDefined();
    switchButton?.onPress?.();

    expect(
      analytics.track.mock.calls.find(([name]) => name === 'BLE Board Config Mismatch Resolved')?.[1],
    ).toMatchObject({ action: 'switch_setup' });

    await waitFor(() => {
      expect(activeBoard.setActiveBoard).toHaveBeenCalledWith(savedBoard);
    });
    expect(pickerState.handleCancel).toHaveBeenCalledOnce();
    // Still on the old (kilter) config — must not auto-connect yet.
    expect(bluetooth.state.connect).not.toHaveBeenCalled();

    // setActiveBoard's cache write propagates new board props into the provider.
    rerender(
      createElement(BluetoothProvider, {
        ...TENSION_PROPS,
        children: createElement('div', null),
      }),
    );

    await waitFor(() => {
      expect(bluetooth.state.connect).toHaveBeenCalledWith(undefined, undefined, 'SN-2');
    });
    expect(bluetooth.state.connect).toHaveBeenCalledOnce();

    // A further re-render must not re-fire the one-shot auto-connect.
    rerender(
      createElement(BluetoothProvider, {
        ...TENSION_PROPS,
        children: createElement('div', null),
      }),
    );
    expect(bluetooth.state.connect).toHaveBeenCalledOnce();
  });

  it('carries an armed undo toast through switch-to-board auto-connect', async () => {
    const pickerState = makeMismatchingPickerState();
    bluetooth.state.pickerState = pickerState;
    const savedBoard = makeBoard();
    resolvedBoards.value = new Map([['SN-2', { kind: 'saved', board: savedBoard }]]);
    presence.enabled = true;
    presence.boardId = 99;
    presence.currentClimb = makePresenceClimb();
    queue.currentClimbQueueItem = makeQueueItem('climb-1');

    const { rerender } = renderProvider(KILTER_PROPS, createElement(BluetoothProbe));
    capturedBluetooth?.armUndoWallChangeToast();
    pickerSheet.props?.onSelect('device-2');

    lastAlertButtons()[2]?.onPress?.();
    await waitFor(() => {
      expect(activeBoard.setActiveBoard).toHaveBeenCalledWith(savedBoard);
    });

    // The config change clears the original arm; the pending auto-connect
    // request should re-arm immediately before it calls connect().
    rerender(
      createElement(BluetoothProvider, {
        ...TENSION_PROPS,
        children: createElement(BluetoothProbe),
      }),
    );
    await waitFor(() => {
      expect(bluetooth.state.connect).toHaveBeenCalledWith(undefined, undefined, 'SN-2');
    });

    bluetooth.state.isConnected = true;
    rerender(
      createElement(BluetoothProvider, {
        ...TENSION_PROPS,
        children: createElement(BluetoothProbe),
      }),
    );

    await waitFor(() => {
      expect(presence.reportClimbForBoard).toHaveBeenCalledTimes(1);
    });
    expect(presence.showUndoWallChangeSnackbar).toHaveBeenCalledTimes(1);
  });

  it('drops a pending auto-connect whose switched config never propagates', async () => {
    // Fake timers: the TTL guard's setTimeout must be controllable; the mocked
    // async switch handler still settles on the (unfaked) microtask queue.
    vi.useFakeTimers();
    try {
      const pickerState = makeMismatchingPickerState();
      bluetooth.state.pickerState = pickerState;
      const savedBoard = makeBoard();
      resolvedBoards.value = new Map([['SN-2', { kind: 'saved', board: savedBoard }]]);

      const { rerender } = renderProvider(KILTER_PROPS);
      pickerSheet.props?.onSelect('device-2');
      lastAlertButtons()[2]?.onPress?.();

      await act(async () => {});
      expect(activeBoard.setActiveBoard).toHaveBeenCalledWith(savedBoard);

      // The TTL elapses before the switched config ever reaches the provider
      // (e.g. the board switch was reverted) — the one-shot must disarm.
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });

      rerender(
        createElement(BluetoothProvider, {
          ...TENSION_PROPS,
          children: createElement('div', null),
        }),
      );
      await act(async () => {});
      expect(bluetooth.state.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetches the saved board for a recorded config with a board uuid and switches to it', async () => {
    const pickerState = makeMismatchingPickerState();
    bluetooth.state.pickerState = pickerState;
    resolvedBoards.value = new Map([['SN-2', { kind: 'recorded', config: makeSerialConfig({ boardUuid: 'uuid-9' }) }]]);
    const fetchedBoard = makeBoard({ uuid: 'uuid-9' });
    graphql.request.mockResolvedValue({ board: fetchedBoard });

    renderProvider(KILTER_PROPS);
    pickerSheet.props?.onSelect('device-2');
    lastAlertButtons()[2]?.onPress?.();

    await waitFor(() => {
      expect(activeBoard.setActiveBoard).toHaveBeenCalledWith(fetchedBoard);
    });
    expect(graphql.request).toHaveBeenCalledWith(expect.anything(), { boardUuid: 'uuid-9' });
    expect(pickerState.handleCancel).toHaveBeenCalledOnce();
  });

  it('keeps the picker open and alerts when the recorded-config board fetch fails', async () => {
    const pickerState = makeMismatchingPickerState();
    bluetooth.state.pickerState = pickerState;
    resolvedBoards.value = new Map([['SN-2', { kind: 'recorded', config: makeSerialConfig({ boardUuid: 'uuid-9' }) }]]);
    graphql.request.mockRejectedValue(new Error('network down'));

    renderProvider(KILTER_PROPS);
    pickerSheet.props?.onSelect('device-2');
    lastAlertButtons()[2]?.onPress?.();

    await waitFor(() => {
      expect(alert.alert).toHaveBeenCalledTimes(2);
    });
    const failureCall = alert.alert.mock.calls[1];
    expect(failureCall?.[1]).toBe('boardConfigMismatch.mobileSwitchFailed');
    expect(activeBoard.setActiveBoard).not.toHaveBeenCalled();
    expect(pickerState.handleCancel).not.toHaveBeenCalled();
  });

  it('treats a null board response for the recorded-config fetch as a failed switch', async () => {
    const pickerState = makeMismatchingPickerState();
    bluetooth.state.pickerState = pickerState;
    resolvedBoards.value = new Map([['SN-2', { kind: 'recorded', config: makeSerialConfig({ boardUuid: 'uuid-9' }) }]]);
    // The beforeEach default already resolves { board: null } — assert it's
    // surfaced as a failure, not a crash or a silent no-op.

    renderProvider(KILTER_PROPS);
    pickerSheet.props?.onSelect('device-2');
    lastAlertButtons()[2]?.onPress?.();

    await waitFor(() => {
      expect(alert.alert).toHaveBeenCalledTimes(2);
    });
    expect(alert.alert.mock.calls[1]?.[1]).toBe('boardConfigMismatch.mobileSwitchFailed');
    expect(activeBoard.setActiveBoard).not.toHaveBeenCalled();
    expect(pickerState.handleCancel).not.toHaveBeenCalled();
  });

  it('omits the Switch button for a recorded config with no saved board uuid', () => {
    bluetooth.state.pickerState = makeMismatchingPickerState();
    resolvedBoards.value = new Map([['SN-2', { kind: 'recorded', config: makeSerialConfig({ boardUuid: null }) }]]);

    renderProvider(KILTER_PROPS);
    pickerSheet.props?.onSelect('device-2');

    expect(alert.alert).toHaveBeenCalledOnce();
    expect(lastAlertButtons()).toHaveLength(2);
  });

  it('flushes one resolution-stats event when the picker closes', () => {
    bluetooth.state.pickerState = makeMismatchingPickerState();
    resolvedBoards.value = new Map([['SN-2', { kind: 'saved', board: makeBoard() }]]);

    const { rerender } = renderProvider(KILTER_PROPS);
    // Open picker → tallies are tracked but nothing is emitted yet.
    expect(analytics.track).not.toHaveBeenCalledWith('BLE Picker Devices Resolved', expect.anything());

    bluetooth.state.pickerState = null;
    rerender(
      createElement(BluetoothProvider, {
        ...KILTER_PROPS,
        children: createElement('div', null),
      }),
    );

    const statsCalls = analytics.track.mock.calls.filter(([name]) => name === 'BLE Picker Devices Resolved');
    expect(statsCalls).toHaveLength(1);
    expect(statsCalls[0]?.[1]).toMatchObject({
      devicesTotal: 1,
      devicesWithSerial: 1,
      resolvedSaved: 1,
      resolvedRecorded: 0,
      unresolvedWithSerial: 0,
      boardName: 'kilter',
    });

    // A later unrelated re-render must not re-emit the summary.
    rerender(
      createElement(BluetoothProvider, {
        ...KILTER_PROPS,
        children: createElement('div', null),
      }),
    );
    expect(analytics.track.mock.calls.filter(([name]) => name === 'BLE Picker Devices Resolved')).toHaveLength(1);
  });

  it('surfaces the switch-failed alert and keeps the picker open when setActiveBoard rejects', async () => {
    const pickerState = makeMismatchingPickerState();
    bluetooth.state.pickerState = pickerState;
    resolvedBoards.value = new Map([['SN-2', { kind: 'saved', board: makeBoard() }]]);
    activeBoard.setActiveBoard.mockRejectedValue(new Error('storage failed'));

    renderProvider(KILTER_PROPS);
    pickerSheet.props?.onSelect('device-2');
    lastAlertButtons()[2]?.onPress?.();

    await waitFor(() => {
      // The first alert is the mismatch prompt; the second is the failure.
      expect(alert.alert).toHaveBeenCalledTimes(2);
    });
    // react-i18next is unconfigured in tests, so `t` echoes the key.
    const failureCall = alert.alert.mock.calls[1];
    expect(failureCall?.[0]).toBe('boardConfigMismatch.title');
    expect(failureCall?.[1]).toBe('boardConfigMismatch.mobileSwitchFailed');
    expect(bluetooth.state.connect).not.toHaveBeenCalled();
    // The picker is only cancelled once the switch goes through — on failure it
    // stays open so the user can still pick a device or use Connect anyway.
    expect(pickerState.handleCancel).not.toHaveBeenCalled();
  });
});

function makeBoardItem(uuid: string, boardType: string | undefined, layoutId: number | undefined): ClimbQueueItem {
  return {
    uuid: `queue-${uuid}`,
    climb: {
      uuid,
      name: `Climb ${uuid}`,
      frames: `frames-${uuid}`,
      boardType,
      layoutId,
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

describe('BluetoothProvider spill skip', () => {
  beforeEach(() => {
    queue.currentClimbQueueItem = null;
    queue.queue = [];
    queue.sessionId = null;
    queue.setCurrentClimb.mockClear();
    toast.showToast.mockClear();
    analytics.track.mockClear();
    bluetooth.state.isConnected = true;
    bluetooth.state.sendFramesToBoard.mockClear();
    bluetooth.state.sendFramesToBoard.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    bluetooth.state.isConnected = false;
  });

  it('skips an incompatible current climb, advances to the next compatible one, and toasts + tracks', async () => {
    // Active board is kilter / layout 1 (KILTER_PROPS). The current is a tension
    // spill; the next compatible kilter climb follows.
    const spill = makeBoardItem('spill', 'tension', 1);
    const compatible = makeBoardItem('ok', 'kilter', 1);
    queue.currentClimbQueueItem = spill;
    queue.queue = [spill, compatible];

    renderProvider(KILTER_PROPS);
    await act(async () => {});

    // The spill frames were never written to the board.
    expect(bluetooth.state.sendFramesToBoard).not.toHaveBeenCalledWith(
      'frames-spill',
      expect.anything(),
      expect.anything(),
    );
    // The queue advanced to the compatible climb and the user was told.
    expect(queue.setCurrentClimb).toHaveBeenCalledWith(compatible);
    expect(toast.showToast).toHaveBeenCalledTimes(1);
    const skipCall = analytics.track.mock.calls.find(([name]) => name === 'BLE Queue Climb Skipped');
    expect(skipCall).toBeDefined();
    expect(skipCall?.[1]).toMatchObject({
      skippedClimbUuid: 'spill',
      skippedCount: 1,
      advancedToClimbUuid: 'ok',
    });
  });

  it('clears the board (no advance) when no compatible climb remains', async () => {
    const spill = makeBoardItem('spill', 'tension', 1);
    queue.currentClimbQueueItem = spill;
    queue.queue = [spill];

    renderProvider(KILTER_PROPS);
    await act(async () => {});

    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    // clearBoard sends empty frames to dark the wall.
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith('');
    expect(toast.showToast).toHaveBeenCalledTimes(1);
    const skipCall = analytics.track.mock.calls.find(([name]) => name === 'BLE Queue Climb Skipped');
    expect(skipCall?.[1]).toMatchObject({ skippedClimbUuid: 'spill', advancedToClimbUuid: null });
  });

  it('sends a compatible current climb normally (no skip)', async () => {
    const compatible = makeBoardItem('ok', 'kilter', 1);
    queue.currentClimbQueueItem = compatible;
    queue.queue = [compatible];

    renderProvider(KILTER_PROPS);
    await act(async () => {});

    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith(
      'frames-ok',
      false,
      expect.anything(),
      expect.objectContaining({ sendSource: 'auto', climbUuid: 'ok' }),
    );
    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('re-reports a spill if the user returns to it after advancing away', async () => {
    const spill = makeBoardItem('spill', 'tension', 1);
    const compatible = makeBoardItem('ok', 'kilter', 1);
    queue.currentClimbQueueItem = spill;
    queue.queue = [spill, compatible];

    const { rerender } = renderProvider(KILTER_PROPS);
    await act(async () => {});
    expect(toast.showToast).toHaveBeenCalledTimes(1);

    // The advance lands: the compatible climb becomes current and is sent, which
    // clears the spill dedup.
    queue.currentClimbQueueItem = compatible;
    rerender(createElement(BluetoothProvider, { ...KILTER_PROPS, children: createElement('div', null) }));
    await act(async () => {});
    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith(
      'frames-ok',
      false,
      expect.anything(),
      expect.objectContaining({ sendSource: 'auto', climbUuid: 'ok' }),
    );

    // Navigating back to the spill skips + toasts again — not a silent stick.
    queue.currentClimbQueueItem = spill;
    rerender(createElement(BluetoothProvider, { ...KILTER_PROPS, children: createElement('div', null) }));
    await act(async () => {});
    expect(toast.showToast).toHaveBeenCalledTimes(2);
  });

  it('does not skip a climb with unknown board metadata', async () => {
    const unknown = makeBoardItem('unknown', undefined, undefined);
    queue.currentClimbQueueItem = unknown;
    queue.queue = [unknown];

    renderProvider(KILTER_PROPS);
    await act(async () => {});

    expect(bluetooth.state.sendFramesToBoard).toHaveBeenCalledWith(
      'frames-unknown',
      false,
      expect.anything(),
      expect.objectContaining({ sendSource: 'auto', climbUuid: 'unknown' }),
    );
    expect(queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(toast.showToast).not.toHaveBeenCalled();
  });
});
