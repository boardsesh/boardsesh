import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { reportError, reportHandledError } from '../report-error';
import type { JsonLogger } from '../logger';

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));

// The whole SDK is mocked so the assertions are about *our* funnel, not about
// whether a Sentry client happens to be initialised in the test process.
// `getCurrentScope` is stubbed too because the logger reads a trace id from it.
vi.mock('@sentry/nextjs', () => ({
  captureException: captureExceptionMock,
  getCurrentScope: () => ({ getPropagationContext: () => ({ traceId: 'f'.repeat(32) }) }),
}));

function recordingLogger() {
  const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const record =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, message, fields });
    };
  const logger: JsonLogger = { info: record('info'), warn: record('warn'), error: record('error') };
  return { logger, lines };
}

beforeEach(() => {
  captureExceptionMock.mockClear();
});

describe('reportError', () => {
  it('writes a log line and captures the same error', () => {
    const { logger, lines } = recordingLogger();
    const failure = new Error('percentile refresh failed');

    reportError(failure, { logger, message: 'profile-percentiles failed', tags: { job: 'profile-percentiles' } });

    expect(lines).toEqual([
      {
        level: 'error',
        message: 'profile-percentiles failed',
        fields: { error: 'Error: percentile refresh failed', job: 'profile-percentiles' },
      },
    ]);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
      level: 'error',
      tags: { job: 'profile-percentiles' },
      extra: undefined,
    });
  });

  it('keeps a drizzle query error’s SQL out of the log line', () => {
    const { logger, lines } = recordingLogger();
    const drizzleError = Object.assign(
      new Error('Failed query: SELECT "email", "password_hash" FROM "users"\nparams: test@boardsesh.com'),
      { cause: new Error('CONNECT_TIMEOUT') },
    );

    reportError(drizzleError, { logger });

    expect(lines[0].fields?.error).toBe('Error: CONNECT_TIMEOUT');
    expect(JSON.stringify(lines[0])).not.toContain('password_hash');
  });

  it('routes a warning to the warn level and an info to info', () => {
    const { logger, lines } = recordingLogger();

    reportError(new Error('slow'), { logger, level: 'warning' });
    reportError(new Error('note'), { logger, level: 'info' });
    reportError(new Error('down'), { logger, level: 'fatal' });

    expect(lines.map((line) => line.level)).toEqual(['warn', 'info', 'error']);
  });
});

describe('reportHandledError', () => {
  it('drops an AbortError without logging or capturing', () => {
    const { logger, lines } = recordingLogger();
    const aborted = new Error('The operation was aborted.');
    aborted.name = 'AbortError';

    reportHandledError(aborted, { logger });

    expect(lines).toEqual([]);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('drops a TanStack CancelledError too', () => {
    const { logger, lines } = recordingLogger();
    const cancelled = Object.assign(new Error('cancelled'), { name: 'CancelledError' });

    reportHandledError(cancelled, { logger });

    expect(lines).toEqual([]);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('downgrades an undici fetch failure to warning and tags it network', () => {
    // The real shape: the rejection says only "fetch failed" and ECONNREFUSED
    // is one cause link down, so a message-only predicate would miss it.
    const { logger, lines } = recordingLogger();
    const socketError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:8080'), { code: 'ECONNREFUSED' });
    const fetchError = new Error('fetch failed', { cause: socketError });

    reportHandledError(fetchError, { logger, tags: { route: '/api/internal/cleanup' } });

    expect(lines[0].level).toBe('warn');
    expect(lines[0].fields).toMatchObject({ network: true, route: '/api/internal/cleanup' });
    expect(captureExceptionMock).toHaveBeenCalledWith(fetchError, {
      level: 'warning',
      tags: { route: '/api/internal/cleanup', network: true },
      extra: undefined,
    });
  });

  it('finds the transport failure when the only signal is two cause links down', () => {
    // The shape web actually sees calling the backend: our client wraps undici's
    // `fetch failed`, which itself wraps the socket error. Neither the thrown
    // value's message nor its `code` says "network" — only the third link does,
    // which is why the predicate walks the chain rather than inspecting the top.
    const { logger, lines } = recordingLogger();
    const socketError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:8080'), { code: 'ECONNREFUSED' });
    const fetchError = new Error('fetch failed', { cause: socketError });
    const clientError = new Error('Backend GraphQL request failed', { cause: fetchError });

    reportHandledError(clientError, { logger });

    expect(lines[0].level).toBe('warn');
    expect(lines[0].fields?.network).toBe(true);
  });

  it('recognises a network failure carried only by its code', () => {
    const { logger, lines } = recordingLogger();
    const dnsError = Object.assign(new Error('getaddrinfo EAI_AGAIN ws.boardsesh.com'), { code: 'EAI_AGAIN' });

    reportHandledError(dnsError, { logger });

    expect(lines[0].level).toBe('warn');
    expect(lines[0].fields?.network).toBe(true);
  });

  it('leaves an application failure at error level and untagged', () => {
    const { logger, lines } = recordingLogger();
    const failure = new Error('Cannot read properties of undefined');

    reportHandledError(failure, { logger });

    expect(lines[0].level).toBe('error');
    expect(lines[0].fields).toEqual({ error: 'Error: Cannot read properties of undefined' });
    expect(captureExceptionMock).toHaveBeenCalledWith(failure, { level: 'error', tags: undefined, extra: undefined });
  });

  it('does not treat a message merely containing "fetch failed" as a network error', () => {
    // Anchored patterns: a 500 whose body happens to quote the words must still
    // page, or downgrading network noise would silently downgrade real bugs.
    const { logger, lines } = recordingLogger();

    reportHandledError(new Error('assertion failed: expected fetch failed to be handled'), { logger });

    expect(lines[0].level).toBe('error');
    expect(lines[0].fields?.network).toBeUndefined();
  });
});
