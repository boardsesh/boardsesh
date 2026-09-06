import { describe, it, expect } from 'vitest';

import {
  BACKEND_UNAVAILABLE_ERROR_NAME,
  GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
  hasGraphqlErrorCode,
  isGraphQLEmptyResponseError,
  isRetryable,
  getErrorStatus,
  isNetworkError,
  isServerFailureSignal,
  isServerUnavailableError,
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

describe('BackendUnavailableError', () => {
  // The mobile app throws this synthetically INSTEAD OF sending a request, when
  // its connectivity store already knows the backend is unreachable, the device
  // is offline, or offline mode is on. Nothing reached a server, so it must
  // behave exactly like a dropped connection: the drain stops, retry_count is
  // untouched, and the write goes out when the backend comes back (#4862).
  function makeBackendUnavailableError(extras: Record<string, unknown> = {}): Error {
    return Object.assign(new Error('Backend is unreachable'), {
      name: BACKEND_UNAVAILABLE_ERROR_NAME,
      ...extras,
    });
  }

  it('classifies as a network failure and stays retryable', () => {
    const backendUnavailable = makeBackendUnavailableError();
    expect(isNetworkError(backendUnavailable)).toBe(true);
    expect(isRetryable(backendUnavailable)).toBe(true);
  });

  it('matches through a bounded cause chain, like the empty-response case', () => {
    const wrapped = Object.assign(new Error('mutation failed'), { cause: makeBackendUnavailableError() });
    expect(isNetworkError(wrapped)).toBe(true);
    expect(isRetryable(wrapped)).toBe(true);
  });

  it('keeps precedence over a status that also resolves', () => {
    // It is a locale-independent signal, so it wins the same way an errno code
    // does — the name is a stable identifier, not a guess at prose.
    const backendUnavailable = makeBackendUnavailableError({ status: 400 });
    expect(getErrorStatus(backendUnavailable)).toBe(400);
    expect(isNetworkError(backendUnavailable)).toBe(true);
  });

  it('does not match an unrelated named error', () => {
    expect(isNetworkError(Object.assign(new Error('nope'), { name: 'BackendError' }))).toBe(false);
  });
});

describe('hasGraphqlErrorCode', () => {
  it('finds a string code in a top-level errors array', () => {
    const graphqlError = { errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] };
    expect(hasGraphqlErrorCode(graphqlError, 'INTERNAL_SERVER_ERROR')).toBe(true);
  });

  it('finds a string code in graphql-request ClientError response.errors', () => {
    const clientError = {
      response: { status: 200, errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] },
    };
    expect(hasGraphqlErrorCode(clientError, 'INTERNAL_SERVER_ERROR')).toBe(true);
  });

  it('finds a string code in extensions on the error itself', () => {
    const singleGraphqlError = Object.assign(new Error('boom'), {
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(hasGraphqlErrorCode(singleGraphqlError, 'INTERNAL_SERVER_ERROR')).toBe(true);
  });

  it('walks a bounded .cause chain, like the stable-name checks do', () => {
    const clientError = {
      response: { status: 200, errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] },
    };
    const wrapped = new Error('fetch wrapper', { cause: new Error('middle', { cause: clientError }) });
    expect(hasGraphqlErrorCode(wrapped, 'INTERNAL_SERVER_ERROR')).toBe(true);

    // Past the depth bound the code is not found — no unbounded recursion.
    const tooDeep = new Error('a', {
      cause: new Error('b', { cause: new Error('c', { cause: new Error('d', { cause: clientError }) }) }),
    });
    expect(hasGraphqlErrorCode(tooDeep, 'INTERNAL_SERVER_ERROR')).toBe(false);
  });

  it('ignores a NUMERIC extensions.code — that is a status, read by getErrorStatus', () => {
    expect(hasGraphqlErrorCode({ errors: [{ extensions: { code: 500 } }] }, '500')).toBe(false);
    expect(hasGraphqlErrorCode({ response: { errors: [{ extensions: { code: 400 } }] } }, '400')).toBe(false);
  });

  it('does not match a different code', () => {
    const graphqlError = { errors: [{ extensions: { code: 'BAD_USER_INPUT' } }] };
    expect(hasGraphqlErrorCode(graphqlError, 'INTERNAL_SERVER_ERROR')).toBe(false);
  });

  it('is null-safe on shapes that carry no GraphQL errors at all', () => {
    expect(hasGraphqlErrorCode(null, 'INTERNAL_SERVER_ERROR')).toBe(false);
    expect(hasGraphqlErrorCode(undefined, 'INTERNAL_SERVER_ERROR')).toBe(false);
    expect(hasGraphqlErrorCode('boom', 'INTERNAL_SERVER_ERROR')).toBe(false);
    expect(hasGraphqlErrorCode({ errors: null }, 'INTERNAL_SERVER_ERROR')).toBe(false);
    expect(hasGraphqlErrorCode({ response: null }, 'INTERNAL_SERVER_ERROR')).toBe(false);
    expect(hasGraphqlErrorCode({ errors: [null, {}] }, 'INTERNAL_SERVER_ERROR')).toBe(false);
    expect(hasGraphqlErrorCode(new Error('boom'), 'INTERNAL_SERVER_ERROR')).toBe(false);
  });
});

