// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const inputs = vi.hoisted(() => ({
  isCrewSession: false,
  connection: {
    inAppBoardConnection: 'disconnected' as string,
    localConnected: false,
    holderDisplayName: null as string | null,
  },
}));

vi.mock('../../providers/queue-provider', () => ({ useIsCrewSession: () => inputs.isCrewSession }));
vi.mock('../../components/ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => inputs.connection,
}));

import { useSessionTimerDriver } from '../use-session-timer-driver';

beforeEach(() => {
  inputs.isCrewSession = false;
  inputs.connection = { inAppBoardConnection: 'disconnected', localConnected: false, holderDisplayName: null };
});

describe('useSessionTimerDriver', () => {
  it('feeds crew membership, wall ownership and the board link into the one rule', () => {
    inputs.isCrewSession = true;
    inputs.connection = { inAppBoardConnection: 'heldByPeer', localConnected: true, holderDisplayName: 'Sam' };
    const { result } = renderHook(() => useSessionTimerDriver());

    expect(result.current).toEqual({
      role: 'passenger',
      canAdvanceQueue: false,
      canDriveGymTimer: true,
      blockedReason: 'crewPassenger',
      pacerDisplayName: 'Sam',
    });
  });

  it('hands back the same object while the answer is unchanged', () => {
    const { result, rerender } = renderHook(() => useSessionTimerDriver());
    const first = result.current;

    // A fresh connection object with the same values, as a BLE context update makes.
    inputs.connection = { ...inputs.connection };
    rerender();
    expect(result.current).toBe(first);

    inputs.isCrewSession = true;
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.role).toBe('unheld');
  });
});
