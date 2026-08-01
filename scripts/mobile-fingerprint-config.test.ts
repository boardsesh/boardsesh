import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type HookSource = { type: 'file'; filePath: string } | { type: 'contents'; id: string };
type HookChunk = Buffer | string | null;
type HashSource = {
  type: 'file' | 'dir';
  filePath: string;
  reasons: string[];
  overrideHashKey?: string;
};
type ExtraSource = HashSource & { overrideHashKey: string };
type FingerprintConfig = {
  extraSources: ExtraSource[];
  fileHookTransform(source: HookSource, chunk: HookChunk): HookChunk;
  __test: {
    AUTOLINKING_SOURCE_IDS: Set<string>;
    decodeBunStorePackageName(encodedPackageName: string): string;
    normalizeAutolinkingValue(value: unknown): unknown;
    normalizeTerminalBunPeerSuffixes(filePath: string): string;
  };
};
type FingerprintSource = {
  type: string;
  filePath?: string;
  reasons?: string[];
  overrideHashKey?: string;
  hash: string | null;
};
type FingerprintResult = { hash: string; sources: FingerprintSource[] };
type FingerprintApi = {
  DEFAULT_IGNORE_PATHS: string[];
};
type FingerprintHashApi = {
  createFingerprintFromSourcesAsync(
    sources: HashSource[],
    projectRoot: string,
    options: Record<string, unknown>,
  ): Promise<FingerprintResult>;
  createSourceId(source: HashSource | FingerprintSource): string;
};
type PatchedPathApi = {
  buildDirMatchObjects(matchObjects: unknown[]): unknown[];
  buildPathMatchObjects(paths: string[]): unknown[];
  isIgnoredPath(filePath: string, ignorePaths: string[]): boolean;
  normalizeBunIsolatedModulePath(filePath: string): string;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_ROOT = resolve(REPO_ROOT, 'packages/mobile');
const MOBILE_PACKAGE_JSON = resolve(MOBILE_ROOT, 'package.json');
const requireFromMobile = createRequire(MOBILE_PACKAGE_JSON);
const fingerprintConfig = requireFromMobile(resolve(MOBILE_ROOT, 'fingerprint.config.js')) as FingerprintConfig;
const fingerprintPackageJsonPath = requireFromMobile.resolve('@expo/fingerprint/package.json');
const fingerprintPackageRoot = dirname(fingerprintPackageJsonPath);
const fingerprintApi = requireFromMobile('@expo/fingerprint') as FingerprintApi;
const fingerprintHashApi = requireFromMobile(
  resolve(fingerprintPackageRoot, 'build/hash/Hash.js'),
) as FingerprintHashApi;
const patchedPathApi = requireFromMobile(resolve(fingerprintPackageRoot, 'build/utils/Path.js')) as PatchedPathApi;

const temporaryRoots: string[] = [];

function createTemporaryRoot(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'boardsesh-fingerprint-'));
  temporaryRoots.push(projectRoot);
  return projectRoot;
}

