import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { PendingMutation } from '../queue';

vi.mock('../queue', () => ({
  peekPending: vi.fn(),
  markCompleted: vi.fn().mockResolvedValue(undefined),
  incrementRetry: vi.fn().mockResolvedValue(undefined),
  markDeadLetter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../handlers', () => ({
  processMutation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../error-classification', () => ({
  isRetryable: vi.fn().mockReturnValue(false),
}));

import { drainMutationQueue, __resetDrainerStateForTests } from '../drainer';
import { peekPending, markCompleted, incrementRetry, markDeadLetter } from '../queue';
import { processMutation } from '../handlers';
import { isRetryable } from '../error-classification';

const mockPeekPending = peekPending as ReturnType<typeof vi.fn>;
const mockMarkCompleted = markCompleted as ReturnType<typeof vi.fn>;
const mockIncrementRetry = incrementRetry as ReturnType<typeof vi.fn>;
const mockMarkDeadLetter = markDeadLetter as ReturnType<typeof vi.fn>;
const mockProcessMutation = processMutation as ReturnType<typeof vi.fn>;
const mockIsRetryable = isRetryable as ReturnType<typeof vi.fn>;

function makeMutation(overrides: Partial<PendingMutation> = {}): PendingMutation {
  return {
    id: 1,
    table_name: 'boardsesh_ticks',
    operation: 'create',
    payload: '{}',
    idempotency_key: 'key-1',
    created_at: '2024-01-01T00:00:00Z',
    retry_count: 0,
    max_retries: 10,
    last_error: null,
    status: 'pending',
    ...overrides,
  };
}

const mockDb = {} as SQLiteDatabase;

function createMockQueryClient() {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('@tanstack/react-query').QueryClient;
}

const mockGraphqlFetch = vi.fn().mockResolvedValue({});

