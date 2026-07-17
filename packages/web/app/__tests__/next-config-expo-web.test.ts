import { afterEach, describe, expect, it } from 'vite-plus/test';

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
});

describe('Expo web Next proxy', () => {
  it('normalizes an HTTP(S) proxy origin and rejects other protocols', () => {
    expect(configModule.resolveExpoWebDevOrigin('http://localhost:8082/path')).toBe('http://localhost:8082');
    expect(configModule.resolveExpoWebDevOrigin(undefined)).toBeNull();
    expect(() => configModule.resolveExpoWebDevOrigin('file:///tmp/expo')).toThrow(/http or https/);
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
    expect(rewrites).toContainEqual({ source: '/app/:path*', destination: 'http://localhost:8082/app/:path*' });
    expect(rewrites).toContainEqual({
      source: '/packages/mobile/:path*',
      destination: 'http://localhost:8082/packages/mobile/:path*',
    });
    expect(rewrites).toContainEqual({ source: '/assets', destination: 'http://localhost:8082/assets' });
    expect(rewrites).toContainEqual({ source: '/assets/:path*', destination: 'http://localhost:8082/assets/:path*' });
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

  it('keeps the authenticated Expo utility surface out of search results', async () => {
    const headers = (await nextConfig.headers?.()) ?? [];

    expect(headers).toContainEqual({
      source: '/app/:path*',
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, follow' }],
    });
  });
});
