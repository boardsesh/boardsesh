/// <reference types="node" />

import { describe, expect, it, vi } from 'vite-plus/test';
import {
  CLIMB_SITEMAP_PATH,
  CUTOVER_TOKEN_ENV,
  DEFAULT_CONCURRENCY,
  DEFAULT_REQUESTS,
  DEFAULT_TIMEOUT_MS,
  READINESS_PATH,
  formatSummary,
  parseArguments,
  parseOrigin,
  rewriteUrlsToOrigin,
  runCutoverSmoke,
  runProbeRequests,
  runRequests,
  selectClimbUrls,
  summarizeOutcomes,
  validateClimbResponse,
  type FetchLike,
  type RequestOutcome,
} from './pgbouncer-cutover-smoke';

const TEST_ENV = { [CUTOVER_TOKEN_ENV]: 'probe-secret' };

function sitemap(urls: readonly string[]): string {
  return `<?xml version="1.0"?><urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
}

function climbResponse(status = 200): Response {
  const body =
    '<!doctype html><html><body><main><h1>Climb name</h1>' +
    '<script type="application/ld+json">{"@type":"CreativeWork"}</script>' +
    `${'x'.repeat(4_000)}</main></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function probeResponse(status = 200, ok = true, noStore = true): Response {
  return Response.json(
    { ok },
    { status, headers: noStore ? { 'cache-control': 'private, no-store, max-age=0' } : undefined },
  );
}

function options(overrides: Partial<ReturnType<typeof parseArguments>> = {}) {
  return {
    origin: 'https://cutover.example.com',
    requests: 3,
    concurrency: 2,
    timeoutMs: 100,
    probeToken: 'probe-secret',
    ...overrides,
  };
}

describe('parseArguments', () => {
  it('requires a safe explicit origin and a dedicated environment token', () => {
    expect(parseArguments(['--origin', 'https://cutover.boardsesh.com/'], TEST_ENV)).toEqual({
      origin: 'https://cutover.boardsesh.com',
      requests: DEFAULT_REQUESTS,
      concurrency: DEFAULT_CONCURRENCY,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      probeToken: 'probe-secret',
    });
    expect(() => parseArguments([], TEST_ENV)).toThrow('--origin is required');
    expect(() => parseArguments(['--origin', 'https://example.com'], {})).toThrow(CUTOVER_TOKEN_ENV);
    expect(() => parseOrigin('postgres://db.example.com')).toThrow('http:// or https://');
    expect(() => parseOrigin('http://cutover.boardsesh.com')).toThrow('https:// outside localhost');
    expect(() => parseOrigin('https://user:secret@cutover.boardsesh.com')).toThrow('credentials');
    expect(() => parseOrigin('https://cutover.boardsesh.com/path')).toThrow('path, query, or fragment');
  });

  it('accepts the vp separator and exact positive overrides', () => {
    expect(
      parseArguments(
        ['--', '--origin', 'http://localhost:3000', '--requests', '7', '--concurrency', '3', '--timeout-ms', '1250'],
        TEST_ENV,
      ),
    ).toEqual({
      origin: 'http://localhost:3000',
      requests: 7,
      concurrency: 3,
      timeoutMs: 1250,
      probeToken: 'probe-secret',
    });
    expect(() => parseArguments(['--origin', 'https://example.com', '--requests', '0'], TEST_ENV)).toThrow(
      'positive integer',
    );
    expect(() => parseArguments(['--origin', 'https://example.com', '--wat', '1'], TEST_ENV)).toThrow('unknown option');
  });
});

describe('sitemap URL selection', () => {
  it('decodes, deduplicates, and samples exactly across the full population', () => {
    const urls = Array.from(
      { length: 10 },
      (_, index) => `https://www.boardsesh.com/kilter/config/40/view/climb-${index}`,
    );
    const xml = sitemap([
      `${urls[0]}?angle=40&amp;mirror=false`,
      `${urls[0]}?angle=40&amp;mirror=false`,
      ...urls.slice(1),
    ]);
    expect(selectClimbUrls(xml, 4)).toEqual([`${urls[0]}?angle=40&mirror=false`, urls[3], urls[6], urls[9]]);
    expect(selectClimbUrls(sitemap(urls), 1)).toEqual([urls[0]]);
  });

  it('fails closed on short, malformed, unsafe, and non-climb sitemaps', () => {
    expect(() => selectClimbUrls(sitemap(['https://www.boardsesh.com/view/one']), 2)).toThrow(
      '1 unique URLs; 2 required',
    );
    expect(() => selectClimbUrls('<html></html>', 1)).toThrow('<urlset>');
    expect(() => selectClimbUrls(sitemap(['not a URL']), 1)).toThrow('invalid <loc>');
    expect(() => selectClimbUrls(sitemap(['https://user:secret@example.com/view/climb']), 1)).toThrow('unsafe <loc>');
    expect(() => selectClimbUrls(sitemap(['https://www.boardsesh.com/settings']), 1)).toThrow('non-climb <loc>');
  });

  it('rewrites only the origin while preserving path and query', () => {
    expect(
      rewriteUrlsToOrigin(
        ['https://www.boardsesh.com/kilter/layout/40/view/example?mirror=false'],
        'https://cutover.boardsesh.com:8443',
      ),
    ).toEqual(['https://cutover.boardsesh.com:8443/kilter/layout/40/view/example?mirror=false']);
  });
});

describe('climb response validation', () => {
  it('requires direct 2xx complete climb-specific SSR HTML', async () => {
    const healthy = climbResponse();
    expect(validateClimbResponse(200, 'text/html', await healthy.text())).toBeNull();
    expect(validateClimbResponse(302, 'text/html', 'x'.repeat(5_000))).toBe('http');
    expect(validateClimbResponse(200, 'text/html', '<main><h1>Error</h1></main>')).toBe('short-html');
    expect(validateClimbResponse(200, 'text/html', `<main><h1>Error</h1>${'x'.repeat(5_000)}</main>`)).toBe(
      'missing-jsonld',
    );
    expect(validateClimbResponse(200, 'application/json', 'x'.repeat(5_000))).toBe('non-html');
  });

  it('keeps the timeout active while consuming a streamed body', async () => {
    const fetchMock: FetchLike = vi.fn(async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<html><main>'));
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/html' } });
    });
    const [outcome] = await runRequests(['https://target.example.com/view/climb'], 1, 5, fetchMock);
    expect(outcome.error).toBe('timeout');
  });
});

