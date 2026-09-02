import { describe, expect, it } from 'vitest';
import {
  BACKEND_DEFAULT_SAMPLE_RATE,
  BACKEND_TRACE_PROPAGATION_TARGETS,
  isWebSocketUpgrade,
  resolveBackendRequestMethod,
  resolveBackendRequestPath,
  resolveBackendTracesSampleRate,
} from '../sentry-sampling';

describe('resolveBackendTracesSampleRate', () => {
  it('samples everything unlisted at 10%', () => {
    // Pinned as a literal, not compared against itself. The budget at the top
    // of sentry-sampling.ts only closes while this bucket stays small: solving
    // 0.01 + 0.09 * f_other <= 0.052 says it may cover at most ~46% of backend
    // traffic. Raising this number means re-deriving that, not editing a test.
    expect(BACKEND_DEFAULT_SAMPLE_RATE).toBe(0.1);
  });

  it('samples /graphql at 1%', () => {
    // 85% of 14.45M requests/month. At the default 10% this one path would be
    // ~5.8M spans/month on its own, twice the whole system budget.
    expect(resolveBackendTracesSampleRate({ name: 'POST /graphql' })).toBe(0.01);
  });

  it('samples /graphql at 1% EVEN WHEN the incoming trace was sampled', () => {
    // The regression that matters. Web SSR is a major source of POST /graphql
    // volume (Railway HTTP logs show clientUa: "node" hitting it at high rate)
    // and web samples at 25%. If this branch ever grows an
    // `inheritOrSampleWith(0.01)` — which is the shape Sentry's own docs push —
    // a quarter of SSR-driven GraphQL requests get recorded instead of 1%, and
    // the budget is wrong by an order of magnitude (~2.6M vs ~123k sampled
    // requests/month).
    expect(resolveBackendTracesSampleRate({ name: 'POST /graphql', parentSampled: true })).toBe(0.01);
    expect(
      resolveBackendTracesSampleRate({
        name: 'POST /graphql',
        parentSampled: true,
        attributes: { 'url.path': '/graphql', 'http.request.method': 'POST' },
        normalizedRequest: { url: 'https://ws.boardsesh.com/graphql', method: 'POST' },
      }),
    ).toBe(0.01);
  });

  it('ignores parentSampled on every other path too', () => {
    expect(resolveBackendTracesSampleRate({ name: 'GET /health', parentSampled: true })).toBe(0);
    expect(resolveBackendTracesSampleRate({ name: 'GET /og/climb', parentSampled: true })).toBe(0.05);
    expect(resolveBackendTracesSampleRate({ name: 'GET /join/abc', parentSampled: false })).toBe(
      BACKEND_DEFAULT_SAMPLE_RATE,
    );
  });

  it('drops the health probes', () => {
    expect(resolveBackendTracesSampleRate({ name: 'GET /health' })).toBe(0);
    expect(resolveBackendTracesSampleRate({ name: 'GET /health/db' })).toBe(0);
  });

  it('drops the board renderer', () => {
    expect(resolveBackendTracesSampleRate({ name: 'GET /render/board' })).toBe(0);
    expect(resolveBackendTracesSampleRate({ name: 'GET /api/internal/board-render' })).toBe(0);
  });

  it('drops the PostHog proxy', () => {
    expect(resolveBackendTracesSampleRate({ name: 'POST /api/posthog/e' })).toBe(0);
    expect(resolveBackendTracesSampleRate({ name: 'POST /api/posthog/batch/' })).toBe(0);
  });

  it('drops static object-storage reads', () => {
    expect(resolveBackendTracesSampleRate({ name: 'GET /static/avatars/abc.webp' })).toBe(0);
    expect(resolveBackendTracesSampleRate({ name: 'GET /static/gym-logos/xyz.png' })).toBe(0);
    expect(resolveBackendTracesSampleRate({ name: 'GET /static/beta-link-thumbnails/1.jpg' })).toBe(0);
  });

  it('drops a WebSocket upgrade, which shares the /graphql path', () => {
    // graphql-ws is mounted on /graphql (websocket/setup.ts), so only the
    // headers distinguish a handshake from a query. A connection that lives for
    // a whole session has no duration worth recording.
    expect(
      resolveBackendTracesSampleRate({
        name: 'GET /graphql',
        normalizedRequest: { url: '/graphql', method: 'GET', headers: { upgrade: 'websocket' } },
      }),
    ).toBe(0);
    expect(
      resolveBackendTracesSampleRate({
        name: 'GET /graphql',
        normalizedRequest: { url: '/graphql', method: 'GET', headers: { connection: 'Upgrade' } },
      }),
    ).toBe(0);
  });

  it('samples /og/climb at 5%', () => {
    expect(resolveBackendTracesSampleRate({ name: 'GET /og/climb' })).toBe(0.05);
    expect(
      resolveBackendTracesSampleRate({ name: 'GET /og/climb', normalizedRequest: { url: '/og/climb?uuid=abc' } }),
    ).toBe(0.05);
  });

  it('samples everything else at 10%', () => {
    expect(resolveBackendTracesSampleRate({ name: 'GET /join/xyz' })).toBe(BACKEND_DEFAULT_SAMPLE_RATE);
    expect(resolveBackendTracesSampleRate({ name: 'GET /integrations/strava' })).toBe(BACKEND_DEFAULT_SAMPLE_RATE);
    expect(resolveBackendTracesSampleRate({})).toBe(BACKEND_DEFAULT_SAMPLE_RATE);
  });

  it('does not confuse a path that merely starts with a zeroed one', () => {
    expect(resolveBackendTracesSampleRate({ name: 'GET /healthz' })).toBe(BACKEND_DEFAULT_SAMPLE_RATE);
    expect(resolveBackendTracesSampleRate({ name: 'GET /render/boards' })).toBe(BACKEND_DEFAULT_SAMPLE_RATE);
    expect(resolveBackendTracesSampleRate({ name: 'POST /graphqlx' })).toBe(BACKEND_DEFAULT_SAMPLE_RATE);
  });

  it('reads the path from span attributes when the name is not method-prefixed', () => {
    // httpServerSpansIntegration sets url.path; it is the most reliable source.
    expect(resolveBackendTracesSampleRate({ name: 'anonymous span', attributes: { 'url.path': '/graphql' } })).toBe(
      0.01,
    );
  });
});

