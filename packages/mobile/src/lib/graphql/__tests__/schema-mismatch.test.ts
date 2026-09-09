import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isPermanentRejection, isRetryable } from '@boardsesh/offline-sync/error-classification';
import {
  isSchemaMismatchError,
  resetSchemaMismatchReportsForTests,
  shouldReportSchemaMismatch,
  withSchemaMismatchFallback,
} from '../schema-mismatch';

// The two live shapes from issue #5370, copied from the Sentry payloads rather
// than invented: graphql-request wraps the backend's HTTP 400 in a ClientError
// carrying `response.status` and `response.errors[]`.

/** Sentry BOARDSESH-CJ — JS ahead of backend (#5283 shipped `layoutId` by OTA first). */
function unknownArgumentError(): Error {
  return Object.assign(new Error('Unknown argument "layoutId" on field "Query.recentBetaLinks".'), {
    response: {
      status: 400,
      errors: [
        {
          message: 'Unknown argument "layoutId" on field "Query.recentBetaLinks".',
          locations: [{ line: 3, column: 59 }],
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        },
      ],
    },
  });
}

/** Sentry BOARDSESH-7H — backend ahead of JS (#4792 deleted `otaPreviewChannels`). */
function unknownFieldError(): Error {
  return Object.assign(new Error('Cannot query field "otaPreviewChannels" on type "Query".'), {
    response: {
      status: 400,
      errors: [
        {
          message: 'Cannot query field "otaPreviewChannels" on type "Query".',
          locations: [{ line: 3, column: 5 }],
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        },
      ],
    },
  });
}

beforeEach(() => {
  resetSchemaMismatchReportsForTests();
});

describe('isSchemaMismatchError', () => {
  it('recognises an unknown argument (JS ahead of backend)', () => {
    expect(isSchemaMismatchError(unknownArgumentError())).toBe(true);
  });

  it('recognises an unknown field (backend ahead of JS)', () => {
    expect(isSchemaMismatchError(unknownFieldError())).toBe(true);
  });

  // This is the guard that stops "degrade on a validation error" becoming
  // "swallow everything". Each of these can succeed on the next attempt, so
  // none may be read as a permanent schema refusal.
  it.each([
    ['a transport failure', Object.assign(new TypeError('Network request failed'), { name: 'TypeError' })],
    ['a request timeout', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    [
      'a 500 from the server',
      Object.assign(new Error('boom'), { response: { status: 500, errors: [{ message: 'boom' }] } }),
    ],
    [
      'a masked internal server error over HTTP 200',
      Object.assign(new Error('Unexpected error.'), {
        response: { status: 200, errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] },
      }),
    ],
    [
      'a rate-limit rejection',
      Object.assign(new Error('Rate limit exceeded.'), {
        response: { status: 200, errors: [{ extensions: { code: 'RATE_LIMITED' } }] },
      }),
    ],
    ['a plain programmer bug', new Error('undefined is not a function')],
  ])('does not claim %s', (_label, error) => {
    expect(isSchemaMismatchError(error)).toBe(false);
  });

  // A 404 / 502 / 503 / 504 is an edge or proxy talking about routing; the body
  // is an error page, not a server's verdict on this document. Railway served
  // exactly that shape for 6m30s on 2026-09-02 (#5295). Reading a canned body's
  // code there would paint a permanent "degraded" state over a transient outage.
  it.each([404, 502, 503, 504])('ignores the code when an edge served the %i', (status) => {
    const edgeError = Object.assign(new Error('Application failed to respond'), {
      response: { status, errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
    });
    expect(isSchemaMismatchError(edgeError)).toBe(false);
  });
});

// The offline drainer already treats GRAPHQL_VALIDATION_FAILED as a permanent
// rejection (PERMANENT_GRAPHQL_ERROR_CODES, #5344). Queries and queued
// mutations must not disagree about what a schema refusal is, so pin that both
// readings land on the same verdict for the same error.
describe('agreement with the offline-sync mutation classifier', () => {
  it.each([
    ['unknown argument', unknownArgumentError()],
    ['unknown field', unknownFieldError()],
  ])('%s is a permanent, non-retryable rejection there too', (_label, error) => {
    expect(isSchemaMismatchError(error)).toBe(true);
    expect(isPermanentRejection(error)).toBe(true);
    expect(isRetryable(error)).toBe(false);
  });
});

describe('withSchemaMismatchFallback', () => {
  it('resolves to the fallback when the server refuses the document', async () => {
    const request = vi.fn().mockRejectedValue(unknownArgumentError());
    await expect(withSchemaMismatchFallback(request, { recentBetaLinks: [] })).resolves.toEqual({
      recentBetaLinks: [],
    });
  });

  it('passes a successful answer through untouched', async () => {
    const payload = { recentBetaLinks: [{ climbName: 'Dinosore' }] };
    await expect(withSchemaMismatchFallback(() => Promise.resolve(payload), { recentBetaLinks: [] })).resolves.toBe(
      payload,
    );
  });

  it('re-throws a transport failure instead of faking an empty answer', async () => {
    const offline = new TypeError('Network request failed');
    await expect(withSchemaMismatchFallback(() => Promise.reject(offline), { recentBetaLinks: [] })).rejects.toBe(
      offline,
    );
  });

  it('re-throws a 5xx instead of faking an empty answer', async () => {
    const serverDown = Object.assign(new Error('boom'), { response: { status: 503, errors: [] } });
    await expect(withSchemaMismatchFallback(() => Promise.reject(serverDown), { recentBetaLinks: [] })).rejects.toBe(
      serverDown,
    );
  });

  it('does not retry the request itself', async () => {
    const request = vi.fn().mockRejectedValue(unknownArgumentError());
    await withSchemaMismatchFallback(request, { recentBetaLinks: [] });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('shouldReportSchemaMismatch', () => {
  it('reports the first occurrence and drops every repeat of the same message', () => {
    expect(shouldReportSchemaMismatch(unknownArgumentError())).toBe(true);
    expect(shouldReportSchemaMismatch(unknownArgumentError())).toBe(false);
    expect(shouldReportSchemaMismatch(unknownArgumentError())).toBe(false);
  });

  it('still reports a different broken element once', () => {
    expect(shouldReportSchemaMismatch(unknownArgumentError())).toBe(true);
    expect(shouldReportSchemaMismatch(unknownFieldError())).toBe(true);
    expect(shouldReportSchemaMismatch(unknownFieldError())).toBe(false);
  });
});
