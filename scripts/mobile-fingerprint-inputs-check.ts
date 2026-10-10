/// <reference types="node" />

/**
 * Verifies the real expo-updates runtimeVersion resolver sees every Boardsesh
 * fingerprint hardening input. This catches regressions that unit tests cannot:
 * a changed Expo source id, a dropped package patch, or an extraSources path that no
 * longer resolves would otherwise produce a valid-looking hash with missing
 * native coverage.
 *
 * Usage: vp run check:mobile-fingerprint-inputs
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseResolverOutput } from './lib/mobile-runtime-version';

export { parseResolverOutput } from './lib/mobile-runtime-version';

export type Platform = 'ios' | 'android';

export interface FingerprintSource {
  type?: unknown;
  id?: unknown;
  filePath?: unknown;
  overrideHashKey?: unknown;
  hash?: unknown;
  contents?: unknown;
  reasons?: unknown;
}

const AUTOLINKING_REASON_BY_PLATFORM: Record<Platform, Set<string>> = {
  ios: new Set(['expoAutolinkingIos', 'rncoreAutolinkingIos']),
  android: new Set(['expoAutolinkingAndroid', 'rncoreAutolinkingAndroid']),
};

function hasAutolinkingReason(source: FingerprintSource, platform: Platform): boolean {
  return (
    Array.isArray(source.reasons) &&
    source.reasons.some((reason) => typeof reason === 'string' && AUTOLINKING_REASON_BY_PLATFORM[platform].has(reason))
  );
}

function parseHashedExpoConfig(contents: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(contents);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readNestedField(parent: unknown, fieldName: string): unknown {
  return typeof parent === 'object' && parent !== null ? (parent as Record<string, unknown>)[fieldName] : undefined;
}

/** Pure invariant check for one resolver result. Empty means complete coverage. */
export function validateFingerprintSources(platform: Platform, sources: readonly FingerprintSource[]): string[] {
  const errors: string[] = [];
  const expectedContentsIds = [`expoAutolinkingConfig:${platform}`, `rncoreAutolinkingConfig:${platform}`];

  for (const id of expectedContentsIds) {
    const matches = sources.filter((source) => source.type === 'contents' && source.id === id);
    if (matches.length !== 1) {
      errors.push(`${platform}: expected exactly one ${id} contents source, found ${matches.length}`);
    } else if (typeof matches[0]?.hash !== 'string') {
      errors.push(`${platform}: ${id} has a null hash`);
    }
  }

  const nativeDirectories = sources.filter((source) => source.type === 'dir' && hasAutolinkingReason(source, platform));
  if (nativeDirectories.length === 0) {
    errors.push(`${platform}: no autolinked native directory sources were discovered`);
  }
  const nullNativeDirectories = nativeDirectories.filter((source) => typeof source.hash !== 'string');
  if (nullNativeDirectories.length > 0) {
    const examples = nullNativeDirectories
      .slice(0, 3)
      .map((source) => String(source.filePath))
      .join(', ');
    errors.push(
      `${platform}: ${nullNativeDirectories.length}/${nativeDirectories.length} autolinked native directories ` +
        `have null hashes (for example: ${examples})`,
    );
  }

  // fingerprint.config.js skips ExpoConfigVersions so a marketing-version bump
  // alone keeps runtimeVersion still. If the skip stopped applying (a typo is
  // ignored silently), the hashed Expo config would carry these fields again
  // and every release bump would cut installed binaries off from OTAs.
  for (const source of sources) {
    if (source.type !== 'contents' || source.id !== 'expoConfig' || typeof source.contents !== 'string') continue;
    const hashedConfig = parseHashedExpoConfig(source.contents);
    if (hashedConfig === null) {
      errors.push(`${platform}: expoConfig contents source is not a JSON object`);
      continue;
    }
    const versionFields = [
      ['version', hashedConfig.version],
      ['ios.buildNumber', readNestedField(hashedConfig.ios, 'buildNumber')],
      ['android.versionCode', readNestedField(hashedConfig.android, 'versionCode')],
    ] as const;
    for (const [fieldName, fieldValue] of versionFields) {
      if (fieldValue !== undefined) {
        errors.push(
          `${platform}: expoConfig still hashes ${fieldName}; the ExpoConfigVersions skip in fingerprint.config.js is not applied`,
        );
      }
    }
  }

  // Config plugins that carry a NATIVE guarantee in their file body rather than
  // in the config they emit. with-android-minify.js holds the R8 keep rules; if
  // its contents stopped being hashed, editing a keep rule would leave the
  // runtimeVersion untouched, the native gate would skip the rebuild, and the fix
  // would never reach a binary. Verified shape: @expo/fingerprint records local
  // plugins as `{ type: 'file', filePath, reasons: ['expoConfigPlugins'] }`.
  const expectedPluginSources = ['plugins/with-android-minify.js', 'plugins/with-android-sentry-proguard-uuid.js'];
  for (const filePath of expectedPluginSources) {
    const matches = sources.filter(
      (source) =>
        source.type === 'file' &&
        source.filePath === filePath &&
        Array.isArray(source.reasons) &&
        source.reasons.includes('expoConfigPlugins'),
    );
    if (matches.length !== 1) {
      errors.push(
        `${platform}: expected exactly one expoConfigPlugins source for ${filePath}, found ${matches.length}`,
      );
    } else if (typeof matches[0]?.hash !== 'string') {
      errors.push(`${platform}: ${filePath} has a null hash`);
    }
  }

  const expectedExtraSources = [
    {
      overrideHashKey: 'boardseshFingerprintConfig',
      type: 'file',
      filePath: 'fingerprint.config.js',
    },
    {
      // Required on BOTH platforms despite the iOS-sounding name. The files are
      // iOS-only in effect (Expo turns them into <lang>.lproj/InfoPlist.strings;
      // Android takes nothing from them), but they're referenced by app.config.ts,
      // which is shared — so both fingerprints must track their contents or an
      // Android OTA could ship against a config the binary never had. An
      // "android: expected exactly one iosInfoPlistLocales source" failure is
      // therefore real, not a platform mix-up.
      overrideHashKey: 'iosInfoPlistLocales',
      type: 'dir',
      filePath: 'locales',
    },
    {
      overrideHashKey: 'rootPatchedDependencies',
      type: 'dir',
      filePath: '../../patches',
    },
  ];
  for (const expected of expectedExtraSources) {
    const matches = sources.filter(
      (source) =>
        source.overrideHashKey === expected.overrideHashKey &&
        source.type === expected.type &&
        source.filePath === expected.filePath,
    );
    if (matches.length !== 1) {
      errors.push(`${platform}: expected exactly one ${expected.overrideHashKey} source, found ${matches.length}`);
    } else if (typeof matches[0]?.hash !== 'string') {
      errors.push(`${platform}: ${expected.overrideHashKey} has a null hash`);
    }
  }

  return errors;
}

