import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

type Rewrite = { source: string; destination: string };
type RewriteResult = Rewrite[] | { beforeFiles?: Rewrite[]; afterFiles?: Rewrite[]; fallback?: Rewrite[] };
type Header = { source: string; headers: Array<{ key: string; value: string }> };
type NextConfigWithExpoWeb = {
  rewrites?: () => Promise<RewriteResult>;
  headers?: () => Promise<Header[]>;
};

const originalWebFlag = process.env.BOARDSESH_WEB;
const originalProxyOrigin = process.env.BOARDSESH_EXPO_WEB_ORIGIN;
const configModule = await import('../../next.config.mjs');
const nextConfig = configModule.default as unknown as NextConfigWithExpoWeb;

function flattenRewrites(result: RewriteResult): Rewrite[] {
  if (Array.isArray(result)) return result;
  return [...(result.beforeFiles ?? []), ...(result.afterFiles ?? []), ...(result.fallback ?? [])];
}

afterEach(() => {
  if (originalWebFlag === undefined) delete process.env.BOARDSESH_WEB;
  else process.env.BOARDSESH_WEB = originalWebFlag;

  if (originalProxyOrigin === undefined) delete process.env.BOARDSESH_EXPO_WEB_ORIGIN;
  else process.env.BOARDSESH_EXPO_WEB_ORIGIN = originalProxyOrigin;

  // The static /app fallback is gated on NODE_ENV === 'development' (W-24,
  // #4438); vitest runs with NODE_ENV=test, so every test that exercises that
  // branch stubs it and this puts it back.
  vi.unstubAllEnvs();
});

