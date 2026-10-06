import { describe, expect, it } from 'vitest';
import { sprayWallLifecycleMessage } from '../../spray/spray-lifecycle-copy';
import {
  extractGraphqlMessage,
  isExpectedAuthError,
  isExpectedBetaValidationError,
  isGraphqlRateLimitedError,
  readGraphqlRateLimit,
  isGraphqlValidationFailedError,
  readGraphqlValidationFailedMessage,
  sprayWallLifecycleRefusal,
  sprayWallRefusalMeansStaleWall,
} from '../extract-error-message';

describe('GraphQL error extraction', () => {
  it.each([
    { extensions: { code: 'RATE_LIMITED', operation: 'searchBoards', retryAfterSeconds: 11 } },
    {
      response: {
        errors: [null, 4, { extensions: { code: 'RATE_LIMITED', operation: 'searchBoards', retryAfterSeconds: 11 } }],
      },
    },
    {
      graphqlErrors: [null, { extensions: { code: 'RATE_LIMITED', operation: 'searchBoards', retryAfterSeconds: 11 } }],
    },
  ])('reads safe structured rate-limit details from %j', (error) => {
    expect(readGraphqlRateLimit(error)).toEqual({ operation: 'searchBoards', retryAfterSeconds: 11 });
    expect(isGraphqlRateLimitedError(error)).toBe(true);
  });

  it.each([undefined, null, -1, NaN, Infinity, '11'])('uses no delay for invalid retryAfterSeconds %s', (delay) => {
    expect(
      readGraphqlRateLimit({ extensions: { code: 'RATE_LIMITED', operation: 4, retryAfterSeconds: delay } }),
    ).toEqual({ operation: null, retryAfterSeconds: null });
  });

  it('accepts zero delay and scans graphqlErrors alongside malformed response errors', () => {
    expect(
      readGraphqlRateLimit({
        response: { errors: [null, false, { extensions: null }] },
        graphqlErrors: [{ extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 0 } }],
      }),
    ).toEqual({ operation: null, retryAfterSeconds: 0 });
  });

  it.each([null, undefined, 'RATE_LIMITED', { response: { errors: [null, 3, false] } }])(
    'ignores malformed or non-rate-limit errors %j',
    (error) => {
      expect(readGraphqlRateLimit(error)).toBeNull();
      expect(isGraphqlRateLimitedError(error)).toBe(false);
    },
  );

  it('detects GRAPHQL_VALIDATION_FAILED and reads its message', () => {
    const error = {
      response: {
        status: 400,
        errors: [
          { message: 'Some other error' },
          {
            message: 'Unknown argument "layoutId" on field "Query.board".',
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          },
        ],
      },
    };

    expect(isGraphqlValidationFailedError(error)).toBe(true);
    expect(readGraphqlValidationFailedMessage(error)).toBe('Unknown argument "layoutId" on field "Query.board".');
  });

  it('reads the message from every shape the predicate matches', () => {
    const message = 'Cannot query field "layoutId" on type "Board".';
    const clientError = { response: { errors: [{ message, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] } };
    const shapes = [
      { cause: clientError },
      { errors: [{ message, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
      Object.assign(new Error(message), { extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }),
    ];

    for (const shape of shapes) {
      expect(isGraphqlValidationFailedError(shape)).toBe(true);
      expect(readGraphqlValidationFailedMessage(shape)).toBe(message);
    }
  });

  it('does not treat other GraphQL codes as validation failures', () => {
    const error = { response: { errors: [{ message: 'nope', extensions: { code: 'BAD_USER_INPUT' } }] } };

    expect(isGraphqlValidationFailedError(error)).toBe(false);
    expect(isGraphqlValidationFailedError(new Error('boom'))).toBe(false);
  });

  it('extracts the first graphql-request response message', () => {
    const error = {
      response: {
        errors: [{ message: 'Server guidance' }],
      },
    };

    expect(extractGraphqlMessage(error)).toBe('Server guidance');
  });

  it('detects RATE_LIMITED graphql-request response errors', () => {
    const error = {
      response: {
        errors: [
          {
            message: 'Rate limit exceeded. Try again in 7 seconds.',
            extensions: { code: 'RATE_LIMITED', operation: 'createSession', retryAfterSeconds: 7 },
          },
        ],
      },
    };

    expect(isGraphqlRateLimitedError(error)).toBe(true);
  });

  it('detects RATE_LIMITED operation errors with direct extensions', () => {
    const error = {
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 3 },
    };

    expect(isGraphqlRateLimitedError(error)).toBe(true);
  });

  it('ignores non-rate-limit GraphQL errors', () => {
    const error = {
      response: {
        errors: [{ message: 'Nope', extensions: { code: 'UNAUTHENTICATED' } }],
      },
    };

    expect(isGraphqlRateLimitedError(error)).toBe(false);
  });
});

describe('isExpectedAuthError', () => {
  it('matches the backend requireAuthenticated message', () => {
    const error = {
      response: {
        status: 200,
        errors: [{ message: 'Authentication required to perform this operation', path: ['myBoards'] }],
      },
    };

    expect(isExpectedAuthError(error)).toBe(true);
  });

  it('matches an UNAUTHENTICATED extensions code', () => {
    const error = {
      response: { errors: [{ message: 'Nope', extensions: { code: 'UNAUTHENTICATED' } }] },
    };

    expect(isExpectedAuthError(error)).toBe(true);
  });

  it('does not match other server errors', () => {
    const error = {
      response: { errors: [{ message: 'Something else broke', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] },
    };

    expect(isExpectedAuthError(error)).toBe(false);
  });

  it('returns false for non-GraphQL errors', () => {
    expect(isExpectedAuthError(new Error('plain'))).toBe(false);
    expect(isExpectedAuthError(null)).toBe(false);
  });
});

describe('isExpectedBetaValidationError', () => {
  it.each([
    'INSTAGRAM_BETA_VALIDATION',
    'BETA_LINK_TICK_NOT_ASCENT',
    'BETA_LINK_TICK_MISMATCH',
    'BETA_LINK_TICK_ALREADY_LINKED',
  ])('matches the expected user-facing attach rejection %s', (code) => {
    const error = { response: { errors: [{ message: 'nope', extensions: { code } }] } };
    expect(isExpectedBetaValidationError(error)).toBe(true);
  });

  it('does not match genuine attach faults that should still report', () => {
    for (const code of ['BETA_LINK_INTERNAL', 'BETA_LINK_INSERT_FAILED', 'FORBIDDEN', 'INTERNAL_SERVER_ERROR']) {
      const error = { response: { errors: [{ message: 'boom', extensions: { code } }] } };
      expect(isExpectedBetaValidationError(error)).toBe(false);
    }
  });

  it('returns false for non-GraphQL errors', () => {
    expect(isExpectedBetaValidationError(new Error('plain'))).toBe(false);
    expect(isExpectedBetaValidationError(null)).toBe(false);
  });
});

describe('spray wall lifecycle refusals', () => {
  const coded = (code: string) => ({ response: { errors: [{ message: 'Server prose.', extensions: { code } }] } });

  it.each([
    ['SPRAY_WALL_ARCHIVED', 'archived', 'sprayWallErrors.archived'],
    ['SPRAY_WALL_HOLDS_LOCKED', 'holdsLocked', 'sprayWallErrors.holdsLocked'],
    ['SPRAY_WALL_RESET_RETIRED', 'resetRetired', 'sprayWallErrors.resetRetired'],
    ['SPRAY_WALL_RESET_OWNER_ONLY', 'resetOwnerOnly', 'sprayWallErrors.resetOwnerOnly'],
    ['SPRAY_WALL_RESET_SOURCE_UNPUBLISHED', 'resetSourceUnpublished', 'sprayWallErrors.resetSourceUnpublished'],
    ['SPRAY_WALL_ARCHIVE_LIMIT_REACHED', 'archiveLimitReached', 'sprayWallErrors.archiveLimitReached'],
  ] as const)('maps %s to its own sentence, never the server prose', (code, refusal, key) => {
    const t = (catalogKey: string) => catalogKey;
    expect(sprayWallLifecycleRefusal(coded(code))).toBe(refusal);
    expect(sprayWallLifecycleMessage(refusal, t)).toBe(key);
  });

  it('reads the code off an error that lifted it onto itself', () => {
    expect(sprayWallLifecycleRefusal({ extensions: { code: 'SPRAY_WALL_ARCHIVED' } })).toBe('archived');
  });

  it('says the archive cap with its number', () => {
    const seen: unknown[] = [];
    sprayWallLifecycleMessage('archiveLimitReached', (key, values) => {
      seen.push(values);
      return key;
    });
    expect(seen).toEqual([{ max: 50 }]);
  });

  it.each([null, undefined, new Error('offline'), coded('SPRAY_WALL_LIMIT_REACHED'), coded('FORBIDDEN')])(
    'leaves anything else alone: %j',
    (error) => {
      expect(sprayWallLifecycleRefusal(error)).toBeNull();
    },
  );

  it('asks for a fresh read of the wall only when it was archived or locked since', () => {
    expect(sprayWallRefusalMeansStaleWall('archived')).toBe(true);
    expect(sprayWallRefusalMeansStaleWall('holdsLocked')).toBe(true);
    expect(sprayWallRefusalMeansStaleWall('resetOwnerOnly')).toBe(false);
    expect(sprayWallRefusalMeansStaleWall(null)).toBe(false);
  });
});
