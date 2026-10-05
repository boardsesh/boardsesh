import { describe, it, expect, vi } from 'vitest';
import type { UpdateTickInput } from '@boardsesh/shared-schema/generated';

import { processMutation, UPDATE_TICK_INPUT_FIELDS } from '../handlers';
import { graphqlErrorRejectsUnknownInputField, isPermanentRejection } from '../error-classification';
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

describe('boardsesh_ticks create dispatch: climbRevision (#6023)', () => {
  const tickInput = {
    boardType: 'kilter',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    isBenchmark: false,
    comment: '',
    climbedAt: '2026-10-01T10:00:00Z',
  };

  /** What graphql-request throws when the server answers 200 with `errors`. */
  function graphqlClientError(message: string, code = 'BAD_USER_INPUT') {
    return Object.assign(new Error(`${message}: {"response":{},"request":{"variables":{"climbRevision":3}}}`), {
      response: { status: 200, errors: [{ message, extensions: { code } }] },
    });
  }

  const unknownFieldMessage =
    'Variable "$input" got invalid value { climbRevision: 3 }; Field "climbRevision" is not defined by type "SaveTickInput".';

  it('sends the queued climbRevision with the tick', async () => {
    const graphqlFetch = vi.fn().mockResolvedValue({});
    const mutation = pendingMutation({
      operation: 'create',
      idempotency_key: 'tick-uuid-9',
      payload: JSON.stringify({ ...tickInput, climbRevision: 3 }),
    });

    await processMutation(mutation, graphqlFetch);

    expect(graphqlFetch).toHaveBeenCalledTimes(1);
    const [query, variables] = graphqlFetch.mock.calls[0];
    expect(query).toContain('mutation SaveTick');
    expect(variables).toEqual({ input: { uuid: 'tick-uuid-9', ...tickInput, climbRevision: 3 } });
  });

  it('sends no climbRevision key when the payload has none', async () => {
    const graphqlFetch = vi.fn().mockResolvedValue({});
    const mutation = pendingMutation({ operation: 'create', payload: JSON.stringify(tickInput) });

    await processMutation(mutation, graphqlFetch);

    const [, variables] = graphqlFetch.mock.calls[0];
    expect('climbRevision' in (variables as { input: object }).input).toBe(false);
  });

  it('retries once without climbRevision when the backend does not know the field', async () => {
    const graphqlFetch = vi.fn().mockRejectedValueOnce(graphqlClientError(unknownFieldMessage)).mockResolvedValue({});
    const mutation = pendingMutation({
      operation: 'create',
      idempotency_key: 'tick-uuid-9',
      payload: JSON.stringify({ ...tickInput, climbRevision: 3 }),
    });

    await expect(processMutation(mutation, graphqlFetch)).resolves.toBeUndefined();

    expect(graphqlFetch).toHaveBeenCalledTimes(2);
    expect(graphqlFetch.mock.calls[0][1]).toEqual({ input: { uuid: 'tick-uuid-9', ...tickInput, climbRevision: 3 } });
    // Same tick, same uuid, so the server dedupes if the first send did land.
    expect(graphqlFetch.mock.calls[1][1]).toEqual({ input: { uuid: 'tick-uuid-9', ...tickInput } });
  });

  it('throws the retry’s own error when the second send fails too', async () => {
    const retryError = new Error('Network request failed');
    const graphqlFetch = vi
      .fn()
      .mockRejectedValueOnce(graphqlClientError(unknownFieldMessage))
      .mockRejectedValueOnce(retryError);
    const mutation = pendingMutation({
      operation: 'create',
      payload: JSON.stringify({ ...tickInput, climbRevision: 3 }),
    });

    await expect(processMutation(mutation, graphqlFetch)).rejects.toBe(retryError);
    expect(graphqlFetch).toHaveBeenCalledTimes(2);
  });

  it('leaves an unrelated validation error permanent: one send, the error thrown as it came', async () => {
    const validationError = graphqlClientError(
      'Variable "$input" got invalid value "sent" at "input.status"; Value "sent" does not exist in "TickStatus" enum.',
    );
    const graphqlFetch = vi.fn().mockRejectedValue(validationError);
    const mutation = pendingMutation({
      operation: 'create',
      payload: JSON.stringify({ ...tickInput, climbRevision: 3 }),
    });

    await expect(processMutation(mutation, graphqlFetch)).rejects.toBe(validationError);
    expect(graphqlFetch).toHaveBeenCalledTimes(1);
    expect(isPermanentRejection(validationError)).toBe(true);
  });

  // The regression the anchored match exists for: graphql-js prints the whole
  // input in the message, so this rejection names `climbRevision: 3` while
  // being about the status. Retrying without the version would not fix it.
  it('does not retry an unrelated input rejection whose message quotes climbRevision: 3', async () => {
    const validationError = graphqlClientError(
      'Variable "$input" got invalid value { status: "sent", attemptCount: 2, climbRevision: 3 }; ' +
        'Value "sent" does not exist in "TickStatus" enum at "input.status".',
    );
    const graphqlFetch = vi.fn().mockRejectedValue(validationError);
    const mutation = pendingMutation({
      operation: 'create',
      payload: JSON.stringify({ ...tickInput, climbRevision: 3 }),
    });

    await expect(processMutation(mutation, graphqlFetch)).rejects.toBe(validationError);
    expect(graphqlFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the tick carried no climbRevision to drop', async () => {
    const rejection = graphqlClientError(unknownFieldMessage);
    const graphqlFetch = vi.fn().mockRejectedValue(rejection);
    const mutation = pendingMutation({ operation: 'create', payload: JSON.stringify(tickInput) });

    await expect(processMutation(mutation, graphqlFetch)).rejects.toBe(rejection);
    expect(graphqlFetch).toHaveBeenCalledTimes(1);
  });

  it('does not read the thrown message itself, which quotes the request variables', async () => {
    // graphql-request appends the request to `error.message`, so every field
    // that was sent appears there. Only the server's own error entries count.
    const networkShaped = Object.assign(new Error('boom: {"request":{"variables":{"input":{"climbRevision":3}}}}'), {
      response: { status: 200, errors: [{ message: 'Climb not found', extensions: { code: 'BAD_USER_INPUT' } }] },
    });
    const graphqlFetch = vi.fn().mockRejectedValue(networkShaped);
    const mutation = pendingMutation({
      operation: 'create',
      payload: JSON.stringify({ ...tickInput, climbRevision: 3 }),
    });

    await expect(processMutation(mutation, graphqlFetch)).rejects.toBe(networkShaped);
    expect(graphqlFetch).toHaveBeenCalledTimes(1);
  });

  it('never drops a field from an update, which has no droppable fields', async () => {
    const rejection = graphqlClientError(unknownFieldMessage);
    const graphqlFetch = vi.fn().mockRejectedValue(rejection);
    const mutation = pendingMutation({ payload: JSON.stringify({ uuid: 'tick-uuid-1', status: 'send' }) });

    await expect(processMutation(mutation, graphqlFetch)).rejects.toBe(rejection);
    expect(graphqlFetch).toHaveBeenCalledTimes(1);
  });
});

describe('graphqlErrorRejectsUnknownInputField', () => {
  it('matches the unknown-field clause for exactly that field', () => {
    const named = { errors: [{ message: 'Field "climbRevision" is not defined by type "SaveTickInput".' }] };
    expect(graphqlErrorRejectsUnknownInputField(named, 'climbRevision')).toBe(true);
    const longerName = { errors: [{ message: 'Field "climbRevisionNote" is not defined by type "SaveTickInput".' }] };
    expect(graphqlErrorRejectsUnknownInputField(longerName, 'climbRevision')).toBe(false);
  });

  // graphql-js prints the whole input object in a coercion message, so the
  // field name appears in a rejection that is about something else entirely.
  it('does not match a rejection that only quotes the field inside the printed input', () => {
    const aboutAnotherField = {
      response: {
        errors: [
          {
            message:
              'Variable "$input" got invalid value "sent" at "input.status"; Value "sent" does not exist in "TickStatus" enum. ' +
              'Input was { status: "sent", climbRevision: 3 }.',
          },
        ],
      },
    };
    expect(graphqlErrorRejectsUnknownInputField(aboutAnotherField, 'climbRevision')).toBe(false);

    const anotherUnknownField = {
      errors: [
        {
          message:
            'Variable "$input" got invalid value { climbRevision: 3, colour: "red" }; Field "colour" is not defined by type "SaveTickInput".',
        },
      ],
    };
    expect(graphqlErrorRejectsUnknownInputField(anotherUnknownField, 'climbRevision')).toBe(false);
  });

  it('follows a wrapped cause and ignores non-errors', () => {
    const wrapped = new Error('send failed', {
      cause: { response: { errors: [{ message: 'Field "climbRevision" is not defined by type "SaveTickInput".' }] } },
    });
    expect(graphqlErrorRejectsUnknownInputField(wrapped, 'climbRevision')).toBe(true);
    expect(graphqlErrorRejectsUnknownInputField(null, 'climbRevision')).toBe(false);
    expect(graphqlErrorRejectsUnknownInputField('Field "climbRevision" is not defined', 'climbRevision')).toBe(false);
  });
});
