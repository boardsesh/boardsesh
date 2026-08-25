// @vitest-environment jsdom
//
// The split that keeps a wall with no lights out of the lock screen.
//
// `boardConnection` is the Live Activity contract: the lock-screen bulb, the
// Dynamic Island, Prev/Next, and both native iOS intents read it, and every one
// of them acts by writing the radio. A hold with no radio behind it must never
// widen that value. `inAppBoardConnection` is the widened one, and only in-app
// surfaces (the queue bar control, the capsule, the bulb) read it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { BoardPresenceCurrentContext, type BoardPresenceCurrentState } from '@boardsesh/board-presence-react';

type BluetoothCtx = {
  isConnected: boolean;
  loading: boolean;
  ledless: boolean;
  virtualWallHeld: boolean;
  wallHeldByOtherUser: boolean;
  canDriveWall: boolean;
} | null;

const ctrl = vi.hoisted(() => ({
  bluetooth: null as BluetoothCtx,
  boardId: null as number | null,
  isSessionWallLit: false,
  sessionId: null as string | null,
  sessionMemberUserIds: new Set<string>(),
  presence: undefined as BoardPresenceCurrentState | undefined,
}));

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

import { useBoardConnectionState } from '../use-board-connection-state';

function makeBluetooth(over: Partial<NonNullable<BluetoothCtx>> = {}): NonNullable<BluetoothCtx> {
  return {
    isConnected: false,
    loading: false,
    ledless: false,
    virtualWallHeld: false,
    wallHeldByOtherUser: false,
    canDriveWall: false,
    ...over,
  };
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(BoardPresenceCurrentContext.Provider, { value: ctrl.presence }, children);

const renderState = () => renderHook(() => useBoardConnectionState(), { wrapper });

beforeEach(() => {
  ctrl.bluetooth = makeBluetooth();
  ctrl.boardId = null;
  ctrl.isSessionWallLit = false;
  ctrl.sessionId = null;
  ctrl.sessionMemberUserIds = new Set();
  ctrl.presence = undefined;
});

describe('useBoardConnectionState under a virtual hold', () => {
  it('leaves the Live Activity value at disconnected while the in-app value reads as driving', () => {
    ctrl.bluetooth = makeBluetooth({ ledless: true, virtualWallHeld: true, canDriveWall: true });
    const { result } = renderState();

    // What the lock screen sees: nothing is driving the wall over Bluetooth.
    expect(result.current.boardConnection).toBe('disconnected');
    expect(result.current.localConnected).toBe(false);
    // What the queue bar sees: this device has the wall.
    expect(result.current.inAppBoardConnection).toBe('connectedByMe');
    expect(result.current.lit).toBe(true);
    expect(result.current.canDriveWall).toBe(true);
  });

  it('hands the in-app value to a peer once the server holder is someone else', () => {
    ctrl.bluetooth = makeBluetooth({
      ledless: true,
      virtualWallHeld: true,
      wallHeldByOtherUser: true,
      canDriveWall: true,
    });
    const { result } = renderState();

    expect(result.current.inAppBoardConnection).toBe('heldByPeer');
    expect(result.current.boardConnection).toBe('disconnected');
  });

  it('surfaces the peer name from the widened value, not the BLE-only one', () => {
    // Board-scoped and NOT session-gated: production shows 413 boards with
    // several climbers reporting versus 36 with any session row at all.
    ctrl.bluetooth = makeBluetooth({ ledless: true, virtualWallHeld: true, wallHeldByOtherUser: true });
    ctrl.presence = {
      holder: { userId: 'peer', displayName: 'Anna' },
      currentClimb: null,
    } as unknown as BoardPresenceCurrentState;
    const { result } = renderState();

    expect(result.current.holderDisplayName).toBe('Anna');
  });

  it('is a pass-through with no hold, on any board', () => {
    for (const ledless of [false, true]) {
      ctrl.bluetooth = makeBluetooth({ ledless });
      const { result } = renderState();
      expect(result.current.inAppBoardConnection).toBe(result.current.boardConnection);
      expect(result.current.lit).toBe(false);
    }
  });

  it('degrades to "has LEDs, nothing held" with no bluetooth context at all', () => {
    ctrl.bluetooth = null;
    const { result } = renderState();
    expect(result.current.ledless).toBe(false);
    expect(result.current.wallHeldLocally).toBe(false);
    expect(result.current.canDriveWall).toBe(false);
    expect(result.current.inAppBoardConnection).toBe('disconnected');
  });
});
