const { createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

// Portrait orientation and Wi-Fi permissions imply required hardware in Play's
// device filters unless explicitly overridden. Boardsesh can run on a landscape
// display and use other network connections, so neither is an install requirement.
const OPTIONAL_FEATURES = ['android.hardware.screen.portrait', 'android.hardware.wifi'];

/**
 * Marks optional hardware features without changing permissions or activity
 * orientation. Existing declarations keep their other attributes, and repeated
 * prebuild passes do not add duplicate entries.
 *
 * @param {{ manifest: { 'uses-feature'?: Array<{ $: Record<string, string> }> } }} androidManifest
 * @returns {typeof androidManifest}
 */
function addOptionalFeatures(androidManifest) {
  const manifest = androidManifest.manifest;
  const usesFeature = manifest['uses-feature'] ?? [];

  for (const featureName of OPTIONAL_FEATURES) {
    const existingFeatures = usesFeature.filter((feature) => feature?.$?.['android:name'] === featureName);

    if (existingFeatures.length === 0) {
      usesFeature.push({ $: { 'android:name': featureName, 'android:required': 'false' } });
      continue;
    }

    for (const feature of existingFeatures) {
      feature.$['android:required'] = 'false';
    }
  }

  manifest['uses-feature'] = usesFeature;
  return androidManifest;
}

function withAndroidOptionalFeatures(config) {
  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = addOptionalFeatures(modConfig.modResults);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withAndroidOptionalFeatures, 'with-android-optional-features', '1.0.0');
module.exports.addOptionalFeatures = addOptionalFeatures;
