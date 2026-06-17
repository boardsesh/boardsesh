// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ ble: false, wall: false, sessionId: null as string | null }));

vi.mock('../../lib/ble/bluetooth-status-store', () => ({
  useBluetoothConnectedStatus: () => cfg.ble,
}));
vi.mock('../../components/queue-control/use-wall-or-queue-climb', () => ({
  useHasWallClimb: () => cfg.wall,
}));
vi.mock('../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: cfg.sessionId }),
}));

import { useIsActivelyClimbing } from '../use-actively-climbing';

describe('useIsActivelyClimbing', () => {
  beforeEach(() => {
    cfg.ble = false;
    cfg.wall = false;
    cfg.sessionId = null;
  });

  it('is false with no climbing signal', () => {
    expect(renderHook(() => useIsActivelyClimbing()).result.current).toBe(false);
  });

  it('is true when a board is connected over Bluetooth', () => {
    cfg.ble = true;
    expect(renderHook(() => useIsActivelyClimbing()).result.current).toBe(true);
  });

  it('is true when a live wall climb is present', () => {
    cfg.wall = true;
    expect(renderHook(() => useIsActivelyClimbing()).result.current).toBe(true);
  });

  it('is true during a session', () => {
    cfg.sessionId = 'session-1';
    expect(renderHook(() => useIsActivelyClimbing()).result.current).toBe(true);
  });
});
