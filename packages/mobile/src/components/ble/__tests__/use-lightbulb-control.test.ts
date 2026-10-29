// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, Fragment, type ReactNode } from 'react';
import {
  BoardPresenceActionsContext,
  BoardPresenceCurrentContext,
  type BoardPresenceActions,
  type BoardPresenceCurrentState,
} from '@boardsesh/board-presence-react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { ClimbBoardConnectContext, type ClimbBoardConnectValue } from '../../../lib/boards/climb-board-connect-context';

type BluetoothCtx = {
  boardName: string | undefined;
  isConnected: boolean;
  lastLocalHolderUserId: string | null;
  loading: boolean;
  connect: ReturnType<typeof vi.fn>;
  connectAfterBoardSwitch: ReturnType<typeof vi.fn>;
  hasRememberedDeviceForBoard: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  armUndoWallChangeToast: ReturnType<typeof vi.fn>;
  reconnectSerialForCurrentBoard: string | null;
  reconnectDeviceIdForCurrentBoard: string | null;
  ledless: boolean;
  virtualWallHeld: boolean;
  wallHeldByOtherUser: boolean;
  canDriveWall: boolean;
  takeVirtualWall: ReturnType<typeof vi.fn>;
  releaseVirtualWall: ReturnType<typeof vi.fn>;
} | null;

const ctrl = vi.hoisted(() => ({
  bluetooth: null as BluetoothCtx,
  boardId: null as number | null,
  isSessionWallLit: false,
  sessionId: null as string | null,
  // The session roster's logged-in member userIds, for id-matching the holder.
  sessionMemberUserIds: new Set<string>(),
  // Holder rides the per-climb BoardPresenceCurrentContext; null = wall free.
  presence: undefined as BoardPresenceCurrentState | undefined,
  // The drawer host's connect-follows-the-climb hook (#7001). Null = no host.
  climbBoardConnect: null as ClimbBoardConnectValue | null,
  // The presence feed's catch-up trigger, behind its actions context.
  refreshPresence: null as ReturnType<typeof vi.fn> | null,
}));
const trackMock = vi.hoisted(() => vi.fn());
const hapticLightMock = vi.hoisted(() => vi.fn());

vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => ctrl.bluetooth }));
vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ boardId: ctrl.boardId }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionControls: () => ({
    isSessionWallLit: ctrl.isSessionWallLit,
    sessionId: ctrl.sessionId,
    sessionMemberUserIds: ctrl.sessionMemberUserIds,
  }),
}));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => 'me' }));
// The hook fires a light haptic on take/release; the real module pulls in
// react-native (Flow-typed), which this jsdom suite can't parse.
vi.mock('../../../lib/haptics', () => ({ hapticLight: hapticLightMock }));

import { useLightbulbControl } from '../use-lightbulb-control';
import { CrewHolderSuspicionSync } from '../../../providers/crew-holder-suspicion';

function makeBluetooth(over: Partial<NonNullable<BluetoothCtx>> = {}): NonNullable<BluetoothCtx> {
  return {
    boardName: 'kilter',
    isConnected: false,
    lastLocalHolderUserId: null,
    loading: false,
    connect: vi.fn().mockResolvedValue(true),
    connectAfterBoardSwitch: vi.fn().mockResolvedValue(true),
    hasRememberedDeviceForBoard: vi.fn(() => false),
    disconnect: vi.fn().mockResolvedValue(undefined),
    armUndoWallChangeToast: vi.fn(),
    reconnectSerialForCurrentBoard: null,
    reconnectDeviceIdForCurrentBoard: null,
    ledless: false,
    virtualWallHeld: false,
    wallHeldByOtherUser: false,
    canDriveWall: false,
    takeVirtualWall: vi.fn(),
    releaseVirtualWall: vi.fn(),
    ...over,
  };
}

// Minimal holder — every BoardConnectionHolder field is optional (anonymous).
const anonymousHolderPresence = { holder: {}, currentClimb: null } as unknown as BoardPresenceCurrentState;
const holderPresenceFor = (userId: string): BoardPresenceCurrentState =>
  ({ holder: { userId }, currentClimb: null }) as unknown as BoardPresenceCurrentState;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    ClimbBoardConnectContext.Provider,
    { value: ctrl.climbBoardConnect },
    createElement(
      BoardPresenceActionsContext.Provider,
      {
        value: ctrl.refreshPresence
          ? ({ refresh: ctrl.refreshPresence } as unknown as BoardPresenceActions)
          : undefined,
      },
      createElement(
        BoardPresenceCurrentContext.Provider,
        { value: ctrl.presence },
        createElement(Fragment, null, createElement(CrewHolderSuspicionSync), children),
      ),
    ),
  );

