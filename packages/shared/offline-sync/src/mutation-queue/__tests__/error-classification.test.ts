import { describe, it, expect } from 'vitest';

import { isRetryable, getErrorStatus, isNetworkError, isTransportNetworkError } from '../error-classification';

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

  it('an aborted request (AbortError by name) is retryable — it never completed against the server', () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    expect(isRetryable(abortError)).toBe(true);
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

  it('an Error-typed WinterCG "fetch failed" wrapper is retryable (not just TypeError)', () => {
    // graphql-ws HTTP transport rejects a timeout mid-drain as a plain Error, so
    // the old `instanceof TypeError` gate dead-lettered a queued offline tick.
    expect(isRetryable(new Error('fetch failed: The request timed out.'))).toBe(true);
  });

  it('a bare iOS NSURLError description (no wrapper) is retryable', () => {
    expect(isRetryable(new Error('The connection has timed out unexpectedly.'))).toBe(true);
  });

  it('an Android UnknownHostException is retryable', () => {
    expect(
      isRetryable(new Error('fetch failed: java.net.UnknownHostException: Unable to resolve host "ws.boardsesh.com"')),
    ).toBe(true);
  });
});

describe('isTransportNetworkError', () => {
  it('matches the always-English fetch/polyfill wrapper strings', () => {
    expect(isTransportNetworkError(new TypeError('Network request failed'))).toBe(true);
    expect(isTransportNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransportNetworkError(new Error('fetch failed: The network connection was lost.'))).toBe(true);
  });

  it('matches locale-independent Java networking exception class names', () => {
    expect(isTransportNetworkError(new Error('java.net.SocketTimeoutException: timeout'))).toBe(true);
    expect(isTransportNetworkError(new Error('javax.net.ssl.SSLHandshakeException: handshake failed'))).toBe(true);
  });

  it('matches an errno transport code on the error or its cause', () => {
    expect(isTransportNetworkError(Object.assign(new Error('boom'), { code: 'ENOTFOUND' }))).toBe(true);
    const wrapped = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    expect(isTransportNetworkError(wrapped)).toBe(true);
  });

  it('matches the best-effort English NSURLError descriptions (un-wrapped iOS case)', () => {
    expect(isTransportNetworkError(new Error('The internet connection appears to be offline.'))).toBe(true);
    expect(isTransportNetworkError(new Error('A TLS error caused the secure connection to fail.'))).toBe(true);
  });

  it('does NOT match a programmer bug that merely mentions fetch/network/timed out', () => {
    // Narrow markers keep real bugs at error level rather than silently retrying them.
    expect(isTransportNetworkError(new TypeError("Cannot read property 'fetch' of undefined"))).toBe(false);
    expect(isTransportNetworkError(new Error('BLE write timed out waiting for the board to accept data'))).toBe(false);
    expect(isTransportNetworkError(new Error('network graph render failed'))).toBe(false);
  });

  it('does not classify a non-object or a real server error', () => {
    expect(isTransportNetworkError('boom')).toBe(false);
    expect(isTransportNetworkError({ response: { status: 500 } })).toBe(false);
  });
});

describe('isNetworkError', () => {
  it('still treats an AbortError (by name) as a network failure — replaying is safe', () => {
    const aborted = new Error('Aborted');
    aborted.name = 'AbortError';
    expect(isNetworkError(aborted)).toBe(true);
  });

  it('classifies the broadened transport shapes', () => {
    expect(isNetworkError(new Error('fetch failed: Could not connect to the server.'))).toBe(true);
    expect(isNetworkError(new TypeError('Network request failed'))).toBe(true);
  });
});
