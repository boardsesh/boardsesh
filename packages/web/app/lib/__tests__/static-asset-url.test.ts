import { describe, expect, it } from 'vitest';
import { STATIC_ASSET_MANIFEST } from '@boardsesh/static-assets';
import { resolveStaticAssetUrl } from '../static-asset-url';

describe('resolveStaticAssetUrl', () => {
  it('keeps logical paths local when no production asset origin is configured', () => {
    expect(resolveStaticAssetUrl('brand/boardsesh-mark.png', '')).toBe('/brand/boardsesh-mark.png');
  });

  it('resolves catalog entries to immutable CDN keys', () => {
    const logicalPath = '/brand/boardsesh-mark.png';
    expect(resolveStaticAssetUrl(logicalPath, 'https://assets.boardsesh.com/')).toBe(
      `https://assets.boardsesh.com/${STATIC_ASSET_MANIFEST[logicalPath]?.objectKey}`,
    );
  });

  it('fails closed when a production build references an uncatalogued image', () => {
    expect(() => resolveStaticAssetUrl('/images/missing.webp', 'https://assets.boardsesh.com')).toThrow(
      'Static asset is missing from the generated catalog: /images/missing.webp',
    );
  });
});
