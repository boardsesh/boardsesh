import { describe, it, expect } from 'vitest';

import { isRetryable, getErrorStatus } from '../error-classification';

describe('getErrorStatus', () => {
  it('extracts status from Response object', () => {
    const response = new Response(null, { status: 404 });
    expect(getErrorStatus(response)).toBe(404);
  });

  it('extracts status from plain object with status property', () => {
    expect(getErrorStatus({ status: 500 })).toBe(500);
  });

  it('extracts status from nested response property', () => {
    expect(getErrorStatus({ response: { status: 502 } })).toBe(502);
  });

  it('extracts status from GraphQL error extensions code', () => {
    const graphqlError = {
      errors: [{ message: 'bad', extensions: { code: 400 } }],
    };
    expect(getErrorStatus(graphqlError)).toBe(400);
  });

  it('extracts status from GraphQL error extensions status', () => {
    const graphqlError = {
      errors: [{ message: 'unauthorized', extensions: { status: 401 } }],
    };
    expect(getErrorStatus(graphqlError)).toBe(401);
  });

  it('returns null for unrecognized error shapes', () => {
    expect(getErrorStatus(new Error('something'))).toBeNull();
    expect(getErrorStatus('string error')).toBeNull();
    expect(getErrorStatus(null)).toBeNull();
    expect(getErrorStatus(undefined)).toBeNull();
  });
});

describe('isRetryable', () => {
  it('network TypeError is retryable', () => {
    expect(isRetryable(new TypeError('network request failed'))).toBe(true);
  });

  it('fetch TypeError is retryable', () => {
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('non-network TypeError without status is retryable (unknown error fallback)', () => {
    expect(isRetryable(new TypeError('Cannot read property'))).toBe(true);
  });

  it('401 is retryable', () => {
    expect(isRetryable({ status: 401 })).toBe(true);
  });

  it('429 rate limit is retryable', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
  });

  it('500 is retryable', () => {
    expect(isRetryable({ status: 500 })).toBe(true);
  });

  it('502 is retryable', () => {
    expect(isRetryable({ status: 502 })).toBe(true);
  });

  it('503 is retryable', () => {
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it('400 is not retryable', () => {
    expect(isRetryable({ status: 400 })).toBe(false);
  });

  it('403 is not retryable', () => {
    expect(isRetryable({ status: 403 })).toBe(false);
  });

  it('404 is not retryable', () => {
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  it('409 is not retryable', () => {
    expect(isRetryable({ status: 409 })).toBe(false);
  });

  it('unknown error without status is retryable', () => {
    expect(isRetryable(new Error('something went wrong'))).toBe(true);
  });

  it('GraphQL error with 5xx extension is retryable', () => {
    const graphqlError = {
      errors: [{ message: 'internal', extensions: { status: 503 } }],
    };
    expect(isRetryable(graphqlError)).toBe(true);
  });

  it('GraphQL error with 400 extension is not retryable', () => {
    const graphqlError = {
      errors: [{ message: 'validation', extensions: { code: 400 } }],
    };
    expect(isRetryable(graphqlError)).toBe(false);
  });
});
