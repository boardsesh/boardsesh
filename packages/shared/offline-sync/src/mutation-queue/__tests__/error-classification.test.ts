import { describe, it, expect } from 'vitest';

import {
  GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
  isGraphQLEmptyResponseError,
  isRetryable,
  getErrorStatus,
  isNetworkError,
  isTransportNetworkError,
} from '../error-classification';

describe('isGraphQLEmptyResponseError', () => {
  it('matches the platform error directly and through a cause wrapper', () => {
    const emptyResponseError = Object.assign(new Error('empty GraphQL response'), {
      name: GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
      status: 200,
    });
    const wrappedError = Object.assign(new Error('request failed'), { cause: emptyResponseError });

    expect(isGraphQLEmptyResponseError(emptyResponseError)).toBe(true);
    expect(isGraphQLEmptyResponseError(wrappedError)).toBe(true);
  });

  it('does not match an ordinary transport failure', () => {
    expect(isGraphQLEmptyResponseError(new TypeError('Network request failed'))).toBe(false);
  });
});

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

  // Issue #4331: a lost local write lock resolves no HTTP status, so the
  // "no status ⇒ dead-letter" rule above used to give up on a write the server
  // had already accepted. Contention is transient by definition.
  describe('local SQLite write-lock contention', () => {
    const lockShapes: [string, unknown][] = [
      ['the iOS message', new Error('SQLiteErrorException: Error code 5: database is locked')],
      [
        'the Android message with a raw control byte for the code',
        new Error(
          `Call to function 'NativeStatement.finalizeAsync' has been rejected. → Caused by: Error code ${String.fromCharCode(5)}: database is locked`,
        ),
      ],
      [
        'a wrapped cause chain',
        new Error('Calling the execAsync function has failed', { cause: new Error('SQLITE_BUSY') }),
      ],
      ['a driver code property', Object.assign(new Error('write failed'), { code: 'SQLITE_BUSY' })],
    ];

    it.each(lockShapes)('is retryable — %s', (_label, error) => {
      expect(isRetryable(error)).toBe(true);
    });

    it('is not mistaken for a transport failure (it must not stop the drain cycle)', () => {
      expect(isNetworkError(new Error('Error code 5: database is locked'))).toBe(false);
    });

    it('does not swallow a genuinely broken database', () => {
      expect(isRetryable(new Error('database or disk is full'))).toBe(false);
    });
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

  it('an EPIPE broken-pipe error is retryable (server closed a keep-alive socket, no response)', () => {
    // Replaying an idempotent sync write is safe: the request never completed.
    expect(isRetryable({ code: 'EPIPE' })).toBe(true);
    expect(isRetryable(Object.assign(new Error('write failed'), { cause: { code: 'EPIPE' } }))).toBe(true);
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

  it('classifies EPIPE (broken pipe) as transport — on the error and on its cause', () => {
    // A server-initiated keep-alive socket close surfaces as EPIPE. The request
    // never got a response, so it is a transport failure, not a server verdict.
    expect(isTransportNetworkError({ code: 'EPIPE' })).toBe(true);
    const wrapped = Object.assign(new Error('write failed'), {
      cause: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    });
    expect(isTransportNetworkError(wrapped)).toBe(true);
  });

  it('matches the best-effort English NSURLError descriptions (un-wrapped iOS case)', () => {
    expect(isTransportNetworkError(new Error('The internet connection appears to be offline.'))).toBe(true);
    expect(isTransportNetworkError(new Error('A secure connection to the server cannot be made.'))).toBe(true);
    expect(isTransportNetworkError(new Error('The secure connection failed.'))).toBe(true);
  });

  it('keeps the low-level transport predicate status-blind', () => {
    // Status precedence belongs to isNetworkError; callers may still ask for
    // transport evidence directly without changing this predicate's contract.
    const error = Object.assign(new Error('The connection has timed out unexpectedly.'), { status: 400 });
    expect(isTransportNetworkError(error)).toBe(true);
  });

  it('does NOT match a programmer bug that merely mentions fetch/network/timed out', () => {
    // Narrow markers keep real bugs at error level rather than silently retrying them.
    expect(isTransportNetworkError(new TypeError("Cannot read property 'fetch' of undefined"))).toBe(false);
    expect(isTransportNetworkError(new Error('BLE write timed out waiting for the board to accept data'))).toBe(false);
    expect(isTransportNetworkError(new Error('network graph render failed'))).toBe(false);
  });

  it('does NOT match an app-level business message that merely contains "secure connection"', () => {
    // Regression guard: the regex was previously a bare `secure connection` alternative,
    // which would have swallowed any unrelated message containing that substring.
    expect(isTransportNetworkError(new Error('This operation requires a secure connection'))).toBe(false);
  });

  it('does not classify a non-object or a real server error', () => {
    expect(isTransportNetworkError('boom')).toBe(false);
    expect(isTransportNetworkError({ response: { status: 500 } })).toBe(false);
  });
});

describe('isNetworkError', () => {
  it('treats a named GraphQL empty 2xx response as transport-shaped even with its status attached', () => {
    const error = Object.assign(new Error('GraphQL response body was empty or not valid JSON (HTTP 200)'), {
      name: GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
      status: 200,
    });

    expect(getErrorStatus(error)).toBe(200);
    expect(isNetworkError(error)).toBe(true);
    expect(isRetryable(error)).toBe(true);
  });

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

describe('isNetworkError / isRetryable — resolved status beats the English-prose heuristic', () => {
  // A server that replies with a real HTTP/GraphQL status has, by definition,
  // received the request — that's a server verdict, not a transport failure, no
  // matter what its message happens to say. Without this, a status whose message
  // matches IOS_NSURL_ENGLISH_DESCRIPTIONS would classify as `isNetworkError` and
  // head-of-line-block the ENTIRE drain cycle (drainer.ts's `networkStop`) waiting
  // for a reconnect that will never come, instead of dead-lettering/retrying that
  // one mutation via the status-based rules.

  it('400 + an NSURL-prose-matching message: status wins, NOT a network error, dead-letters', () => {
    const error = Object.assign(new Error('The connection has timed out unexpectedly.'), { status: 400 });
    expect(isNetworkError(error)).toBe(false);
    expect(isRetryable(error)).toBe(false);
  });

  it('503 + an NSURL-prose-matching message: status wins, NOT a network error, but still retries (via status)', () => {
    const error = Object.assign(new Error('The connection has timed out unexpectedly.'), { status: 503 });
    expect(isNetworkError(error)).toBe(false);
    expect(isRetryable(error)).toBe(true);
  });

  it('nested GraphQL 400 plus NSURL prose: status wins and the mutation dead-letters', () => {
    const error = Object.assign(new Error('The connection has timed out unexpectedly.'), {
      response: {
        errors: [{ message: 'invalid input', extensions: { code: 400 } }],
      },
    });
    expect(isNetworkError(error)).toBe(false);
    expect(isRetryable(error)).toBe(false);
  });

  it('no status + an NSURL-prose-matching message: unchanged, still a network error and retryable', () => {
    const error = new Error('The connection has timed out unexpectedly.');
    expect(isNetworkError(error)).toBe(true);
    expect(isRetryable(error)).toBe(true);
  });

  it('no status + a locale-independent code: unchanged, still a network error and retryable', () => {
    const error = { code: 'ECONNREFUSED' };
    expect(isNetworkError(error)).toBe(true);
    expect(isRetryable(error)).toBe(true);
  });

  it('a resolved status + a locale-independent code: locale-independent signal keeps precedence, still a network error', () => {
    // Pins the precedence contract: only the English-prose fallback defers to a
    // resolved status. Locale-independent signals (errno codes, stable markers)
    // are trustworthy regardless of what status also resolves.
    const error = Object.assign(new Error('boom'), { status: 400, code: 'ECONNREFUSED' });
    expect(isNetworkError(error)).toBe(true);
    expect(isRetryable(error)).toBe(true);
  });
});
