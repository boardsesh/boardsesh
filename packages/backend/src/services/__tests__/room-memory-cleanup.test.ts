import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { RoomManager } from '../room-manager/room-manager';
import type { ConnectedClient } from '../room-manager/types';
import type { RedisSessionStore } from '../redis-session-store';

let manager: RoomManager;
let localState: {
  clients: Map<string, ConnectedClient>;
  sessions: Map<string, Set<string>>;
  redisStore: RedisSessionStore | null;
  sessionGraceTimers: Map<string, NodeJS.Timeout>;
};

beforeEach(() => {
  vi.useFakeTimers();
  manager = new RoomManager();
  localState = manager as unknown as typeof localState;
  localState.clients.set('connection', {
    connectionId: 'connection',
    sessionId: 'session',
    participantId: 'connection',
    userId: null,
    username: 'Climber',
    isLeader: false,
    connectedAt: new Date(),
  });
  localState.sessions.set('session', new Set(['connection']));
});

afterEach(() => {
  manager.reset();
  vi.useRealTimers();
});

describe('room memory cleanup', () => {
  it('expires an empty room even when the periodic write flush runs during its grace period', async () => {
    await manager.disconnectClient('connection');
    expect(manager.getRuntimeStats()).toMatchObject({ clients: 0, emptySessions: 1, graceTimers: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    await manager.flushPendingWrites();
    expect(manager.getRuntimeStats().graceTimers).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.getRuntimeStats()).toMatchObject({ sessions: 0, emptySessions: 0, graceTimers: 0 });
  });

  it('does not expire a room that has acquired another local connection', async () => {
    await manager.disconnectClient('connection');
    localState.sessions.get('session')!.add('reconnected');
    await manager.flushPendingWrites();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRuntimeStats()).toMatchObject({ sessions: 1, emptySessions: 0, graceTimers: 0 });
  });

  it('refreshes Redis TTLs only for rooms with local connections', async () => {
    const refreshTTL = vi.fn().mockResolvedValue(undefined);
    localState.redisStore = { refreshTTL } as unknown as RedisSessionStore;
    localState.sessions.set('empty', new Set());
    await manager.refreshActiveSessionTTLs();
    expect(refreshTTL).toHaveBeenCalledExactlyOnceWith('session');
  });

  it('explicitly disposes grace timers during shutdown', async () => {
    await manager.disconnectClient('connection');
    const timer = localState.sessionGraceTimers.get('session');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    await manager.shutdown();
    expect(manager.getRuntimeStats().graceTimers).toBe(0);
    expect(clearTimer).toHaveBeenCalledWith(timer);
    clearTimer.mockRestore();
  });
});
