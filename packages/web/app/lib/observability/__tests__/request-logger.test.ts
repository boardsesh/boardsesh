import { describe, expect, it, vi } from 'vite-plus/test';
import { createRequestLogger } from '../request-logger';
import type { JsonLogger } from '../logger';

/** A logger that records `(level, message, fields)` instead of writing. */
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

describe('createRequestLogger', () => {
  it('binds Railway’s request id, route and method to every line', () => {
    const { logger, lines } = recordingLogger();
    const request = new Request('https://boardsesh.com/api/internal/ws-auth?next=/board', {
      headers: { 'x-railway-request-id': 'DZbCaC5vTe2s0k7CFB6vMQ' },
    });

    const log = createRequestLogger(request, { logger });
    log.info('handshake accepted', { userId: 'user-1' });
    log.error('token read failed');

    expect(log.requestId).toBe('DZbCaC5vTe2s0k7CFB6vMQ');
    expect(log.route).toBe('/api/internal/ws-auth');
    expect(lines).toEqual([
      {
        level: 'info',
        message: 'handshake accepted',
        fields: {
          route: '/api/internal/ws-auth',
          method: 'GET',
          requestId: 'DZbCaC5vTe2s0k7CFB6vMQ',
          userId: 'user-1',
        },
      },
      {
        level: 'error',
        message: 'token read failed',
        fields: { route: '/api/internal/ws-auth', method: 'GET', requestId: 'DZbCaC5vTe2s0k7CFB6vMQ' },
      },
    ]);
  });

  it('omits requestId entirely when the header is absent', () => {
    // The normal case off Railway: local dev, tests, and any direct hit that
    // did not pass through the edge. An empty-string requestId would look like
    // a real correlation key in the log explorer and match nothing.
    const { logger, lines } = recordingLogger();
    const request = new Request('https://boardsesh.com/api/internal/profile-percentiles');

    const log = createRequestLogger(request, { logger });
    log.warn('nothing to refresh');

    expect(log.requestId).toBeUndefined();
    expect(lines[0].fields).toEqual({ route: '/api/internal/profile-percentiles', method: 'GET' });
    expect(lines[0].fields && 'requestId' in lines[0].fields).toBe(false);
  });

  it('prefers an explicit route template over the resolved pathname', () => {
    const { logger, lines } = recordingLogger();
    const request = new Request('https://boardsesh.com/api/v1/kilter/climb-stats/abc-123');

    const log = createRequestLogger(request, {
      logger,
      route: '/api/v1/[board_name]/climb-stats/[climb_uuid]',
    });
    log.info('served');

    expect(log.route).toBe('/api/v1/[board_name]/climb-stats/[climb_uuid]');
    expect(lines[0].fields?.route).toBe('/api/v1/[board_name]/climb-stats/[climb_uuid]');
  });

  it('lets a per-call field override a bound one', () => {
    const { logger, lines } = recordingLogger();
    const request = new Request('https://boardsesh.com/api/internal/cleanup', { method: 'POST' });

    createRequestLogger(request, { logger }).info('rerouted', { route: '/api/internal/cleanup#feed' });

    expect(lines[0].fields).toEqual({ route: '/api/internal/cleanup#feed', method: 'POST' });
  });

  it('does not throw on a relative request url', () => {
    const { logger, lines } = recordingLogger();
    // `new Request('/x')` throws in undici, so a relative url can only arrive
    // via a hand-built request-like object — which a route test may well pass.
    const requestLike = { url: '/api/internal/cleanup?token=abc', method: 'GET', headers: new Headers() } as Request;

    const log = createRequestLogger(requestLike, { logger });
    log.info('ok');

    expect(log.route).toBe('/api/internal/cleanup');
    expect(lines[0].fields?.route).toBe('/api/internal/cleanup');
  });

  it('writes through the app logger when none is injected', () => {
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    const request = new Request('https://boardsesh.com/api/internal/cleanup', {
      headers: { 'x-railway-request-id': 'req-42' },
    });

    try {
      createRequestLogger(request).error('cleanup failed');
    } finally {
      stderrSpy.mockRestore();
    }

    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('cleanup failed');
    expect(stderr[0]).toContain('req-42');
  });
});
