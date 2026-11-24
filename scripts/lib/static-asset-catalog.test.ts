import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createStaticAssetRecord,
  discoverStaticAssetSources,
  renderStaticAssetJson,
  renderStaticAssetObjectKeyCatalogJson,
  renderStaticAssetShellTypeScript,
  renderStaticAssetMarketingTypeScript,
} from './static-asset-catalog';

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

  it('renders deterministic upload, runtime, and shell catalogs', () => {
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
    expect(renderStaticAssetObjectKeyCatalogJson(reverseManifest)).toBe(
      renderStaticAssetObjectKeyCatalogJson(forwardManifest),
    );
    expect(JSON.parse(renderStaticAssetObjectKeyCatalogJson(forwardManifest))).toEqual({
      '/favicon.ico': faviconRecord.objectKey,
      '/icon.png': iconRecord.objectKey,
    });
    expect(renderStaticAssetShellTypeScript(reverseManifest)).toBe(renderStaticAssetShellTypeScript(forwardManifest));
    expect(renderStaticAssetShellTypeScript(forwardManifest)).toContain('satisfies StaticAssetObjectKeyCatalog');
  });

  it('gives a help clip its video content type and keeps the extension in the object key', () => {
    const mp4 = createStaticAssetRecord(
      {
        logicalPath: '/videos/help/hold-filter-paint.mp4',
        sourcePath: 'packages/web/public/videos/help/hold-filter-paint.mp4',
        nativeBundle: true,
      },
      Buffer.from('mp4'),
    );
    const webm = createStaticAssetRecord(
      {
        logicalPath: '/videos/help/hold-filter-paint.webm',
        sourcePath: 'packages/web/public/videos/help/hold-filter-paint.webm',
        nativeBundle: true,
      },
      Buffer.from('webm'),
    );

    expect(mp4.contentType).toBe('video/mp4');
    expect(webm.contentType).toBe('video/webm');
    expect(mp4.objectKey).toMatch(/^static\/v1\/[a-f0-9]{64}\.mp4$/);
    expect(webm.objectKey).toMatch(/^static\/v1\/[a-f0-9]{64}\.webm$/);
  });

  it('refuses an extension nothing is allowed to serve', () => {
    expect(() =>
      createStaticAssetRecord(
        {
          logicalPath: '/videos/help/raw.mov',
          sourcePath: 'packages/web/public/videos/help/raw.mov',
          nativeBundle: true,
        },
        Buffer.from('mov'),
      ),
    ).toThrow(/Unsupported static asset extension/);
  });

  it('keeps help clips out of the shell catalog, like the rest of the route-loaded art', () => {
    const clipRecord = createStaticAssetRecord(
      {
        logicalPath: '/videos/help/zone-filter-drag.webm',
        sourcePath: 'packages/web/public/videos/help/zone-filter-drag.webm',
        nativeBundle: true,
      },
      Buffer.from('clip'),
    );

    expect(renderStaticAssetShellTypeScript({ [clipRecord.logicalPath]: clipRecord })).not.toContain(
      clipRecord.logicalPath,
    );
  });

  it('keeps native board art out of the shell catalog', () => {
    const boardRecord = createStaticAssetRecord(
      {
        logicalPath: '/images/kilter/wall.webp',
        sourcePath: 'packages/web/public/images/kilter/wall.webp',
        nativeBundle: true,
      },
      Buffer.from('wall'),
    );

    expect(renderStaticAssetShellTypeScript({ [boardRecord.logicalPath]: boardRecord })).not.toContain(
      boardRecord.logicalPath,
    );
  });
});

/**
 * The runtime images `discoverStaticAssetSources` insists on. A fixture repo has
 * to carry them or discovery throws before it reaches what the test is about.
 */
const RUNTIME_IMAGE_PATHS = [
  'packages/web/public/brand/boardsesh-mark.webp',
  'packages/web/public/icons/apple-touch-icon.png',
  'packages/web/public/icons/icon-192.png',
  'packages/web/public/icons/icon-512.png',
  'packages/web/public/icons/icon-maskable-512.png',
  'packages/web/app/favicon.ico',
  'packages/web/app/icon.png',
];

