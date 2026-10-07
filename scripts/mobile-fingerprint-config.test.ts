import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

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
  sourceSkips: string[];
  fileHookTransform(source: HookSource, chunk: HookChunk): HookChunk;
  __test: {
    AUTOLINKING_SOURCE_IDS: Set<string>;
    decodeStorePackageName(encodedPackageName: string): string;
    normalizeAutolinkingValue(value: unknown): unknown;
    normalizeTerminalStorePeerSuffixes(filePath: string): string;
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
type FingerprintSourceSkips = Record<string, string | number>;
type FingerprintConfigApi = {
  loadConfigAsync(projectRoot: string, silent?: boolean): Promise<{ sourceSkips?: number } | null>;
  normalizeSourceSkips(sourceSkips: unknown): number;
};
type FingerprintOptionsApi = {
  DEFAULT_SOURCE_SKIPS: number;
  normalizeOptionsAsync(projectRoot: string, options?: Record<string, unknown>): Promise<{ sourceSkips: number }>;
};
type ContentsSource = { type: 'contents'; id: string; contents: string; reasons: string[] };
type ExpoSourcerApi = {
  getExpoConfigSourcesAsync(
    projectRoot: string,
    config: { exp: Record<string, unknown> },
    loadedModules: string[] | null,
    options: { sourceSkips: number; platforms: string[] },
  ): Promise<ContentsSource[]>;
};
type FingerprintHashApi = {
  createFingerprintFromSourcesAsync(
    sources: Array<HashSource | ContentsSource>,
    projectRoot: string,
    options: Record<string, unknown>,
  ): Promise<FingerprintResult>;
  createSourceId(source: HashSource | FingerprintSource): string;
};
type PatchedPathApi = {
  buildDirMatchObjects(matchObjects: unknown[]): unknown[];
  buildPathMatchObjects(paths: string[]): unknown[];
  isIgnoredPath(filePath: string, ignorePaths: string[]): boolean;
  normalizeIsolatedStoreModulePath(filePath: string): string;
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
const fingerprintConfigApi = requireFromMobile(
  resolve(fingerprintPackageRoot, 'build/Config.js'),
) as FingerprintConfigApi;
const fingerprintOptionsApi = requireFromMobile(
  resolve(fingerprintPackageRoot, 'build/Options.js'),
) as FingerprintOptionsApi;
const expoSourcerApi = requireFromMobile(resolve(fingerprintPackageRoot, 'build/sourcer/Expo.js')) as ExpoSourcerApi;
const { SourceSkips } = requireFromMobile(resolve(fingerprintPackageRoot, 'build/sourcer/SourceSkips.js')) as {
  SourceSkips: FingerprintSourceSkips;
};

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
    expect(fingerprintConfig.__test.decodeStorePackageName('@scope-name')).toBe('@scope-name');
    expect(fingerprintConfig.__test.decodeStorePackageName('@scope+name')).toBe('@scope/name');
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
          '../../node_modules/.pnpm/expo@57.0.9-rc.2_react@19.2.3_react-native@0.86.3/node_modules/expo/android',
          '../../node_modules/.pnpm/@expo+metro-runtime@57.0.8+build.20260801_react@19.2.3/' +
            'node_modules/@expo/metro-runtime',
        ],
      },
      version: '57.0.9',
    });
    const expected = {
      modules: {
        paths: [
          '../../node_modules/.pnpm/expo@57.0.9-rc.2/node_modules/expo/android',
          '../../node_modules/.pnpm/@expo+metro-runtime@57.0.8+build.20260801/' + 'node_modules/@expo/metro-runtime',
        ],
      },
      version: '57.0.9',
    };

    for (const id of fingerprintConfig.__test.AUTOLINKING_SOURCE_IDS) {
      const transformed = fingerprintConfig.fileHookTransform({ type: 'contents', id }, input);
      expect(JSON.parse(String(transformed))).toEqual(expected);
    }
  });

  it('keeps the patch marker and SemVer build metadata while dropping the peer tail', () => {
    const buildMetadataThenPeers =
      '../../node_modules/.pnpm/native@1.2.3+build.20260801_react@19.2.3/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(buildMetadataThenPeers)).toBe(
      '../../node_modules/.pnpm/native@1.2.3+build.20260801/node_modules/native/ios',
    );

    const patchedThenPeers =
      '../../node_modules/.pnpm/@expo+ui@57.0.14_patch_hash=ab12cd_react@19.2.3/node_modules/@expo/ui/ios';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(patchedThenPeers)).toBe(
      '../../node_modules/.pnpm/@expo+ui@57.0.14_patch_hash=ab12cd/node_modules/@expo/ui/ios',
    );

    // Long entries are truncated and end in a digest. It is part of the peer
    // tail, while the patch marker remains stable.
    const truncatedEntry =
      '../../node_modules/.pnpm/@expo+fingerprint@0.20.11_patch_hash=d541ef86_90fdc4dc921dac98343faa86434b2c09/' +
      'node_modules/@expo/fingerprint/build';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(truncatedEntry)).toBe(
      '../../node_modules/.pnpm/@expo+fingerprint@0.20.11_patch_hash=d541ef86/node_modules/@expo/fingerprint/build',
    );
  });

  it('does not normalize malformed, mismatched, non-terminal, or non-allowlisted paths', () => {
    const nonTerminal = '../../node_modules/.pnpm/expo@57.0.9_react@19.2.3/cache/expo';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(nonTerminal)).toBe(nonTerminal);

    const malformedStoreEntry = '../../node_modules/.pnpm/cache-key_react@19.2.3/node_modules/cache-key/native';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(malformedStoreEntry)).toBe(malformedStoreEntry);

    const nonSemverStoreEntry = '../../node_modules/.pnpm/native@latest_react@19.2.3/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(nonSemverStoreEntry)).toBe(nonSemverStoreEntry);

    const offStoreBoundary = '../../cache/.pnpm/native@1.2.3_react@19.2.3/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(offStoreBoundary)).toBe(offStoreBoundary);

    const leadingZeroPrerelease = '../../node_modules/.pnpm/native@1.2.3-01_react@19.2.3/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(leadingZeroPrerelease)).toBe(
      leadingZeroPrerelease,
    );

    const leadingZeroPrereleaseSegment =
      '../../node_modules/.pnpm/native@1.2.3-alpha.01_react@19.2.3/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(leadingZeroPrereleaseSegment)).toBe(
      leadingZeroPrereleaseSegment,
    );

    const mismatchedInstalledPackage =
      '../../node_modules/.pnpm/@scope+native@1.2.3_react@19.2.3/node_modules/@scope/not-native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(mismatchedInstalledPackage)).toBe(
      mismatchedInstalledPackage,
    );

    const ordinaryBuildMetadata = '../../node_modules/.pnpm/native@1.2.3+build.20260801/node_modules/native/ios';
    expect(fingerprintConfig.__test.normalizeTerminalStorePeerSuffixes(ordinaryBuildMetadata)).toBe(
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

  it('hashes the config itself, the iOS locale strings and the monorepo root patches with stable keys', () => {
    expect(fingerprintConfig.extraSources).toEqual([
      {
        type: 'file',
        filePath: 'fingerprint.config.js',
        reasons: ['boardseshFingerprintConfig'],
        overrideHashKey: 'boardseshFingerprintConfig',
      },
      {
        type: 'dir',
        filePath: 'locales',
        reasons: ['iosInfoPlistLocales'],
        overrideHashKey: 'iosInfoPlistLocales',
      },
      {
        type: 'dir',
        filePath: '../../patches',
        reasons: ['rootPatchedDependencies'],
        overrideHashKey: 'rootPatchedDependencies',
      },
    ]);
  });
});

