const { createRunOncePlugin, withEntitlementsPlist } = require('expo/config-plugins');

// app.config.ts declares group.com.boardsesh.app in ios.entitlements (the single
// source of truth — the BoardseshWidgets Live Activity target and the shared
// keychain both depend on it). expo-share-intent's own withIosAppEntitlements
// *prepends* the same App Group to the main app's application-groups array
// without deduping (node_modules/expo-share-intent/plugin/build/ios/
// withIosAppEntitlements.js), so the merged array ends up holding
// group.com.boardsesh.app twice. A duplicated app-group entry is the kind of
// thing codesign/EAS credential validation can choke on, so we collapse it.
//
// Must run AFTER expo-share-intent's entitlements mod. Expo executes user mods
// in reverse registration order (the earliest plugin in the array runs last —
// see @expo/config-plugins withMod), so this plugin is registered FIRST in
// app.config.ts's plugins array to guarantee it runs last and sees the final,
// merged array.
const APP_GROUP_KEY = 'com.apple.security.application-groups';

/**
 * Collapse the application-groups entitlement to unique values, preserving
 * order. Pure transform over the parsed entitlements object for testability.
 *
 * @param {Record<string, unknown>} entitlements
 * @returns {Record<string, unknown>}
 */
function dedupeApplicationGroups(entitlements) {
  const groups = entitlements[APP_GROUP_KEY];
  if (Array.isArray(groups)) {
    entitlements[APP_GROUP_KEY] = Array.from(new Set(groups));
  }
  return entitlements;
}

function withShareIntentAppGroupDedup(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    modConfig.modResults = dedupeApplicationGroups(modConfig.modResults);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withShareIntentAppGroupDedup, 'with-share-intent-app-group-dedup', '1.0.0');
module.exports.dedupeApplicationGroups = dedupeApplicationGroups;
module.exports.APP_GROUP_KEY = APP_GROUP_KEY;
