import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import * as Sentry from '@sentry/nextjs';
import { createJsonLogger, describeError, readTraceId } from '../logger';

/**
 * Captures what the logger actually writes, per stream.
 *
 * Spying on `process.stdout.write` / `process.stderr.write` rather than on
 * `console.*` is the point: Railway derives a line's severity from the stream
 * it arrived on, independently of the `level` attribute in the payload, so
 * "warn went to stderr" is the behaviour under test — not "warn called
 * console.warn", which would pass even if the logger wrote everything to
 * stdout.
 */
function captureStreams() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stdout, stderr, restore: () => [stdoutSpy, stderrSpy].forEach((spy) => spy.mockRestore()) };
}

const HEX_TRACE_ID = /^[0-9a-f]{32}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createJsonLogger in production mode', () => {
  it('emits one JSON object per line with the scheduler envelope', () => {
    const streams = captureStreams();
    const logger = createJsonLogger({ service: 'web', pretty: false });

    try {
      logger.info('prewarm-heatmap done', { boardName: 'kilter', warmed: 12, failed: 0, durationMs: 4310 });
    } finally {
      streams.restore();
    }

    expect(streams.stdout).toHaveLength(1);
    // Exactly one line, newline-terminated: a JSON log parser reads one object
    // per line, so a missing or extra newline breaks ingestion.
    expect(streams.stdout[0].endsWith('\n')).toBe(true);
    expect(streams.stdout[0].trimEnd()).not.toContain('\n');

    const line = JSON.parse(streams.stdout[0]);
    expect(line).toEqual({
      level: 'info',
      service: 'web',
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      message: 'prewarm-heatmap done',
      boardName: 'kilter',
      warmed: 12,
      failed: 0,
      durationMs: 4310,
      traceId: expect.stringMatching(HEX_TRACE_ID),
    });
    // Numbers stay numbers so Railway can range over them (`@durationMs > 1000`).
    expect(typeof line.durationMs).toBe('number');
    // Key order matches packages/scheduler/src/logger.ts.
    expect(Object.keys(line).slice(0, 4)).toEqual(['level', 'service', 'time', 'message']);
  });

  it('omits the fields object entirely when there are none', () => {
    const streams = captureStreams();
    const logger = createJsonLogger({ service: 'web', pretty: false });

    try {
      logger.info('starting');
    } finally {
      streams.restore();
    }

    const line = JSON.parse(streams.stdout[0]);
    expect(Object.keys(line).sort()).toEqual(['level', 'message', 'service', 'time', 'traceId']);
  });

  it('never lets a caller field shadow the real traceId', () => {
    const streams = captureStreams();
    const logger = createJsonLogger({ service: 'web', pretty: false, traceId: () => 'b'.repeat(32) });

    try {
      logger.error('boom', { traceId: 'not-the-real-one' });
    } finally {
      streams.restore();
    }

    expect(JSON.parse(streams.stderr[0]).traceId).toBe('b'.repeat(32));
  });
});

describe('stream routing', () => {
  it('sends info to stdout and warn + error to stderr', () => {
    const streams = captureStreams();
    const logger = createJsonLogger({ service: 'web', pretty: false });

    try {
      logger.info('an info line');
      logger.warn('a warn line');
      logger.error('an error line');
    } finally {
      streams.restore();
    }

    expect(streams.stdout.map((line) => JSON.parse(line).message)).toEqual(['an info line']);
    expect(streams.stderr.map((line) => JSON.parse(line).message)).toEqual(['a warn line', 'an error line']);
    expect(streams.stderr.map((line) => JSON.parse(line).level)).toEqual(['warn', 'error']);
  });
});

describe('traceId stamping', () => {
  it('reads the trace id off the current Sentry scope', () => {
    const streams = captureStreams();
    const logger = createJsonLogger({ service: 'web', pretty: false });
    const scopedTraceId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

    try {
      Sentry.withScope((scope) => {
        scope.setPropagationContext({ traceId: scopedTraceId, sampleRand: 0.5 });
        logger.info('inside a request');
      });
    } finally {
      streams.restore();
    }

    expect(JSON.parse(streams.stdout[0]).traceId).toBe(scopedTraceId);
  });

  it('still returns a trace id with no scope set and no Sentry.init', () => {
    // Scope's constructor seeds `_propagationContext` with a generated traceId,
    // and both getters are synchronous, so this is defined everywhere — server
    // component, route handler, `after()` callback.
    expect(readTraceId()).toMatch(HEX_TRACE_ID);
  });

  it('logs without a traceId rather than throwing when the source fails', () => {
    const streams = captureStreams();
    const logger = createJsonLogger({
      service: 'web',
      pretty: false,
      traceId: () => {
        throw new Error('no async context strategy');
      },
    });

    try {
      expect(() => logger.error('handler failed')).not.toThrow();
    } finally {
      streams.restore();
    }

    const line = JSON.parse(streams.stderr[0]);
    expect(line.message).toBe('handler failed');
    expect('traceId' in line).toBe(false);
  });
});