describe('bounded runners', () => {
  it('completes exactly 100 climb GETs without exceeding concurrency 32, even after failures', async () => {
    let active = 0;
    let peak = 0;
    const seen = new Map<string, number>();
    const fetchMock: FetchLike = vi.fn(async (input, init) => {
      active += 1;
      peak = Math.max(peak, active);
      const url = String(input);
      seen.set(url, (seen.get(url) ?? 0) + 1);
      expect(init?.redirect).toBe('manual');
      expect(init?.headers).not.toHaveProperty('Authorization');
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return url.endsWith('/0') ? new Response(null, { status: 302 }) : climbResponse();
    });
    const urls = Array.from({ length: 100 }, (_, index) => `https://cutover.example.com/view/${index}`);

    const outcomes = await runRequests(urls, 32, 100, fetchMock);

    expect(outcomes).toHaveLength(100);
    expect(peak).toBe(32);
    expect([...seen.values()]).toEqual(Array.from({ length: 100 }, () => 1));
    expect(outcomes[0].error).toBe('http');
  });

  it('runs one authenticated no-store database probe per request under the same bound', async () => {
    let active = 0;
    let peak = 0;
    const fetchMock: FetchLike = vi.fn(async (input, init) => {
      active += 1;
      peak = Math.max(peak, active);
      expect(String(input)).toMatch(`${READINESS_PATH}?request=`);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer probe-secret' });
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return probeResponse();
    });

    const outcomes = await runProbeRequests(options({ requests: 100, concurrency: 32 }), fetchMock);

    expect(outcomes).toHaveLength(100);
    expect(peak).toBe(32);
    expect(outcomes.every((outcome) => outcome.error === null)).toBe(true);
  });

  it('rejects redirects, bad payloads, and cacheable probe responses', async () => {
    const responses = [new Response(null, { status: 302 }), probeResponse(200, false), probeResponse(200, true, false)];
    const fetchMock: FetchLike = vi.fn(async () => responses.shift() ?? probeResponse());
    const outcomes = await runProbeRequests(options(), fetchMock);
    expect(outcomes.map((outcome) => outcome.error)).toEqual(['invalid-probe', 'invalid-probe', 'cacheable-probe']);
  });
});

describe('summary', () => {
  it('prints fixed status, failure-reason, and latency counts without request details', () => {
    const outcomes: RequestOutcome[] = [
      { status: 200, latencyMs: 10, error: null },
      { status: 204, latencyMs: 20, error: null },
      { status: 302, latencyMs: 30, error: 'http' },
      { status: 500, latencyMs: 40, error: 'http' },
      { status: null, latencyMs: 50, error: 'network' },
    ];
    const formatted = formatSummary(summarizeOutcomes(outcomes));
    expect(formatted).toBe(
      'requests=5 ok=2 failed=3 status=200:1,204:1,302:1,500:1 timeouts=0 network=1 invalid=2 errors=http:2,network:1 latency_ms=p50:30,p95:50,max:50',
    );
    expect(formatted).not.toContain('http://');
    expect(formatted).not.toContain('secret');
  });
});

describe('runCutoverSmoke', () => {
  it('runs exact database and climb batches while keeping the token off public requests', async () => {
    const requestedUrls: string[] = [];
    const fetchMock: FetchLike = vi.fn(async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === `https://cutover.example.com${CLIMB_SITEMAP_PATH}`) {
        expect(init?.headers).not.toHaveProperty('Authorization');
        return new Response(
          sitemap(Array.from({ length: 4 }, (_, index) => `https://www.boardsesh.com/kilter/view/climb-${index}`)),
        );
      }
      if (url.includes(READINESS_PATH)) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer probe-secret' });
        return probeResponse();
      }
      expect(init?.headers).not.toHaveProperty('Authorization');
      return climbResponse();
    });

    const report = await runCutoverSmoke(options(), fetchMock);

    expect(report.database).toMatchObject({ total: 3, successful: 3, failed: 0 });
    expect(report.climbs).toMatchObject({ total: 3, successful: 3, failed: 0 });
    expect(requestedUrls).toEqual([
      'https://cutover.example.com/sitemaps/climbs/1.xml',
      'https://cutover.example.com/api/internal/pgbouncer-cutover-readiness?request=1',
      'https://cutover.example.com/api/internal/pgbouncer-cutover-readiness?request=2',
      'https://cutover.example.com/api/internal/pgbouncer-cutover-readiness?request=3',
      'https://cutover.example.com/kilter/view/climb-0',
      'https://cutover.example.com/kilter/view/climb-2',
      'https://cutover.example.com/kilter/view/climb-3',
    ]);
  });

  it('does not start either batch when the sitemap has fewer URLs than required', async () => {
    const fetchMock: FetchLike = vi.fn(
      async () => new Response(sitemap(['https://www.boardsesh.com/kilter/view/only-one'])),
    );
    await expect(runCutoverSmoke(options({ requests: 2 }), fetchMock)).rejects.toThrow('1 unique URLs; 2 required');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
