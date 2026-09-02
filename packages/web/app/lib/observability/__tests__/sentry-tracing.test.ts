import { describe, expect, it } from 'vitest';
import type { RailwayTaggableEvent } from '../sentry-tracing';
import {
  redactSensitiveSpanUrls,
  resolveSampledRequestMethod,
  resolveSampledRequestPath,
  stripSensitiveQueryString,
  tagRailwayRequestId,
  WEB_SERVER_TRACES_SAMPLE_RATE,
  WEB_TRACE_PROPAGATION_TARGETS,
  resolveWebTracesSampleRate,
} from '../sentry-tracing';

describe('resolveWebTracesSampleRate', () => {
  it('drops POST /monitoring, the Sentry tunnel', () => {
    // next.config.mjs sets `tunnelRoute: '/monitoring'`, so every browser
    // envelope arrives as a Next route handler POST. Sampling it would roughly
    // double server span volume with traces of Sentry reporting to Sentry, and
    // put a route nobody navigates to at the top of the p75-by-route table.
    expect(resolveWebTracesSampleRate({ name: 'POST /monitoring' })).toBe(0);
    expect(resolveWebTracesSampleRate({ name: 'POST /monitoring', method: 'POST', url: '/monitoring?o=123' })).toBe(0);
  });

  it('drops the health probe', () => {
    expect(resolveWebTracesSampleRate({ name: 'GET /api/health' })).toBe(0);
    expect(resolveWebTracesSampleRate({ name: 'GET /api/health/db' })).toBe(0);
  });

  it('samples an ordinary route at the default rate', () => {
    expect(resolveWebTracesSampleRate({ name: 'GET /gyms/london' })).toBe(WEB_SERVER_TRACES_SAMPLE_RATE);
    expect(resolveWebTracesSampleRate({ name: 'GET /api/v1/climbs' })).toBe(WEB_SERVER_TRACES_SAMPLE_RATE);
  });

  it('does not confuse a route that merely starts with a zeroed path', () => {
    // `/monitoring-preferences` and `/api/healthcheck` are not the tunnel and
    // not the probe. A `startsWith` on the bare path would swallow both.
    expect(resolveWebTracesSampleRate({ name: 'GET /monitoring-preferences' })).toBe(WEB_SERVER_TRACES_SAMPLE_RATE);
    expect(resolveWebTracesSampleRate({ name: 'GET /api/healthcheck' })).toBe(WEB_SERVER_TRACES_SAMPLE_RATE);
  });

  it('samples rather than drops when the context carries nothing recognisable', () => {
    // Failing open matters: a sampler that returned 0 for an unparseable
    // context would take tracing dark without any error to notice.
    expect(resolveWebTracesSampleRate({})).toBe(WEB_SERVER_TRACES_SAMPLE_RATE);
  });

  it('reads the path from a full URL when the span name has none', () => {
    expect(resolveWebTracesSampleRate({ name: 'middleware', url: 'https://www.boardsesh.com/api/health' })).toBe(0);
  });
});

describe('resolveSampledRequestPath / resolveSampledRequestMethod', () => {
  it('splits a Sentry server span name into method and path', () => {
    expect(resolveSampledRequestPath({ name: 'POST /monitoring' })).toBe('/monitoring');
    expect(resolveSampledRequestMethod({ name: 'POST /monitoring' })).toBe('POST');
  });

  it('strips the query string from a URL', () => {
    expect(resolveSampledRequestPath({ url: '/api/health?probe=railway' })).toBe('/api/health');
    expect(resolveSampledRequestPath({ url: 'https://www.boardsesh.com/gyms?page=2' })).toBe('/gyms');
  });

  it('leaves a name that is not method-prefixed alone', () => {
    expect(resolveSampledRequestPath({ name: '/some/custom/span' })).toBe('/some/custom/span');
    expect(resolveSampledRequestMethod({ name: '/some/custom/span' })).toBe('');
  });
});

describe('WEB_TRACE_PROPAGATION_TARGETS', () => {
  it('is set at all, because Node defaults to propagating everywhere', () => {
    // shouldPropagateTraceForUrl in @sentry/core returns `true` for every URL
    // when the option is falsy, and @sentry/node supplies no default. An empty
    // or missing list would ship sentry-trace/baggage to the Aurora APIs and
    // the OAuth endpoints.
    expect(WEB_TRACE_PROPAGATION_TARGETS.length).toBeGreaterThan(0);
  });

  it('covers our own hosts and relative paths, and nothing third-party', () => {
    expect(WEB_TRACE_PROPAGATION_TARGETS).toContain('ws.boardsesh.com');
    expect(WEB_TRACE_PROPAGATION_TARGETS).toContain('www.boardsesh.com');

    const relativePathPattern = WEB_TRACE_PROPAGATION_TARGETS.find(
      (target): target is RegExp => target instanceof RegExp,
    );
    expect(relativePathPattern?.test('/api/v1/climbs')).toBe(true);

    const thirdPartyHosts = ['kilterboardapp.com', 'tensionboardapp2.com', 'accounts.google.com'];
    for (const host of thirdPartyHosts) {
      expect(WEB_TRACE_PROPAGATION_TARGETS).not.toContain(host);
    }
  });
});

