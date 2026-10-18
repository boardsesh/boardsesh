/**
 * Tests for the APNs Live Activity heartbeat.
 *
 * Verifies:
 * - Skips when APNs is not configured.
 * - Acquires the cluster lock; bails when another instance holds it.
 * - Calls sendLiveActivityUpdate for every session with a registered token.
 * - Skips sessions where buildContentStateFromQueueState returns null.
 * - Skips sessions that already have a pending debounced send.
 * - Increments the heartbeatsSent metric per dispatched session.
 * - Survives a thrown error in one session without blocking the others.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vite-plus/test';
import type { QueueState } from '../services/room-manager';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Mocks (hoisted before importing the heartbeat module)
// ---------------------------------------------------------------------------

const distinctSessionsRows = vi.fn<() => Array<{ sessionId: string }>>(() => []);

vi.mock('../db/client', () => {
  function makeSelectDistinctChain() {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(async () => distinctSessionsRows());
    return chain;
  }
  return {
    db: {
      selectDistinct: vi.fn(() => makeSelectDistinctChain()),
    },
  };
});

const isApnsConfiguredMock = vi.fn<() => boolean>(() => true);
const hasPendingSendMock = vi.fn<(sessionId: string) => boolean>(() => false);
const sendLiveActivityUpdateMock = vi.fn<(sessionId: string, state: unknown) => void>();
const incrementApnsMetricMock = vi.fn<(key: string) => void>();

vi.mock('../services/apns', () => ({
  isApnsConfigured: () => isApnsConfiguredMock(),
  hasPendingSend: (sessionId: string) => hasPendingSendMock(sessionId),
  sendLiveActivityUpdate: (sessionId: string, state: unknown) => sendLiveActivityUpdateMock(sessionId, state),
  incrementApnsMetric: (key: string) => incrementApnsMetricMock(key),
}));

const redisIsConnectedMock = vi.fn<() => boolean>(() => true);
const redisSetMock = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => 'OK');

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => redisIsConnectedMock(),
    getClients: () => ({
      publisher: {
        set: redisSetMock,
      },
    }),
  },
}));

const { __runHeartbeatTickForTests } = await import('../services/apns/heartbeat');

const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

afterAll(() => {
  loggerWarnSpy.mockRestore();
  loggerErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueueState(sessionLabel: string): QueueState {
  const item = {
    uuid: `q-${sessionLabel}`,
    climb: {
      uuid: `c-${sessionLabel}`,
      name: `Test ${sessionLabel}`,
      difficulty: 'V5',
      angle: 40,
    },
  };
  return {
    queue: [item],
    currentClimbQueueItem: item,
  } as unknown as QueueState;
}

function makeRoomManager(stateMap: Record<string, QueueState | Error | null>) {
  return {
    getQueueState: vi.fn(async (sessionId: string) => {
      const entry = stateMap[sessionId];
      if (entry instanceof Error) throw entry;
      if (entry === null) {
        return { queue: [], currentClimbQueueItem: null } as unknown as QueueState;
      }
      if (!entry) throw new Error(`unexpected sessionId ${sessionId}`);
      return entry;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHeartbeatTick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isApnsConfiguredMock.mockReturnValue(true);
    hasPendingSendMock.mockReturnValue(false);
    redisIsConnectedMock.mockReturnValue(true);
    redisSetMock.mockResolvedValue('OK');
    distinctSessionsRows.mockReturnValue([]);
  });

  it('skips entirely when APNs is not configured', async () => {
    isApnsConfiguredMock.mockReturnValue(false);
    distinctSessionsRows.mockReturnValue([{ sessionId: 'a' }]);
    const roomManager = makeRoomManager({ a: makeQueueState('a') });

    await __runHeartbeatTickForTests(roomManager);

    expect(roomManager.getQueueState).not.toHaveBeenCalled();
    expect(sendLiveActivityUpdateMock).not.toHaveBeenCalled();
  });

  it('skips the tick when another instance holds the lock', async () => {
    redisSetMock.mockResolvedValue(null); // NX rejected
    distinctSessionsRows.mockReturnValue([{ sessionId: 'a' }]);
    const roomManager = makeRoomManager({ a: makeQueueState('a') });

    await __runHeartbeatTickForTests(roomManager);

    expect(roomManager.getQueueState).not.toHaveBeenCalled();
    expect(sendLiveActivityUpdateMock).not.toHaveBeenCalled();
  });

  it('dispatches one send per session and increments the metric', async () => {
    distinctSessionsRows.mockReturnValue([{ sessionId: 'a' }, { sessionId: 'b' }]);
    const roomManager = makeRoomManager({
      a: makeQueueState('a'),
      b: makeQueueState('b'),
    });

    await __runHeartbeatTickForTests(roomManager);

    expect(sendLiveActivityUpdateMock).toHaveBeenCalledTimes(2);
    expect(sendLiveActivityUpdateMock).toHaveBeenCalledWith('a', expect.objectContaining({ climbUuid: 'c-a' }));
    expect(sendLiveActivityUpdateMock).toHaveBeenCalledWith('b', expect.objectContaining({ climbUuid: 'c-b' }));
    expect(incrementApnsMetricMock).toHaveBeenCalledTimes(2);
    expect(incrementApnsMetricMock).toHaveBeenCalledWith('heartbeatsSent');
  });

  it('skips sessions whose queue state yields no current item', async () => {
    distinctSessionsRows.mockReturnValue([{ sessionId: 'a' }, { sessionId: 'b' }]);
    const roomManager = makeRoomManager({
      a: null, // no currentClimbQueueItem → builder returns null → skip
      b: makeQueueState('b'),
    });

    await __runHeartbeatTickForTests(roomManager);

    expect(sendLiveActivityUpdateMock).toHaveBeenCalledTimes(1);
    expect(sendLiveActivityUpdateMock).toHaveBeenCalledWith('b', expect.objectContaining({ climbUuid: 'c-b' }));
  });

  it('skips sessions that already have a pending debounced send', async () => {
    distinctSessionsRows.mockReturnValue([{ sessionId: 'a' }, { sessionId: 'b' }]);
    hasPendingSendMock.mockImplementation((sessionId: string) => sessionId === 'a');
    const roomManager = makeRoomManager({
      a: makeQueueState('a'),
      b: makeQueueState('b'),
    });

    await __runHeartbeatTickForTests(roomManager);

    expect(sendLiveActivityUpdateMock).toHaveBeenCalledTimes(1);
    expect(sendLiveActivityUpdateMock).toHaveBeenCalledWith('b', expect.anything());
  });

  it('does not block other sessions when one throws', async () => {
    distinctSessionsRows.mockReturnValue([{ sessionId: 'a' }, { sessionId: 'b' }]);
    const roomManager = makeRoomManager({
      a: new Error('boom'),
      b: makeQueueState('b'),
    });

    await __runHeartbeatTickForTests(roomManager);

    expect(sendLiveActivityUpdateMock).toHaveBeenCalledTimes(1);
    expect(sendLiveActivityUpdateMock).toHaveBeenCalledWith('b', expect.anything());
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[APNs Heartbeat] Failed to build heartbeat state for session a:'),
      expect.any(Error),
    );
  });
});
