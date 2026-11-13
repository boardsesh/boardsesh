import { describe, expect, it } from 'vite-plus/test';

const { resolveNextAssetPrefix } = await import('../../next.config.mjs');

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
