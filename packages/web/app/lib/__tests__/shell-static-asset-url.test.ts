import { describe, expect, it } from 'vitest';
import { STATIC_SHELL_ASSET_OBJECT_KEYS } from '@boardsesh/static-assets/shell';
import { resolveShellStaticAssetUrl } from '../shell-static-asset-url';

describe('resolveShellStaticAssetUrl', () => {
  it('keeps shell images local outside production', () => {
    expect(resolveShellStaticAssetUrl('/brand/boardsesh-mark.png', '')).toBe('/brand/boardsesh-mark.png');
  });

  it('uses the tiny shell catalog in production', () => {
    expect(resolveShellStaticAssetUrl('/favicon.ico', 'https://assets.boardsesh.com/')).toBe(
      `https://assets.boardsesh.com/${STATIC_SHELL_ASSET_OBJECT_KEYS['/favicon.ico']}`,
    );
  });

  it('fails closed for an invalid production path', () => {
    expect(() => resolveShellStaticAssetUrl('/images/missing.webp' as never, 'https://assets.boardsesh.com')).toThrow(
      'Static shell asset is missing from the generated catalog: /images/missing.webp',
    );
  });
});