describe('mobile fingerprint source skips', () => {
  // Resolved Expo config for the fixture. Only fields with no external file
  // behind them, so the sourcer returns the single `expoConfig` contents source.
  function expoConfigFixture(overrides: {
    version?: string;
    buildNumber?: string;
    versionCode?: number;
    bundleIdentifier?: string;
  }): { exp: Record<string, unknown> } {
    return {
      exp: {
        name: 'Boardsesh',
        slug: 'boardsesh',
        version: overrides.version ?? '2.6.0',
        ios: {
          bundleIdentifier: overrides.bundleIdentifier ?? 'com.boardsesh.app',
          buildNumber: overrides.buildNumber ?? '100',
        },
        android: { package: 'com.boardsesh.app', versionCode: overrides.versionCode ?? 100 },
      },
    };
  }

  async function expoConfigFingerprint(
    sourceSkips: number,
    overrides: Parameters<typeof expoConfigFixture>[0],
  ): Promise<string> {
    const projectRoot = createTemporaryRoot();
    const sources = await expoSourcerApi.getExpoConfigSourcesAsync(projectRoot, expoConfigFixture(overrides), null, {
      sourceSkips,
      platforms: ['android', 'ios'],
    });
    expect(sources.map((source) => source.id)).toEqual(['expoConfig']);
    return (await fingerprintHashApi.createFingerprintFromSourcesAsync(sources, projectRoot, createHashOptions())).hash;
  }

  it('skips the config versions and re-states the default skip it would otherwise replace', () => {
    expect(fingerprintConfig.sourceSkips).toEqual([
      'ExpoConfigVersions',
      'PackageJsonAndroidAndIosScriptsIfNotContainRun',
    ]);
  });

  it('names only real SourceSkips members, because the loader ignores an unknown name without an error', () => {
    for (const skipName of fingerprintConfig.sourceSkips) {
      expect(typeof SourceSkips[skipName], `"${skipName}" is not a key of the installed SourceSkips enum`).toBe(
        'number',
      );
    }
    // The failure this guards against: a typo resolves to "skip nothing".
    expect(fingerprintConfigApi.normalizeSourceSkips(['ExpoConfigVersion'])).toBe(0);
  });

  it('resolves to bitmask 513 through the real config loader and option merge', async () => {
    expect(fingerprintConfigApi.normalizeSourceSkips(fingerprintConfig.sourceSkips)).toBe(513);
    expect(fingerprintOptionsApi.DEFAULT_SOURCE_SKIPS).toBe(512);

    const loadedConfig = await fingerprintConfigApi.loadConfigAsync(MOBILE_ROOT, true);
    expect(loadedConfig?.sourceSkips).toBe(513);

    // normalizeOptionsAsync spreads the config over the default, so this is the
    // value the resolver actually hashes with. 513 & 512 proves the default
    // package.json-scripts skip survived being replaced.
    const normalizedOptions = await fingerprintOptionsApi.normalizeOptionsAsync(MOBILE_ROOT, { silent: true });
    expect(normalizedOptions.sourceSkips).toBe(513);
    expect(normalizedOptions.sourceSkips & fingerprintOptionsApi.DEFAULT_SOURCE_SKIPS).toBe(512);
  });

  it('keeps the hash still for a version or build-number bump and moves it for a real native input', async () => {
    const configuredSkips = fingerprintConfigApi.normalizeSourceSkips(fingerprintConfig.sourceSkips);

    const baseline = await expoConfigFingerprint(configuredSkips, {});
    expect(await expoConfigFingerprint(configuredSkips, { version: '2.6.1' })).toBe(baseline);
    expect(await expoConfigFingerprint(configuredSkips, { buildNumber: '101', versionCode: 101 })).toBe(baseline);
    expect(await expoConfigFingerprint(configuredSkips, { bundleIdentifier: 'com.boardsesh.other' })).not.toBe(
      baseline,
    );

    // Control: under @expo/fingerprint's default the same version bump DOES move
    // the hash, so the equality above is the skip working, not a blind fixture.
    const defaultSkips = fingerprintOptionsApi.DEFAULT_SOURCE_SKIPS;
    expect(await expoConfigFingerprint(defaultSkips, { version: '2.6.1' })).not.toBe(
      await expoConfigFingerprint(defaultSkips, {}),
    );
  });
});

