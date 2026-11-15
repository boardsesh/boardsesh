/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import semver from 'semver';

// Android 8.63.0 includes sentry-native 0.17.6. Older SDKs can abort while
// allocating in the crash unwinder, masking the original fault (#7512).
// Upstream fix: https://github.com/getsentry/sentry-native/pull/2239
const MINIMUM_SENTRY_ANDROID_VERSION = '8.63.0';

export function checkSentryAndroidSdkSource(androidBuildGradle: string): string[] {
  const androidVersion = /^\s*def sentryAndroidVersion = ['"]([^'"]+)['"]/m.exec(androidBuildGradle)?.[1];
  if (!androidVersion || !semver.valid(androidVersion)) {
    return ['Could not identify the installed Sentry Android SDK version; audit its Gradle dependency declaration.'];
  }
  if (semver.lt(androidVersion, MINIMUM_SENTRY_ANDROID_VERSION)) {
    return [
      `Sentry Android ${androidVersion} lacks the native unwinder allocation fix; require ${MINIMUM_SENTRY_ANDROID_VERSION} or newer.`,
    ];
  }
  return [];
}

/** Check the installed native dependency, rather than trusting the JS SDK pin. */
export function checkInstalledSentryAndroidSdk(mobilePackageJsonPath: string): string[] {
  try {
    const mobilePackage = JSON.parse(readFileSync(mobilePackageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const declaredVersion = mobilePackage.dependencies?.['@sentry/react-native'];
    const requireFromMobile = createRequire(mobilePackageJsonPath);
    const sentryPackagePath = requireFromMobile.resolve('@sentry/react-native/package.json');
    const sentryPackage = JSON.parse(readFileSync(sentryPackagePath, 'utf8')) as { version?: string };
    if (!declaredVersion || !semver.valid(declaredVersion) || sentryPackage.version !== declaredVersion) {
      return ['Sentry React Native must be exactly pinned and match the installed SDK before native qualification.'];
    }
    return checkSentryAndroidSdkSource(readFileSync(join(dirname(sentryPackagePath), 'android/build.gradle'), 'utf8'));
  } catch (error) {
    return [
      `Could not verify the installed Sentry native SDK: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}
