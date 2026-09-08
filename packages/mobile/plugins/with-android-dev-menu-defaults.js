const { createRunOncePlugin, withAndroidManifest, AndroidConfig } = require('expo/config-plugins');
const { resolveScreenshotMetroUrl } = require('./with-screenshot-dev-menu');

// The Android twin of plugins/with-screenshot-dev-menu.js: it bakes the same
// four dev-client defaults into <application> <meta-data> that the iOS plugin
// bakes into Info.plist. Only applied to the "Boardsesh Dev" variant (gated on
// BOARDSESH_APP_VARIANT=dev in app.config.ts), so the production config — and
// with it the store fingerprint — never moves.
//
// WHY manifest defaults and not SharedPreferences: every screenshot capture
// launches the dev-client COLD (`adb shell pm clear` after install, then
// Maestro's `launchApp`), so nothing written to preferences by an earlier
// launch survives. expo-dev-menu reads EXDevMenuIsOnboardingFinished /
// EXDevMenuShowFloatingActionButton / EXDevMenuShowsAtLaunch from the manifest
// as its registered defaults (DevMenuPreferences.kt), so without these the
// one-time "developer menu" onboarding sheet covers the first screen and the
// floating gear button sits in the corner of EVERY captured PNG.
// DEV_CLIENT_DEFAULT_LAUNCHER_URL is the other half: DevLauncherController reads
// it from the manifest and auto-loads that URL on a plain launch, so the capture
// never has to fire a deep link or dismiss a "Development servers" list.
//
// WHAT A DEV LOSES: the floating action button. The dev menu still opens by
// shaking the device or `adb shell input keyevent 82`.
//
// ON A PHYSICAL DEVICE http://localhost:8081 is the phone's own loopback and
// has no Metro on it (unless `adb reverse tcp:8081 tcp:8081` is set), so
// expo-dev-launcher's launchDefaultUrlOrNavigateToLauncher falls back to the
// launcher UI — the sideload experience is unchanged.
const LAUNCHER_URL_KEY = 'DEV_CLIENT_DEFAULT_LAUNCHER_URL';

/**
 * Writes the four dev-menu / dev-launcher defaults onto the main <application>.
 * Idempotent: addMetaDataItemToMainApplication replaces an existing item with
 * the same name rather than appending a second one, so repeated prebuilds (and
 * a double registration) leave exactly one item per key. Pure transform over the
 * parsed manifest for testability.
 *
 * @param {object} androidManifest - the @expo/config-plugins AndroidManifest object
 * @param {Record<string, string | undefined>} [env] - env the Metro URL is read from
 * @returns {object} the mutated manifest
 */
function applyAndroidDevMenuDefaults(androidManifest, env = process.env) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);

  // Manifest meta-data values are strings — 'true'/'false', not booleans.
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(
    application,
    LAUNCHER_URL_KEY,
    resolveScreenshotMetroUrl(env),
  );
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, 'EXDevMenuIsOnboardingFinished', 'true');
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, 'EXDevMenuShowFloatingActionButton', 'false');
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, 'EXDevMenuShowsAtLaunch', 'false');

  return androidManifest;
}

function withAndroidDevMenuDefaults(config) {
  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = applyAndroidDevMenuDefaults(modConfig.modResults);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withAndroidDevMenuDefaults, 'with-android-dev-menu-defaults', '1.0.0');
module.exports.applyAndroidDevMenuDefaults = applyAndroidDevMenuDefaults;
module.exports.LAUNCHER_URL_KEY = LAUNCHER_URL_KEY;
