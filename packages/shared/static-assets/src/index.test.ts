import { describe, expect, it } from 'vitest';
import { STATIC_ASSET_OBJECT_KEYS, getStaticAssetObjectKey } from './index';

describe('static asset catalog', () => {
  it('exposes compact content-addressed object keys', () => {
    expect(getStaticAssetObjectKey('/brand/boardsesh-mark.png')).toMatch(/^static\/v1\/[a-f0-9]{64}\.png$/);
  });

  it('contains only immutable object keys', () => {
    for (const [logicalPath, objectKey] of Object.entries(STATIC_ASSET_OBJECT_KEYS)) {
      expect(logicalPath).toMatch(/^\//);
      expect(objectKey).toMatch(/^static\/v1\/[a-f0-9]{64}\.(?:ico|png|webp)$/);
    }
  });

  it('returns undefined for an uncatalogued path', () => {
    expect(getStaticAssetObjectKey('/missing.webp')).toBeUndefined();
  });
});
