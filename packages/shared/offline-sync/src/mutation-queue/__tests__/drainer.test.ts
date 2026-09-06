import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OfflineDatabase, QueryInvalidator } from '../../database';
import type { PendingMutation } from '../queue';

vi.mock('../queue', () => ({
  peekPending: vi.fn(),
  markCompleted: vi.fn().mockResolvedValue(undefined),
  recordFailure: vi.fn().mockResolvedValue(undefined),
  markDeadLetter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../handlers', () => ({
  processMutation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../error-classification', () => ({
  isGraphQLEmptyResponseError: vi.fn().mockReturnValue(false),
  isRetryable: vi.fn().mockReturnValue(false),
  isNetworkError: vi.fn().mockReturnValue(false),
  isServerUnavailableError: vi.fn().mockReturnValue(false),
  isServerFailureSignal: vi.fn().mockReturnValue(false),
  getErrorStatus: vi.fn().mockReturnValue(null),
}));

import { drainMutationQueue, __resetDrainerStateForTests, setSigningOut, setBackgrounded } from '../drainer';
import { peekPending, markCompleted, recordFailure, markDeadLetter } from '../queue';
import { processMutation } from '../handlers';
import {
  isGraphQLEmptyResponseError,
  isRetryable,
  isNetworkError,
  isServerUnavailableError,
  isServerFailureSignal,
  getErrorStatus,
} from '../error-classification';

const mockPeekPending = peekPending as ReturnType<typeof vi.fn>;
const mockMarkCompleted = markCompleted as ReturnType<typeof vi.fn>;
const mockRecordFailure = recordFailure as ReturnType<typeof vi.fn>;
const mockMarkDeadLetter = markDeadLetter as ReturnType<typeof vi.fn>;
const mockProcessMutation = processMutation as ReturnType<typeof vi.fn>;
const mockIsGraphQLEmptyResponseError = isGraphQLEmptyResponseError as ReturnType<typeof vi.fn>;
const mockIsRetryable = isRetryable as ReturnType<typeof vi.fn>;
const mockIsNetworkError = isNetworkError as ReturnType<typeof vi.fn>;
const mockIsServerUnavailableError = isServerUnavailableError as ReturnType<typeof vi.fn>;
const mockIsServerFailureSignal = isServerFailureSignal as ReturnType<typeof vi.fn>;
const mockGetErrorStatus = getErrorStatus as ReturnType<typeof vi.fn>;

// Always online unless a test opts out — matches the onlineManager default and
// keeps every existing drain-behaviour test running as before.
const ONLINE = { isOnline: () => true } as const;

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

const mockDb = {} as OfflineDatabase;

function createMockQueryClient() {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueryInvalidator;
}

const mockGraphqlFetch = vi.fn().mockResolvedValue({});

