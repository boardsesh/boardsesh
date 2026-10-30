// @vitest-environment jsdom
//
// Taking the board with a hand-off (#7113 PR 4), from the holder's side. A
// crewmate's swipe asks this phone to let go: it disconnects with the
// `taken_over` reason, ends its drive, buzzes once and says who took the board,
// and then must never connect again by itself, whatever presence or the app's
// foreground state does next, until the climber connects by hand.
import { act, render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import type { BleConnectionEnded, BleConnectionHandle, PickerState } from '../../lib/ble/use-board-bluetooth';

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
const haptics = vi.hoisted(() => ({
  hapticLight: vi.fn(),
  hapticSuccess: vi.fn(),
  hapticError: vi.fn(),
  hapticWarning: vi.fn(),
}));
const announce = vi.hoisted(() => ({ announceQueued: vi.fn() }));
const appState = vi.hoisted(() => ({ listeners: [] as Array<(state: string) => void> }));

const queue = vi.hoisted(() => ({
  currentClimbQueueItem: null as ClimbQueueItem | null,
  items: [] as ClimbQueueItem[],
  sessionId: 'session-1' as string | null,
  participantId: 'participant-self' as string | null,
  sessionMemberUserIds: new Set(['me', 'liz']) as ReadonlySet<string>,
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
      consumeBackgroundAdoptSendGate: vi.fn(() => false),
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
  lastConnectionSeq: 0,
  handoffRequest: null as {
    holderUserId: string;
    requester: { userId: string; displayName?: string | null; avatarUrl?: string | null };
    requestId: string;
    requestedAt: string;
  } | null,
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

// Every GraphQL operation the provider could possibly issue funnels through this
// one client, so counting its calls is a behavioural proof that taking the wall
// writes nothing to the server — unlike a source-text tripwire, a refactor
// cannot quietly defeat it.
const graphql = vi.hoisted(() => ({ request: vi.fn(async () => ({ board: null })) }));

const resolvedBoards = vi.hoisted(() => ({ value: new Map<string, ResolvedBoardEntry>() }));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios', Version: 0 },
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listeners.push(listener);
      return { remove: vi.fn() };
    },
  },
}));

vi.mock('@tanstack/react-query', () => ({
  // The provider reads the viewer's id off the shared ['profile'] cache entry.
  // Scoped to that key on purpose: answering EVERY useQuery with a profile would
  // hand a future query the wrong shape and pass anyway.
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] !== 'profile') {
      throw new Error(`Unmocked useQuery in this suite: ${JSON.stringify(queryKey)}`);
    }
    return { data: viewer.profile };
  },
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
    lastConnectionSeq: presence.lastConnectionSeq,
    handoffRequest: presence.handoffRequest,
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
vi.mock('../../lib/announce-queued', () => announce);
vi.mock('../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../lib/graphql/use-active-board', () => ({ useSetActiveBoard: () => vi.fn(async () => {}) }));
vi.mock('../../lib/graphql/client', () => ({
  getHttpClient: () => ({ request: graphql.request }),
}));

vi.mock('../../components/ble/DevicePickerSheet', () => ({
  DevicePickerSheet: () => createElement('div', { 'data-testid': 'device-picker' }),
}));

