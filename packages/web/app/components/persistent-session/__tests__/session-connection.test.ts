import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionConnection, type SessionConnectionCallbacks, type SessionData } from '../session-connection';

const mockCreateGraphQLClient = vi.fn();
const mockExecute = vi.fn();
const mockSubscribe = vi.fn();

vi.mock('../../graphql-queue/graphql-client', () => ({
  createGraphQLClient: (...args: unknown[]) => mockCreateGraphQLClient(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  subscribe: (...args: unknown[]) => mockSubscribe(...args),
}));

vi.mock('@/app/utils/hash', () => ({
  computeQueueStateHash: () => 'hash',
}));

function buildSessionData(sequence = 1): SessionData {
  return {
    id: 'session-1',
    name: 'Test Session',
    boardPath: '/kilter/1/10/1,2/40',
    users: [],
    queueState: {
      sequence,
      stateHash: 'abc123',
      queue: [],
      currentClimbQueueItem: null,
    },
    isLeader: true,
    clientId: 'client-1',
  };
}

function buildCallbacks(overrides?: Partial<SessionConnectionCallbacks>): SessionConnectionCallbacks {
  return {
    onConnectionFlagsChange: vi.fn(),
    onSessionJoined: vi.fn(),
    onSessionCleared: vi.fn(),
    onQueueEvent: vi.fn(),
    onSessionEvent: vi.fn(),
    onError: vi.fn(),
    onClientCreated: vi.fn(),
    getQueueState: () => ({ queue: [], currentItemUuid: null }),
    getLastSequence: () => 1,
    toClimbQueueItemInput: (item) => item,
    getPendingInitialQueue: () => null,
    clearPendingInitialQueue: vi.fn(),
    ...overrides,
  };
}

describe('SessionConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCreateGraphQLClient.mockReturnValue({
      subscribe: vi.fn(),
      dispose: vi.fn(),
    });
    mockSubscribe.mockReturnValue(vi.fn());
    // Default: resolve execute calls (e.g. LEAVE_SESSION on dispose)
    mockExecute.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles reconnect with transient join failure without clearing session', async () => {
    const callbacks = buildCallbacks();
    mockExecute.mockResolvedValueOnce({ joinSession: buildSessionData() });

    const conn = new SessionConnection({
      backendUrl: 'ws://test',
      sessionId: 'session-1',
      boardPath: '/kilter/1/10/1,2/40',
      callbacks,
    });

    await conn.connect();
    expect(callbacks.onSessionJoined).toHaveBeenCalledTimes(1);

    // Reconnect fails with transient error
    mockExecute.mockRejectedValueOnce(new Error('network timeout'));
    conn.triggerResync(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onSessionCleared).not.toHaveBeenCalled();
    expect(conn.flags.isReconnecting).toBe(true);

    conn.dispose();
  });

  it('clears session on definitive auth failure during reconnect', async () => {
    const callbacks = buildCallbacks();
    mockExecute.mockResolvedValueOnce({ joinSession: buildSessionData() });

    const conn = new SessionConnection({
      backendUrl: 'ws://test',
      sessionId: 'session-1',
      boardPath: '/kilter/1/10/1,2/40',
      callbacks,
    });

    await conn.connect();

    // Reconnect fails with auth error
    mockExecute.mockRejectedValueOnce(new Error('Unauthorized: invalid token'));
    conn.triggerResync(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onSessionCleared).toHaveBeenCalled();
    expect(conn.flags.isReconnecting).toBe(false);

    conn.dispose();
  });

  it('suspends and resumes with a fresh client', async () => {
    const callbacks = buildCallbacks();
    mockExecute.mockResolvedValue({ joinSession: buildSessionData() });

    const conn = new SessionConnection({
      backendUrl: 'ws://test',
      sessionId: 'session-1',
      boardPath: '/kilter/1/10/1,2/40',
      callbacks,
    });

    await conn.connect();
    expect(callbacks.onClientCreated).toHaveBeenCalledTimes(1);

    conn.suspend();
    expect(callbacks.onClientCreated).toHaveBeenCalledWith(null);

    conn.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockCreateGraphQLClient).toHaveBeenCalledTimes(2);

    conn.dispose();
  });

  it('retries transient initial join failure from IDLE and eventually connects', async () => {
    const callbacks = buildCallbacks();

    // First attempt fails with transient error
    mockExecute.mockRejectedValueOnce(new Error('network timeout'));
    // Second attempt succeeds
    mockExecute.mockResolvedValueOnce({ joinSession: buildSessionData() });

    const conn = new SessionConnection({
      backendUrl: 'ws://test',
      sessionId: 'session-1',
      boardPath: '/kilter/1/10/1,2/40',
      callbacks,
    });

    await conn.connect();
    expect(callbacks.onSessionJoined).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledTimes(1);

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(5000);

    expect(callbacks.onSessionJoined).toHaveBeenCalledTimes(1);

    conn.dispose();
  });
});
