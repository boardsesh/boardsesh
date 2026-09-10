const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

// Associates a release binary with the R8 mapping file the Android release
// workflow uploads to Sentry. sentry-android's ManifestMetadataReader reads this
// meta-data key into SentryOptions.proguardUuid, which attaches the mapping as a
// debug image so obfuscated Java/Kotlin frames deobfuscate in Sentry.
//
// The Sentry Android Gradle Plugin normally injects this. We do NOT apply it:
// android-apk-rn.yml deliberately keeps Sentry out of the Gradle critical path
// (SENTRY_DISABLE_AUTO_UPLOAD), because a Sentry-side failure must never take
// down a release that already built and verified. So the workflow mints the UUID
// BEFORE `expo prebuild`, this plugin bakes it into the manifest, and the
// decoupled upload step passes the SAME value to `sentry-cli upload-proguard
// --uuid`. Play is unaffected either way — AGP embeds the mapping in the AAB
// under BUNDLE-METADATA and Play ingests it on upload.
//
// Env-driven on purpose: @expo/fingerprint hashes the RESOLVED Expo config and
// this file's CONTENTS, never process.env, so a per-run UUID cannot move the
// runtimeVersion. Unset is a no-op, not a failure — a local prebuild, a PR build
// and the screenshot capture all have no UUID and must still prebuild cleanly.
const META_DATA_NAME = 'io.sentry.proguard-uuid';
const ENV_VAR = 'BOARDSESH_SENTRY_PROGUARD_UUID';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Adds `<meta-data android:name="io.sentry.proguard-uuid" android:value="..."/>`
 * to the parsed AndroidManifest's main <application>. Pure transform for
 * testability. Idempotent — addMetaDataItemToMainApplication replaces an
 * existing entry with the same name rather than appending a duplicate.
 *
 * A falsy uuid is a no-op. A non-empty value that is not a UUID throws: that
 * means the workflow set the variable and got it wrong, and shipping a binary
 * whose manifest carries a UUID no mapping was uploaded under is worse than
 * failing prebuild.
 *
 * @param {object} androidManifest - the @expo/config-plugins manifest object
 * @param {string | undefined} uuid
 * @returns {typeof androidManifest}
 */
function applySentryProguardUuid(androidManifest, uuid) {
  if (!uuid) {
    return androidManifest;
  }

  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(
      `with-android-sentry-proguard-uuid: ${ENV_VAR} is set but is not a UUID: ${JSON.stringify(uuid)}. ` +
        'The Android release workflow mints it with `uuidgen`; a malformed value would bake a ' +
        'proguard-uuid into the binary that no uploaded mapping matches.',
    );
  }

  const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(mainApplication, META_DATA_NAME, uuid);
  return androidManifest;
}

function withAndroidSentryProguardUuid(config) {
  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = applySentryProguardUuid(modConfig.modResults, process.env[ENV_VAR]);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withAndroidSentryProguardUuid, 'with-android-sentry-proguard-uuid', '1.0.0');
module.exports.applySentryProguardUuid = applySentryProguardUuid;
module.exports.META_DATA_NAME = META_DATA_NAME;
module.exports.ENV_VAR = ENV_VAR;