describe('runtimes without process streams', () => {
  it('falls back to console at the same severity', () => {
    // The Edge runtime (and a client component importing this by mistake) has
    // no process.stderr. Writing there would throw inside a catch block and
    // replace the real error with a TypeError, so the logger degrades instead.
    // Only stderr is swapped: vitest's own worker output uses stdout.
    const originalStderr = Object.getOwnPropertyDescriptor(process, 'stderr');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createJsonLogger({ service: 'web', pretty: false, traceId: () => undefined });

    try {
      Object.defineProperty(process, 'stderr', { value: {}, configurable: true });
      expect(() => logger.error('edge handler failed')).not.toThrow();
    } finally {
      if (originalStderr) Object.defineProperty(process, 'stderr', originalStderr);
    }

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleErrorSpy.mock.calls[0][0]))).toMatchObject({
      level: 'error',
      message: 'edge handler failed',
    });
  });
});

describe('unserializable fields', () => {
  it('drops the fields instead of throwing out of a catch block', () => {
    const streams = captureStreams();
    const logger = createJsonLogger({ service: 'web', pretty: false });
    const circular: { self?: unknown } = {};
    circular.self = circular;

    try {
      expect(() => logger.error('upstream failed', { circular })).not.toThrow();
    } finally {
      streams.restore();
    }

    const line = JSON.parse(streams.stderr[0]);
    expect(line.message).toBe('upstream failed');
    expect(line.fieldsError).toBe('unserializable');
  });
});

describe('development format', () => {
  it('writes a readable one-liner tagged with the short trace id', () => {
    const streams = captureStreams();
    const logger = createJsonLogger({ service: 'web', pretty: true, traceId: () => 'abcd1234'.padEnd(32, '0') });

    try {
      logger.warn('NEXTAUTH_SECRET is not configured', { route: '/api/internal/ws-auth' });
    } finally {
      streams.restore();
    }

    expect(streams.stderr[0]).toBe(
      '[t:abcd1234] [warn] NEXTAUTH_SECRET is not configured {"route":"/api/internal/ws-auth"}\n',
    );
  });

  it('leaves off the trailing object when there are no fields', () => {
    const streams = captureStreams();
    const logger = createJsonLogger({ service: 'web', pretty: true, traceId: () => 'abcd1234'.padEnd(32, '0') });

    try {
      logger.info('starting');
    } finally {
      streams.restore();
    }

    expect(streams.stdout[0]).toBe('[t:abcd1234] [info] starting\n');
  });
});

describe('describeError', () => {
  it('unwraps the cause chain so a bare "fetch failed" names its reason', () => {
    // The exact shape undici produces: the rejection message says nothing, and
    // ECONNREFUSED — the only part that tells you which of Aurora / the backend
    // is down — is one link below.
    const socketError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:8080'), { code: 'ECONNREFUSED' });
    const fetchError = new Error('fetch failed', { cause: socketError });

    expect(describeError(fetchError)).toBe('fetch failed: connect ECONNREFUSED 10.0.0.4:8080');
  });

  it('follows three cause links and stops, so a pathological chain cannot blow out the line', () => {
    const fifth = new Error('fifth');
    const fourth = new Error('fourth', { cause: fifth });
    const third = new Error('third', { cause: fourth });
    const second = new Error('second', { cause: third });
    const first = new Error('first', { cause: second });

    expect(describeError(first)).toBe('first: second: third: fourth');
  });

  it('does not repeat an identical message from a re-wrapped cause', () => {
    const inner = new Error('fetch failed');
    const outer = new Error('fetch failed', { cause: inner });

    expect(describeError(outer)).toBe('fetch failed');
  });

  it('falls back to the error name when every message is empty', () => {
    const nameless = new Error('');
    nameless.name = 'AbortError';

    expect(describeError(nameless)).toBe('AbortError');
  });

  it('stringifies a non-Error throw', () => {
    expect(describeError('a thrown string')).toBe('a thrown string');
    expect(describeError({ code: 500 })).toBe('[object Object]');
  });
});
