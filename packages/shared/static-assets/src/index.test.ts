import { describe, expect, it } from 'vitest';
import {
  STATIC_ASSET_MANIFEST,
  STATIC_ASSET_ORIGIN,
  getStaticAsset,
  getStaticAssetUrl,
  requireStaticAsset,
  requireStaticAssetUrl,
} from './index';

describe('static asset catalog', () => {
  it('exposes content-addressed immutable records', () => {
    const asset = requireStaticAsset('/brand/boardsesh-mark.png');

    expect(asset.logicalPath).toBe('/brand/boardsesh-mark.png');
    expect(asset.objectKey).toMatch(/^static\/v1\/[a-f0-9]{64}\.png$/);
    expect(asset.sha256).toHaveLength(64);
    expect(asset.contentType).toBe('image/png');
    expect(asset.bytes).toBeGreaterThan(0);
    expect(asset.nativeBundle).toBe(false);
    expect(requireStaticAssetUrl(asset.logicalPath)).toBe(`${STATIC_ASSET_ORIGIN}/${asset.objectKey}`);
  });

  it('marks only board WebPs for native wrapper bundling', () => {
    for (const asset of Object.values(STATIC_ASSET_MANIFEST)) {
      expect(asset.nativeBundle).toBe(asset.logicalPath.startsWith('/images/') && asset.logicalPath.endsWith('.webp'));
    }
  });

  it('provides optional and throwing lookups', () => {
    expect(getStaticAsset('/missing.webp')).toBeUndefined();
    expect(getStaticAssetUrl('/missing.webp')).toBeUndefined();
    expect(() => requireStaticAsset('/missing.webp')).toThrow('Static asset is not cataloged');
  });
});