function renderControl(options: Partial<Parameters<typeof useLightbulbControl>[0]> = {}) {
  return renderHook(() => useLightbulbControl({ surface: 'play_drawer', ...options }), { wrapper });
}

beforeEach(() => {
  ctrl.bluetooth = makeBluetooth();
  ctrl.boardId = null;
  ctrl.isSessionWallLit = false;
  ctrl.sessionId = null;
  ctrl.sessionMemberUserIds = new Set();
  ctrl.presence = undefined;
  ctrl.climbBoardConnect = null;
  ctrl.refreshPresence = null;
  trackMock.mockClear();
});

describe('useLightbulbControl lit state', () => {
  it('lights from this device when its BLE link is connected', () => {
    ctrl.bluetooth = makeBluetooth({ isConnected: true });
    const { result } = renderControl();
    expect(result.current.lit).toBe(true);
    expect(result.current.localConnected).toBe(true);
  });

  it('stays lit and locally connected when this device holds the wall and is subscribed', () => {
    // This device drives the wall (isConnected) AND is subscribed to the board
    // feed (boardId bound). Local connection short-circuits lit before the
    // holder/session checks, so both read true.
    ctrl.bluetooth = makeBluetooth({ isConnected: true });
    ctrl.boardId = 42;
    const { result } = renderControl();
    expect(result.current.lit).toBe(true);
    expect(result.current.localConnected).toBe(true);
  });

  it('lights from a session peer holding the wall, without claiming local connection', () => {
    // Subscribed to the board feed (boardId bound), a session member holds it
    // (their userId is in my roster), this device is not connected — the bulb
    // reads lit without claiming the local link. What the TAP does in this state
    // is pinned separately, below.
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.sessionMemberUserIds = new Set(['peer-user']);
    ctrl.presence = holderPresenceFor('peer-user');
    const { result } = renderControl();
    expect(result.current.lit).toBe(true);
    expect(result.current.localConnected).toBe(false);
  });

  it('lights for a late-joiner from the seeded holder, without the session flag', () => {
    // A late-joiner seeds the holder via the boardConnection query but never
    // receives the WallConfirmedClimb that sets isSessionWallLit. The logged-in
    // peer's userId match lights the bulb immediately, so the bulb is correct
    // before (and even without) the fragile session flag.
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.sessionMemberUserIds = new Set(['peer-user']);
    ctrl.isSessionWallLit = false;
    ctrl.presence = holderPresenceFor('peer-user');
    const { result } = renderControl();
    expect(result.current.lit).toBe(true);
  });

  it('stays off when a stranger holds the wall while solo', () => {
    // The bug fix: subscribed and a holder exists, but I'm not in a session, so
    // the holder isn't someone I'm climbing with — the bulb reads off (the avatar
    // still shows separately via the lightbulb holder pip, LightbulbHolderBadge).
    ctrl.boardId = 42;
    ctrl.sessionId = null;
    ctrl.presence = holderPresenceFor('stranger-user');
    const { result } = renderControl();
    expect(result.current.lit).toBe(false);
  });

  it('stays off when an in-session holder is not a roster member', () => {
    // In a session, but the board holder's userId isn't in my roster (a stranger
    // on the same physical board) → off.
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.sessionMemberUserIds = new Set(['peer-user']);
    ctrl.presence = holderPresenceFor('stranger-user');
    const { result } = renderControl();
    expect(result.current.lit).toBe(false);
  });

  it('lights from an anonymous session peer via the session flag', () => {
    // Anonymous holder (no userId to id-match) while in a session: fall back to
    // the best-effort wall-lit flag.
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.isSessionWallLit = true;
    ctrl.presence = anonymousHolderPresence;
    const { result } = renderControl();
    expect(result.current.lit).toBe(true);
  });

  it('reads off once the holder has cleared, even if the session flag is stuck', () => {
    // The regression guard: holder authoritatively cleared, but the best-effort
    // session flag is stuck true. No holder → neither path fires → off.
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.presence = undefined; // holder cleared
    ctrl.isSessionWallLit = true;
    const { result } = renderControl();
    expect(result.current.lit).toBe(false);
  });

  it('falls back to the session flag when no board is bound', () => {
    ctrl.boardId = null;
    ctrl.isSessionWallLit = true;
    const { result } = renderControl();
    expect(result.current.lit).toBe(true);
  });
});

