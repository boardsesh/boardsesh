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

export type Platform = 'ios' | 'android';

export interface FingerprintSource {
  type?: unknown;
  id?: unknown;
  filePath?: unknown;
  overrideHashKey?: unknown;
  hash?: unknown;
  reasons?: unknown;
}

interface RuntimeVersionResult {
  runtimeVersion?: unknown;
  fingerprintSources?: unknown;
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

function isRuntimeVersionResult(candidate: unknown): candidate is RuntimeVersionResult {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'runtimeVersion' in candidate &&
    typeof candidate.runtimeVersion === 'string' &&
    'fingerprintSources' in candidate &&
    Array.isArray(candidate.fingerprintSources)
  );
}

export function parseResolverOutput(stdout: string): RuntimeVersionResult {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRuntimeVersionResult(parsed)) return parsed;
  } catch {
    // Resolver wrappers may print diagnostics before or after the JSON payload.
  }

  type ObjectCandidate = {
    start: number;
    hasRuntimeVersionKey: boolean;
    hasFingerprintSourcesKey: boolean;
  };

  const objectCandidates: ObjectCandidate[] = [];
  let insideString = false;
  let escaped = false;
  let stringStart = -1;
  let pendingKey: { candidate: ObjectCandidate; name: 'runtimeVersion' | 'fingerprintSources' } | undefined;
  let matchedResult: RuntimeVersionResult | null = null;
  let remainingParseBudget = trimmed.length * 2;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];

    if (insideString) {
      if (character === '\n' || character === '\r') {
        // JSON strings cannot contain raw newlines. Recover from an unmatched
        // quote in a diagnostic without discarding balanced objects spanning
        // otherwise-valid pretty-printed JSON lines.
        insideString = false;
        escaped = false;
        stringStart = -1;
        pendingKey = undefined;
        objectCandidates.length = 0;
      } else if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
        const rawString = trimmed.slice(stringStart + 1, index);
        const candidate = objectCandidates.at(-1);
        if (candidate && (rawString === 'runtimeVersion' || rawString === 'fingerprintSources')) {
          pendingKey = { candidate, name: rawString };
        }
        stringStart = -1;
      }
      continue;
    }

    if (pendingKey) {
      if (/\s/.test(character)) continue;
      if (character === ':' && objectCandidates.at(-1) === pendingKey.candidate) {
        if (pendingKey.name === 'runtimeVersion') pendingKey.candidate.hasRuntimeVersionKey = true;
        else pendingKey.candidate.hasFingerprintSourcesKey = true;
      }
      pendingKey = undefined;
    }

    if (character === '"') {
      insideString = true;
      stringStart = index;
      continue;
    }

    if (character === '{') {
      objectCandidates.push({
        start: index,
        hasRuntimeVersionKey: false,
        hasFingerprintSourcesKey: false,
      });
      continue;
    }
    if (character !== '}') continue;
    const completedCandidate = objectCandidates.pop();
    if (!completedCandidate) continue;
    if (!completedCandidate.hasRuntimeVersionKey || !completedCandidate.hasFingerprintSourcesKey) continue;

    const candidate = trimmed.slice(completedCandidate.start, index + 1);
    remainingParseBudget -= candidate.length;
    if (remainingParseBudget < 0) {
      throw new Error('Too many resolver-shaped JSON objects found in stdout');
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRuntimeVersionResult(parsed)) continue;
      if (matchedResult !== null) {
        throw new Error('Multiple runtimeVersion resolver JSON objects found in stdout');
      }
      matchedResult = parsed;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Multiple runtimeVersion')) throw error;
      // Keep scanning: a diagnostic may contain braces before the payload.
    }
  }

  if (matchedResult !== null) return matchedResult;
  throw new Error('Could not find a runtimeVersion resolver JSON object in stdout');
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
