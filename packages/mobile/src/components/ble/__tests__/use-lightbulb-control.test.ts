// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { BoardPresenceCurrentContext, type BoardPresenceCurrentState } from '@boardsesh/board-presence-react';

type BluetoothCtx = {
  isConnected: boolean;
  loading: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  armUndoWallChangeToast: ReturnType<typeof vi.fn>;
  reconnectSerialForCurrentBoard: string | null;
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
}));
const trackMock = vi.hoisted(() => vi.fn());

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

import { useLightbulbControl } from '../use-lightbulb-control';

function makeBluetooth(over: Partial<NonNullable<BluetoothCtx>> = {}): NonNullable<BluetoothCtx> {
  return {
    isConnected: false,
    loading: false,
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    armUndoWallChangeToast: vi.fn(),
    reconnectSerialForCurrentBoard: null,
    ...over,
  };
}

// Minimal holder — every BoardConnectionHolder field is optional (anonymous).
const anonymousHolderPresence = { holder: {}, currentClimb: null } as unknown as BoardPresenceCurrentState;
const holderPresenceFor = (userId: string): BoardPresenceCurrentState =>
  ({ holder: { userId }, currentClimb: null }) as unknown as BoardPresenceCurrentState;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(BoardPresenceCurrentContext.Provider, { value: ctrl.presence }, children);

function renderControl(source: 'lightbulb_toolbar' | 'lightbulb_drawer' = 'lightbulb_toolbar') {
  return renderHook(() => useLightbulbControl({ source }), { wrapper });
}

beforeEach(() => {
  ctrl.bluetooth = makeBluetooth();
  ctrl.boardId = null;
  ctrl.isSessionWallLit = false;
  ctrl.sessionId = null;
  ctrl.sessionMemberUserIds = new Set();
  ctrl.presence = undefined;
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
    // The headline behaviour: subscribed to the board feed (boardId bound), a
    // session member holds it (their userId is in my roster), this device is not
    // connected — the bulb reads lit but the tap still connects/takes over.
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
  it('connects, arms the undo toast, and tracks when disconnected', () => {
    ctrl.bluetooth = makeBluetooth({ isConnected: false, reconnectSerialForCurrentBoard: 'serial-1' });
    const { result } = renderControl();
    result.current.onPress();
    expect(ctrl.bluetooth?.armUndoWallChangeToast).toHaveBeenCalledOnce();
    expect(ctrl.bluetooth?.connect).toHaveBeenCalledWith(undefined, undefined, 'serial-1');
    expect(ctrl.bluetooth?.disconnect).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith(
      'Board Lightbulb Connect',
      expect.objectContaining({ source: 'lightbulb_toolbar' }),
    );
  });

  it('disconnects (no connect, no track) when already connected', () => {
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