describe('drainMutationQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDrainerStateForTests();
    mockPeekPending.mockResolvedValue([]);
  });

  it('processes mutations in order', async () => {
    const mutationA = makeMutation({ id: 1, idempotency_key: 'key-a' });
    const mutationB = makeMutation({ id: 2, idempotency_key: 'key-b' });

    mockPeekPending.mockResolvedValueOnce([mutationA, mutationB]).mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);

    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
    expect(mockProcessMutation.mock.calls[0][0]).toBe(mutationA);
    expect(mockProcessMutation.mock.calls[1][0]).toBe(mutationB);
    expect(mockMarkCompleted).toHaveBeenCalledTimes(2);
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 1);
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 2);
  });

  it('stops processing on retryable error and increments retry', async () => {
    const mutationA = makeMutation({ id: 1 });
    const mutationB = makeMutation({ id: 2 });
    const mutationC = makeMutation({ id: 3 });

    mockPeekPending.mockResolvedValueOnce([mutationA, mutationB, mutationC]);

    const retryableError = new Error('Server unavailable');
    mockProcessMutation.mockResolvedValueOnce(undefined).mockRejectedValueOnce(retryableError);
    mockIsRetryable.mockReturnValue(true);

    const queryClient = createMockQueryClient();

    // maxCycleAttempts:0 → give up the cycle on the first retryable hit (no
    // in-cycle backoff retry), exercising the single-pass stop behavior.
    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { maxCycleAttempts: 0 });

    expect(mockMarkCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 1);
    expect(mockIncrementRetry).toHaveBeenCalledWith(mockDb, 2, 'Server unavailable');
    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
  });

  it('dead-letters non-retryable error and continues processing', async () => {
    const mutationA = makeMutation({ id: 1 });
    const mutationB = makeMutation({ id: 2 });

    mockPeekPending.mockResolvedValueOnce([mutationA, mutationB]).mockResolvedValueOnce([]);

    const nonRetryableError = new Error('Validation failed');
    mockProcessMutation.mockRejectedValueOnce(nonRetryableError).mockResolvedValueOnce(undefined);
    mockIsRetryable.mockReturnValue(false);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);

    expect(mockMarkDeadLetter).toHaveBeenCalledWith(mockDb, 1, 'Validation failed');
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 2);
    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
  });

  it('dead-letters mutation when max retries reached', async () => {
    const mutation = makeMutation({ id: 5, retry_count: 9, max_retries: 10 });

    mockPeekPending.mockResolvedValueOnce([mutation]);

    const retryableError = new Error('Timeout');
    mockProcessMutation.mockRejectedValueOnce(retryableError);
    mockIsRetryable.mockReturnValue(true);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { maxCycleAttempts: 0 });

    expect(mockIncrementRetry).toHaveBeenCalledWith(mockDb, 5, 'Timeout');
    expect(mockMarkDeadLetter).toHaveBeenCalledWith(mockDb, 5, 'Timeout');
  });

  it('prevents concurrent drains', async () => {
    const mutation = makeMutation({ id: 1 });

    let resolveSlowProcess: () => void;
    const slowProcessPromise = new Promise<void>((resolve) => {
      resolveSlowProcess = resolve;
    });

    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValue([]);
    mockProcessMutation.mockImplementationOnce(() => slowProcessPromise);

    const queryClient = createMockQueryClient();

    const drainPromiseA = drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);
    const drainPromiseB = drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);

    resolveSlowProcess!();
    await Promise.all([drainPromiseA, drainPromiseB]);

    expect(mockPeekPending).toHaveBeenCalledTimes(2);
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
  });

  it('invalidates correct query keys for boardsesh_ticks', async () => {
    const mutation = makeMutation({ id: 1, table_name: 'boardsesh_ticks' });

    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['ticks'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['logbook'] });
  });

  it('invalidates correct query keys for user_favorites', async () => {
    const mutation = makeMutation({ id: 1, table_name: 'user_favorites' });

    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['favorites'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['searchClimbs'] });
  });

  it('does not invalidate queries for unknown tables', async () => {
    const mutation = makeMutation({ id: 1, table_name: 'unknown_table' });

    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('stops when peekPending returns empty batch', async () => {
    mockPeekPending.mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);

    expect(mockProcessMutation).not.toHaveBeenCalled();
  });

  it('resets draining flag even when an unexpected error occurs', async () => {
    const mutation = makeMutation({ id: 1 });

    mockPeekPending.mockResolvedValueOnce([mutation]);
    mockProcessMutation.mockRejectedValueOnce(new Error('crash'));
    mockIsRetryable.mockReturnValue(false);

    mockPeekPending.mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);

    const newMutation = makeMutation({ id: 2 });
    mockPeekPending.mockResolvedValueOnce([newMutation]).mockResolvedValueOnce([]);
    mockProcessMutation.mockResolvedValueOnce(undefined);

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch);

    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
  });

  // ── I7: in-cycle exponential backoff ──────────────────────────────────

  it('recovers from a transient retryable failure within the same cycle (backoff)', async () => {
    const mutation = makeMutation({ id: 1 });

    // First peek returns the mutation; it fails (retryable). After the backoff
    // sleep, the queue is re-peeked, the same mutation now succeeds, then empty.
    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);
    mockProcessMutation.mockRejectedValueOnce(new Error('transient 503')).mockResolvedValueOnce(undefined);
    mockIsRetryable.mockReturnValue(true);

    const sleep = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { sleep, baseDelayMs: 10, maxDelayMs: 100 });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(mockIncrementRetry).toHaveBeenCalledWith(mockDb, 1, 'transient 503');
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 1);
    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
  });

  it('does not sleep when the batch drains cleanly', async () => {
    const mutation = makeMutation({ id: 1 });
    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);
    mockProcessMutation.mockResolvedValueOnce(undefined);

    const sleep = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { sleep });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after maxCycleAttempts retryable failures (bounded, no busy-loop)', async () => {
    const mutation = makeMutation({ id: 1, max_retries: 100 });

    // Always returns the same mutation; processMutation always fails (retryable).
    mockPeekPending.mockResolvedValue([mutation]);
    mockProcessMutation.mockRejectedValue(new Error('still down'));
    mockIsRetryable.mockReturnValue(true);

    const sleep = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, {
      sleep,
      maxCycleAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    // 3 backoff sleeps, then it gives up (the 4th retryable hit breaks the cycle).
    expect(sleep).toHaveBeenCalledTimes(3);
    // processMutation ran once per attempt: initial + 3 retries = 4.
    expect(mockProcessMutation).toHaveBeenCalledTimes(4);
  });

  it('passes growing delays to sleep on successive retryable failures', async () => {
    const mutation = makeMutation({ id: 1, max_retries: 100 });

    mockPeekPending.mockResolvedValue([mutation]);
    mockProcessMutation.mockRejectedValue(new Error('down'));
    mockIsRetryable.mockReturnValue(true);

    // Force jitter to its max so the delay is deterministic per attempt.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, {
      sleep,
      maxCycleAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 100_000,
    });

    const delays = sleep.mock.calls.map((call) => call[0] as number);
    // Full-jitter cap doubles each attempt: ~100, ~200, ~400, ~800 (×0.999999, floored).
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
    expect(delays[2]).toBeLessThan(delays[3]);
    expect(delays[0]).toBeGreaterThanOrEqual(99);
    expect(delays[0]).toBeLessThanOrEqual(100);

    randomSpy.mockRestore();
  });
});
