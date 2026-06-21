const { createRunOncePlugin, withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

// Apple Health (HealthKit) entitlement + usage descriptions for the
// health-workouts native module. We WRITE workouts (finished climbing sessions)
// and READ body mass (to estimate calories). Idempotent: re-running prebuild
// (or a double-registered plugin) leaves both plists unchanged because we set
// the same keys to the same values.
const HEALTH_UPDATE_USAGE = 'Boardsesh saves your finished climbing sessions to Apple Health as workouts.';
const HEALTH_SHARE_USAGE =
  'Boardsesh reads your body weight to estimate calories and your saved Boardsesh workouts to prevent duplicates.';

function withHealthKitEntitlement(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    modConfig.modResults['com.apple.developer.healthkit'] = true;
    return modConfig;
  });
}

function withHealthKitUsageDescriptions(config) {
  return withInfoPlist(config, (modConfig) => {
    modConfig.modResults.NSHealthUpdateUsageDescription = HEALTH_UPDATE_USAGE;
    modConfig.modResults.NSHealthShareUsageDescription = HEALTH_SHARE_USAGE;
    return modConfig;
  });
}

function withHealthKit(config) {
  return withHealthKitUsageDescriptions(withHealthKitEntitlement(config));
}

module.exports = createRunOncePlugin(withHealthKit, 'with-healthkit', '1.0.0');
module.exports.HEALTH_UPDATE_USAGE = HEALTH_UPDATE_USAGE;
module.exports.HEALTH_SHARE_USAGE = HEALTH_SHARE_USAGE;