describe('Expo web Next proxy', () => {
  it('derives the board-render HTTP endpoint from the public WebSocket URL', () => {
    expect(configModule.resolveBoardRenderBackendUrl('wss://ws.boardsesh.com/graphql')).toBe(
      'https://ws.boardsesh.com/render/board',
    );
    expect(configModule.resolveBoardRenderBackendUrl('ws://localhost:8080/graphql')).toBe(
      'http://localhost:8080/render/board',
    );
    expect(() => configModule.resolveBoardRenderBackendUrl('file:///tmp/socket')).toThrow(/ws, wss, http, or https/);
  });

  it('always installs the legacy board-render compatibility rewrite', async () => {
    delete process.env.BOARDSESH_WEB;
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');

    const rewrites = flattenRewrites((await nextConfig.rewrites?.()) ?? []);

    expect(rewrites).toContainEqual({
      source: '/api/internal/board-render',
      destination: 'https://ws.boardsesh.com/render/board',
    });
  });

  it('normalizes an HTTP(S) proxy origin and rejects other protocols', () => {
    expect(configModule.resolveExpoWebDevOrigin('http://localhost:8082/path')).toBe('http://localhost:8082');
    expect(configModule.resolveExpoWebDevOrigin(undefined)).toBeNull();
    expect(() => configModule.resolveExpoWebDevOrigin('file:///tmp/expo')).toThrow(/http or https/);
  });

  it('rejects a scheme-less proxy origin with a clear message', () => {
    // `//localhost:8081` (scheme omitted) makes `new URL` throw a bare
    // "Invalid URL"; resolveExpoWebDevOrigin must surface the actual value and
    // the expected shape instead.
    expect(() => configModule.resolveExpoWebDevOrigin('//localhost:8081')).toThrow(
      /BOARDSESH_EXPO_WEB_ORIGIN is not a valid URL/,
    );
  });

  it('accepts only loopback hosts for the dev Metro proxy', () => {
    expect(configModule.resolveExpoWebDevOrigin('http://localhost:8082')).toBe('http://localhost:8082');
    expect(configModule.resolveExpoWebDevOrigin('http://127.0.0.1:8082')).toBe('http://127.0.0.1:8082');
    expect(configModule.resolveExpoWebDevOrigin('http://[::1]:8082')).toBe('http://[::1]:8082');
    // A non-loopback host would turn the /app rewrite into an open forward.
    expect(() => configModule.resolveExpoWebDevOrigin('http://evil.example.com:8082')).toThrow(/loopback host/);
    expect(() => configModule.resolveExpoWebDevOrigin('http://192.168.0.5:8082')).toThrow(/loopback host/);
  });

  it('adds /app rewrites only when Expo web and its proxy origin are enabled', async () => {
    process.env.BOARDSESH_WEB = '1';
    process.env.BOARDSESH_EXPO_WEB_ORIGIN = 'http://localhost:8082';

    const rewrites = flattenRewrites((await nextConfig.rewrites?.()) ?? []);

    expect(rewrites).toContainEqual({ source: '/app', destination: 'http://localhost:8082/app' });
    expect(rewrites).toContainEqual({
      source: '/app/wasm/:path*',
      destination: 'http://localhost:8082/wasm/:path*',
    });
    expect(rewrites).toContainEqual({
      source: '/app/manifest.json',
      destination: 'http://localhost:8082/manifest.json',
    });
    expect(rewrites).toContainEqual({ source: '/app/:path*', destination: 'http://localhost:8082/app/:path*' });
    expect(rewrites).toContainEqual({
      source: '/packages/mobile/:path*',
      destination: 'http://localhost:8082/packages/mobile/:path*',
    });
    expect(rewrites).toContainEqual({ source: '/assets', destination: 'http://localhost:8082/assets' });
    expect(rewrites).toContainEqual({ source: '/assets/:path*', destination: 'http://localhost:8082/assets/:path*' });
  });

  it('proxies to Metro before the filesystem so a stale local export cannot shadow the dev server', async () => {
    process.env.BOARDSESH_WEB = '1';
    process.env.BOARDSESH_EXPO_WEB_ORIGIN = 'http://localhost:8082';

    const rewriteResult = (await nextConfig.rewrites?.()) ?? [];

    expect(Array.isArray(rewriteResult)).toBe(false);
    const phasedRewrites = rewriteResult as Exclude<RewriteResult, Rewrite[]>;
    const isExpoNamespace = ({ source }: Rewrite) =>
      source === '/app' ||
      source.startsWith('/app/') ||
      source === '/assets' ||
      source.startsWith('/assets/') ||
      source.startsWith('/packages/mobile/');
    expect((phasedRewrites.beforeFiles ?? []).filter(isExpoNamespace).length).toBeGreaterThan(0);
    expect((phasedRewrites.afterFiles ?? []).filter(isExpoNamespace)).toEqual([]);
    expect((phasedRewrites.fallback ?? []).filter(isExpoNamespace)).toEqual([]);
  });

  it('bakes no /app rewrite into a production build (the retirement)', async () => {
    // W-24 (#4438): the Expo browser app ships only at app.boardsesh.com. A
    // production build must not be able to serve /app even with the web flag on
    // — that is the property #3795 (web → Railway, whose image builds from
    // Dockerfile.web) depends on.
    process.env.BOARDSESH_WEB = '1';
    delete process.env.BOARDSESH_EXPO_WEB_ORIGIN;
    vi.stubEnv('NODE_ENV', 'production');

    const appRewrites = flattenRewrites((await nextConfig.rewrites?.()) ?? []).filter(
      ({ source }) => source === '/app' || source.startsWith('/app/'),
    );

    expect(appRewrites).toEqual([]);
  });

  it('keeps the SPA fallback in dev so vp run dev:mobile:web-static still serves /app', async () => {
    // scripts/dev-expo-web-static.sh bakes the default (/app baseUrl) export
    // into packages/web/public/app and starts the orchestrator with the web flag
    // on and no proxy origin — the tailnet device-QA loop lands here.
    process.env.BOARDSESH_WEB = '1';
    delete process.env.BOARDSESH_EXPO_WEB_ORIGIN;
    vi.stubEnv('NODE_ENV', 'development');

    const rewriteResult = (await nextConfig.rewrites?.()) ?? [];

    // The compatibility proxy makes the result phased; scope the assertion to
    // the /app namespace because Sentry adds unrelated rewrites too.
    expect(Array.isArray(rewriteResult)).toBe(false);
    const appRewrites = flattenRewrites(rewriteResult).filter(
      ({ source }) => source === '/app' || source.startsWith('/app/'),
    );
    expect(appRewrites).toEqual([
      { source: '/app', destination: '/app/index.html' },
      { source: '/app/:path((?!_expo/|assets/|wasm/).*)', destination: '/app/index.html' },
    ]);
  });

  it('keeps content-hashed and WASM namespaces out of the SPA fallback so missing assets 404', async () => {
    process.env.BOARDSESH_WEB = '1';
    delete process.env.BOARDSESH_EXPO_WEB_ORIGIN;
    vi.stubEnv('NODE_ENV', 'development');

    const appRewrites = flattenRewrites((await nextConfig.rewrites?.()) ?? []).filter(
      ({ source }) => source === '/app' || source.startsWith('/app/'),
    );

    // The fallback source is a path-to-regexp pattern with a negative lookahead.
    // Compile it and confirm hashed-asset / WASM paths do NOT fall back to the
    // shell (they must miss public/ and 404), while real Expo Router routes do.
    const fallback = appRewrites.find(({ source }) => source !== '/app');
    expect(fallback?.destination).toBe('/app/index.html');
    const capturedTail = /:path\((.*)\)/.exec(fallback?.source ?? '');
    expect(capturedTail).not.toBeNull();
    const tailMatcher = new RegExp(`^${capturedTail?.[1]}$`);

    expect(tailMatcher.test('_expo/static/js/entry-abc123.js')).toBe(false);
    expect(tailMatcher.test('assets/node_modules/expo/deadbeef.png')).toBe(false);
    expect(tailMatcher.test('wasm/board_renderer_wasm.js')).toBe(false);
    expect(tailMatcher.test('session/history')).toBe(true);
  });

  it('keeps Metro-only support namespaces out of the static configuration', async () => {
    process.env.BOARDSESH_WEB = '1';
    delete process.env.BOARDSESH_EXPO_WEB_ORIGIN;
    vi.stubEnv('NODE_ENV', 'development');

    const rewrites = flattenRewrites((await nextConfig.rewrites?.()) ?? []);

    expect(
      rewrites.some(
        ({ source, destination }) =>
          source === '/assets' ||
          source.startsWith('/assets/') ||
          source.startsWith('/packages/mobile/') ||
          (source.startsWith('/app') && destination.startsWith('http')),
      ),
    ).toBe(false);
  });

  it('does not expose the Expo proxy in the normal Next configuration', async () => {
    delete process.env.BOARDSESH_WEB;
    process.env.BOARDSESH_EXPO_WEB_ORIGIN = 'http://localhost:8082';

    const rewrites = flattenRewrites((await nextConfig.rewrites?.()) ?? []);

    expect(
      rewrites.some(
        ({ source }) =>
          source === '/app' ||
          source.startsWith('/app/') ||
          source === '/assets' ||
          source.startsWith('/assets/') ||
          source.startsWith('/packages/mobile/'),
      ),
    ).toBe(false);
  });

  it('headers() owns no /app rule after the retirement', async () => {
    // W-24 (#4438): the noindex and immutable-cache rules moved to the surface
    // that actually serves the app (deploy/app-subdomain/_headers). The dev
    // Metro proxy is an external rewrite, which forwards Metro's own headers
    // past headers() entirely — middleware.ts covers that surface instead.
    const headers = (await nextConfig.headers?.()) ?? [];

    expect(headers.filter(({ source }) => source === '/app' || source.startsWith('/app/'))).toEqual([]);
    // The global (non-embed) catch-all is `/((?!embed/).*)`, which does match
    // /app requests at runtime — it must survive, so assert it is still there
    // rather than letting a blunt "no rule mentions app" check pass by
    // deleting it.
    expect(headers.some(({ source }) => source === '/((?!embed/).*)')).toBe(true);
  });
});