describe('resolveBackendRequestPath / resolveBackendRequestMethod', () => {
  it('prefers url.path over everything else', () => {
    expect(
      resolveBackendRequestPath({
        name: 'POST /wrong',
        attributes: { 'url.path': '/graphql' },
        normalizedRequest: { url: '/also-wrong' },
      }),
    ).toBe('/graphql');
  });

  it('falls back to http.url, then normalizedRequest.url, then the span name', () => {
    expect(resolveBackendRequestPath({ attributes: { 'http.url': 'https://ws.boardsesh.com/og/climb?uuid=a' } })).toBe(
      '/og/climb',
    );
    expect(resolveBackendRequestPath({ normalizedRequest: { url: '/health/db' } })).toBe('/health/db');
    expect(resolveBackendRequestPath({ name: 'GET /health' })).toBe('/health');
    expect(resolveBackendRequestPath({})).toBe('');
  });

  it('resolves the method from attributes, the normalized request, or the span name', () => {
    expect(resolveBackendRequestMethod({ attributes: { 'http.request.method': 'post' } })).toBe('POST');
    expect(resolveBackendRequestMethod({ attributes: { 'http.method': 'delete' } })).toBe('DELETE');
    expect(resolveBackendRequestMethod({ normalizedRequest: { method: 'patch' } })).toBe('PATCH');
    expect(resolveBackendRequestMethod({ name: 'GET /health' })).toBe('GET');
    expect(resolveBackendRequestMethod({ name: 'some custom span' })).toBe('');
  });
});

describe('isWebSocketUpgrade', () => {
  it('recognises both header spellings, case-insensitively', () => {
    expect(isWebSocketUpgrade({ normalizedRequest: { headers: { upgrade: 'WebSocket' } } })).toBe(true);
    expect(isWebSocketUpgrade({ normalizedRequest: { headers: { connection: 'keep-alive, Upgrade' } } })).toBe(true);
  });

  it('is false for a plain request', () => {
    expect(isWebSocketUpgrade({ normalizedRequest: { headers: { connection: 'keep-alive' } } })).toBe(false);
    expect(isWebSocketUpgrade({ normalizedRequest: {} })).toBe(false);
    expect(isWebSocketUpgrade({})).toBe(false);
  });
});

describe('BACKEND_TRACE_PROPAGATION_TARGETS', () => {
  it('is set at all, because Node defaults to propagating everywhere', () => {
    // Unset means shouldPropagateTraceForUrl returns true for every URL, which
    // would send sentry-trace/baggage to Aurora, Instagram, TikTok and Tigris.
    expect(BACKEND_TRACE_PROPAGATION_TARGETS.length).toBeGreaterThan(0);
  });

  it('covers our own host and relative paths only', () => {
    expect(BACKEND_TRACE_PROPAGATION_TARGETS).toContain('www.boardsesh.com');

    const relativePathPattern = BACKEND_TRACE_PROPAGATION_TARGETS.find(
      (target): target is RegExp => target instanceof RegExp,
    );
    expect(relativePathPattern?.test('/graphql')).toBe(true);

    for (const host of ['kilterboardapp.com', 'tensionboardapp2.com', 'www.instagram.com', 'www.tiktok.com']) {
      expect(BACKEND_TRACE_PROPAGATION_TARGETS).not.toContain(host);
    }
  });
});