describe('drainMutationQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDrainerStateForTests();
    mockPeekPending.mockResolvedValue([]);
    // Re-assert the factory defaults each test (clearAllMocks keeps implementations,
    // so a prior test's mockReturnValue(true) would otherwise leak forward).
    mockIsGraphQLEmptyResponseError.mockReturnValue(false);
    mockIsRetryable.mockReturnValue(false);
    mockIsNetworkError.mockReturnValue(false);
    mockIsServerUnavailableError.mockReturnValue(false);
    mockIsServerFailureSignal.mockReturnValue(false);
    mockGetErrorStatus.mockReturnValue(null);
    mockRecordFailure.mockResolvedValue({ status: 'pending', retryCount: 1 });
  });

  it('skips the drain entirely while offline', async () => {
    const mutation = makeMutation({ id: 1 });
    mockPeekPending.mockResolvedValue([mutation]);
    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { isOnline: () => false });

    // Never even peeks the queue: no processing, no retry bump, no dead-letter.
    expect(mockPeekPending).not.toHaveBeenCalled();
    expect(mockProcessMutation).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockMarkDeadLetter).not.toHaveBeenCalled();
  });

  it('leaves a write pending (no retry bump, no dead-letter) when the connection drops mid-drain', async () => {
    const mutation = makeMutation({ id: 1 });
    mockPeekPending.mockResolvedValueOnce([mutation]);
    mockProcessMutation.mockRejectedValueOnce(new TypeError('Network request failed'));
    mockIsNetworkError.mockReturnValue(true);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    // The write stays pending to sync on reconnect — an offline blip must never
    // advance retry_count toward the dead-letter.
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockMarkDeadLetter).not.toHaveBeenCalled();
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('processes mutations in order', async () => {
    const mutationA = makeMutation({ id: 1, idempotency_key: 'key-a' });
    const mutationB = makeMutation({ id: 2, idempotency_key: 'key-b' });

    mockPeekPending.mockResolvedValueOnce([mutationA, mutationB]).mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
    expect(mockProcessMutation.mock.calls[0][0]).toBe(mutationA);
    expect(mockProcessMutation.mock.calls[1][0]).toBe(mutationB);
    expect(mockMarkCompleted).toHaveBeenCalledTimes(2);
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 1);
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 2);
  });

  it('emits acknowledgement only after the local queue row is completed', async () => {
    const mutation = makeMutation({ idempotency_key: 'tick-uuid' });
    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);
    const onMutationStatus = vi.fn();
    mockMarkCompleted.mockImplementationOnce(async () => {
      expect(onMutationStatus).not.toHaveBeenCalled();
    });

    await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
      ...ONLINE,
      onMutationStatus,
    });

    expect(onMutationStatus).toHaveBeenCalledWith({
      tableName: 'boardsesh_ticks',
      operation: 'create',
      idempotencyKey: 'tick-uuid',
      status: 'acknowledged',
    });
  });

  it('reports a throwing mutation-status callback and continues delivering the batch', async () => {
    const mutationA = makeMutation({ id: 1, idempotency_key: 'tick-a' });
    const mutationB = makeMutation({ id: 2, idempotency_key: 'tick-b' });
    mockPeekPending.mockResolvedValueOnce([mutationA, mutationB]).mockResolvedValueOnce([]);
    const listenerError = new Error('listener failed');
    const onMutationStatus = vi.fn((event: { idempotencyKey: string }) => {
      if (event.idempotencyKey === 'tick-a') throw listenerError;
    });
    const onMutationStatusError = vi.fn();

    await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
      ...ONLINE,
      onMutationStatus,
      onMutationStatusError,
    });

    expect(onMutationStatus).toHaveBeenCalledTimes(2);
    expect(onMutationStatus.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ idempotencyKey: 'tick-b' }));
    expect(onMutationStatusError).toHaveBeenCalledTimes(1);
    expect(onMutationStatusError).toHaveBeenCalledWith({
      error: listenerError,
      event: expect.objectContaining({ idempotencyKey: 'tick-a', status: 'acknowledged' }),
    });
    expect(mockMarkCompleted).toHaveBeenCalledTimes(2);
  });

  it('emits dead-letter delivery for exhausted retryable and non-retryable writes', async () => {
    const retryable = makeMutation({ id: 1, idempotency_key: 'retryable-tick' });
    const nonRetryable = makeMutation({ id: 2, idempotency_key: 'invalid-tick' });
    mockPeekPending.mockResolvedValueOnce([retryable]).mockResolvedValueOnce([nonRetryable]).mockResolvedValueOnce([]);
    mockProcessMutation.mockRejectedValueOnce(new Error('503')).mockRejectedValueOnce(new Error('invalid'));
    mockIsRetryable.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockRecordFailure.mockResolvedValueOnce({ status: 'dead_letter', retryCount: 10 });
    const onMutationStatus = vi.fn();

    await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
      ...ONLINE,
      maxCycleAttempts: 1,
      sleep: async () => {},
      onMutationStatus,
    });

    expect(onMutationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'retryable-tick', status: 'dead_letter' }),
    );
    expect(onMutationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'invalid-tick', status: 'dead_letter' }),
    );
  });

  // Issue #4315: a dead letter is a permanently lost user write, and until this
  // seam existed it produced no Sentry event and no analytics event anywhere.
  describe('dead-letter telemetry', () => {
    it('reports an exhausted retry budget with the bumped attempt count', async () => {
      const mutation = makeMutation({ id: 1, idempotency_key: 'tick-uuid', max_retries: 5 });
      mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);
      mockProcessMutation.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      mockIsRetryable.mockReturnValue(true);
      mockGetErrorStatus.mockReturnValue(503);
      mockRecordFailure.mockResolvedValueOnce({ status: 'dead_letter', retryCount: 5 });
      const onMutationDeadLettered = vi.fn();

      await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
        ...ONLINE,
        maxCycleAttempts: 1,
        sleep: async () => {},
        onMutationDeadLettered,
      });

      expect(onMutationDeadLettered).toHaveBeenCalledTimes(1);
      expect(onMutationDeadLettered).toHaveBeenCalledWith(
        expect.objectContaining({
          tableName: 'boardsesh_ticks',
          operation: 'create',
          idempotencyKey: 'tick-uuid',
          reason: 'retries_exhausted',
          retryCount: 5,
          maxRetries: 5,
          status: 503,
          errorMessage: '503 Service Unavailable',
        }),
      );
      // The original throw rides along so the platform reporter can attach it
      // as `cause` — a synthetic wrapper with no cause classifies as nothing.
      expect(onMutationDeadLettered.mock.calls[0]?.[0].error).toBeInstanceOf(Error);
      expect(onMutationDeadLettered.mock.calls[0]?.[0].queuedForMs).toBeTypeOf('number');
    });

    it('reports a non-retryable rejection', async () => {
      const mutation = makeMutation({ id: 2, idempotency_key: 'invalid-tick', retry_count: 1 });
      mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);
      mockProcessMutation.mockRejectedValueOnce(new Error('400 Bad Request'));
      mockIsRetryable.mockReturnValue(false);
      mockGetErrorStatus.mockReturnValue(400);
      const onMutationDeadLettered = vi.fn();

      await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
        ...ONLINE,
        onMutationDeadLettered,
      });

      expect(onMutationDeadLettered).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'non_retryable', retryCount: 1, status: 400 }),
      );
    });

    it('does not fire on an acknowledged write', async () => {
      mockPeekPending.mockResolvedValueOnce([makeMutation({ id: 3 })]).mockResolvedValueOnce([]);
      const onMutationDeadLettered = vi.fn();

      await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
        ...ONLINE,
        onMutationDeadLettered,
      });

      expect(onMutationDeadLettered).not.toHaveBeenCalled();
    });

    // The regression that would silently re-break the "an offline write never
    // dead-letters for lack of a connection" contract: a network failure must
    // leave the row pending, so there is nothing to report.
    it('does not fire on a network error', async () => {
      // No trailing empty peek queued: the network branch breaks the cycle
      // immediately, so an unconsumed mockResolvedValueOnce would leak into the
      // next test and silently drain nothing there.
      mockPeekPending.mockResolvedValueOnce([makeMutation({ id: 4 })]);
      mockProcessMutation.mockRejectedValueOnce(new Error('Network request failed'));
      mockIsNetworkError.mockReturnValue(true);
      const onMutationDeadLettered = vi.fn();

      await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
        ...ONLINE,
        onMutationDeadLettered,
      });

      expect(onMutationDeadLettered).not.toHaveBeenCalled();
      expect(mockRecordFailure).not.toHaveBeenCalled();
      expect(mockMarkDeadLetter).not.toHaveBeenCalled();
    });

    it('survives a throwing reporter without aborting the drain or skipping the write', async () => {
      const failing = makeMutation({ id: 5, idempotency_key: 'invalid-tick' });
      const healthy = makeMutation({ id: 6, idempotency_key: 'tick-ok' });
      mockPeekPending.mockResolvedValueOnce([failing, healthy]).mockResolvedValueOnce([]);
      mockProcessMutation.mockRejectedValueOnce(new Error('400')).mockResolvedValueOnce(undefined);
      mockIsRetryable.mockReturnValue(false);
      const onMutationDeadLettered = vi.fn(() => {
        throw new Error('reporter exploded');
      });

      await expect(
        drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
          ...ONLINE,
          onMutationDeadLettered,
        }),
      ).resolves.toBeUndefined();

      expect(mockMarkDeadLetter).toHaveBeenCalledWith(mockDb, 5, '400');
      expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 6);
    });
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
    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE, maxCycleAttempts: 0 });

    expect(mockMarkCompleted).toHaveBeenCalledTimes(1);
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 1);
    expect(mockRecordFailure).toHaveBeenCalledWith(mockDb, 2, 'Server unavailable');
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

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    expect(mockMarkDeadLetter).toHaveBeenCalledWith(mockDb, 1, 'Validation failed');
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 2);
    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
  });

  it('records the failure atomically when a retryable error hits (dead-letter folded into recordFailure)', async () => {
    const mutation = makeMutation({ id: 5, retry_count: 9, max_retries: 10 });

    mockPeekPending.mockResolvedValueOnce([mutation]);

    const retryableError = new Error('Timeout');
    mockProcessMutation.mockRejectedValueOnce(retryableError);
    mockIsRetryable.mockReturnValue(true);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE, maxCycleAttempts: 0 });

    // recordFailure does the retry bump AND the dead-letter transition in one
    // UPDATE; the drainer no longer issues a separate markDeadLetter for the
    // retryable-at-max case (that's the atomicity fix).
    expect(mockRecordFailure).toHaveBeenCalledWith(mockDb, 5, 'Timeout');
    expect(mockMarkDeadLetter).not.toHaveBeenCalled();
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

    const drainPromiseA = drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });
    const drainPromiseB = drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    resolveSlowProcess!();
    await Promise.all([drainPromiseA, drainPromiseB]);

    expect(mockPeekPending).toHaveBeenCalledTimes(2);
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
  });

  it('early-returns without touching the queue while sign-out is in progress', async () => {
    const mutation = makeMutation({ id: 1 });
    mockPeekPending.mockResolvedValue([mutation]);

    const queryClient = createMockQueryClient();

    // Sign-out is wiping local data — a scheduler/listener drain must not run.
    setSigningOut(true);
    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    expect(mockPeekPending).not.toHaveBeenCalled();
    expect(mockProcessMutation).not.toHaveBeenCalled();

    // Once sign-out clears the guard, draining resumes normally.
    setSigningOut(false);
    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);
    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
  });

  it('aborts mid-batch when a sign-out wipe starts (and even completes) during a mutation send', async () => {
    // The drain tail hazard: graphqlFetch resolves the CURRENT auth token per
    // request, so a drain that keeps replaying after the account switch would
    // post the old user's queued writes into the NEW user's account. The
    // epoch check at the top of the per-mutation loop must stop the batch even
    // though the boolean flag is already false again by then.
    const first = makeMutation({ id: 1, idempotency_key: 'key-1' });
    const second = makeMutation({ id: 2, idempotency_key: 'key-2' });
    mockPeekPending.mockResolvedValue([first, second]);

    mockProcessMutation.mockImplementationOnce(async () => {
      // Wipe starts AND finishes while mutation #1 is on the wire.
      setSigningOut(true);
      setSigningOut(false);
    });

    const queryClient = createMockQueryClient();
    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    // Mutation #2 must never have been sent.
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
    expect(mockPeekPending).toHaveBeenCalledTimes(1);
  });

  it('early-returns without touching the queue while the app is backgrounded', async () => {
    const mutation = makeMutation({ id: 1 });
    mockPeekPending.mockResolvedValue([mutation]);

    const queryClient = createMockQueryClient();

    // Backgrounded (Sentry BOARDSESH-AN): further SQLite calls risk running
    // right as iOS suspends the process — a scheduler/listener drain must not
    // start until the app is foregrounded again.
    setBackgrounded(true);
    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    expect(mockPeekPending).not.toHaveBeenCalled();
    expect(mockProcessMutation).not.toHaveBeenCalled();

    // Once foregrounded, draining resumes normally.
    setBackgrounded(false);
    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);
    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });
    expect(mockProcessMutation).toHaveBeenCalledTimes(1);
  });

  it('aborts mid-batch when the app backgrounds during a mutation send', async () => {
    const first = makeMutation({ id: 1, idempotency_key: 'key-1' });
    const second = makeMutation({ id: 2, idempotency_key: 'key-2' });
    mockPeekPending.mockResolvedValue([first, second]);

    mockProcessMutation.mockImplementationOnce(async () => {
      // The app backgrounds while mutation #1 is on the wire.
      setBackgrounded(true);
    });

    const queryClient = createMockQueryClient();
    try {
      await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

      // Mutation #2 must never have been sent — issuing it risks a SQLite call
      // (markCompleted) landing right as the process suspends.
      expect(mockProcessMutation).toHaveBeenCalledTimes(1);
      expect(mockPeekPending).toHaveBeenCalledTimes(1);
      // Sentry BOARDSESH-AN: mutation #1's send already succeeded, but
      // backgrounding was detected right after that network await — the
      // markCompleted SQLite write must be skipped too (row stays pending;
      // idempotency_key makes a resend on the next drain safe).
      expect(mockMarkCompleted).not.toHaveBeenCalled();
    } finally {
      // Explicit reset (not just relying on the next test's beforeEach —
      // __resetDrainerStateForTests already covers it, but a leaked `true`
      // would otherwise silently skip every subsequent test until then).
      setBackgrounded(false);
    }
  });

  it('Sentry BOARDSESH-AN: skips the failure-bookkeeping write when the app backgrounds right after a retryable error', async () => {
    const mutation = makeMutation({ id: 1 });
    mockPeekPending.mockResolvedValue([mutation]);

    const retryableError = new Error('Server unavailable');
    mockProcessMutation.mockImplementationOnce(async () => {
      setBackgrounded(true);
      throw retryableError;
    });
    mockIsRetryable.mockReturnValue(true);

    const queryClient = createMockQueryClient();
    try {
      await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

      // recordFailure would normally bump retry_count here — backgrounding must
      // pre-empt that SQLite write too, leaving the mutation pending as-is.
      expect(mockRecordFailure).not.toHaveBeenCalled();
      expect(mockMarkDeadLetter).not.toHaveBeenCalled();
    } finally {
      setBackgrounded(false);
    }
  });

  it('invalidates correct query keys for boardsesh_ticks', async () => {
    const mutation = makeMutation({ id: 1, table_name: 'boardsesh_ticks' });

    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['logbook'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['userTicks'] });
  });

  it('invalidates correct query keys for user_favorites', async () => {
    const mutation = makeMutation({ id: 1, table_name: 'user_favorites' });

    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['favoriteStatus'] });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['searchClimbs'] });
  });

  it('does not invalidate queries for unknown tables', async () => {
    const mutation = makeMutation({ id: 1, table_name: 'unknown_table' });

    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('stops when peekPending returns empty batch', async () => {
    mockPeekPending.mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    expect(mockProcessMutation).not.toHaveBeenCalled();
  });

  it('resets draining flag even when an unexpected error occurs', async () => {
    const mutation = makeMutation({ id: 1 });

    mockPeekPending.mockResolvedValueOnce([mutation]);
    mockProcessMutation.mockRejectedValueOnce(new Error('crash'));
    mockIsRetryable.mockReturnValue(false);

    mockPeekPending.mockResolvedValueOnce([]);

    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

    const newMutation = makeMutation({ id: 2 });
    mockPeekPending.mockResolvedValueOnce([newMutation]).mockResolvedValueOnce([]);
    mockProcessMutation.mockResolvedValueOnce(undefined);

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE });

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

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, {
      ...ONLINE,
      sleep,
      baseDelayMs: 10,
      maxDelayMs: 100,
    });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(mockRecordFailure).toHaveBeenCalledWith(mockDb, 1, 'transient 503');
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, 1);
    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
  });

  it('does not sleep when the batch drains cleanly', async () => {
    const mutation = makeMutation({ id: 1 });
    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);
    mockProcessMutation.mockResolvedValueOnce(undefined);

    const sleep = vi.fn().mockResolvedValue(undefined);
    const queryClient = createMockQueryClient();

    await drainMutationQueue(mockDb, queryClient, mockGraphqlFetch, { ...ONLINE, sleep });

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
      ...ONLINE,
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
      ...ONLINE,
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

  // Issue #4862: a backend that is up but whose database is down answers every
  // mutation with a server-side failure. Charging each queued write a strike for
  // that spends the whole outbox's budget on a single outage — and the masked
  // shape (HTTP 200 + extensions.code INTERNAL_SERVER_ERROR) used to spend it
  // all at once, dead-lettering a tick on its first attempt.
  describe('server-side failures during an outage', () => {
    it('ends the cycle without a strike when the server answers 503', async () => {
      const mutation = makeMutation({ id: 1 });
      // No trailing empty peek: the unavailable branch ends the cycle, so an
      // unconsumed mockResolvedValueOnce would leak into the next test.
      mockPeekPending.mockResolvedValueOnce([mutation]);
      mockProcessMutation.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      mockIsServerUnavailableError.mockReturnValue(true);
      mockIsServerFailureSignal.mockReturnValue(true);
      // Retryable too, so this pins the ORDER: the unavailability branch has to
      // pre-empt the retry bookkeeping, not merely coexist with it.
      mockIsRetryable.mockReturnValue(true);
      const onMutationDeadLettered = vi.fn();

      await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
        ...ONLINE,
        onMutationDeadLettered,
      });

      expect(mockRecordFailure).not.toHaveBeenCalled();
      expect(mockMarkDeadLetter).not.toHaveBeenCalled();
      expect(mockMarkCompleted).not.toHaveBeenCalled();
      expect(onMutationDeadLettered).not.toHaveBeenCalled();
      // One pass: a network stop ends the cycle rather than backing off.
      expect(mockPeekPending).toHaveBeenCalledTimes(1);
    });

    it('ends the cycle without a strike when the availability probe says the server is down', async () => {
      const mutation = makeMutation({ id: 1 });
      mockPeekPending.mockResolvedValueOnce([mutation]);
      mockProcessMutation.mockRejectedValueOnce(new Error('500 Internal Server Error'));
      mockIsServerFailureSignal.mockReturnValue(true);
      mockIsRetryable.mockReturnValue(true);
      const confirmServerAvailability = vi.fn().mockResolvedValue(false);

      await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
        ...ONLINE,
        confirmServerAvailability,
      });

      expect(confirmServerAvailability).toHaveBeenCalledTimes(1);
      expect(mockRecordFailure).not.toHaveBeenCalled();
      expect(mockMarkDeadLetter).not.toHaveBeenCalled();
      expect(mockPeekPending).toHaveBeenCalledTimes(1);
    });

    it('treats a probe that rejects as "server down": no strike, cycle ends', async () => {
      const mutation = makeMutation({ id: 1 });
      mockPeekPending.mockResolvedValueOnce([mutation]);
      mockProcessMutation.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      mockIsServerFailureSignal.mockReturnValue(true);
      mockIsRetryable.mockReturnValue(true);
      // During a real outage the probe is the request MOST likely to fail. It
      // must never escape the catch block and reject the whole drain.
      const confirmServerAvailability = vi.fn().mockRejectedValue(new Error('probe timed out'));

      await expect(
        drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
          ...ONLINE,
          confirmServerAvailability,
        }),
      ).resolves.toBeUndefined();

      expect(confirmServerAvailability).toHaveBeenCalledTimes(1);
      expect(mockRecordFailure).not.toHaveBeenCalled();
      expect(mockMarkDeadLetter).not.toHaveBeenCalled();
      expect(mockMarkCompleted).not.toHaveBeenCalled();
      expect(mockPeekPending).toHaveBeenCalledTimes(1);
    });

    it('never pays for the probe on a non-server failure (a 400 dead-letters as before)', async () => {
      const mutation = makeMutation({ id: 1 });
      mockPeekPending.mockResolvedValueOnce([mutation]);
      mockProcessMutation.mockRejectedValueOnce(new Error('400 Bad Request'));
      mockIsServerFailureSignal.mockReturnValue(false);
      mockIsRetryable.mockReturnValue(false);
      const confirmServerAvailability = vi.fn().mockResolvedValue(true);

      await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
        ...ONLINE,
        confirmServerAvailability,
      });

      expect(confirmServerAvailability).not.toHaveBeenCalled();
      expect(mockMarkDeadLetter).toHaveBeenCalledWith(mockDb, 1, '400 Bad Request');
    });

    it('charges the retry as before when the probe says the server is usable', async () => {
      const mutation = makeMutation({ id: 1 });
      mockPeekPending.mockResolvedValueOnce([mutation]);
      mockProcessMutation.mockRejectedValueOnce(new Error('500 Internal Server Error'));
      mockIsServerFailureSignal.mockReturnValue(true);
      mockIsRetryable.mockReturnValue(true);
      mockRecordFailure.mockResolvedValueOnce({ status: 'pending', retryCount: 1 });
      const confirmServerAvailability = vi.fn().mockResolvedValue(true);

      await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
        ...ONLINE,
        maxCycleAttempts: 0,
        confirmServerAvailability,
      });

      expect(confirmServerAvailability).toHaveBeenCalledTimes(1);
      // One broken resolver behind a healthy server is exactly what the retry
      // budget is for, so the mutation is charged the way it always was.
      expect(mockRecordFailure).toHaveBeenCalledTimes(1);
      expect(mockRecordFailure).toHaveBeenCalledWith(mockDb, 1, '500 Internal Server Error');
      expect(mockMarkDeadLetter).not.toHaveBeenCalled();
    });

    it('takes the masked HTTP 200 failure as a retryable strike, not an instant dead letter', async () => {
      // The engine's behaviour when the platform wires no probe at all: the
      // masked shape is retryable, so the write keeps the rest of its budget
      // instead of being lost on attempt one.
      const mutation = makeMutation({ id: 1 });
      mockPeekPending.mockResolvedValueOnce([mutation]);
      mockProcessMutation.mockRejectedValueOnce(new Error('Something went wrong on our end. Please try again.'));
      mockIsServerFailureSignal.mockReturnValue(true);
      mockIsRetryable.mockReturnValue(true);
      mockGetErrorStatus.mockReturnValue(200);
      mockRecordFailure.mockResolvedValueOnce({ status: 'pending', retryCount: 1 });

      await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
        ...ONLINE,
        maxCycleAttempts: 0,
      });

      expect(mockRecordFailure).toHaveBeenCalledTimes(1);
      expect(mockMarkDeadLetter).not.toHaveBeenCalled();
    });

    it('skips the failure bookkeeping when the app backgrounds during the probe', async () => {
      // The probe is another await, so the lifecycle re-check below it has to
      // cover it too — otherwise a SQLite write lands right as iOS suspends.
      const mutation = makeMutation({ id: 1 });
      // Queued once, like the other outage cases: the lifecycle re-check ends
      // the cycle, so a persistent mock would only leak into the next test.
      mockPeekPending.mockResolvedValueOnce([mutation]);
      mockProcessMutation.mockRejectedValueOnce(new Error('500 Internal Server Error'));
      mockIsServerFailureSignal.mockReturnValue(true);
      mockIsRetryable.mockReturnValue(true);
      const confirmServerAvailability = vi.fn(async () => {
        setBackgrounded(true);
        return true;
      });

      try {
        await drainMutationQueue(mockDb, createMockQueryClient(), mockGraphqlFetch, {
          ...ONLINE,
          confirmServerAvailability,
        });

        expect(confirmServerAvailability).toHaveBeenCalledTimes(1);
        expect(mockRecordFailure).not.toHaveBeenCalled();
        expect(mockMarkDeadLetter).not.toHaveBeenCalled();
      } finally {
        setBackgrounded(false);
      }
    });
  });
});
