const { createRunOncePlugin, withAppBuildGradle } = require('expo/config-plugins');

// Marker so the transform is idempotent across repeated prebuilds and so the
// generated build.gradle is greppable in CI logs / on-device debugging.
const MARKER = 'boardsesh-release-signing';

// A `release` signing config injected into `android { signingConfigs { ... } }`.
// It reads the keystore from the ANDROID_KEYSTORE_* env-var names (the same
// secret names the retired Capacitor build used), so the existing
// ANDROID_KEYSTORE_* GitHub secrets line up 1:1. The runtime
// null-check keeps the block inert when the env is absent — a developer running
// `expo prebuild` locally has no keystore and the release build type falls back
// to debug signing (see RELEASE_SIGNING_CONFIG_LINE below).
const RELEASE_SIGNING_BLOCK = `
        release {
            // ${MARKER}
            if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {
                storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }`;

const RELEASE_SIGNING_CONFIG_LINE =
  'signingConfig System.getenv("ANDROID_KEYSTORE_PATH") != null ? signingConfigs.release : signingConfigs.debug';

/**
 * Rewrites the contents of `android/app/build.gradle` so the `release` build
 * type is signed with our keystore when the keystore env vars are present, and
 * with the debug key otherwise. Pure string transform for testability.
 *
 * @param {string} contents - the build.gradle source
 * @returns {string} the rewritten source
 */
function applyAndroidReleaseSigning(contents) {
  // Idempotent: a second prebuild (or a double-registered plugin) is a no-op.
  if (contents.includes(MARKER)) {
    return contents;
  }

  // Fail loudly if a future Expo SDK ships its own `release` signing config:
  // blindly injecting ours would produce a duplicate `release {}` inside
  // `signingConfigs` and a cryptic Gradle DSL error. signingConfigs always
  // precedes buildTypes in the generated file, so scan only that slice.
  const buildTypesIndex = contents.search(/buildTypes\s*\{/);
  const signingConfigsIndex = contents.search(/signingConfigs\s*\{/);
  if (signingConfigsIndex !== -1 && buildTypesIndex > signingConfigsIndex) {
    const signingConfigsSlice = contents.slice(signingConfigsIndex, buildTypesIndex);
    if (/\brelease\s*\{/.test(signingConfigsSlice)) {
      throw new Error(
        'with-android-release-signing: the generated build.gradle already defines a `release` ' +
          'signing config (the Expo template changed). Update this plugin to reuse it instead of injecting a duplicate.',
      );
    }
  }

  // 1) Add a `release` signing config right after `signingConfigs {`.
  const withSigningConfig = contents.replace(/signingConfigs\s*\{/, (match) => `${match}\n${RELEASE_SIGNING_BLOCK}`);
  if (withSigningConfig === contents) {
    throw new Error('with-android-release-signing: could not find a `signingConfigs {` block in build.gradle.');
  }

  // 2) Point the `release` build type at the conditional signing config.
  //    The lazy prefix is anchored at `buildTypes {`, which is textually after
  //    `signingConfigs {`, so it skips the debug build type's identical
  //    `signingConfig signingConfigs.debug` and only the release one is matched.
  const withReleaseSigning = withSigningConfig.replace(
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
    `$1${RELEASE_SIGNING_CONFIG_LINE}`,
  );
  if (withReleaseSigning === withSigningConfig) {
    throw new Error(
      'with-android-release-signing: could not find `signingConfig signingConfigs.debug` in the release build type.',
    );
  }

  return withReleaseSigning;
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = applyAndroidReleaseSigning(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withAndroidReleaseSigning, 'with-android-release-signing', '1.0.0');
module.exports.applyAndroidReleaseSigning = applyAndroidReleaseSigning;
module.exports.MARKER = MARKER;
module.exports.RELEASE_SIGNING_CONFIG_LINE = RELEASE_SIGNING_CONFIG_LINE;
