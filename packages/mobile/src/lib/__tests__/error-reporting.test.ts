import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportError, reportHandledError } from '../error-reporting';
import { captureToSentry } from '../sentry';

// captureToSentry is the only side-effecting dependency; mocking it keeps this a
// pure test of the noise policy (and avoids sentry.ts's import-time Sentry.init +
// global error-capture install).
vi.mock('../sentry', () => ({
  captureToSentry: vi.fn(),
}));

const mockedCaptureToSentry = vi.mocked(captureToSentry);

afterEach(() => {
  mockedCaptureToSentry.mockClear();
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

  it('downgrades offline fetch failures to a warning and tags them network', () => {
    const offline = new TypeError('Network request failed');
    reportHandledError(offline, { tags: { source: 'react-query' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(offline, {
      level: 'warning',
      tags: { source: 'react-query', network: true },
    });
  });

  it('treats a transport ClientError (response without a numeric status) as network', () => {
    const transport = Object.assign(new Error('boom'), { response: { errors: [] } });
    reportHandledError(transport, { tags: { source: 'queue-mutation' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(transport, {
      level: 'warning',
      tags: { source: 'queue-mutation', network: true },
    });
  });

  it('forces warning for a network error even if the caller asked for a higher level', () => {
    const offline = new TypeError('Network request failed');
    reportHandledError(offline, { level: 'fatal', tags: { source: 'x' } });
    expect(mockedCaptureToSentry).toHaveBeenCalledWith(offline, {
      level: 'warning',
      tags: { source: 'x', network: true },
    });
  });

  it('reports a real server error (response with an HTTP status) at error level', () => {
    const serverError = Object.assign(new Error('Internal Server Error'), { response: { status: 500 } });
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