function resolveFingerprintSources(mobileRoot: string, platform: Platform): FingerprintSource[] {
  const childEnv = { ...process.env };
  if (platform === 'ios') delete childEnv.GOOGLE_MAPS_API_KEY;
  const stdout = execFileSync('vp', ['exec', 'expo-updates', 'runtimeversion:resolve', '--platform', platform], {
    cwd: mobileRoot,
    encoding: 'utf8',
    env: childEnv,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const parsed = parseResolverOutput(stdout);
  if (typeof parsed.runtimeVersion !== 'string' || !Array.isArray(parsed.fingerprintSources)) {
    throw new Error(`${platform}: resolver returned no runtimeVersion/fingerprintSources`);
  }
  return parsed.fingerprintSources as FingerprintSource[];
}

export function main(): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const mobileRoot = resolve(repoRoot, 'packages/mobile');
  const errors: string[] = [];

  for (const platform of ['ios', 'android'] as const) {
    try {
      const sources = resolveFingerprintSources(mobileRoot, platform);
      const platformErrors = validateFingerprintSources(platform, sources);
      errors.push(...platformErrors);
      if (platformErrors.length === 0) {
        const nativeDirectoryCount = sources.filter(
          (source) => source.type === 'dir' && hasAutolinkingReason(source, platform),
        ).length;
        console.log(
          `[mobile-fingerprint-inputs] ${platform}: ${nativeDirectoryCount} autolinked native dirs + config + patches hashed.`,
        );
      }
    } catch (error) {
      errors.push(`${platform}: resolver failed (${(error as Error).message})`);
    }
  }

  if (errors.length > 0) {
    console.error('[mobile-fingerprint-inputs] FAILED:');
    for (const error of errors) console.error(`  ✗ ${error}`);
    return 1;
  }
  console.log('[mobile-fingerprint-inputs] OK — fingerprint inputs are complete on both platforms.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