function writeFixtureFile(projectRoot: string, relativePath: string, contents: string): void {
  const absolutePath = resolve(projectRoot, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function createHashOptions(): Record<string, unknown> {
  const ignorePathMatchObjects = patchedPathApi.buildPathMatchObjects(fingerprintApi.DEFAULT_IGNORE_PATHS);
  return {
    concurrentIoLimit: 4,
    debug: false,
    enableReactImportsPatcher: false,
    fileHookTransform: undefined,
    hashAlgorithm: 'sha1',
    ignoreDirMatchObjects: patchedPathApi.buildDirMatchObjects(ignorePathMatchObjects),
    ignorePathMatchObjects,
  };
}

afterEach(() => {
  for (const projectRoot of temporaryRoots.splice(0)) rmSync(projectRoot, { recursive: true, force: true });
});

describe('mobile fingerprint config', () => {
  it('fails closed when a scoped store name lacks its encoded scope separator', () => {
    expect(fingerprintConfig.__test.decodeBunStorePackageName('@scope-name')).toBe('@scope-name');
    expect(fingerprintConfig.__test.decodeBunStorePackageName('@scope+name')).toBe('@scope/name');
  });

  it('normalizes matching package@version paths for exactly the four platform autolinking content ids', () => {
    expect([...fingerprintConfig.__test.AUTOLINKING_SOURCE_IDS].sort()).toEqual([
      'expoAutolinkingConfig:android',
      'expoAutolinkingConfig:ios',
      'rncoreAutolinkingConfig:android',
      'rncoreAutolinkingConfig:ios',
    ]);

    const input = JSON.stringify({
      modules: {
        paths: [
          '../../node_modules/.bun/expo@57.0.9-rc.2+aaaaaaaaaaaaaaaa/node_modules/expo/android',
          '../../node_modules/.bun/@expo+metro-runtime@57.0.8+build.20260801+bbbbbbbbbbbbbbbb/' +
            'node_modules/@expo/metro-runtime',
        ],
      },
      version: '57.0.9',
    });
    const expected = {
      modules: {
        paths: [
          '../../node_modules/.bun/expo@57.0.9-rc.2/node_modules/expo/android',
          '../../node_modules/.bun/@expo+metro-runtime@57.0.8+build.20260801/' + 'node_modules/@expo/metro-runtime',
        ],
      },
      version: '57.0.9',
    };

    for (const id of fingerprintConfig.__test.AUTOLINKING_SOURCE_IDS) {
      const transformed = fingerprintConfig.fileHookTransform({ type: 'contents', id }, input);
      expect(JSON.parse(String(transformed))).toEqual(expected);
    }
  });

  it('preserves build metadata before the final peer token and documents the terminal-hex boundary', () => {
    const buildMetadataThenPeer =
      '../../node_modules/.bun/native@1.2.3+abcdefabcdefabcd+bbbbbbbbbbbbbbbb/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(buildMetadataThenPeer)).toBe(
      '../../node_modules/.bun/native@1.2.3+abcdefabcdefabcd/node_modules/native/ios',
    );

    // A lone terminal 16-hex token has the same path shape whether it is Bun's
    // peer hash or SemVer build metadata. The hook deliberately treats this one
    // ambiguous terminal position as Bun's peer token; preceding metadata stays.
    const loneTerminalHex = '../../node_modules/.bun/native@1.2.3+abcdefabcdefabcd/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(loneTerminalHex)).toBe(
      '../../node_modules/.bun/native@1.2.3/node_modules/native/ios',
    );
  });

  it('does not normalize malformed, mismatched, non-terminal, or non-allowlisted paths', () => {
    const nonTerminal = '../../node_modules/.bun/expo@57.0.9+aaaaaaaaaaaaaaaa/cache/expo';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(nonTerminal)).toBe(nonTerminal);

    const malformedStoreEntry = '../../node_modules/.bun/cache-key+aaaaaaaaaaaaaaaa/node_modules/cache-key/native';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(malformedStoreEntry)).toBe(malformedStoreEntry);

    const nonSemverStoreEntry = '../../node_modules/.bun/native@latest+aaaaaaaaaaaaaaaa/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(nonSemverStoreEntry)).toBe(nonSemverStoreEntry);

    const offStoreBoundary = '../../cache/.bun/native@1.2.3+aaaaaaaaaaaaaaaa/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(offStoreBoundary)).toBe(offStoreBoundary);

    const leadingZeroPrerelease = '../../node_modules/.bun/native@1.2.3-01+aaaaaaaaaaaaaaaa/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(leadingZeroPrerelease)).toBe(
      leadingZeroPrerelease,
    );

    const leadingZeroPrereleaseSegment =
      '../../node_modules/.bun/native@1.2.3-alpha.01+aaaaaaaaaaaaaaaa/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(leadingZeroPrereleaseSegment)).toBe(
      leadingZeroPrereleaseSegment,
    );

    const mismatchedInstalledPackage =
      '../../node_modules/.bun/@scope+native@1.2.3+aaaaaaaaaaaaaaaa/node_modules/@scope/not-native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(mismatchedInstalledPackage)).toBe(
      mismatchedInstalledPackage,
    );

    const ordinaryBuildMetadata = '../../node_modules/.bun/native@1.2.3+build.20260801/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalBunPeerSuffixes(ordinaryBuildMetadata)).toBe(
      ordinaryBuildMetadata,
    );

    const serialized = JSON.stringify({ path: nonTerminal.replace('/cache/', '/node_modules/') });
    expect(fingerprintConfig.fileHookTransform({ type: 'contents', id: 'expoConfig' }, serialized)).toBe(serialized);
    expect(fingerprintConfig.fileHookTransform({ type: 'file', filePath: 'autolinking.json' }, serialized)).toBe(
      serialized,
    );

    const binaryChunk = Buffer.from(serialized);
    expect(
      fingerprintConfig.fileHookTransform({ type: 'contents', id: 'rncoreAutolinkingConfig:ios' }, binaryChunk),
    ).toBe(binaryChunk);
  });

  it('fails closed when an allowlisted autolinking source is not valid JSON', () => {
    expect(() =>
      fingerprintConfig.fileHookTransform({ type: 'contents', id: 'expoAutolinkingConfig:ios' }, 'not-json'),
    ).toThrow();
  });

  it('hashes the config itself and the monorepo root patches with stable keys', () => {
    expect(fingerprintConfig.extraSources).toEqual([
      {
        type: 'file',
        filePath: 'fingerprint.config.js',
        reasons: ['boardseshFingerprintConfig'],
        overrideHashKey: 'boardseshFingerprintConfig',
      },
      {
        type: 'dir',
        filePath: '../../patches',
        reasons: ['bunPatchedDependencies'],
        overrideHashKey: 'bunPatchedDependencies',
      },
    ]);
  });
});