describe('isServerUnavailableError', () => {
  it('is true only for the edge/upstream verdicts 502, 503 and 504', () => {
    expect(isServerUnavailableError({ status: 502 })).toBe(true);
    expect(isServerUnavailableError({ status: 503 })).toBe(true);
    expect(isServerUnavailableError({ status: 504 })).toBe(true);
  });

  it('is false for a 500 — that is the server answering, not an unreachable one', () => {
    expect(isServerUnavailableError({ status: 500 })).toBe(false);
  });

  it('is false for a 200 and for an error carrying no status', () => {
    expect(isServerUnavailableError({ status: 200 })).toBe(false);
    expect(isServerUnavailableError(new Error('boom'))).toBe(false);
  });

  it('reads a nested graphql-request status the same way getErrorStatus does', () => {
    expect(isServerUnavailableError({ response: { status: 503 } })).toBe(true);
    expect(isServerUnavailableError({ errors: [{ extensions: { status: 504 } }] })).toBe(true);
  });
});

describe('isServerFailureSignal', () => {
  it('is true for a real 5xx', () => {
    expect(isServerFailureSignal({ status: 500 })).toBe(true);
    expect(isServerFailureSignal({ status: 503 })).toBe(true);
  });

  it('is true for the masked INTERNAL_SERVER_ERROR shape served over HTTP 200', () => {
    const masked = { response: { status: 200, errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } };
    expect(isServerFailureSignal(masked)).toBe(true);
  });

  it('is false for a client error and for a plain 200 carrying no masked code', () => {
    expect(isServerFailureSignal({ status: 400 })).toBe(false);
    expect(
      isServerFailureSignal({ response: { status: 200, errors: [{ extensions: { code: 'BAD_USER_INPUT' } }] } }),
    ).toBe(false);
    expect(isServerFailureSignal({ status: 200 })).toBe(false);
  });
});

describe('the masked INTERNAL_SERVER_ERROR shape (issue #4862)', () => {
  // packages/backend/src/graphql/mask-error.ts scrubs any unexpected server-side
  // failure — a Postgres outage included — into a GraphQLError carrying the
  // STRING extensions.code 'INTERNAL_SERVER_ERROR', served over HTTP 200.
  // graphql-request wraps that in a ClientError whose response.status is 200, so
  // every status-based rule reads 200: the queued tick used to be dead-lettered
  // on its FIRST attempt, with the write permanently lost.
  function makeMaskedClientError(): Error {
    return Object.assign(new Error('Something went wrong on our end. Please try again.'), {
      response: {
        status: 200,
        errors: [
          {
            message: 'Something went wrong on our end. Please try again.',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
      },
    });
  }

  it('still resolves as HTTP 200 and is still not a network error', () => {
    const masked = makeMaskedClientError();
    expect(getErrorStatus(masked)).toBe(200);
    expect(isNetworkError(masked)).toBe(false);
  });

  it('is retryable — the regression that dead-lettered a tick queued during a DB outage', () => {
    expect(isRetryable(makeMaskedClientError())).toBe(true);
  });

  it('reads as a server failure signal but not as an unavailability verdict', () => {
    const masked = makeMaskedClientError();
    expect(isServerFailureSignal(masked)).toBe(true);
    expect(isServerUnavailableError(masked)).toBe(false);
  });

  it('leaves an ordinary validation rejection dead-lettering as before', () => {
    // Guard the blast radius: only the masked code changes verdict, so a real
    // 4xx still fails fast instead of burning ten retries.
    const validationError = {
      response: { status: 200, errors: [{ message: 'title is required', extensions: { code: 'BAD_USER_INPUT' } }] },
    };
    expect(isRetryable(validationError)).toBe(false);
  });
});
