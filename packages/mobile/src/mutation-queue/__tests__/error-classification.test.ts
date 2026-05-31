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

  it('extracts status from graphql-request ClientError response.errors extensions code', () => {
    // graphql-request's ClientError nests GraphQL errors under .response.errors
    const clientError = {
      response: {
        errors: [{ message: 'bad request', extensions: { code: 400 } }],
      },
    };
    expect(getErrorStatus(clientError)).toBe(400);
  });

  it('extracts status from graphql-request ClientError response.errors extensions status', () => {
    const clientError = {
      response: {
        errors: [{ message: 'server error', extensions: { status: 503 } }],
      },
    };
    expect(getErrorStatus(clientError)).toBe(503);
  });

  it('prefers response.status over nested response.errors when both present', () => {
    const clientError = {
      response: {
        status: 502,
        errors: [{ message: 'whatever', extensions: { code: 400 } }],
      },
    };
    expect(getErrorStatus(clientError)).toBe(502);
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

  it('non-network TypeError without status is NOT retryable (likely programmer bug, dead-letter)', () => {
    expect(isRetryable(new TypeError('Cannot read property'))).toBe(false);
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

  it('unknown error without status is NOT retryable (dead-letter for visibility)', () => {
    expect(isRetryable(new Error('something went wrong'))).toBe(false);
  });

  it('plain string error without status is NOT retryable', () => {
    expect(isRetryable('boom')).toBe(false);
  });

  it('network TypeError is retryable even though it has no status', () => {
    // Guards against the I5 change regressing genuine network failures.
    expect(isRetryable(new TypeError('Network request failed'))).toBe(true);
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

  it('graphql-request ClientError with 5xx in response.errors is retryable', () => {
    const clientError = {
      response: { errors: [{ message: 'down', extensions: { status: 500 } }] },
    };
    expect(isRetryable(clientError)).toBe(true);
  });

  it('graphql-request ClientError with 400 in response.errors is not retryable', () => {
    const clientError = {
      response: { errors: [{ message: 'invalid', extensions: { code: 400 } }] },
    };
    expect(isRetryable(clientError)).toBe(false);
  });
});
