import { describe, expect, it } from 'vitest';
import { createStaticAssetRecord, renderStaticAssetJson, renderStaticAssetTypeScript } from './static-asset-catalog';

describe('static asset catalog generation', () => {
  it('changes the immutable object key when bytes change in place', () => {
    const source = {
      logicalPath: '/images/kilter/wall.webp',
      sourcePath: 'packages/web/public/images/kilter/wall.webp',
      nativeBundle: true,
    };
    const before = createStaticAssetRecord(source, Buffer.from('before'));
    const after = createStaticAssetRecord(source, Buffer.from('aftEre'));

    expect(before.bytes).toBe(after.bytes);
    expect(before.objectKey).not.toBe(after.objectKey);
    expect(before.objectKey).toMatch(/^static\/v1\/[a-f0-9]{64}\.webp$/);
  });

  it('renders deterministic JSON and TypeScript catalogs', () => {
    const iconRecord = createStaticAssetRecord(
      { logicalPath: '/icon.png', sourcePath: 'packages/web/app/icon.png', nativeBundle: false },
      Buffer.from('icon'),
    );
    const faviconRecord = createStaticAssetRecord(
      { logicalPath: '/favicon.ico', sourcePath: 'packages/web/app/favicon.ico', nativeBundle: false },
      Buffer.from('favicon'),
    );
    const forwardManifest = { '/favicon.ico': faviconRecord, '/icon.png': iconRecord };
    const reverseManifest = { '/icon.png': iconRecord, '/favicon.ico': faviconRecord };

    expect(renderStaticAssetJson(reverseManifest)).toBe(renderStaticAssetJson(forwardManifest));
    expect(renderStaticAssetTypeScript(reverseManifest)).toBe(renderStaticAssetTypeScript(forwardManifest));
    expect(renderStaticAssetTypeScript(forwardManifest)).toContain('satisfies StaticAssetManifest');
  });
});
