import { describe, it, expect, vi } from 'vitest';
import type { UpdateTickInput } from '@boardsesh/shared-schema/generated';

import { processMutation, UPDATE_TICK_INPUT_FIELDS } from '../handlers';
import type { PendingMutation } from '../queue';

// Compile-time drift guard: the whitelist must name exactly UpdateTickInput's
// fields. A field added to the GraphQL input without updating the whitelist
// (silently dropped from offline edits) or a whitelist entry the schema
// doesn't know (GraphQL validation failure → dead-letter) fails typecheck.
type WhitelistKey = (typeof UPDATE_TICK_INPUT_FIELDS)[number];
const _noMissingFields: [Exclude<keyof UpdateTickInput, WhitelistKey>] extends [never] ? true : never = true;
const _noExtraFields: [Exclude<WhitelistKey, keyof UpdateTickInput>] extends [never] ? true : never = true;
void _noMissingFields;
void _noExtraFields;

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
      angle: 0,
    };
    const mutation = pendingMutation({
      payload: JSON.stringify({ uuid: 'tick-uuid-2', ...fullInput }),
    });

    await processMutation(mutation, graphqlFetch);

    const [, variables] = graphqlFetch.mock.calls[0];
    expect(variables).toEqual({ uuid: 'tick-uuid-2', input: fullInput });
  });

  it('carries an angle edit through the whitelist', async () => {
    const graphqlFetch = vi.fn().mockResolvedValue({});
    const mutation = pendingMutation({
      payload: JSON.stringify({ uuid: 'tick-uuid-3', angle: 25 }),
    });

    await processMutation(mutation, graphqlFetch);

    const [, variables] = graphqlFetch.mock.calls[0];
    expect(variables).toEqual({ uuid: 'tick-uuid-3', input: { angle: 25 } });
  });
});

describe('playlist_climbs update dispatch', () => {
  it('routes a queued reorder through ReorderPlaylistClimb', async () => {
    const graphqlFetch = vi.fn().mockResolvedValue({});
    await processMutation(
      pendingMutation({
        table_name: 'playlist_climbs',
        operation: 'update',
        payload: JSON.stringify({ playlistId: 'playlist-1', climbUuid: 'climb-1', newIndex: 2 }),
      }),
      graphqlFetch,
    );

    expect(graphqlFetch).toHaveBeenCalledWith(expect.stringContaining('ReorderPlaylistClimb'), {
      input: { playlistId: 'playlist-1', climbUuid: 'climb-1', newIndex: 2 },
    });
  });
});
