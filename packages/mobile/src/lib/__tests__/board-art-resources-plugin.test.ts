import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

type AssetRecord = {
  logicalPath: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
  nativeBundle: boolean;
};

type BoardArtPlugin = {
  IOS_BUNDLE_NAME: string;
  ANDROID_ASSET_DIRECTORY: string;
  copyNativeBoardArt(options: {
    repoRoot: string;
    destinationRoot: string;
    manifest: Record<string, AssetRecord>;
  }): number;
  addIosResourceBundle(
    project: {
      hasFile(path: string): boolean;
      getFirstTarget(): { uuid: string };
    },
    projectName: string,
    addResourceFileToGroup: (options: {
      filepath: string;
      groupName: string;
      project: unknown;
      isBuildFile: boolean;
      targetUuid: string;
    }) => unknown,
  ): unknown;
};

const plugin = require('../../../plugins/with-board-art-resources.js') as BoardArtPlugin;
const temporaryRoots: string[] = [];

function makeFixture(contents = 'webp bytes'): {
  repoRoot: string;
  destinationRoot: string;
  record: AssetRecord;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), 'boardsesh-board-art-plugin-'));
  temporaryRoots.push(repoRoot);
  const logicalPath = '/images/kilter/example.webp';
  const sourcePath = join(repoRoot, 'packages/web/public/images/kilter/example.webp');
  mkdirSync(join(sourcePath, '..'), { recursive: true });
  writeFileSync(sourcePath, contents);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  return {
    repoRoot,
    destinationRoot: join(repoRoot, 'native-output'),
    record: {
      logicalPath,
      objectKey: `static/v1/${sha256}.webp`,
      sha256,
      bytes: Buffer.byteLength(contents),
      contentType: 'image/webp',
      nativeBundle: true,
    },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('with-board-art-resources', () => {
  it('copies nativeBundle WebPs under their content-addressed object key', () => {
    const fixture = makeFixture();
    const copied = plugin.copyNativeBoardArt({
      repoRoot: fixture.repoRoot,
      destinationRoot: fixture.destinationRoot,
      manifest: { [fixture.record.logicalPath]: fixture.record },
    });

    const copiedPath = join(fixture.destinationRoot, fixture.record.objectKey);
    expect(copied).toBe(1);
    expect(existsSync(copiedPath)).toBe(true);
    expect(readFileSync(copiedPath, 'utf8')).toBe('webp bytes');
  });

  it('fails closed when source bytes no longer match the catalog hash', () => {
    const fixture = makeFixture();
    fixture.record.sha256 = '0'.repeat(64);
    fixture.record.objectKey = `static/v1/${fixture.record.sha256}.webp`;
    expect(() =>
      plugin.copyNativeBoardArt({
        repoRoot: fixture.repoRoot,
        destinationRoot: fixture.destinationRoot,
        manifest: { [fixture.record.logicalPath]: fixture.record },
      }),
    ).toThrow('catalog is stale');
  });

  it('adds the iOS bundle to the main target once', () => {
    const addResourceFileToGroup = vi.fn((options) => options.project);
    const project = {
      hasFile: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      getFirstTarget: vi.fn(() => ({ uuid: 'main-target' })),
    };

    plugin.addIosResourceBundle(project, 'Boardsesh', addResourceFileToGroup);
    plugin.addIosResourceBundle(project, 'Boardsesh', addResourceFileToGroup);

    expect(addResourceFileToGroup).toHaveBeenCalledOnce();
    expect(addResourceFileToGroup).toHaveBeenCalledWith({
      filepath: `Boardsesh/${plugin.IOS_BUNDLE_NAME}`,
      groupName: 'Boardsesh',
      project,
      isBuildFile: true,
      targetUuid: 'main-target',
    });
  });
});
