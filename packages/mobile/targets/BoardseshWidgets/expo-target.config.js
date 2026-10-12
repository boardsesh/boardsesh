/// Widget extension target configured via @bacons/apple-targets. Sources in
/// this folder are compiled into the BoardseshWidgets bundle; their Swift
/// uses `#if WIDGET_EXTENSION` to gate code that must not run in the widget
/// process (e.g. LiveActivityBleBridge, which lives in the main app target).
/// The `WIDGET_EXTENSION` Swift flag is applied by
/// `packages/mobile/plugins/with-boardsesh-widget-build-settings.js` after
/// @bacons/apple-targets creates the generated Xcode target.
///
/// Files duplicated from the main app target (ClimbSessionAttributes,
/// SharedConstants, SharedKeychain, WidgetNetworking, TakeControlIntent) are
/// intentional copies. Each Xcode target compiles its own binary — there's no shared module — so the
/// duplicates must stay byte-identical or the JSON encoded into shared
/// UserDefaults will mismatch between processes.
const hostBundleIdentifier =
  process.env.BOARDSESH_IOS_APP_VARIANT === 'dev' ? 'com.boardsesh.app.dev' : 'com.boardsesh.app';
const appGroupIdentifier = `group.${hostBundleIdentifier}`;

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'BoardseshWidgets',
  bundleIdentifier: `${hostBundleIdentifier}.widgets`,
  deploymentTarget: '17.0',
  frameworks: ['ActivityKit', 'WidgetKit', 'AppIntents', 'SwiftUI'],
  entitlements: {
    'com.apple.security.application-groups': [appGroupIdentifier],
    'keychain-access-groups': [`$(AppIdentifierPrefix)${appGroupIdentifier}`],
  },
  // Custom identity plist keys are injected by with-boardsesh-widget-build-settings.
};