vi.mock('../queue-provider', () => ({
  useQueue: () => ({ state: { currentClimbQueueItem: queue.currentClimbQueueItem, queue: queue.items } }),
  useQueueActions: () => ({
    setCurrentClimb: vi.fn(),
    getQueueSnapshot: () => ({
      sessionId: queue.sessionId,
      currentClimbQueueItem: queue.currentClimbQueueItem,
      queue: queue.items,
      playlistSuggestionSource: null,
    }),
  }),
  useQueueSessionControls: () => ({
    sessionId: queue.sessionId,
    sessionMemberUserIds: queue.sessionMemberUserIds,
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
import { resetAnsweredHandoffRequestsForTests } from '../use-board-handoff-release';
import {
  enterDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  resetDriveModeForTests,
} from '../../components/play-drawer/drive-mode-store';

let capturedBluetooth: ReturnType<typeof useBluetoothContext> | null = null;

function BluetoothProbe() {
  capturedBluetooth = useBluetoothContext();
  return null;
}

function providerElement() {
  return createElement(BluetoothProvider, {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    boardUuid: 'board-uuid-1',
    hasLeds: true,
    children: createElement(BluetoothProbe, null) as ReactNode,
  });
}

const LIZ_ASKS = {
  holderUserId: 'me',
  requester: { userId: 'liz', displayName: 'Liz', avatarUrl: null },
  requestId: 'request-1',
  requestedAt: '2026-10-30T12:00:00.000Z',
};

function handedOffEvents() {
  return analytics.track.mock.calls.filter(([name]) => name === 'Board Handed Off');
}

/** The hook's teardown ends the link: what the real `useBoardBluetooth` reports. */
function linkEnded() {
  bluetooth.state.isConnected = false;
  bluetooth.options?.onConnectionEnded?.({
    reason: 'user',
    disconnectTrigger: 'taken_over',
    connectionDurationSec: 60,
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    boardId: 42,
    inSession: true,
  } as BleConnectionEnded);
}

describe('BluetoothProvider — a crewmate takes the board (#7113 PR 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAnsweredHandoffRequestsForTests();
    resetDriveModeForTests();
    capturedBluetooth = null;
    appState.listeners = [];
    queue.sessionId = 'session-1';
    queue.sessionMemberUserIds = new Set(['me', 'liz']);
    bluetooth.state.isConnected = true;
    bluetooth.state.loading = false;
    bluetooth.state.connect.mockClear();
    bluetooth.state.disconnect.mockClear();
    presence.boardId = 42;
    presence.holder = { userId: 'me', displayName: 'Me' };
    presence.lastConnectionSeq = 4;
    presence.handoffRequest = null;
    presence.reportDisconnectForBoard.mockClear();
    analytics.track.mockClear();
    haptics.hapticWarning.mockClear();
    announce.announceQueued.mockClear();
  });

  afterEach(() => {
    cleanup();
    resetDriveModeForTests();
    vi.useRealTimers();
  });

  it('lets go with the taken_over reason, ends the drive, buzzes and says who took it', async () => {
    enterDriveMode({ sessionId: 'session-1', boardId: 42 });
    const view = render(providerElement());
    presence.handoffRequest = LIZ_ASKS;
    await act(async () => {
      view.rerender(providerElement());
    });
    expect(bluetooth.state.disconnect).toHaveBeenCalledExactlyOnceWith('taken_over');
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('taken_over');
    expect(haptics.hapticWarning).toHaveBeenCalledOnce();
    expect(announce.announceQueued).toHaveBeenCalledExactlyOnceWith('playView.wallControl.boardTakenBy');
    expect(handedOffEvents()).toEqual([['Board Handed Off', { wasDriving: true }]]);
    // No ids or names in the event.
    expect(JSON.stringify(handedOffEvents())).not.toContain('liz');
    expect(capturedBluetooth?.takenOverBy).toEqual(LIZ_ASKS.requester);

    // The teardown's connection-ended path frees the board for Liz.
    await act(async () => {
      linkEnded();
      view.rerender(providerElement());
    });
    expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(42);
  });

  it('never connects again by itself: not on the board going free, a foreground, or a repeat of the request', async () => {
    const view = render(providerElement());
    presence.handoffRequest = LIZ_ASKS;
    await act(async () => {
      view.rerender(providerElement());
    });
    await act(async () => {
      linkEnded();
      view.rerender(providerElement());
    });
    // The release report lands: the board is free.
    presence.holder = null;
    presence.lastConnectionSeq = 5;
    await act(async () => {
      view.rerender(providerElement());
    });
    // Back from the background (iOS and Android both fire this).
    await act(async () => {
      for (const listener of appState.listeners) listener('background');
      for (const listener of appState.listeners) listener('active');
      view.rerender(providerElement());
    });
    // The same request delivered again (a resubscribe) changes nothing.
    presence.handoffRequest = { ...LIZ_ASKS };
    await act(async () => {
      view.rerender(providerElement());
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(bluetooth.state.connect).not.toHaveBeenCalled();
    expect(bluetooth.state.disconnect).toHaveBeenCalledOnce();
    // Until Liz holds it, the board reads as hers on this phone.
    expect(capturedBluetooth?.takenOverBy).toEqual(LIZ_ASKS.requester);

    presence.holder = { userId: 'liz', displayName: 'Liz' };
    presence.lastConnectionSeq = 6;
    await act(async () => {
      view.rerender(providerElement());
    });
    expect(capturedBluetooth?.takenOverBy).toBeNull();
    expect(bluetooth.state.connect).not.toHaveBeenCalled();
  });

  it('lets the taken-over hold lapse after 30 s if nobody takes the board', async () => {
    const view = render(providerElement());
    presence.handoffRequest = LIZ_ASKS;
    await act(async () => {
      view.rerender(providerElement());
    });
    await act(async () => {
      linkEnded();
      view.rerender(providerElement());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(capturedBluetooth?.takenOverBy).toBeNull();
    expect(bluetooth.state.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['this phone is not linked', () => (bluetooth.state.isConnected = false), LIZ_ASKS],
    ['the request names another account', () => {}, { ...LIZ_ASKS, holderUserId: 'someone-else' }],
    ['the asker is not in this session', () => (queue.sessionMemberUserIds = new Set(['me'])), LIZ_ASKS],
    [
      'the asker is this account (its other phone)',
      () => {},
      { ...LIZ_ASKS, requester: { userId: 'me', displayName: 'Me', avatarUrl: null } },
    ],
  ])('ignores a request when %s', async (_case, arrange, request) => {
    arrange();
    const view = render(providerElement());
    presence.handoffRequest = request;
    await act(async () => {
      view.rerender(providerElement());
    });
    expect(bluetooth.state.disconnect).not.toHaveBeenCalled();
    expect(haptics.hapticWarning).not.toHaveBeenCalled();
    expect(handedOffEvents()).toEqual([]);
    expect(capturedBluetooth?.takenOverBy).toBeNull();
  });

  it('gives back a virtual hold (a wall taken with no radio), freeing the board for the asker', async () => {
    bluetooth.state.isConnected = false;
    const view = render(providerElement());
    await act(async () => {
      capturedBluetooth?.takeVirtualWall();
    });
    expect(capturedBluetooth?.virtualWallHeld).toBe(true);
    presence.reportDisconnectForBoard.mockClear();
    presence.handoffRequest = LIZ_ASKS;
    await act(async () => {
      view.rerender(providerElement());
    });
    expect(capturedBluetooth?.virtualWallHeld).toBe(false);
    expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(42);
    expect(bluetooth.state.disconnect).not.toHaveBeenCalled();
    expect(haptics.hapticWarning).toHaveBeenCalledOnce();
    expect(handedOffEvents()).toEqual([['Board Handed Off', { wasDriving: false }]]);
    expect(capturedBluetooth?.takenOverBy).toEqual(LIZ_ASKS.requester);
    expect(bluetooth.state.connect).not.toHaveBeenCalled();
  });

  it('never answers an old request on a link made after it', async () => {
    bluetooth.state.isConnected = false;
    const view = render(providerElement());
    presence.handoffRequest = LIZ_ASKS;
    await act(async () => {
      view.rerender(providerElement());
    });
    bluetooth.state.isConnected = true;
    await act(async () => {
      view.rerender(providerElement());
    });
    expect(bluetooth.state.disconnect).not.toHaveBeenCalled();
  });
});