function createFixtureRepo(files: readonly string[]): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'static-assets-'));
  for (const relativePath of [...RUNTIME_IMAGE_PATHS, ...files]) {
    const absolutePath = join(repoRoot, relativePath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, relativePath);
  }
  return repoRoot;
}

describe('static asset discovery', () => {
  it('catalogs both encodings of a help clip alongside its poster', () => {
    const repoRoot = createFixtureRepo([
      'packages/web/public/images/help/clips/hold-filter-paint.webp',
      'packages/web/public/videos/help/hold-filter-paint.mp4',
      'packages/web/public/videos/help/hold-filter-paint.webm',
    ]);

    const logicalPaths = discoverStaticAssetSources(repoRoot).map((source) => source.logicalPath);

    expect(logicalPaths).toContain('/images/help/clips/hold-filter-paint.webp');
    expect(logicalPaths).toContain('/videos/help/hold-filter-paint.mp4');
    expect(logicalPaths).toContain('/videos/help/hold-filter-paint.webm');
  });

  it('ignores the raw recording formats that must never ship', () => {
    const repoRoot = createFixtureRepo([
      'packages/web/public/videos/help/hold-filter-paint.mp4',
      'packages/web/public/videos/help/hold-filter-paint.mov',
    ]);

    const logicalPaths = discoverStaticAssetSources(repoRoot).map((source) => source.logicalPath);

    expect(logicalPaths).toContain('/videos/help/hold-filter-paint.mp4');
    expect(logicalPaths).not.toContain('/videos/help/hold-filter-paint.mov');
  });

  it('generates a catalog with no videos directory at all', () => {
    // Git cannot carry an empty directory, so a checkout with no clips yet has
    // no packages/web/public/videos. That must generate, not throw.
    const repoRoot = createFixtureRepo(['packages/web/public/images/help/discover.webp']);

    expect(() => discoverStaticAssetSources(repoRoot)).not.toThrow();
  });
});

describe('marketing asset catalog generation', () => {
  const record = (logicalPath: string, contents = logicalPath) =>
    createStaticAssetRecord(
      {
        logicalPath,
        sourcePath: `packages/web/public${logicalPath}`,
        nativeBundle: true,
      },
      Buffer.from(contents),
    );

  it('includes marketing captures and media while excluding unrelated board and help assets', () => {
    const included = [
      '/images/app/ios/queue.webp',
      '/images/app/android/es/queue.webp',
      '/images/home/showcase-hero-9x16.webp',
      '/videos/home/showcase-9x16-lite.webm',
      '/videos/home/showcase-9x16-lite.mp4',
      '/images/help/spray-wall-photo.webp',
    ];
    const excluded = ['/images/kilter/wall.webp', '/images/help/logbook.webp', '/videos/help/paint.webm'];
    const manifest = Object.fromEntries(
      [...included, ...excluded].map((logicalPath) => [logicalPath, record(logicalPath)]),
    );
    const generated = renderStaticAssetMarketingTypeScript(manifest);
    for (const logicalPath of included)
      expect(generated).toContain(`'${logicalPath}': '${manifest[logicalPath].objectKey}'`);
    for (const logicalPath of excluded) expect(generated).not.toContain(logicalPath);
  });
  it('stays deterministic and follows changed source bytes without handwritten hashes', () => {
    const queue = record('/images/app/ios/queue.webp');
    const poster = record('/images/home/showcase.webp');
    const first = { [queue.logicalPath]: queue, [poster.logicalPath]: poster };
    const reversed = { [poster.logicalPath]: poster, [queue.logicalPath]: queue };
    expect(renderStaticAssetMarketingTypeScript(first)).toBe(renderStaticAssetMarketingTypeScript(reversed));
    expect(
      renderStaticAssetMarketingTypeScript({ [queue.logicalPath]: record(queue.logicalPath, 'new capture') }),
    ).not.toContain(queue.objectKey);
  });
});
