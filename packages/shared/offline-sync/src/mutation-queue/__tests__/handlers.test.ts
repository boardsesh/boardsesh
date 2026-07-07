import { describe, it, expect, vi } from 'vitest';

import { processMutation } from '../handlers';
import type { PendingMutation } from '../queue';

function pendingMutation(overrides: Partial<PendingMutation>): PendingMutation {
  return {
    id: 1,
    table_name: 'boardsesh_ticks',
    operation: 'update',
    payload: '{}',
    idempotency_key: 'idem-1',
    created_at: '2026-05-01T10:00:00Z',
    retry_count: 0,
    max_retries: 5,
    last_error: null,
    status: 'pending',
    ...overrides,
  };
}

describe('boardsesh_ticks update dispatch', () => {
  it('whitelists UpdateTickInput fields: uuid rides as a variable, stray keys are dropped', async () => {
    const graphqlFetch = vi.fn().mockResolvedValue({});
    const mutation = pendingMutation({
      payload: JSON.stringify({
        uuid: 'tick-uuid-1',
        status: 'send',
        attemptCount: 2,
        comment: 'crux beta',
        // Local row baggage that must never reach UpdateTickInput — GraphQL
        // rejects unknown input fields and the mutation would dead-letter.
        createdAt: '2026-05-01T09:00:00Z',
        board_id: 7,
        junk: true,
      }),
    });

    await processMutation(mutation, graphqlFetch);

    expect(graphqlFetch).toHaveBeenCalledTimes(1);
    const [query, variables] = graphqlFetch.mock.calls[0];
    expect(query).toContain('mutation UpdateTick');
    expect(variables).toEqual({
      uuid: 'tick-uuid-1',
      input: { status: 'send', attemptCount: 2, comment: 'crux beta' },
    });
  });

  it('passes every UpdateTickInput field through, including falsy values', async () => {
    const graphqlFetch = vi.fn().mockResolvedValue({});
    const fullInput = {
      status: 'attempt',
      attemptCount: 0,
      quality: 1,
      difficulty: 10,
      isBenchmark: false,
      comment: '',
      climbedAt: '2026-05-01T10:00:00Z',
    };
    const mutation = pendingMutation({
      payload: JSON.stringify({ uuid: 'tick-uuid-2', ...fullInput }),
    });

    await processMutation(mutation, graphqlFetch);

    const [, variables] = graphqlFetch.mock.calls[0];
    expect(variables).toEqual({ uuid: 'tick-uuid-2', input: fullInput });
  });
});
