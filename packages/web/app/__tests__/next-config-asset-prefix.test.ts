import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const configModule = await import('../../next.config.mjs');
const { resolveNextAssetPrefix, getRetainedNextAssetRewrites } = configModule;

afterEach(() => vi.unstubAllEnvs());

describe('retained Next build assets', () => {
  it('uses the configured CDN origin only for an opted-in production build', () => {
    expect(resolveNextAssetPrefix('https://assets.boardsesh.com/', 'production')).toBe('https://assets.boardsesh.com');
    expect(resolveNextAssetPrefix(undefined, 'production')).toBeUndefined();
    expect(resolveNextAssetPrefix('', 'production')).toBeUndefined();
    expect(resolveNextAssetPrefix('https://assets.boardsesh.com', 'development')).toBeUndefined();
    expect(resolveNextAssetPrefix('https://assets.boardsesh.com', 'test')).toBeUndefined();
  });

  it.each([
    'http://assets.boardsesh.com',
    'https://user:password@assets.boardsesh.com',
    'https://assets.boardsesh.com/static/v1',
    'https://assets.boardsesh.com?preview=1',
    'https://assets.boardsesh.com#preview',
    'not a URL',
  ])('rejects an invalid production asset origin: %s', (origin) => {
    expect(() => resolveNextAssetPrefix(origin, 'production')).toThrow();
  });
});

describe('retained-file routing', () => {
  it('does not send development asset misses to production', () => {
    expect(getRetainedNextAssetRewrites('development', '1')).toEqual([]);
    expect(getRetainedNextAssetRewrites('test', '1')).toEqual([]);
    expect(getRetainedNextAssetRewrites('production', '0')).toEqual([]);
    vi.stubEnv('NEXT_PUBLIC_RETAINED_NEXT_ASSETS', undefined);
    expect(getRetainedNextAssetRewrites('production')).toEqual([]);
  });

  it.each([undefined, '1'])('checks the filesystem before the retained redirect with web flag %s', async (webFlag) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_RETAINED_NEXT_ASSETS', '1');
    vi.stubEnv('BOARDSESH_WEB', webFlag);
    vi.stubEnv('BOARDSESH_EXPO_WEB_ORIGIN', undefined);
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');
    const config = configModule.default as unknown as {
      rewrites: () => Promise<{
        beforeFiles: Array<{ source: string }>;
        afterFiles: Array<{ source: string; destination: string }>;
      }>;
    };
    const rules = await config.rewrites();
    expect(rules.beforeFiles.some((rule) => rule.source.startsWith('/_next/static'))).toBe(false);
    expect(rules.afterFiles).toEqual([
      {
        source: '/_next/static/:assetPath+',
        destination: '/api/internal/retained-next-assets/:assetPath*',
      },
    ]);
  });
});

it('sets no-referrer at both retained redirect entrypoints after general headers', async () => {
  const config = configModule.default as unknown as {
    headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
  };
  const headers = await config.headers();
  for (const source of ['/_next/static/:assetPath*', '/api/internal/retained-next-assets/:assetPath*']) {
    const specific = headers.findIndex((entry) => entry.source === source);
    const defaults = headers.findIndex((entry) =>
      entry.headers.some(
        (header) => header.key === 'Referrer-Policy' && header.value === 'strict-origin-when-cross-origin',
      ),
    );
    expect(specific).toBeGreaterThan(defaults);
    expect(headers[specific].headers).toContainEqual({ key: 'Referrer-Policy', value: 'no-referrer' });
  }
});
