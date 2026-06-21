const fs = require('node:fs');
const path = require('node:path');
const { createRunOncePlugin, withDangerousMod } = require('expo/config-plugins');

// React Native 0.85.3's included Gradle plugin still pins the Foojay resolver
// convention plugin at 0.5.0. That resolver fails under Gradle 9.3.x, which Expo
// 56 currently generates locally. Pin the generated app wrapper to a compatible
// Gradle runtime until React Native updates the included build plugin.
const GRADLE_VERSION = '8.14.3';
const DISTRIBUTION_URL = `https\\://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`;

function applyAndroidGradleWrapperVersion(contents) {
  if (/^distributionUrl=/m.test(contents)) {
    return contents.replace(/^distributionUrl=.*$/m, `distributionUrl=${DISTRIBUTION_URL}`);
  }

  return `${contents.trimEnd()}\ndistributionUrl=${DISTRIBUTION_URL}\n`;
}

function withAndroidGradleWrapperVersion(config) {
  return withDangerousMod(config, [
    'android',
    (modConfig) => {
      const wrapperPath = path.join(
        modConfig.modRequest.platformProjectRoot,
        'gradle',
        'wrapper',
        'gradle-wrapper.properties',
      );
      const contents = fs.readFileSync(wrapperPath, 'utf8');
      fs.writeFileSync(wrapperPath, applyAndroidGradleWrapperVersion(contents));
      return modConfig;
    },
  ]);
}

module.exports = createRunOncePlugin(withAndroidGradleWrapperVersion, 'with-android-gradle-wrapper-version', '1.0.0');
module.exports.applyAndroidGradleWrapperVersion = applyAndroidGradleWrapperVersion;
module.exports.GRADLE_VERSION = GRADLE_VERSION;
module.exports.DISTRIBUTION_URL = DISTRIBUTION_URL;
