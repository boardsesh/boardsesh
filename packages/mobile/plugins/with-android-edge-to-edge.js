const { createRunOncePlugin, withGradleProperties } = require('expo/config-plugins');

// React Native 0.86 ships built-in edge-to-edge support. Per the
// react-native-edge-to-edge / @zoontek/react-native-navigation-bar guidance for
// RN 0.86+, enable it through the framework's own `edgeToEdgeEnabled=true` Gradle
// property rather than the react-native-edge-to-edge config plugin. The
// @zoontek/react-native-navigation-bar native module also REQUIRES this property
// ("RN 0.86+ with edge-to-edge enabled").
//
// We write the raw gradle.properties entry directly (instead of
// android.edgeToEdgeEnabled in app.config) because Expo SDK 56's config schema
// rejects that field with a warning — withGradleProperties bypasses the schema
// and sets the property the RN gradle plugin actually reads.
const PROPS = {
  edgeToEdgeEnabled: 'true',
};

/**
 * Upserts the edge-to-edge property into the parsed gradle.properties.
 * Pure transform for testability.
 *
 * @param {Array<{type: string, key?: string, value?: string}>} gradleProps
 * @returns {Array<{type: string, key?: string, value?: string}>}
 */
function applyEdgeToEdge(gradleProps) {
  for (const [key, value] of Object.entries(PROPS)) {
    const existing = gradleProps.find((entry) => entry.type === 'property' && entry.key === key);
    if (existing) {
      existing.value = value;
    } else {
      gradleProps.push({ type: 'property', key, value });
    }
  }
  return gradleProps;
}

function withAndroidEdgeToEdge(config) {
  return withGradleProperties(config, (modConfig) => {
    modConfig.modResults = applyEdgeToEdge(modConfig.modResults);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withAndroidEdgeToEdge, 'with-android-edge-to-edge', '1.0.0');
module.exports.applyEdgeToEdge = applyEdgeToEdge;
module.exports.PROPS = PROPS;
