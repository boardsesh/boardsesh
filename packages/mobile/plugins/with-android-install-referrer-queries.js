const { createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

// Play Install Referrer needs to bind to the Play Store's service. On
// Android 11+ (API 30+) package-visibility filtering hides other apps'
// packages by default, so com.android.vending must be explicitly declared
// visible via <queries>, or InstallReferrerClient always resolves
// FEATURE_NOT_SUPPORTED even on a genuine Play Store install.
const VENDING_PACKAGE = 'com.android.vending';

/**
 * Adds `<queries><package android:name="com.android.vending"/></queries>` to
 * the parsed AndroidManifest. Idempotent: a second pass (or a double-registered
 * plugin) leaves the manifest unchanged. Pure transform over the
 * @expo/config-plugins manifest object for testability.
 *
 * @param {{ manifest: { queries?: Array<{ package?: Array<{ $: Record<string, string> }> }> } }} androidManifest
 * @returns {typeof androidManifest}
 */
function addInstallReferrerQueries(androidManifest) {
  const manifest = androidManifest.manifest;
  const queries = manifest.queries ?? [];
  const container = queries[0] ?? {};
  const packages = container.package ?? [];

  const alreadyDeclared = packages.some((entry) => entry?.$?.['android:name'] === VENDING_PACKAGE);
  if (!alreadyDeclared) {
    packages.push({ $: { 'android:name': VENDING_PACKAGE } });
  }
  container.package = packages;
  queries[0] = container;
  manifest.queries = queries;

  return androidManifest;
}

function withAndroidInstallReferrerQueries(config) {
  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = addInstallReferrerQueries(modConfig.modResults);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(
  withAndroidInstallReferrerQueries,
  'with-android-install-referrer-queries',
  '1.0.0',
);
module.exports.addInstallReferrerQueries = addInstallReferrerQueries;
module.exports.VENDING_PACKAGE = VENDING_PACKAGE;
