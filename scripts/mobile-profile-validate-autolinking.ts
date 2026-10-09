/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { objectRecord, sha256 } from './lib/mobile-profile-protocol';

/** Supply actual generated provider/lock files; retain their hashes in build evidence. */
export function validateGeneratedTelemetryInventories(paths: readonly string[]) {
  if (!paths.length) throw new Error('Generated native module inventories are required');
  return paths.map((path) => {
    const contents = readFileSync(path);
    if (
      /ExpoObserve|ExpoAppMetrics|ObserveModule|AppMetricsModule|ObserveAppDelegateSubscriber|AppMetricsAppDelegateSubscriber|expo\.modules\.(observe|appmetrics)/.test(
        contents.toString(),
      )
    )
      throw new Error(`Generated native telemetry module remains in inventory: ${path}`);
    return { path, sha256: sha256(contents), nativeTelemetryModulesAbsent: true };
  });
}

/** Run after vp install and before prebuild; this uses Expo's actual resolver. */
export function validateProfileAutolinking(checkout: string) {
  const mobile = join(checkout, 'packages/mobile');
  const mobileRequire = createRequire(join(mobile, 'package.json'));
  const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
  const resolver = join(
    dirname(expoRequire.resolve('expo-modules-autolinking/package.json')),
    'bin/expo-modules-autolinking.js',
  );
  const platforms = ['apple', 'android'] as const;
  const proof = platforms.map((platform) => {
    const bytes = execFileSync(
      process.execPath,
      [resolver, 'resolve', '--project-root', mobile, '--platform', platform, '--json'],
      {
        cwd: mobile,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, EXPO_NO_DOTENV: '1' },
      },
    );
    const resolved = objectRecord(JSON.parse(bytes) as unknown);
    if (!Array.isArray(resolved.modules)) throw new Error('Expo resolver module inventory missing');
    const moduleNames = resolved.modules.map((candidate) => objectRecord(candidate).packageName);
    if (!moduleNames.includes('expo-modules-core')) throw new Error('Expo resolver is incomplete; core module absent');
    if (
      moduleNames.some((name) => name === 'expo-observe' || name === 'expo-app-metrics') ||
      /ObserveModule|AppMetricsModule|ObserveAppDelegateSubscriber|AppMetricsAppDelegateSubscriber/.test(bytes)
    )
      throw new Error(`Native telemetry autolinking remains enabled on ${platform}`);
    return {
      platform,
      moduleCount: moduleNames.length,
      nativeTelemetryModulesAbsent: true,
      resolvedInventorySha256: sha256(bytes),
      moduleNames,
    };
  });
  return { schemaVersion: 1, packageSha256: sha256(readFileSync(join(mobile, 'package.json'))), platforms: proof };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [runDirectory, ...inventories] = process.argv.slice(2);
  if (!runDirectory)
    throw new Error('Usage: vp exec tsx scripts/mobile-profile-validate-autolinking.ts <prepare-directory>');
  const directory = resolve(runDirectory);
  const prepared = objectRecord(JSON.parse(readFileSync(join(directory, 'prepare.json'), 'utf8')) as unknown);
  if (typeof prepared.checkout !== 'string') throw new Error('Prepared checkout missing');
  const proof = {
    ...validateProfileAutolinking(prepared.checkout),
    ...(inventories.length ? { generatedInventories: validateGeneratedTelemetryInventories(inventories) } : {}),
  };
  writeFileSync(join(directory, 'telemetry-autolinking-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
}
