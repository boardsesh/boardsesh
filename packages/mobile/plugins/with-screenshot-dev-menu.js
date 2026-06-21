const { createRunOncePlugin, withInfoPlist } = require('expo/config-plugins');

// Suppresses expo-dev-client's dev-menu chrome (the one-time "developer menu"
// onboarding sheet, the floating gear button, and show-at-launch) via Info.plist
// DEFAULTS, so it stays suppressed across EVERY launch.
//
// Why Info.plist and not the per-launch `simctl launch -EXDevMenu... ` args the
// screenshot orchestrator also passes: those only live in the launched process's
// argument domain. On CI, Maestro's cold start lets that pre-launched process get
// idle-killed, then its `openLink` cold-relaunches the app WITHOUT the args — the
// onboarding sheet then covers the auth screen and the capture times out waiting
// for `auth-email-input`. DevMenuPreferences.setup() reads these three keys as
// the registered defaults (Bundle.main Info dictionary), so baking them in keeps
// the chrome suppressed no matter how the app is (re)launched.
//
// Only applied to the dedicated screenshots build (gated in app.config.ts on
// BOARDSESH_SCREENSHOT_BUILD, set by scripts/mobile-build-sim-app.ts), so normal
// `vp run mobile:ios` dev builds keep the full dev menu + floating button.
function applyScreenshotDevMenuInfoPlist(infoPlist) {
  infoPlist.EXDevMenuIsOnboardingFinished = true;
  infoPlist.EXDevMenuShowFloatingActionButton = false;
  infoPlist.EXDevMenuShowsAtLaunch = false;
  // Make the dev-client auto-load Metro on a plain launch. EXDevLauncherController
  // reads this Info.plist key and, when there's no incoming URL and no
  // last-opened app, loads it directly (no `simctl openurl`). That's the whole
  // point: a fresh CI sim raises an "Open in Boardsesh?" confirmation for any
  // openurl of the custom scheme, and Maestro can't dismiss it reliably. With this
  // the orchestrator just `simctl launch`es the app and it connects to Metro —
  // no openurl, no dialog. Fixed to 8081 (the screenshots Metro port); a
  // BOARDSESH_METRO_PORT override would need this rebuilt to match.
  infoPlist.DEV_CLIENT_DEFAULT_LAUNCHER_URL = 'http://localhost:8081';
  return infoPlist;
}

function withScreenshotDevMenu(config) {
  return withInfoPlist(config, (modConfig) => {
    applyScreenshotDevMenuInfoPlist(modConfig.modResults);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withScreenshotDevMenu, 'with-screenshot-dev-menu', '1.0.0');
module.exports.applyScreenshotDevMenuInfoPlist = applyScreenshotDevMenuInfoPlist;
