const { createRunOncePlugin, withPodfile, withPodfileProperties } = require('expo/config-plugins');

const SOURCE_BUILD_KEYS = ['RCT_USE_RN_DEP', 'RCT_USE_PREBUILT_RNCORE'];

/** A prebuilt React framework omits the Scheduler lifetime patch (#5293). */
function enforceReactNativeSourceBuilds(contents) {
  let updated = contents;
  for (const key of SOURCE_BUILD_KEYS) {
    const assignment = new RegExp(`^([ \\t]*)ENV\\['${key}'\\]\\s*(?:\\|\\|)?=.*$`, 'gm');
    if (!assignment.test(updated)) {
      throw new Error(
        `[with-react-native-source-builds] Missing Expo Podfile setting ${key}; verify source-build configuration.`,
      );
    }
    // Explicit assignment also defeats a caller's inherited prebuilt setting.
    updated = updated.replace(assignment, (_line, indent) => `${indent}ENV['${key}'] = '0'`);
  }
  return updated;
}

function withReactNativeSourceBuilds(config) {
  const configured = withPodfileProperties(config, (modConfig) => {
    modConfig.modResults['ios.buildReactNativeFromSource'] = 'true';
    return modConfig;
  });
  return withPodfile(configured, (modConfig) => {
    modConfig.modResults.contents = enforceReactNativeSourceBuilds(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withReactNativeSourceBuilds, 'with-react-native-source-builds', '1.0.0');
module.exports.enforceReactNativeSourceBuilds = enforceReactNativeSourceBuilds;
