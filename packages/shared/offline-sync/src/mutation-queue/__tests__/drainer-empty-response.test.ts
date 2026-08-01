import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineDatabase, QueryInvalidator } from '../../database';
import type { PendingMutation } from '../queue';

vi.mock('../queue', () => ({
  peekPending: vi.fn(),
  markCompleted: vi.fn().mockResolvedValue(undefined),
  recordFailure: vi.fn().mockResolvedValue(undefined),
  markDeadLetter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../handlers', () => ({
  processMutation: vi.fn(),
}));

import { __resetDrainerStateForTests, drainMutationQueue, setBackgrounded, setSigningOut } from '../drainer';
import { GRAPHQL_EMPTY_RESPONSE_ERROR_NAME } from '../error-classification';
import { processMutation } from '../handlers';
import { markCompleted, markDeadLetter, peekPending, recordFailure } from '../queue';

const mockPeekPending = vi.mocked(peekPending);
const mockMarkCompleted = vi.mocked(markCompleted);
const mockRecordFailure = vi.mocked(recordFailure);
const mockMarkDeadLetter = vi.mocked(markDeadLetter);
const mockProcessMutation = vi.mocked(processMutation);

const mockDb = {} as OfflineDatabase;
const queryClient = {
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
} as unknown as QueryInvalidator;
const graphqlFetch = vi.fn().mockResolvedValue({});

function makeMutation(overrides: Partial<PendingMutation> = {}): PendingMutation {
  return {
    id: 1,
    table_name: 'boardsesh_ticks',
    operation: 'create',
    payload: '{}',
    idempotency_key: 'tick-key-1',
    created_at: '2026-08-01T00:00:00Z',
    retry_count: 0,
    max_retries: 10,
    last_error: null,
    status: 'pending',
    ...overrides,
  };
}

function makeEmptyResponseError(): Error {
  return Object.assign(new Error('GraphQL response body was empty or not valid JSON (HTTP 200)'), {
    name: GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
    status: 200,
  });
}

describe('drainMutationQueue with the real error classifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDrainerStateForTests();
  });

  it('retries an empty 2xx response in-cycle and completes without failure bookkeeping', async () => {
    const mutation = makeMutation();
    const sleep = vi.fn().mockResolvedValue(undefined);

    mockPeekPending.mockResolvedValueOnce([mutation]).mockResolvedValueOnce([mutation]).mockResolvedValueOnce([]);
    mockProcessMutation.mockRejectedValueOnce(makeEmptyResponseError()).mockResolvedValueOnce(undefined);

    await drainMutationQueue(mockDb, queryClient, graphqlFetch, {
      isOnline: () => true,
      sleep,
      maxCycleAttempts: 3,
    });

    expect(mockPeekPending).toHaveBeenCalledWith(mockDb, 10);
    expect(mockPeekPending).toHaveBeenCalledTimes(3);
    expect(mockProcessMutation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockMarkDeadLetter).not.toHaveBeenCalled();
    expect(mockMarkCompleted).toHaveBeenCalledOnce();
    expect(mockMarkCompleted).toHaveBeenCalledWith(mockDb, mutation.id);
  });

  it('bounds persistent empty responses without advancing to a later FIFO row', async () => {
    const firstMutation = makeMutation({ id: 1, idempotency_key: 'tick-key-1' });
    const laterMutation = makeMutation({ id: 2, idempotency_key: 'tick-key-2' });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const maxCycleAttempts = 3;

    mockPeekPending.mockResolvedValue([firstMutation, laterMutation]);
    mockProcessMutation.mockRejectedValue(makeEmptyResponseError());

    await drainMutationQueue(mockDb, queryClient, graphqlFetch, {
      isOnline: () => true,
      sleep,
      maxCycleAttempts,
    });

    expect(mockProcessMutation).toHaveBeenCalledTimes(maxCycleAttempts + 1);
    expect(mockProcessMutation.mock.calls.every(([mutation]) => mutation === firstMutation)).toBe(true);
    expect(mockPeekPending).toHaveBeenCalledTimes(maxCycleAttempts + 1);
    expect(sleep).toHaveBeenCalledTimes(maxCycleAttempts);
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockMarkDeadLetter).not.toHaveBeenCalled();
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('does not sleep or re-peek when the empty-response retry budget is zero', async () => {
    const mutation = makeMutation();
    const sleep = vi.fn().mockResolvedValue(undefined);

    mockPeekPending.mockResolvedValue([mutation]);
    mockProcessMutation.mockRejectedValue(makeEmptyResponseError());

    await drainMutationQueue(mockDb, queryClient, graphqlFetch, {
      isOnline: () => true,
      sleep,
      maxCycleAttempts: 0,
    });

    expect(mockPeekPending).toHaveBeenCalledOnce();
    expect(mockProcessMutation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockMarkDeadLetter).not.toHaveBeenCalled();
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('stops immediately on an ordinary transport failure', async () => {
    const mutation = makeMutation();
    const sleep = vi.fn().mockResolvedValue(undefined);

    mockPeekPending.mockResolvedValueOnce([mutation]);
    mockProcessMutation.mockRejectedValueOnce(new TypeError('Network request failed'));

    await drainMutationQueue(mockDb, queryClient, graphqlFetch, {
      isOnline: () => true,
      sleep,
      maxCycleAttempts: 3,
    });

    expect(mockProcessMutation).toHaveBeenCalledOnce();
    expect(mockPeekPending).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockMarkDeadLetter).not.toHaveBeenCalled();
  });

  it('does not retry after a sign-out starts and completes during empty-response backoff', async () => {
    const mutation = makeMutation();
    const sleep = vi.fn().mockImplementation(async () => {
      setSigningOut(true);
      setSigningOut(false);
    });

    mockPeekPending.mockResolvedValue([mutation]);
    mockProcessMutation.mockRejectedValue(makeEmptyResponseError());

    await drainMutationQueue(mockDb, queryClient, graphqlFetch, {
      isOnline: () => true,
      sleep,
      maxCycleAttempts: 3,
    });

    expect(mockProcessMutation).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('does not retry after the app backgrounds during empty-response backoff', async () => {
    const mutation = makeMutation();
    const sleep = vi.fn().mockImplementation(async () => {
      setBackgrounded(true);
    });

    mockPeekPending.mockResolvedValue([mutation]);
    mockProcessMutation.mockRejectedValue(makeEmptyResponseError());

    try {
      await drainMutationQueue(mockDb, queryClient, graphqlFetch, {
        isOnline: () => true,
        sleep,
        maxCycleAttempts: 3,
      });

      expect(mockProcessMutation).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalledOnce();
      expect(mockRecordFailure).not.toHaveBeenCalled();
    } finally {
      setBackgrounded(false);
    }
  });

  it('does not retry after connectivity drops during empty-response backoff', async () => {
    const mutation = makeMutation();
    let isOnline = true;
    const sleep = vi.fn().mockImplementation(async () => {
      isOnline = false;
    });

    mockPeekPending.mockResolvedValue([mutation]);
    mockProcessMutation.mockRejectedValue(makeEmptyResponseError());

    await drainMutationQueue(mockDb, queryClient, graphqlFetch, {
      isOnline: () => isOnline,
      sleep,
      maxCycleAttempts: 3,
    });

    expect(mockProcessMutation).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });
});
