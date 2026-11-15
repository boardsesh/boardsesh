import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkInstalledSentryAndroidSdk, checkSentryAndroidSdkSource } from '../mobile-sentry-native-check';

const fixtureDirectories: string[] = [];

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeInstalledSdk(declaredVersion: string, installedVersion: string, androidVersion: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-sentry-native-'));
  fixtureDirectories.push(directory);
  const sdkDirectory = join(directory, 'node_modules/@sentry/react-native');
  mkdirSync(join(sdkDirectory, 'android'), { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ dependencies: { '@sentry/react-native': declaredVersion } }),
  );
  writeFileSync(join(sdkDirectory, 'package.json'), JSON.stringify({ version: installedVersion }));
  writeFileSync(join(sdkDirectory, 'android/build.gradle'), `def sentryAndroidVersion = '${androidVersion}'\n`);
  return join(directory, 'package.json');
}

describe('Sentry native unwinder dependency', () => {
  it('qualifies the actual installed SDK selected by mobile', () => {
    const mobilePackageJson = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/mobile/package.json');
    expect(checkInstalledSentryAndroidSdk(mobilePackageJson)).toEqual([]);
  });

  it.each(['8.53.0', '8.62.0'])('rejects the affected Android SDK %s', (androidVersion) => {
    expect(checkSentryAndroidSdkSource(`def sentryAndroidVersion = '${androidVersion}'`)).toEqual([
      `Sentry Android ${androidVersion} lacks the native unwinder allocation fix; require 8.63.0 or newer.`,
    ]);
  });

  it.each(['8.63.0', '8.64.0'])('accepts Android SDK %s with the upstream fix', (androidVersion) => {
    expect(checkSentryAndroidSdkSource(`def sentryAndroidVersion = '${androidVersion}'`)).toEqual([]);
  });

  it('does not qualify a prerelease before the fixed Android version', () => {
    expect(checkSentryAndroidSdkSource("def sentryAndroidVersion = '8.63.0-beta.1'")).not.toEqual([]);
  });

  it('requires an audit when the native dependency declaration changes', () => {
    expect(checkSentryAndroidSdkSource('dependencies { api "io.sentry:sentry-android:8.64.0" }')).not.toEqual([]);
  });

  it('rejects an affected native SDK even beneath a newer JavaScript package', () => {
    expect(checkInstalledSentryAndroidSdk(makeInstalledSdk('8.35.0', '8.35.0', '8.62.0'))).toEqual([
      'Sentry Android 8.62.0 lacks the native unwinder allocation fix; require 8.63.0 or newer.',
    ]);
  });

  it('rejects an installation that does not match the declared SDK', () => {
    expect(checkInstalledSentryAndroidSdk(makeInstalledSdk('8.35.0', '8.33.0', '8.64.0'))).not.toEqual([]);
  });

  it('rejects a range even when the installed SDK is fixed', () => {
    expect(checkInstalledSentryAndroidSdk(makeInstalledSdk('^8.35.0', '8.35.0', '8.64.0'))).not.toEqual([]);
  });

  it('accepts a matching, fixed installation', () => {
    expect(checkInstalledSentryAndroidSdk(makeInstalledSdk('8.35.0', '8.35.0', '8.64.0'))).toEqual([]);
  });
});
