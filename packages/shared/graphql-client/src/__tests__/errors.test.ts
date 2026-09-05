// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import { ClientError } from 'graphql-request';
import {
  GraphQLOperationError,
  parseRateLimitError,
  isRateLimitedError,
  isNotSessionMemberExtension,
  isNotSessionMemberError,
} from '../errors';

describe('parseRateLimitError', () => {
  it('reads retryAfterSeconds from the structured RATE_LIMITED extension', () => {
    const error = new GraphQLOperationError([
      {
        message: 'Rate limit exceeded. Try again in 4 seconds.',
        extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 4 },
      },
    ]);
    expect(parseRateLimitError(error)).toEqual({ retryAfterSeconds: 4 });
    expect(isRateLimitedError(error)).toBe(true);
  });

  it('finds a RATE_LIMITED error even when it is not the first in the array', () => {
    const error = new GraphQLOperationError([
      { message: 'other' },
      {
        message: 'Rate limit exceeded. Try again in 9 seconds.',
        extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 9 },
      },
    ]);
    expect(parseRateLimitError(error)).toEqual({ retryAfterSeconds: 9 });
  });

  it('falls back to the message when there is no extension code (legacy server)', () => {
    const error = new GraphQLOperationError([{ message: 'Rate limit exceeded. Try again in 6 seconds.' }]);
    expect(parseRateLimitError(error)).toEqual({ retryAfterSeconds: 6 });
  });

  it('parses a plain Error whose message matches the rate-limit shape', () => {
    expect(parseRateLimitError(new Error('Rate limit exceeded. Try again in 2 seconds.'))).toEqual({
      retryAfterSeconds: 2,
    });
  });

  it('reads structured extensions from an actual graphql-request ClientError', () => {
    const response = {
      errors: [
        { message: 'other', extensions: { code: 'BAD_USER_INPUT' } },
        { message: 'slow down', extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 7 } },
      ],
      status: 429,
      headers: new Headers(),
      body: '',
    } as unknown as ConstructorParameters<typeof ClientError>[0];
    const error = new ClientError(response, { query: 'query Test { __typename }' });

    expect(parseRateLimitError(error)).toEqual({ retryAfterSeconds: 7 });
  });

  it('returns null for a non-rate-limit GraphQL error', () => {
    const error = new GraphQLOperationError([{ message: 'nope', extensions: { code: 'BAD_USER_INPUT' } }]);
    expect(parseRateLimitError(error)).toBeNull();
    expect(isRateLimitedError(error)).toBe(false);
  });

  it('returns null for unrelated errors and non-errors', () => {
    expect(parseRateLimitError(new Error('network down'))).toBeNull();
    expect(parseRateLimitError('rate limit exceeded. try again in 1 seconds.')).toBeNull();
    expect(parseRateLimitError(null)).toBeNull();
  });
});

describe('isNotSessionMemberExtension', () => {
  it('matches the NOT_SESSION_MEMBER code and narrows the reason', () => {
    const extensions = { code: 'NOT_SESSION_MEMBER', reason: 'no-session-id' };
    expect(isNotSessionMemberExtension(extensions)).toBe(true);
    if (isNotSessionMemberExtension(extensions)) {
      // Type narrowing: `reason` is accessible without a cast.
      expect(extensions.reason).toBe('no-session-id');
    }
  });

  it('does not match other codes, null, or undefined', () => {
    expect(isNotSessionMemberExtension({ code: 'RATE_LIMITED' })).toBe(false);
    expect(isNotSessionMemberExtension({ code: 'SESSION_ENDED' })).toBe(false);
    expect(isNotSessionMemberExtension(null)).toBe(false);
    expect(isNotSessionMemberExtension(undefined)).toBe(false);
  });
});

describe('isNotSessionMemberError', () => {
  it('is true for a GraphQLOperationError carrying NOT_SESSION_MEMBER', () => {
    const error = new GraphQLOperationError([
      {
        message: 'Unauthorized: not in any session',
        extensions: { code: 'NOT_SESSION_MEMBER', reason: 'no-session-id' },
      },
    ]);
    expect(isNotSessionMemberError(error)).toBe(true);
  });

  it('finds NOT_SESSION_MEMBER even when a DIFFERENTLY-coded error comes first', () => {
    // The harder case: `GraphQLOperationError.extensions` resolves to the first
    // *coded* error (here SESSION_ENDED), so the guard must iterate every error
    // rather than trust that convenience field.
    const error = new GraphQLOperationError([
      { message: 'This session has ended', extensions: { code: 'SESSION_ENDED' } },
      {
        message: 'Unauthorized: session mismatch',
        extensions: { code: 'NOT_SESSION_MEMBER', reason: 'session-mismatch' },
      },
    ]);
    expect(isNotSessionMemberError(error)).toBe(true);
  });

  it('is true for a raw graphql-ws GraphQLError[] payload (mobile client.subscribe sink)', () => {
    // graphql-ws hands a `client.subscribe` sink's `error` callback the raw
    // error array — mobile session subscriptions never box it into a
    // GraphQLOperationError, so the guard must recognise this shape too.
    const rawPayload = [
      {
        message: 'Unauthorized: not in any session',
        extensions: { code: 'NOT_SESSION_MEMBER', reason: 'no-session-id' },
      },
    ];
    expect(isNotSessionMemberError(rawPayload)).toBe(true);
  });

  it('is false for a raw payload carrying a different code, or malformed entries', () => {
    expect(isNotSessionMemberError([{ message: 'x', extensions: { code: 'RATE_LIMITED' } }])).toBe(false);
    expect(isNotSessionMemberError([{ message: 'no extensions' }])).toBe(false);
    expect(isNotSessionMemberError([null, 'nope'])).toBe(false);
    expect(isNotSessionMemberError([])).toBe(false);
  });

  it('is false for other GraphQL errors, plain errors, and non-errors', () => {
    expect(
      isNotSessionMemberError(new GraphQLOperationError([{ message: 'x', extensions: { code: 'SESSION_ENDED' } }])),
    ).toBe(false);
    expect(isNotSessionMemberError(new Error('Unauthorized: not in any session'))).toBe(false);
    expect(isNotSessionMemberError(null)).toBe(false);
  });
});
