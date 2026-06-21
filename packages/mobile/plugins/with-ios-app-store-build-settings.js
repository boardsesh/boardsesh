const { createRunOncePlugin } = require('expo/config-plugins');
const { withXcodeProjectBeta } = require('@bacons/apple-targets/build/with-bacons-xcode');

const IOS_APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application';
const IOS_APP_TARGET_NAME = 'Boardsesh';
const MAC_DESIGNED_FOR_IPHONE_IPAD_BUILD_SETTING = 'SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD';
const MAC_DESIGNED_FOR_IPHONE_IPAD_DISABLED = 'NO';

function getProjectTargets(project) {
  return project?.rootObject?.props?.targets ?? [];
}

function isNativeTarget(candidateTarget) {
  return candidateTarget?.isa === 'PBXNativeTarget';
}

function isIosApplicationTarget(candidateTarget) {
  return isNativeTarget(candidateTarget) && candidateTarget?.props?.productType === IOS_APPLICATION_PRODUCT_TYPE;
}

function isBoardseshApplicationTarget(candidateTarget) {
  return (
    isIosApplicationTarget(candidateTarget) &&
    (candidateTarget?.props?.name === IOS_APP_TARGET_NAME ||
      candidateTarget?.props?.productName === IOS_APP_TARGET_NAME)
  );
}

function findIosApplicationTarget(project) {
  const applicationTargets = getProjectTargets(project).filter(isIosApplicationTarget);
  const boardseshTarget = applicationTargets.find(isBoardseshApplicationTarget);

  if (boardseshTarget) {
    return boardseshTarget;
  }

  if (applicationTargets.length === 1) {
    return applicationTargets[0];
  }

  const targetNames = applicationTargets
    .map((target) => target?.props?.name ?? target?.props?.productName)
    .filter(Boolean)
    .join(', ');

  throw new Error(
    `Could not find the ${IOS_APP_TARGET_NAME} iOS application target in the generated Xcode project.` +
      (targetNames ? ` Found application targets: ${targetNames}.` : ''),
  );
}

function configureIosAppStoreBuildSettings(project) {
  const iosApplicationTarget = findIosApplicationTarget(project);

  if (typeof iosApplicationTarget.setBuildSetting !== 'function') {
    throw new Error(`${IOS_APP_TARGET_NAME} target does not support setBuildSetting().`);
  }

  // Boardsesh is an iPhone app that depends on BLE/background iOS behavior.
  // Do not let App Store Connect validate it as a macOS destination.
  iosApplicationTarget.setBuildSetting(
    MAC_DESIGNED_FOR_IPHONE_IPAD_BUILD_SETTING,
    MAC_DESIGNED_FOR_IPHONE_IPAD_DISABLED,
  );
}

function withIosAppStoreBuildSettings(config) {
  return withXcodeProjectBeta(config, async (modConfig) => {
    configureIosAppStoreBuildSettings(modConfig.modResults);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withIosAppStoreBuildSettings, 'with-ios-app-store-build-settings', '1.0.0');
module.exports.configureIosAppStoreBuildSettings = configureIosAppStoreBuildSettings;
module.exports.IOS_APPLICATION_PRODUCT_TYPE = IOS_APPLICATION_PRODUCT_TYPE;
module.exports.MAC_DESIGNED_FOR_IPHONE_IPAD_BUILD_SETTING = MAC_DESIGNED_FOR_IPHONE_IPAD_BUILD_SETTING;
module.exports.MAC_DESIGNED_FOR_IPHONE_IPAD_DISABLED = MAC_DESIGNED_FOR_IPHONE_IPAD_DISABLED;
