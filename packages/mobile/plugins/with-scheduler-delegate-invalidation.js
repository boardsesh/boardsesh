const { createRunOncePlugin, withAppDelegate } = require('expo/config-plugins');

// boardsesh/boardsesh#5293 (Sentry BOARDSESH-8S): turn on React Native's
// SchedulerDelegate invalidation guard at runtime.
//
// The work lives in modules/react-flag-overrides (Objective-C++). This plugin
// only wires the call into the generated AppDelegate.swift, at the one point
// where it is safe:
//   - AFTER `ExpoReactNativeFactory(delegate:)`: the factory's init calls
//     ReactNativeFeatureFlags::override(), which throws if a provider is set.
//   - BEFORE `factory.startReactNative(...)`: the override swaps the flag
//     accessor without a lock, so no RCTHost / JS thread may exist yet.
//
// A missing anchor throws instead of warning. A skipped insert would build a
// green app that silently ships the crash again.

const MODULE_NAME = 'BoardseshReactFlagOverrides';
const IMPORT_LINE = `import ${MODULE_NAME}`;
const INSTALL_CALL = `${MODULE_NAME}.install()`;
const IMPORT_ANCHOR = /^import React$/m;
const FACTORY_ANCHOR = /^([ \t]*)let factory = ExpoReactNativeFactory\(delegate: delegate\)[ \t]*$/m;
const START_ANCHOR = 'factory.startReactNative(';

/**
 * Returns AppDelegate.swift with the import and the install call added.
 * Idempotent. Throws when the template no longer has the anchors, or when the
 * call would land after startReactNative.
 * @param {string} contents
 * @returns {string}
 */
function applySchedulerDelegateInvalidation(contents) {
  if (contents.includes(INSTALL_CALL)) {
    return contents;
  }

  if (!IMPORT_ANCHOR.test(contents)) {
    throw new Error(
      `[with-scheduler-delegate-invalidation] AppDelegate.swift has no "import React" line to anchor "${IMPORT_LINE}". ` +
        'The Expo template changed; re-check where the React Native factory is created (#5293).',
    );
  }
  const factoryMatch = FACTORY_ANCHOR.exec(contents);
  if (!factoryMatch) {
    throw new Error(
      '[with-scheduler-delegate-invalidation] AppDelegate.swift no longer creates the factory with ' +
        '"let factory = ExpoReactNativeFactory(delegate: delegate)". The Expo template changed; the ' +
        `${INSTALL_CALL} call must run after the factory init and before startReactNative (#5293).`,
    );
  }

  const indent = factoryMatch[1];
  const insertAt = factoryMatch.index + factoryMatch[0].length;
  const startIndex = contents.indexOf(START_ANCHOR, insertAt);
  if (startIndex === -1) {
    throw new Error(
      `[with-scheduler-delegate-invalidation] AppDelegate.swift has no "${START_ANCHOR}" after the factory init, so ` +
        `${INSTALL_CALL} cannot be proven to run before React Native starts (#5293).`,
    );
  }

  const installBlock =
    `\n${indent}// boardsesh #5293: arm the SchedulerDelegate invalidation guard. Must stay after the\n` +
    `${indent}// factory init (it installs the base flag provider) and before startReactNative.\n` +
    `${indent}${INSTALL_CALL}`;

  const withInstall = contents.slice(0, insertAt) + installBlock + contents.slice(insertAt);
  return withInstall.replace(IMPORT_ANCHOR, (line) => `${line}\n${IMPORT_LINE}`);
}

function withSchedulerDelegateInvalidation(config) {
  return withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== 'swift') {
      throw new Error(
        `[with-scheduler-delegate-invalidation] expected a Swift AppDelegate, got "${modConfig.modResults.language}" (#5293).`,
      );
    }
    modConfig.modResults.contents = applySchedulerDelegateInvalidation(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(
  withSchedulerDelegateInvalidation,
  'with-scheduler-delegate-invalidation',
  '1.0.0',
);
module.exports.applySchedulerDelegateInvalidation = applySchedulerDelegateInvalidation;
module.exports.INSTALL_CALL = INSTALL_CALL;
module.exports.IMPORT_LINE = IMPORT_LINE;