describe('patched @expo/fingerprint isolated-store path handling', () => {
  it('collapses isolated store wrappers recursively but preserves genuine nested node_modules', () => {
    const isolatedStorePath =
      '../../node_modules/.pnpm/parent@1.0.0_react@19.2.3/node_modules/parent/' +
      'node_modules/.pnpm/child@2.0.0_react@19.2.3/node_modules/child/ios';
    expect(patchedPathApi.normalizeIsolatedStoreModulePath(isolatedStorePath)).toBe(
      '../../node_modules/parent/node_modules/child/ios',
    );

    const nestedPath = '../../node_modules/parent/node_modules/child/ios';
    expect(patchedPathApi.normalizeIsolatedStoreModulePath(nestedPath)).toBe(nestedPath);

    const hoistedCompatDir = 'node_modules/.pnpm/node_modules/xcode';
    expect(patchedPathApi.normalizeIsolatedStoreModulePath(hoistedCompatDir)).toBe(hoistedCompatDir);
  });

  it("unblocks store-wrapped native dirs without weakening Expo's genuine nested-dependency ignore", () => {
    const nestedIgnore = ['**/node_modules/**/node_modules/**'];
    expect(
      patchedPathApi.isIgnoredPath(
        '../../node_modules/.pnpm/expo@57.0.9_react@19.2.3/node_modules/expo/ios',
        nestedIgnore,
      ),
    ).toBe(false);
    expect(patchedPathApi.isIgnoredPath('../../node_modules/expo/node_modules/transitive/ios', nestedIgnore)).toBe(
      true,
    );
  });

  it('uses the production source id for stable peer variants and still hashes native body changes', async () => {
    const projectRoot = createTemporaryRoot();
    const firstPath = 'node_modules/.pnpm/native@1.0.0_react@19.2.3/node_modules/native/ios';
    const secondPath = 'node_modules/.pnpm/native@1.0.0_react@19.2.8/node_modules/native/ios';
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
    const workspaceManifest = parseYaml(readFileSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')) as {
      patchedDependencies?: Record<string, string>;
    };
    const installedPackage = JSON.parse(readFileSync(fingerprintPackageJsonPath, 'utf8')) as { version?: string };
    const expoPackageJsonPath = requireFromMobile.resolve('expo/package.json');
    const requireFromExpo = createRequire(expoPackageJsonPath);
    const expoFingerprintPath = requireFromExpo.resolve('@expo/fingerprint/package.json');

    expect(mobilePackage.devDependencies?.['@expo/fingerprint']).toBe('0.20.11');
    expect(workspaceManifest.patchedDependencies?.['@expo/fingerprint@0.20.11']).toBe(
      'patches/@expo__fingerprint@0.20.11.patch',
    );
    expect(installedPackage.version).toBe('0.20.11');
    expect(realpathSync(expoFingerprintPath)).toBe(realpathSync(fingerprintPackageJsonPath));
    expect(readFileSync(resolve(dirname(expoPackageJsonPath), 'fingerprint.js'), 'utf8').trim()).toBe(
      "module.exports = require('@expo/fingerprint');",
    );
  });
});
