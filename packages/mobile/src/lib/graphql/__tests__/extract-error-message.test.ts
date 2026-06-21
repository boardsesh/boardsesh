import { describe, expect, it } from 'vitest';
import {
  extractGraphqlMessage,
  isExpectedAuthError,
  isExpectedBetaValidationError,
  isGraphqlRateLimitedError,
} from '../extract-error-message';

describe('GraphQL error extraction', () => {
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