describe('redactSensitiveSpanUrls', () => {
  it('strips the OAuth code and state from a NextAuth callback span', () => {
    const span = {
      data: {
        'http.url': 'https://www.boardsesh.com/api/auth/callback/google?code=4/0AY0e-abc&state=xyz789',
        'url.full': 'https://www.boardsesh.com/api/auth/callback/google?code=4/0AY0e-abc&state=xyz789',
        'http.method': 'GET',
      },
    };

    const redacted = redactSensitiveSpanUrls(span);

    expect(redacted.data['http.url']).toBe('https://www.boardsesh.com/api/auth/callback/google');
    expect(redacted.data['url.full']).toBe('https://www.boardsesh.com/api/auth/callback/google');
    expect(String(redacted.data['http.url'])).not.toContain('code=');
    expect(String(redacted.data['url.full'])).not.toContain('state=');
    expect(redacted.data['http.method']).toBe('GET');
  });

  it('strips a session identifier from any path', () => {
    const span = { data: { 'url.full': 'https://www.boardsesh.com/join?session=abc123&board=kilter' } };

    expect(redactSensitiveSpanUrls(span).data['url.full']).toBe('https://www.boardsesh.com/join');
  });

  it('leaves an ordinary span untouched', () => {
    const span = {
      data: {
        'http.url': 'https://www.boardsesh.com/api/v1/climbs?board=kilter&angle=40',
        'url.full': 'https://www.boardsesh.com/api/v1/climbs?board=kilter&angle=40',
        'db.system': 'postgresql',
      },
    };

    const redacted = redactSensitiveSpanUrls(span);

    expect(redacted.data['http.url']).toBe('https://www.boardsesh.com/api/v1/climbs?board=kilter&angle=40');
    expect(redacted.data['url.full']).toBe('https://www.boardsesh.com/api/v1/climbs?board=kilter&angle=40');
    expect(redacted.data['db.system']).toBe('postgresql');
  });

  it('handles a span with no URL attributes at all', () => {
    const span = { data: { 'db.system': 'postgresql', 'db.statement': 'select 1' } };

    expect(redactSensitiveSpanUrls(span).data).toEqual({ 'db.system': 'postgresql', 'db.statement': 'select 1' });
  });

  it('does not treat a non-session parameter as a session', () => {
    const url = 'https://www.boardsesh.com/profile?sessionCount=12';

    expect(stripSensitiveQueryString(url)).toBe(url);
  });

  it('redacts a relative auth URL too', () => {
    expect(stripSensitiveQueryString('/api/auth/callback/apple?code=abc')).toBe('/api/auth/callback/apple');
  });
});

describe('tagRailwayRequestId', () => {
  it('promotes the Railway edge request id to a tag', () => {
    // This is the join key: the same id appears on the Railway HTTP log line
    // for the request, so a slow trace can be looked up in the platform logs.
    const event: RailwayTaggableEvent = { request: { headers: { 'x-railway-request-id': 'req_01HZ' } } };

    expect(tagRailwayRequestId(event).tags).toEqual({ railway_request_id: 'req_01HZ' });
  });

  it('keeps tags that are already on the event', () => {
    const event: RailwayTaggableEvent = {
      request: { headers: { 'x-railway-request-id': 'req_01HZ' } },
      tags: { route: '/gyms' },
    };

    expect(tagRailwayRequestId(event).tags).toEqual({ route: '/gyms', railway_request_id: 'req_01HZ' });
  });

  it('does not throw, or invent a tag, when the header is absent', () => {
    // The normal case off Railway: local dev, tests, and any browser event.
    const eventsWithoutTheHeader: RailwayTaggableEvent[] = [
      {},
      { request: {} },
      { request: { headers: {} } },
      { request: { headers: { 'user-agent': 'curl' } } },
    ];

    for (const event of eventsWithoutTheHeader) {
      expect(() => tagRailwayRequestId(event)).not.toThrow();
      expect(tagRailwayRequestId(event).tags).toBeUndefined();
    }
  });

  it('returns the same event object the processor was handed', () => {
    const event: RailwayTaggableEvent = { request: { headers: { 'x-railway-request-id': 'req_01HZ' } } };

    expect(tagRailwayRequestId(event)).toBe(event);
  });
});
