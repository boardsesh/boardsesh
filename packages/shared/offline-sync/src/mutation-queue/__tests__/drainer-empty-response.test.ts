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

import { __resetDrainerStateForTests, drainMutationQueue } from '../drainer';
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

function makeMutation(): PendingMutation {
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
  };
}

describe('drainMutationQueue with the real error classifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDrainerStateForTests();
  });

  it('leaves a mutation pending when its 2xx GraphQL response body is truncated', async () => {
    const mutation = makeMutation();
    const emptyResponseError = Object.assign(
      new Error('GraphQL response body was empty or not valid JSON (HTTP 200)'),
      {
        name: GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
        status: 200,
      },
    );

    mockPeekPending.mockResolvedValueOnce([mutation]);
    mockProcessMutation.mockRejectedValueOnce(emptyResponseError);

    await drainMutationQueue(mockDb, queryClient, graphqlFetch, { isOnline: () => true });

    expect(mockPeekPending).toHaveBeenCalledWith(mockDb, 10);
    expect(mockProcessMutation).toHaveBeenCalledOnce();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockMarkDeadLetter).not.toHaveBeenCalled();
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });
});