describe('patched @expo/fingerprint Bun path handling', () => {
  it('collapses isolated store wrappers recursively but preserves genuine nested node_modules', () => {
    const bunPath =
      '../../node_modules/.bun/parent@1.0.0+aaaaaaaaaaaaaaaa/node_modules/parent/' +
      'node_modules/.bun/child@2.0.0+bbbbbbbbbbbbbbbb/node_modules/child/ios';
    expect(patchedPathApi.normalizeBunIsolatedModulePath(bunPath)).toBe(
      '../../node_modules/parent/node_modules/child/ios',
    );

    const nestedPath = '../../node_modules/parent/node_modules/child/ios';
    expect(patchedPathApi.normalizeBunIsolatedModulePath(nestedPath)).toBe(nestedPath);
  });

  it("unblocks Bun native dirs without weakening Expo's genuine nested-dependency ignore", () => {
    const nestedIgnore = ['**/node_modules/**/node_modules/**'];
    expect(
      patchedPathApi.isIgnoredPath(
        '../../node_modules/.bun/expo@57.0.9+aaaaaaaaaaaaaaaa/node_modules/expo/ios',
        nestedIgnore,
      ),
    ).toBe(false);
    expect(patchedPathApi.isIgnoredPath('../../node_modules/expo/node_modules/transitive/ios', nestedIgnore)).toBe(
      true,
    );
  });

  it('uses the production source id for stable peer variants and still hashes native body changes', async () => {
    const projectRoot = createTemporaryRoot();
    const firstPath = 'node_modules/.bun/native@1.0.0+aaaaaaaaaaaaaaaa/node_modules/native/ios';
    const secondPath = 'node_modules/.bun/native@1.0.0+bbbbbbbbbbbbbbbb/node_modules/native/ios';
    writeFixtureFile(projectRoot, `${firstPath}/Native.m`, '@interface Native : NSObject\n@end\n');
    writeFixtureFile(projectRoot, `${secondPath}/Native.m`, '@interface Native : NSObject\n@end\n');

    const resolveFor = (filePath: string) =>
      fingerprintHashApi.createFingerprintFromSourcesAsync(
        [
          {
            type: 'dir',
            filePath,
            reasons: ['testNativeModule'],
          },
        ],
        projectRoot,
        createHashOptions(),
      );
    const [first, second] = await Promise.all([resolveFor(firstPath), resolveFor(secondPath)]);
    const firstNativeSource = first.sources.find((source) => source.filePath === firstPath);
    const secondNativeSource = second.sources.find((source) => source.filePath === secondPath);

    expect(firstNativeSource).not.toHaveProperty('overrideHashKey');
    expect(secondNativeSource).not.toHaveProperty('overrideHashKey');
    expect(firstNativeSource?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(secondNativeSource?.hash).toBe(firstNativeSource?.hash);
    expect(fingerprintHashApi.createSourceId(firstNativeSource!)).toBe('node_modules/native/ios');
    expect(fingerprintHashApi.createSourceId(secondNativeSource!)).toBe('node_modules/native/ios');
    expect(second.hash).toBe(first.hash);

    writeFixtureFile(projectRoot, `${secondPath}/Native.m`, '@interface NativeV2 : NSObject\n@end\n');
    const changed = await resolveFor(secondPath);
    const changedNativeSource = changed.sources.find((source) => source.filePath === secondPath);

    expect(changedNativeSource?.hash).not.toBe(firstNativeSource?.hash);
    expect(fingerprintHashApi.createSourceId(changedNativeSource!)).toBe('node_modules/native/ios');
    expect(changed.hash).not.toBe(first.hash);
  });

  it('changes the fingerprint when either the config or a root patch body changes', async () => {
    async function fixtureFingerprint(configMarker: string, patchBody: string): Promise<string> {
      const projectRoot = createTemporaryRoot();
      writeFixtureFile(
        projectRoot,
        'fingerprint.config.js',
        `// ${configMarker}\nmodule.exports = { extraSources: [` +
          `{ type: 'file', filePath: 'fingerprint.config.js', reasons: ['config'], overrideHashKey: 'config' },` +
          `{ type: 'dir', filePath: 'patches', reasons: ['patches'], overrideHashKey: 'patches' }` +
          `] };\n`,
      );
      writeFixtureFile(projectRoot, 'patches/native.patch', patchBody);
      return (
        await fingerprintHashApi.createFingerprintFromSourcesAsync(
          [
            {
              type: 'file',
              filePath: 'fingerprint.config.js',
              reasons: ['config'],
              overrideHashKey: 'config',
            },
            {
              type: 'dir',
              filePath: 'patches',
              reasons: ['patches'],
              overrideHashKey: 'patches',
            },
          ],
          projectRoot,
          createHashOptions(),
        )
      ).hash;
    }

    const baseline = await fixtureFingerprint('config-v1', 'native patch v1\n');
    const configChanged = await fixtureFingerprint('config-v2', 'native patch v1\n');
    const patchChanged = await fixtureFingerprint('config-v1', 'native patch v2\n');

    expect(configChanged).not.toBe(baseline);
    expect(patchChanged).not.toBe(baseline);
  });
});

describe('@expo/fingerprint resolver parity', () => {
  it('exact-pins and patches the same installation loaded by expo/fingerprint', () => {
    const mobilePackage = JSON.parse(readFileSync(MOBILE_PACKAGE_JSON, 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    const rootPackage = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      patchedDependencies?: Record<string, string>;
    };
    const installedPackage = JSON.parse(readFileSync(fingerprintPackageJsonPath, 'utf8')) as { version?: string };
    const expoPackageJsonPath = requireFromMobile.resolve('expo/package.json');
    const requireFromExpo = createRequire(expoPackageJsonPath);
    const expoFingerprintPath = requireFromExpo.resolve('@expo/fingerprint/package.json');

    expect(mobilePackage.devDependencies?.['@expo/fingerprint']).toBe('0.20.6');
    expect(rootPackage.patchedDependencies?.['@expo/fingerprint@0.20.6']).toBe(
      'patches/@expo%2Ffingerprint@0.20.6.patch',
    );
    expect(installedPackage.version).toBe('0.20.6');
    expect(realpathSync(expoFingerprintPath)).toBe(realpathSync(fingerprintPackageJsonPath));
    expect(readFileSync(resolve(dirname(expoPackageJsonPath), 'fingerprint.js'), 'utf8').trim()).toBe(
      "module.exports = require('@expo/fingerprint');",
    );
  });
});
