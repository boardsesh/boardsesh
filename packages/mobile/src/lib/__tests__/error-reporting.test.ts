import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRAPHQL_EMPTY_RESPONSE_ERROR_NAME } from '@boardsesh/offline-sync/error-classification';
import { reportError, reportHandledError } from '../error-reporting';
import { addBreadcrumbToSentry, captureToSentry } from '../sentry';
import { resetObserveRuntimeForTests, setObserveRuntime } from '../observe-runtime';

// captureToSentry and addBreadcrumbToSentry are the only side-effecting
// dependencies; mocking them keeps this a pure test of the noise policy (and
// avoids sentry.ts's import-time Sentry.init + global error-capture install).
vi.mock('../sentry', () => ({
  captureToSentry: vi.fn(),
  addBreadcrumbToSentry: vi.fn(),
}));

const mockedCaptureToSentry = vi.mocked(captureToSentry);
const mockedAddBreadcrumbToSentry = vi.mocked(addBreadcrumbToSentry);

afterEach(() => {
  mockedCaptureToSentry.mockClear();
  mockedAddBreadcrumbToSentry.mockClear();
});

describe('reportHandledError', () => {
  it('drops cancellations (user dismiss / unmount) without reporting', () => {
    reportHandledError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    reportHandledError(Object.assign(new Error('cancelled'), { name: 'CancelledError' }));
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
  });

  it('drops expected auth-required GraphQL errors (a session-only query ran logged-out)', () => {
    // graphql-request ClientError shape: the backend returns HTTP 200 with the
    // guard message in response.errors[]. Must drop before the network check.
    const authError = Object.assign(new Error('Authentication required to perform this operation'), {
      response: {
        status: 200,
        errors: [{ message: 'Authentication required to perform this operation', path: ['myBoards'] }],
      },
    });
    reportHandledError(authError, { tags: { source: 'react-query' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
  });

  it('drops the auth error before the network check, even when it looks transport-shaped', () => {
    // A ClientError whose response carries no numeric status is otherwise treated
    // as a transport/network failure and downgraded to a warning. The auth check
    // runs first, so this is dropped entirely — locks in that ordering so a future
    // reorder can't start leaking auth errors as network warnings.
    const authError = Object.assign(new Error('Authentication required to perform this operation'), {
      response: {
        errors: [{ message: 'Authentication required to perform this operation', path: ['myBoards'] }],
      },
    });
    reportHandledError(authError, { tags: { source: 'react-query' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
  });

  it('drops expected beta-attach validation rejections (user resolves them on the share sheet)', () => {
    const alreadyLinked = Object.assign(new Error('This tick already has a beta video linked'), {
      response: {
        status: 200,
        errors: [
          {
            message: 'This tick already has a beta video linked',
            extensions: { code: 'BETA_LINK_TICK_ALREADY_LINKED' },
          },
        ],
      },
    });
    reportHandledError(alreadyLinked, { tags: { source: 'react-query', kind: 'mutation' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
  });

  it('still reports a genuine beta-attach write fault (BETA_LINK_INSERT_FAILED)', () => {
    const insertFailed = Object.assign(new Error("Couldn't save the beta link. Please try again."), {
      response: {
        status: 200,
        errors: [
          {
            message: "Couldn't save the beta link. Please try again.",
            extensions: { code: 'BETA_LINK_INSERT_FAILED' },
          },
        ],
      },
    });
    reportHandledError(insertFailed, { tags: { source: 'react-query', kind: 'mutation' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(insertFailed, {
      level: 'error',
      tags: { source: 'react-query', kind: 'mutation' },
    });
  });

  it.each(['invalid_credentials', 'account_already_linked', 'rate_limited'])(
    'drops an expected board-account rejection (%s) — already surfaced as a toast (#3610)',
    (code) => {
      // BoardAccountError is matched structurally by name + code (no import, to
      // avoid the aurora-credentials → auth-interceptor → error-reporting cycle).
      const boardAccountError = Object.assign(new Error(code), { name: 'BoardAccountError', code });
      reportHandledError(boardAccountError, { tags: { source: 'react-query', kind: 'mutation' } });
      expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    },
  );

  it.each(['request_failed', 'unauthorized', 'not_allowed'])(
    'still reports an unexpected board-account failure (%s) at error level',
    (code) => {
      const boardAccountError = Object.assign(new Error(code), { name: 'BoardAccountError', code });
      reportHandledError(boardAccountError, { tags: { source: 'react-query', kind: 'mutation' } });
      expect(mockedCaptureToSentry).toHaveBeenCalledWith(boardAccountError, {
        level: 'error',
        tags: { source: 'react-query', kind: 'mutation' },
      });
    },
  );

  it('drops a duplicate-board create refusal (the caller uses the board it names)', () => {
    // createBoard rejects with the existing board attached; the create screen
    // offers it and a deep link adopts it outright. Nothing failed, but the
    // rejection still reaches here via MutationCache.onError.
    const duplicate = Object.assign(new Error('You already have this board'), {
      response: {
        status: 200,
        errors: [
          {
            message: 'You already have this board',
            extensions: {
              code: 'BOARD_DUPLICATE_CONFIG',
              existingBoardUuid: 'b2f1c0de-0000-4000-8000-000000000000',
              existingBoardName: "Marco's garage",
            },
          },
        ],
      },
    });
    reportHandledError(duplicate, { tags: { source: 'react-query', kind: 'mutation' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
  });

  it('still reports a duplicate-shaped rejection that names no board', () => {
    // `readDuplicateBoardError` requires `existingBoardUuid` — without it the
    // caller has nothing to recover to, so it is a genuine create failure.
    const unusable = Object.assign(new Error('You already have this board'), {
      response: {
        status: 200,
        errors: [{ message: 'You already have this board', extensions: { code: 'BOARD_DUPLICATE_CONFIG' } }],
      },
    });
    reportHandledError(unusable, { tags: { source: 'react-query', kind: 'mutation' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(unusable, {
      level: 'error',
      tags: { source: 'react-query', kind: 'mutation' },
    });
  });

  it('downgrades a RATE_LIMITED GraphQL rejection to a warning and tags it (expected backpressure — #3285)', () => {
    const rateLimited = Object.assign(new Error('Rate limit exceeded. Try again in 7 seconds.'), {
      response: {
        status: 200,
        errors: [
          {
            message: 'Rate limit exceeded. Try again in 7 seconds.',
            extensions: { code: 'RATE_LIMITED', operation: 'searchBoards', retryAfterSeconds: 7 },
          },
        ],
      },
    });
    reportHandledError(rateLimited, { tags: { source: 'react-query', kind: 'query' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(rateLimited, {
      level: 'warning',
      tags: { source: 'react-query', kind: 'query', rate_limited: true },
    });
  });

  it('reports a GRAPHQL_VALIDATION_FAILED rejection as a warning fingerprinted by its message (#5370)', () => {
    // Yoga's HTTP validation plugin: HTTP 400 with the code on each error.
    const validationFailed = Object.assign(new Error('Cannot query field "otaPreviewChannels" on type "Query".'), {
      response: {
        status: 400,
        errors: [
          {
            message: 'Cannot query field "otaPreviewChannels" on type "Query".',
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED', http: { status: 400 } },
          },
        ],
      },
    });
    reportHandledError(validationFailed, { tags: { source: 'react-query', kind: 'query' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(validationFailed, {
      level: 'warning',
      tags: { source: 'react-query', kind: 'query', schema_mismatch: true },
      fingerprint: ['graphql-validation-failed', 'Cannot query field "otaPreviewChannels" on type "Query".'],
    });
  });

  it('bounds the validation message used in the fingerprint', () => {
    const longMessage = `Cannot query field "x" on type "Query". Did you mean ${'"y", '.repeat(100)}?`;
    const validationFailed = Object.assign(new Error(longMessage), {
      response: { status: 400, errors: [{ message: longMessage, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
    });
    reportHandledError(validationFailed);
    const fingerprint = mockedCaptureToSentry.mock.calls[0]?.[1]?.fingerprint;
    expect(fingerprint?.[1]).toHaveLength(200);
  });

  it('catches a RATE_LIMITED error via direct extensions before the network check', () => {
    // No `response` at all here, so if the rate-limit guard didn't run first this
    // would otherwise fall into isNetworkError's "no numeric status" branch.
    const rateLimited = Object.assign(new Error('Rate limit exceeded. Try again in 3 seconds.'), {
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 3 },
    });
    reportHandledError(rateLimited, { tags: { source: 'react-query' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(rateLimited, {
      level: 'warning',
      tags: { source: 'react-query', rate_limited: true },
    });
  });

  it('drops offline fetch failures entirely and leaves a network breadcrumb', () => {
    const offline = new TypeError('Network request failed');
    reportHandledError(offline, { tags: { source: 'react-query' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(mockedAddBreadcrumbToSentry).toHaveBeenCalledWith({
      category: 'network',
      message: 'transport failure',
      level: 'warning',
      data: { source: 'react-query' },
    });
  });

  it('drops a transport ClientError (response without a numeric status) as network, with a breadcrumb', () => {
    const transport = Object.assign(new Error('boom'), { response: { errors: [] } });
    reportHandledError(transport, { tags: { source: 'queue-mutation' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(mockedAddBreadcrumbToSentry).toHaveBeenCalledWith({
      category: 'network',
      message: 'transport failure',
      level: 'warning',
      data: { source: 'queue-mutation' },
    });
  });

  it('drops a GraphQLEmptyResponseError (2xx with an empty/truncated body) as network, with a breadcrumb (#3190)', () => {
    const emptyBody = Object.assign(new Error('GraphQL response body was empty or not valid JSON (HTTP 200)'), {
      name: GRAPHQL_EMPTY_RESPONSE_ERROR_NAME,
    });
    reportHandledError(emptyBody, { tags: { source: 'react-query', kind: 'query' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(mockedAddBreadcrumbToSentry).toHaveBeenCalledWith({
      category: 'network',
      message: 'transport failure',
      level: 'warning',
      data: { source: 'react-query' },
    });
  });

  it('drops an Error-typed WinterCG "fetch failed" transport rejection as network, with a breadcrumb (#3610)', () => {
    // graphql-ws HTTP wraps the underlying NSURLError as `Error: "fetch failed: <cause>"`
    // (a plain Error, not a TypeError) — the shared matcher classifies it as network.
    const offline = new Error('fetch failed: The network connection was lost.');
    reportHandledError(offline, { tags: { source: 'ws-client' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(mockedAddBreadcrumbToSentry).toHaveBeenCalledWith({
      category: 'network',
      message: 'transport failure',
      level: 'warning',
      data: { source: 'ws-client' },
    });
  });

  it('drops a bare iOS NSURLError description (no wrapper) as network, with a breadcrumb — best-effort English (#3610)', () => {
    const offline = new Error('The connection has timed out unexpectedly.');
    reportHandledError(offline, { tags: { source: 'ws-client' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(mockedAddBreadcrumbToSentry).toHaveBeenCalledWith({
      category: 'network',
      message: 'transport failure',
      level: 'warning',
      data: { source: 'ws-client' },
    });
  });

  it('follows the .cause chain of a synthetic wrapper to find the transport failure and drops it (#4238)', () => {
    // The snapshot-bootstrap reporter wraps its own prose around the real error.
    // The wrapper message matches nothing, so before the cause was attached this
    // reached Sentry at level: error for every user who opened the app offline.
    const wrapped = new Error('Snapshot bootstrap failed for kilter:1:10 at stage "manifest" (attempt 1)', {
      cause: new TypeError('Network request failed'),
    });
    reportHandledError(wrapped, { tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(mockedAddBreadcrumbToSentry).toHaveBeenCalledWith({
      category: 'network',
      message: 'transport failure',
      level: 'warning',
      data: { source: 'offline-sync' },
    });
  });

  it('reaches a transport cause nested two wrappers deep and drops it (expo-file-system inside our own wrapper)', () => {
    const wrapped = new Error('Snapshot bootstrap failed for kilter:1:10 at stage "download" (attempt 1)', {
      cause: new Error('snapshot download: File.downloadFileAsync failed for kilter:1: The request timed out.', {
        cause: Object.assign(new Error('The request timed out.'), { name: 'UnableToDownloadException' }),
      }),
    });
    reportHandledError(wrapped, { tags: { source: 'offline-sync' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(mockedAddBreadcrumbToSentry).toHaveBeenCalledWith({
      category: 'network',
      message: 'transport failure',
      level: 'warning',
      data: { source: 'offline-sync' },
    });
  });

  it('drops a network error entirely even when the caller asked for a higher level', () => {
    const offline = new TypeError('Network request failed');
    reportHandledError(offline, { level: 'fatal', tags: { source: 'x' } });
    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(mockedAddBreadcrumbToSentry).toHaveBeenCalledWith({
      category: 'network',
      message: 'transport failure',
      level: 'warning',
      data: { source: 'x' },
    });
  });

  it('downgrades a BLE write-resume timeout to a warning and tags it (native auto-recovers it — #3181)', () => {
    const writeTimeout = new Error('BLE write timed out waiting for the board to accept data');
    reportHandledError(writeTimeout, { tags: { source: 'ble-auto-send' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(writeTimeout, {
      level: 'warning',
      tags: { source: 'ble-auto-send', ble_write_timeout: true },
    });
  });

  it('reports an HTTP error at error level', () => {
    const serverError = Object.assign(new Error('Internal Server Error'), { response: { status: 500 } });
    reportHandledError(serverError, { tags: { source: 'react-query', kind: 'mutation' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(serverError, {
      level: 'error',
      tags: { source: 'react-query', kind: 'mutation' },
    });
  });

  it('reports an HTTP error even when its message resembles NSURL prose', () => {
    const serverError = Object.assign(new Error('The connection has timed out unexpectedly.'), {
      response: { status: 400 },
    });
    reportHandledError(serverError, { tags: { source: 'react-query', kind: 'mutation' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(serverError, {
      level: 'error',
      tags: { source: 'react-query', kind: 'mutation' },
    });
  });

  it('reports a nested GraphQL status even when its message resembles NSURL prose', () => {
    const serverError = Object.assign(new Error('The connection has timed out unexpectedly.'), {
      response: {
        errors: [{ message: 'invalid input', extensions: { code: 400 } }],
      },
    });
    reportHandledError(serverError, { tags: { source: 'react-query', kind: 'mutation' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(serverError, {
      level: 'error',
      tags: { source: 'react-query', kind: 'mutation' },
    });
  });

  it('defaults a plain error to error level', () => {
    const error = new Error('boom');
    reportHandledError(error, { tags: { source: 'ble-connect' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(error, {
      level: 'error',
      tags: { source: 'ble-connect' },
    });
  });

  it('lets the caller keep a non-error severity for a non-network failure', () => {
    const error = new Error('boom');
    reportHandledError(error, { level: 'info', tags: { source: 'x' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(error, { level: 'info', tags: { source: 'x' } });
  });
});

describe('reportError', () => {
  it('forwards verbatim to captureToSentry', () => {
    const error = new Error('x');
    reportError(error, { level: 'error', tags: { source: 's' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(error, { level: 'error', tags: { source: 's' } });
  });
});

describe('Observe forwarding', () => {
  // Sentry and Observe hang off the same funnel so the two can never disagree
  // about what counted as an error. The real slot is used rather than a mock, so
  // these also prove the slot itself behaves under the funnel.
  afterEach(() => {
    resetObserveRuntimeForTests();
  });

  function registerObserve(reportError_ = vi.fn()) {
    setObserveRuntime({ configure: vi.fn(), reportError: reportError_ });
    return reportError_;
  }

  it('sends a reported error to both destinations', () => {
    const observeReport = registerObserve();
    const error = new Error('boom');

    reportError(error);

    expect(mockedCaptureToSentry).toHaveBeenCalledWith(error, undefined);
    expect(observeReport).toHaveBeenCalledWith(error);
  });

  it('drops from both what the noise policy drops from Sentry', () => {
    // A cancellation is not a failure; it must not reach either destination.
    const observeReport = registerObserve();

    reportHandledError(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(observeReport).not.toHaveBeenCalled();
  });

  it('still forwards an error the policy downgraded rather than dropped', () => {
    const observeReport = registerObserve();

    // A BLE write-resume timeout is downgraded to `warning`, not dropped —
    // unlike a network failure, which is dropped entirely (see
    // 'error-reporting' network tests above) and so never reaches Observe.
    reportHandledError(new Error('BLE write timed out waiting for the board to accept data'));

    expect(mockedCaptureToSentry).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: 'warning', tags: { ble_write_timeout: true } }),
    );
    expect(observeReport).toHaveBeenCalledTimes(1);
  });

  it('drops a network failure from Observe too, not just from Sentry', () => {
    const observeReport = registerObserve();

    reportHandledError(new TypeError('Network request failed'));

    expect(mockedCaptureToSentry).not.toHaveBeenCalled();
    expect(observeReport).not.toHaveBeenCalled();
  });

  it('reports to Sentry even when Observe throws', () => {
    // The whole point of the try/catch in the slot: telemetry must never be
    // able to lose the actual error.
    setObserveRuntime({
      configure: vi.fn(),
      reportError: () => {
        throw new Error('native module exploded');
      },
    });
    const error = new Error('boom');

    expect(() => reportError(error)).not.toThrow();
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(error, undefined);
  });

  it('reports to Sentry when no Observe runtime is registered', () => {
    const error = new Error('boom');

    reportError(error);

    expect(mockedCaptureToSentry).toHaveBeenCalledWith(error, undefined);
  });
});