describe('useLightbulbControl press action', () => {
  it('connects and arms the undo toast when disconnected', () => {
    ctrl.bluetooth = makeBluetooth({ isConnected: false, reconnectSerialForCurrentBoard: 'serial-1' });
    const { result } = renderControl();
    result.current.onPress();
    expect(ctrl.bluetooth?.armUndoWallChangeToast).toHaveBeenCalledOnce();
    expect(ctrl.bluetooth?.connect).toHaveBeenCalledWith(undefined, undefined, 'serial-1', undefined);
    expect(ctrl.bluetooth?.disconnect).not.toHaveBeenCalled();
    // The tap is tracked (#5654): a connect that dies at a denied permission or a
    // radio that's off never reaches Bluetooth Connection Success / Failed.
    expect(trackMock).toHaveBeenCalledWith('Board Connect Tapped', {
      surface: 'play_drawer',
      boardName: 'kilter',
      reconnect: true,
    });
  });

  it('reconnects a MoonBoard by its remembered device id (no serial)', () => {
    ctrl.bluetooth = makeBluetooth({ isConnected: false, reconnectDeviceIdForCurrentBoard: 'moon-abc' });
    const { result } = renderControl();
    result.current.onPress();
    // Serial arg stays undefined; the device id is forwarded so the adapter
    // silently reconnects to the same MoonBoard instead of opening the picker.
    expect(ctrl.bluetooth?.connect).toHaveBeenCalledWith(undefined, undefined, undefined, 'moon-abc');
  });

  it('disconnects (no connect) when already connected', () => {
    ctrl.bluetooth = makeBluetooth({ isConnected: true });
    const { result } = renderControl();
    result.current.onPress();
    expect(ctrl.bluetooth?.disconnect).toHaveBeenCalledOnce();
    expect(ctrl.bluetooth?.connect).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('no-ops a tap while a connect/disconnect is in flight', () => {
    ctrl.bluetooth = makeBluetooth({ isConnected: false, loading: true });
    const { result } = renderControl();
    result.current.onPress();
    expect(ctrl.bluetooth?.connect).not.toHaveBeenCalled();
    expect(ctrl.bluetooth?.disconnect).not.toHaveBeenCalled();
  });
});

describe('useLightbulbControl on a wall with no LED light kit', () => {
  it('takes the wall instead of connecting, and never arms the undo toast', () => {
    // The first take has no previous wall state to restore, so an undo toast
    // would offer to undo nothing.
    ctrl.bluetooth = makeBluetooth({ ledless: true, reconnectSerialForCurrentBoard: 'serial-1' });
    const { result } = renderControl();
    result.current.onPress();
    expect(ctrl.bluetooth?.takeVirtualWall).toHaveBeenCalledOnce();
    expect(ctrl.bluetooth?.connect).not.toHaveBeenCalled();
    expect(ctrl.bluetooth?.armUndoWallChangeToast).not.toHaveBeenCalled();
    // The provider's takeVirtualWall owns the haptic (and the toast it goes
    // with). Buzzing here as well would stutter every tap.
    expect(hapticLightMock).not.toHaveBeenCalled();
  });

  it('releases the wall on the next tap', () => {
    ctrl.bluetooth = makeBluetooth({ ledless: true, virtualWallHeld: true });
    const { result } = renderControl();
    result.current.onPress();
    expect(ctrl.bluetooth?.releaseVirtualWall).toHaveBeenCalledOnce();
    expect(ctrl.bluetooth?.disconnect).not.toHaveBeenCalled();
    expect(hapticLightMock).not.toHaveBeenCalled();
  });

  it('reads lit while holding the wall, without claiming a local BLE link', () => {
    ctrl.bluetooth = makeBluetooth({ ledless: true, virtualWallHeld: true });
    const { result } = renderControl();
    expect(result.current.lit).toBe(true);
    expect(result.current.localConnected).toBe(false);
    expect(result.current.wallHeldLocally).toBe(true);
    expect(result.current.ledless).toBe(true);
  });

  it('keeps the BLE controls sheet unreachable under a virtual hold', () => {
    // Every action in that sheet (Re-light / Turn off / Disconnect) writes the
    // radio, and there is no controller behind a virtual hold to write to.
    const openControls = vi.fn();
    ctrl.bluetooth = makeBluetooth({ ledless: true, virtualWallHeld: true });
    const { result } = renderHook(() => useLightbulbControl({ surface: 'toolbar', onOpenControls: openControls }), {
      wrapper,
    });
    result.current.onLongPress();
    expect(openControls).not.toHaveBeenCalled();
  });

  it('still disconnects a ledless board that somehow holds a live link', () => {
    // Recovery path for a board wrongly flagged as having no lights, and for the
    // back doors that can connect one (creator header toggle, iOS reconnect intent).
    ctrl.bluetooth = makeBluetooth({ ledless: true, isConnected: true });
    const { result } = renderControl();
    result.current.onPress();
    expect(ctrl.bluetooth?.disconnect).toHaveBeenCalledOnce();
    expect(ctrl.bluetooth?.takeVirtualWall).not.toHaveBeenCalled();
  });

  it("reads a peer holding the server slot as their wall, not this device's", () => {
    // Two climbers can both tap take; the server keeps one holder. The loser must
    // stop showing a held control.
    ctrl.bluetooth = makeBluetooth({ ledless: true, virtualWallHeld: true, wallHeldByOtherUser: true });
    const { result } = renderControl();
    expect(result.current.localConnected).toBe(false);
    expect(result.current.wallHeldLocally).toBe(true);
    expect(result.current.lit).toBe(true);
  });
});

describe('useLightbulbControl relay to an authoritative holder', () => {
  // A session peer authoritatively holds the board: server-owned, seq-gated
  // board-presence holder whose userId is in my roster.
  function arrangePeerHoldsBoard() {
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.sessionMemberUserIds = new Set(['peer-user']);
    ctrl.presence = holderPresenceFor('peer-user');
  }

  it('relays instead of opening a second link the board would refuse', () => {
    arrangePeerHoldsBoard();
    const onRelayToHolder = vi.fn();
    const { result } = renderControl({ onRelayToHolder, canRelay: true });

    expect(result.current.pressAction).toBe('relay');
    expect(result.current.holderIsAuthoritative).toBe(true);

    result.current.onPress();

    expect(onRelayToHolder).toHaveBeenCalledTimes(1);
    // The whole point: no doomed connect, and no BLE touched from this device.
    expect(ctrl.bluetooth?.connect).not.toHaveBeenCalled();
    expect(ctrl.bluetooth?.armUndoWallChangeToast).not.toHaveBeenCalled();
  });

  it('settles without connecting when there is nothing to relay', () => {
    // The toolbar and app-bar bulbs: no displayed climb to put up.
    arrangePeerHoldsBoard();
    const { result } = renderControl({ canRelay: false });

    expect(result.current.pressAction).toBe('noop');
    result.current.onPress();
    expect(ctrl.bluetooth?.connect).not.toHaveBeenCalled();
  });

  it('still connects when the peer-held reading is only the best-effort flag', () => {
    // No board feed bound, so there is no authoritative holder to trust — only
    // `isSessionWallLit`, which has no reconciliation and can stick `true` after
    // a missed WallDisconnected. Suppressing the connect on that would strand a
    // climber with a bulb that never reconnects, so it must NOT relay.
    ctrl.sessionId = 'session-1';
    ctrl.isSessionWallLit = true;
    const onRelayToHolder = vi.fn();
    const { result } = renderControl({ onRelayToHolder, canRelay: true });

    // Lit (a peer appears to be driving) but the tap is still a real connect.
    expect(result.current.lit).toBe(true);
    expect(result.current.holderIsAuthoritative).toBe(false);
    expect(result.current.pressAction).toBe('connect');

    result.current.onPress();

    expect(onRelayToHolder).not.toHaveBeenCalled();
    expect(ctrl.bluetooth?.connect).toHaveBeenCalledTimes(1);
  });

  it('still connects when the stale holder is this device itself', () => {
    // This device held the link, then dropped it. The release is a round-trip
    // behind — and on an unexpected drop may never land — so presence still
    // names us the holder. Relaying to ourselves would suppress the very
    // connect that clears it.
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.sessionMemberUserIds = new Set(['me']);
    ctrl.presence = holderPresenceFor('me');
    ctrl.bluetooth = makeBluetooth({ isConnected: true });

    const onRelayToHolder = vi.fn();
    const { result, rerender } = renderControl({ onRelayToHolder, canRelay: true });
    // While connected the tap disconnects — never relays, even though presence
    // names a session holder.
    expect(result.current.pressAction).toBe('disconnect');

    // The link goes away; presence has not caught up.
    ctrl.bluetooth = makeBluetooth({ isConnected: false, lastLocalHolderUserId: 'me' });
    rerender();

    expect(result.current.holderIsAuthoritative).toBe(false);
    expect(result.current.pressAction).toBe('connect');

    result.current.onPress();
    expect(onRelayToHolder).not.toHaveBeenCalled();
    expect(ctrl.bluetooth?.connect).toHaveBeenCalledTimes(1);
  });

  it('connects when mounted after the provider already observed the local drop', () => {
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.sessionMemberUserIds = new Set(['me']);
    ctrl.presence = holderPresenceFor('me');
    ctrl.bluetooth = makeBluetooth({ lastLocalHolderUserId: 'me' });
    const onRelayToHolder = vi.fn();
    const { result } = renderControl({ onRelayToHolder, canRelay: true });

    expect(result.current.pressAction).toBe('connect');
    result.current.onPress();
    expect(ctrl.bluetooth.connect).toHaveBeenCalledOnce();
    expect(onRelayToHolder).not.toHaveBeenCalled();
  });

  it('forgets the remembered self-hold when the board binding changes', () => {
    // The memory must not outlive what it describes. After an account switch
    // that doesn't remount the tree, the previous account rejoining as a genuine
    // PEER would match its own remembered id and be misread as our stale self.
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.sessionMemberUserIds = new Set(['me']);
    ctrl.presence = holderPresenceFor('me');
    ctrl.bluetooth = makeBluetooth({ isConnected: true });
    const { result, rerender } = renderControl({ onRelayToHolder: vi.fn(), canRelay: true });
    expect(result.current.pressAction).toBe('disconnect');

    // Rebind to a different board; 'me' is now a peer driving THAT board.
    ctrl.bluetooth = makeBluetooth({ isConnected: false });
    ctrl.boardId = 99;
    rerender();

    expect(result.current.holderIsAuthoritative).toBe(true);
    expect(result.current.pressAction).toBe('relay');
  });

  it.each([
    { virtualWallHeld: false, expected: 'takeWall' },
    { virtualWallHeld: true, expected: 'releaseWall' },
  ])('preserves $expected on a ledless board with a session holder', ({ virtualWallHeld, expected }) => {
    arrangePeerHoldsBoard();
    ctrl.bluetooth = makeBluetooth({ ledless: true, virtualWallHeld });
    const onRelayToHolder = vi.fn();
    const { result } = renderControl({ onRelayToHolder, canRelay: true });

    expect(result.current.pressAction).toBe(expected);
    result.current.onPress();
    expect(virtualWallHeld ? ctrl.bluetooth.releaseVirtualWall : ctrl.bluetooth.takeVirtualWall).toHaveBeenCalledOnce();
    expect(onRelayToHolder).not.toHaveBeenCalled();
    expect(ctrl.bluetooth.connect).not.toHaveBeenCalled();
  });

  it('disconnects rather than relaying while this device holds the link', () => {
    arrangePeerHoldsBoard();
    ctrl.bluetooth = makeBluetooth({ isConnected: true });
    const onRelayToHolder = vi.fn();
    const { result } = renderControl({ onRelayToHolder, canRelay: true });

    expect(result.current.pressAction).toBe('disconnect');
    result.current.onPress();

    expect(onRelayToHolder).not.toHaveBeenCalled();
    expect(ctrl.bluetooth?.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('useLightbulbControl Board Connect Tapped (#5654)', () => {
  const connectTaps = () => trackMock.mock.calls.filter(([eventName]) => eventName === 'Board Connect Tapped');

  it('reports which bulb was tapped', () => {
    ctrl.bluetooth = makeBluetooth({ boardName: 'tension' });
    const { result } = renderControl({ surface: 'app_bar' });
    result.current.onPress();
    expect(trackMock).toHaveBeenCalledWith('Board Connect Tapped', {
      surface: 'app_bar',
      boardName: 'tension',
      reconnect: false,
    });
  });

  it('marks a remembered MoonBoard device as a reconnect', () => {
    ctrl.bluetooth = makeBluetooth({ boardName: 'moonboard', reconnectDeviceIdForCurrentBoard: 'moon-abc' });
    const { result } = renderControl({ surface: 'toolbar' });
    result.current.onPress();
    expect(connectTaps()[0]?.[1]).toMatchObject({ surface: 'toolbar', reconnect: true });
  });

  it('says which placement a platter bulb sat in, and only for the platter', () => {
    ctrl.bluetooth = makeBluetooth({ boardName: 'kilter' });
    renderControl({ surface: 'board_control_indicator', placement: 'inline' }).result.current.onPress();
    renderControl({ surface: 'board_control_indicator' }).result.current.onPress();
    expect(connectTaps().map(([, properties]) => properties)).toEqual([
      { surface: 'board_control_indicator', placement: 'inline', boardName: 'kilter', reconnect: false },
      { surface: 'board_control_indicator', boardName: 'kilter', reconnect: false },
    ]);
  });

  it('tells the controls sheet which bulb opened it', () => {
    const openControls = vi.fn();
    ctrl.bluetooth = makeBluetooth({ isConnected: true });
    renderControl({
      surface: 'board_control_indicator',
      placement: 'regular',
      onOpenControls: openControls,
    }).result.current.onLongPress();
    expect(openControls).toHaveBeenCalledWith({ surface: 'board_control_indicator', placement: 'regular' });
  });

  it('counts only taps that start a connect', () => {
    // Disconnect, take/release the wall and a no-op tap are not connect attempts.
    ctrl.bluetooth = makeBluetooth({ isConnected: true });
    renderControl().result.current.onPress();
    ctrl.bluetooth = makeBluetooth({ ledless: true });
    renderControl().result.current.onPress();
    ctrl.bluetooth = makeBluetooth({ loading: true });
    renderControl().result.current.onPress();

    expect(connectTaps()).toHaveLength(0);
  });
});

describe('useLightbulbControl connect (#5654 connect step)', () => {
  it('is the connect onPress runs: logged, undo armed, remembered board targeted, outcome returned', async () => {
    const bluetooth = makeBluetooth({ reconnectSerialForCurrentBoard: 'serial-1' });
    bluetooth.connect.mockResolvedValue(false);
    ctrl.bluetooth = bluetooth;
    const { result } = renderControl({ surface: 'first_connect_card' });

    await expect(result.current.connect()).resolves.toBe(false);

    expect(trackMock).toHaveBeenCalledWith('Board Connect Tapped', {
      surface: 'first_connect_card',
      boardName: 'kilter',
      reconnect: true,
    });
    expect(bluetooth.armUndoWallChangeToast).toHaveBeenCalledTimes(1);
    expect(bluetooth.connect).toHaveBeenCalledWith(undefined, undefined, 'serial-1', undefined);
  });

  it('tags a connect with the surface it was started from', async () => {
    const { result } = renderControl({ surface: 'play_drawer' });

    await result.current.connect('put_on_wall');

    expect(trackMock).toHaveBeenCalledWith('Board Connect Tapped', {
      surface: 'put_on_wall',
      boardName: 'kilter',
      reconnect: false,
    });
  });

  it('resolves false and logs nothing with no board selected', async () => {
    ctrl.bluetooth = null;
    const { result } = renderControl();

    await expect(result.current.connect()).resolves.toBe(false);
    expect(trackMock).not.toHaveBeenCalled();
  });

  // Same gate as onPress: a caller that skips its own pressAction check must
  // not start a second link or a doomed one.
  it.each([
    ['a connect is already in flight', 'noop', () => ({ bluetooth: makeBluetooth({ loading: true }) })],
    ['the wall has no lights', 'takeWall', () => ({ bluetooth: makeBluetooth({ ledless: true }) })],
    [
      'a session peer holds the wall',
      'relay',
      () => {
        ctrl.boardId = 42;
        ctrl.sessionId = 'session-1';
        ctrl.sessionMemberUserIds = new Set(['peer-user']);
        ctrl.presence = holderPresenceFor('peer-user');
        return { bluetooth: makeBluetooth() };
      },
    ],
  ] as const)('resolves false without touching the radio when %s', async (_label, expectedAction, arrange) => {
    const { bluetooth } = arrange();
    ctrl.bluetooth = bluetooth;
    const { result } = renderControl({ onRelayToHolder: vi.fn(), canRelay: true });

    expect(result.current.pressAction).toBe(expectedAction);
    await expect(result.current.connect('first_connect_card')).resolves.toBe(false);
    expect(bluetooth.connect).not.toHaveBeenCalled();
    expect(bluetooth.armUndoWallChangeToast).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalledWith('Board Connect Tapped', expect.anything());
  });
});

// #7001: at a gym with a Kilter, a MoonBoard and a Tension, Previous lands on a
// MoonBoard climb while the Kilter is selected. Connect has to reach the
// MoonBoard. A Kilter connect scans the Aurora family, so its picker listed the
// Kilter and the Tension and never the MoonBoard.
describe('useLightbulbControl connect follows the climb (#7001)', () => {
  const GYM_MOONBOARD = {
    uuid: 'gym-moon',
    boardType: 'moonboard',
    layoutId: 2,
    sizeId: 1,
    setIds: '1,2',
  } as UserBoard;

  function climbOnMoonBoard(): ClimbBoardConnectValue & { moveToClimbBoard: ReturnType<typeof vi.fn> } {
    return { moveToClimbBoard: vi.fn().mockResolvedValue({ kind: 'switched', board: GYM_MOONBOARD }) };
  }

  it('moves to the MoonBoard and connects there, not to the selected Kilter', async () => {
    const bluetooth = makeBluetooth({ reconnectSerialForCurrentBoard: 'kilter-serial' });
    ctrl.bluetooth = bluetooth;
    const climbBoardConnect = climbOnMoonBoard();
    ctrl.climbBoardConnect = climbBoardConnect;
    const { result } = renderControl();

    await expect(result.current.connect()).resolves.toBe(true);

    expect(climbBoardConnect.moveToClimbBoard).toHaveBeenCalledOnce();
    expect(bluetooth.connectAfterBoardSwitch).toHaveBeenCalledWith(GYM_MOONBOARD);
    // Never the Kilter's remembered serial, and never a Kilter-family scan.
    expect(bluetooth.connect).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith('Board Connect Tapped', {
      surface: 'play_drawer',
      boardName: 'moonboard',
      reconnect: false,
    });
  });

  it('does the same for a plain bulb tap', async () => {
    const bluetooth = makeBluetooth();
    ctrl.bluetooth = bluetooth;
    ctrl.climbBoardConnect = climbOnMoonBoard();
    const { result } = renderControl();

    result.current.onPress();

    await vi.waitFor(() => expect(bluetooth.connectAfterBoardSwitch).toHaveBeenCalledWith(GYM_MOONBOARD));
    expect(bluetooth.connect).not.toHaveBeenCalled();
  });

  it('hands the climb the caller just made current to the board lookup', async () => {
    ctrl.bluetooth = makeBluetooth();
    const climbBoardConnect = climbOnMoonBoard();
    ctrl.climbBoardConnect = climbBoardConnect;
    const { result } = renderControl();
    const justCommitted = { boardType: 'moonboard', layoutId: 2 };

    await result.current.connect('put_on_wall', justCommitted);

    expect(climbBoardConnect.moveToClimbBoard).toHaveBeenCalledWith(justCommitted);
  });

  it('connects to the selected board as before when it draws the climb', async () => {
    const bluetooth = makeBluetooth({ reconnectSerialForCurrentBoard: 'kilter-serial' });
    ctrl.bluetooth = bluetooth;
    ctrl.climbBoardConnect = { moveToClimbBoard: vi.fn().mockResolvedValue({ kind: 'none' }) };
    const { result } = renderControl();

    await expect(result.current.connect()).resolves.toBe(true);

    expect(bluetooth.connect).toHaveBeenCalledWith(undefined, undefined, 'kilter-serial', undefined);
    expect(bluetooth.armUndoWallChangeToast).toHaveBeenCalledOnce();
    expect(bluetooth.connectAfterBoardSwitch).not.toHaveBeenCalled();
  });

  it('connects nowhere when the switch fails, rather than falling back to the Kilter', async () => {
    const bluetooth = makeBluetooth();
    ctrl.bluetooth = bluetooth;
    ctrl.climbBoardConnect = { moveToClimbBoard: vi.fn().mockResolvedValue({ kind: 'failed' }) };
    const { result } = renderControl();

    await expect(result.current.connect()).resolves.toBe(false);

    expect(bluetooth.connect).not.toHaveBeenCalled();
    expect(bluetooth.connectAfterBoardSwitch).not.toHaveBeenCalled();
  });

  // A gym MoonBoard with no light kit has no radio to scan for. The bulb on a
  // ledless board takes the wall instead of connecting, so after the move the
  // tap stops there: the bulb re-derives to take-the-wall on the new board.
  it('moves to a ledless board but never scans for it', async () => {
    const bluetooth = makeBluetooth();
    ctrl.bluetooth = bluetooth;
    const ledlessMoonBoard = { ...GYM_MOONBOARD, hasLeds: false } as UserBoard;
    const climbBoardConnect = {
      moveToClimbBoard: vi.fn().mockResolvedValue({ kind: 'switched', board: ledlessMoonBoard }),
    };
    ctrl.climbBoardConnect = climbBoardConnect;
    const { result } = renderControl();

    await expect(result.current.connect()).resolves.toBe(false);

    expect(climbBoardConnect.moveToClimbBoard).toHaveBeenCalledOnce();
    expect(bluetooth.connectAfterBoardSwitch).not.toHaveBeenCalled();
    expect(bluetooth.connect).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalledWith('Board Connect Tapped', expect.anything());
  });

  it('never moves boards for a tap that does not connect', async () => {
    const bluetooth = makeBluetooth({ isConnected: true });
    ctrl.bluetooth = bluetooth;
    const climbBoardConnect = climbOnMoonBoard();
    ctrl.climbBoardConnect = climbBoardConnect;
    const { result } = renderControl();

    result.current.onPress();
    await expect(result.current.connect()).resolves.toBe(false);

    expect(bluetooth.disconnect).toHaveBeenCalledOnce();
    expect(climbBoardConnect.moveToClimbBoard).not.toHaveBeenCalled();
  });
});

describe('useLightbulbControl with a crewmate presence has not confirmed as holder (#7017 QA)', () => {
  // The Pixel that joined Liz's session: its feed named the climb Liz lit a
  // minute ago but no holder yet. It read that as a free board, so one Put on
  // the wall moved the crew's climb AND opened the Select Board picker.
  function arrangeJoinedCrewBeforeHolder(
    over: { holder?: { userId: string | null } | null; lastConnectionSeq?: number; sentAt?: string } = {},
  ) {
    ctrl.boardId = 42;
    ctrl.sessionId = 'session-1';
    ctrl.sessionMemberUserIds = new Set(['me', 'liz']);
    ctrl.refreshPresence = vi.fn();
    ctrl.presence = {
      holder: over.holder ?? null,
      lastConnectionSeq: over.lastConnectionSeq ?? 0,
      currentClimb: { climbUuid: 'propagation', sentByUserId: 'liz', sentAt: over.sentAt ?? new Date().toISOString() },
    } as unknown as BoardPresenceCurrentState;
  }

  it('relays the preview and never connects', async () => {
    arrangeJoinedCrewBeforeHolder();
    const onRelayToHolder = vi.fn();
    const { result } = renderControl({ onRelayToHolder, canRelay: true });

    expect(result.current.pressAction).toBe('relay');
    expect(result.current.holderIsAuthoritative).toBe(true);
    result.current.onPress();
    expect(onRelayToHolder).toHaveBeenCalledTimes(1);
    // The Put on the wall chain's connect is refused too: no picker, no scan.
    await expect(result.current.connect('put_on_wall')).resolves.toBe(false);
    expect(ctrl.bluetooth?.connect).not.toHaveBeenCalled();
    // And the feed is asked to confirm the holder now, not at the next wall event.
    await waitFor(() => expect(ctrl.refreshPresence).toHaveBeenCalledWith('crew-holder-unconfirmed'));
  });

  it('does nothing on the crew climb itself rather than open the picker', () => {
    arrangeJoinedCrewBeforeHolder();
    const { result } = renderControl({ onRelayToHolder: vi.fn(), canRelay: false });
    expect(result.current.pressAction).toBe('noop');
    result.current.onPress();
    expect(ctrl.bluetooth?.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['a holder event said the board is free', { lastConnectionSeq: 7 }],
    ['the climb was lit over an hour ago', { sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }],
  ])('connects as before once %s', (_case, over) => {
    arrangeJoinedCrewBeforeHolder(over);
    const { result } = renderControl({ onRelayToHolder: vi.fn(), canRelay: true });
    expect(result.current.pressAction).toBe('connect');
    expect(result.current.holderIsAuthoritative).toBe(false);
  });

  it('connects as before when this phone held the board as that account', () => {
    arrangeJoinedCrewBeforeHolder();
    ctrl.bluetooth = makeBluetooth({ lastLocalHolderUserId: 'liz' });
    const { result } = renderControl({ onRelayToHolder: vi.fn(), canRelay: true });
    expect(result.current.pressAction).toBe('connect');
  });

  it('connects as before outside a session', () => {
    arrangeJoinedCrewBeforeHolder();
    ctrl.sessionId = null;
    const { result } = renderControl({ onRelayToHolder: vi.fn(), canRelay: true });
    expect(result.current.pressAction).toBe('connect');
  });
});
