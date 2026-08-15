import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AURORA_PROXY_DEPRECATION_DATE,
  AURORA_PROXY_SUNSET_DATE,
  DEPRECATED_AURORA_PROXY_EVENT,
  DEPRECATION_DOCS_URL,
  deprecatedAuroraProxyResponse,
  deprecatedAuroraProxyRoute,
} from '../api-deprecation';

vi.mock('server-only', () => ({}));

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics.server', () => ({
  track: (...args: Parameters<typeof mockTrack>) => mockTrack(...args),
}));

const routeProps = { params: Promise.resolve({ board_name: 'kilter' }) };

function proxyRequest(init: RequestInit = {}): Request {
  return new Request('https://www.boardsesh.com/api/v1/kilter/proxy/login', { method: 'POST', ...init });
}

describe('the Aurora proxy deprecation contract', () => {
  it('pins the Deprecation date this PR records, and never advertises a future one', () => {
    // A 410 that says "will become deprecated on <future date>" contradicts
    // itself (RFC 9745 §2 reads a future sf-date as not-yet-deprecated), so the
    // constant is pinned to a literal AND bounded to the past. Bumping it forces
    // the PR body's recorded date to be bumped with it.
    expect(AURORA_PROXY_DEPRECATION_DATE.toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(AURORA_PROXY_DEPRECATION_DATE.getTime()).toBeLessThanOrEqual(Date.now());
    expect(deprecatedAuroraProxyResponse().headers.get('Deprecation')).toBe('@1786752000');
  });

  it('pins the Sunset date W-25b (#4443) is scheduled on', () => {
    expect(AURORA_PROXY_SUNSET_DATE.toUTCString()).toBe('Thu, 01 Oct 2026 00:00:00 GMT');
    expect(deprecatedAuroraProxyResponse().headers.get('Sunset')).toBe('Thu, 01 Oct 2026 00:00:00 GMT');
  });

  it('sends every caller to a page that actually documents the retirement', async () => {
    // Not just `rel="deprecation"`: pin the whole header and the body field, so a
    // repointed (or off-site) docs URL cannot ship green.
    expect(DEPRECATION_DOCS_URL).toBe('https://www.boardsesh.com/docs#retired-endpoints');

    const response = deprecatedAuroraProxyResponse();
    expect(response.headers.get('Link')).toBe(
      '<https://www.boardsesh.com/docs#retired-endpoints>; rel="deprecation"; type="text/html"',
    );
    await expect(response.json()).resolves.toEqual({
      error: 'Gone: the Aurora proxy endpoints have been retired.',
      documentation: 'https://www.boardsesh.com/docs#retired-endpoints',
    });
  });

  it('links to a fragment that exists on /docs', () => {
    // The two operations are deregistered from the Swagger pane, so the only
    // thing at the far end of the `rel="deprecation"` link is the "Retired
    // endpoints" card. A dangling fragment makes the whole header decorative.
    const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const docsClient = readFileSync(join(webRoot, 'app/docs/docs-client.tsx'), 'utf8');

    const fragment = DEPRECATION_DOCS_URL.split('#')[1];
    expect(fragment).toBeTruthy();
    expect(docsClient).toContain(`id="${fragment}"`);
    expect(docsClient).toContain('docs.overview.retired.title');

    // The card names the sunset date in prose. It cannot import the constant —
    // this module is `server-only` and docs-client.tsx is a client component —
    // so pin the two together here instead, or a slipped sunset leaves the page
    // advertising a date the `Sunset` header disagrees with.
    const sunsetDay = AURORA_PROXY_SUNSET_DATE.toISOString().slice(0, 10);
    expect(docsClient).toContain(`sunset: '${sunsetDay}'`);
  });
});

describe('the Aurora proxy deprecation counter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockResolvedValue(undefined);
  });

  it('records the method, so a crawler GET is not counted as a live integration POST', async () => {
    const handler = deprecatedAuroraProxyRoute('login');

    await handler(proxyRequest({ method: 'GET' }), routeProps);

    expect(mockTrack).toHaveBeenCalledWith(
      DEPRECATED_AURORA_PROXY_EVENT,
      expect.objectContaining({ method: 'GET' }),
      expect.anything(),
    );
  });

  it('lower-cases the board name, because the middleware board check is case-insensitive', async () => {
    const handler = deprecatedAuroraProxyRoute('saveAscent');

    await handler(proxyRequest(), { params: Promise.resolve({ board_name: 'Kilter' }) });

    expect(mockTrack).toHaveBeenCalledWith(
      DEPRECATED_AURORA_PROXY_EVENT,
      { endpoint: 'saveAscent', boardName: 'kilter', method: 'POST' },
      expect.anything(),
    );
  });

  it('never forwards the caller cookie to the analytics endpoint', async () => {
    const handler = deprecatedAuroraProxyRoute('saveAscent');
    const request = proxyRequest({
      headers: {
        cookie: 'next-auth.session-token=super-secret',
        'user-agent': 'curl/8.5.0',
        'x-forwarded-for': '203.0.113.7',
      },
    });

    await handler(request, routeProps);

    // `@vercel/analytics` copies `cookie` verbatim onto its outbound request, so
    // it may only ever be handed an allowlist.
    const [, , options] = mockTrack.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(options.headers).toEqual({ 'user-agent': 'curl/8.5.0', 'x-forwarded-for': '203.0.113.7' });
  });

  it('still answers 410 when telemetry throws synchronously', async () => {
    mockTrack.mockImplementation(() => {
      throw new Error('analytics module boom');
    });

    const response = await deprecatedAuroraProxyRoute('login')(proxyRequest(), routeProps);

    expect(response.status).toBe(410);
  });

  it('attaches a rejection handler to the telemetry promise', async () => {
    // The ruling's binding constraint is `void track(...).catch(() => {})`, and
    // asserting the 410 alone cannot see the `.catch` go missing — the rejection
    // settles on a later microtask either way, and vitest's own settled-result
    // tracking on a `vi.fn` attaches a handler that hides the unhandled
    // rejection. So watch the `.catch` call itself.
    const catchSpy = vi.fn(() => Promise.resolve());
    mockTrack.mockReturnValue({ catch: catchSpy } as unknown as Promise<void>);

    const response = await deprecatedAuroraProxyRoute('login')(proxyRequest(), routeProps);

    expect(response.status).toBe(410);
    expect(catchSpy).toHaveBeenCalledTimes(1);
  });

  it('still answers 410 when telemetry rejects', async () => {
    mockTrack.mockRejectedValue(new Error('analytics down'));

    const response = await deprecatedAuroraProxyRoute('saveAscent')(proxyRequest(), routeProps);

    expect(response.status).toBe(410);
  });
});
