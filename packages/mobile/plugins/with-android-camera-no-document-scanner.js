const { createRunOncePlugin, withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

// Keeps expo-camera's document scanner out of the Android app. We use
// expo-camera only to read QR codes ("Scan a board code"); its multi-page
// document scanner (`CameraView.scanDocumentAsync`) links Google's
// play-services-mlkit-document-scanner, which nothing here calls.
//
// Two switches, because Android can link expo-camera two ways:
//
// 1. The gradle property is expo-camera's own off switch. Its build.gradle
//    reads `expo.camera.document-scanner-enabled` and turns the library into a
//    compileOnly dependency. That only runs when expo-camera is built from
//    source (`expo.autolinking.buildFromSource` in package.json).
// 2. Today it isn't: autolinking uses the prebuilt AAR in expo-camera's
//    local-maven-repo, whose Gradle module metadata lists the document scanner
//    as a runtime dependency whatever the property says. So the app module also
//    excludes that one artifact from every configuration.
//
// Either way the result is the state expo-camera supports with the switch off:
// `isDocumentScannerAvailable` checks for the class at runtime and answers
// false, and the AAR's consumer rules (`-dontwarn com.google.mlkit.vision.**`)
// keep R8 quiet about the missing classes. The barcode scanner
// (com.google.mlkit:barcode-scanning) is untouched.
//
// Deterministic: fixed strings, no env reads, so the fingerprint is the same on
// every machine.
const DOCUMENT_SCANNER_PROPERTY = 'expo.camera.document-scanner-enabled';
const DOCUMENT_SCANNER_GROUP = 'com.google.android.gms';
const DOCUMENT_SCANNER_MODULE = 'play-services-mlkit-document-scanner';

// Marker so the build.gradle append is idempotent across repeated prebuilds.
const EXCLUDE_MARKER = 'boardsesh-camera-no-document-scanner';
const EXCLUDE_BLOCK = `
// ${EXCLUDE_MARKER}: added by packages/mobile/plugins/with-android-camera-no-document-scanner.js.
// expo-camera's prebuilt AAR lists its document scanner as a runtime dependency; we never call it.
configurations.configureEach {
    exclude group: '${DOCUMENT_SCANNER_GROUP}', module: '${DOCUMENT_SCANNER_MODULE}'
}
`;

/**
 * Upserts the document-scanner switch into the parsed gradle.properties. Pure
 * transform for testability, like applyGradleMemory.
 *
 * @param {Array<{type: string, key?: string, value?: string}>} gradleProps
 * @returns {Array<{type: string, key?: string, value?: string}>}
 */
function applyDocumentScannerProperty(gradleProps) {
  const existing = gradleProps.find((entry) => entry.type === 'property' && entry.key === DOCUMENT_SCANNER_PROPERTY);
  if (existing) {
    existing.value = 'false';
  } else {
    gradleProps.push({ type: 'property', key: DOCUMENT_SCANNER_PROPERTY, value: 'false' });
  }
  return gradleProps;
}

/**
 * Appends the exclude block to android/app/build.gradle. Pure string transform;
 * idempotent via EXCLUDE_MARKER.
 *
 * @param {string} contents - the build.gradle source
 * @returns {string} the rewritten source
 */
function applyDocumentScannerExclude(contents) {
  if (contents.includes(EXCLUDE_MARKER)) {
    return contents;
  }
  return `${contents.trimEnd()}\n${EXCLUDE_BLOCK}`;
}

function withAndroidCameraNoDocumentScanner(config) {
  const withProperty = withGradleProperties(config, (modConfig) => {
    modConfig.modResults = applyDocumentScannerProperty(modConfig.modResults);
    return modConfig;
  });
  return withAppBuildGradle(withProperty, (modConfig) => {
    modConfig.modResults.contents = applyDocumentScannerExclude(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(
  withAndroidCameraNoDocumentScanner,
  'with-android-camera-no-document-scanner',
  '1.0.0',
);
module.exports.applyDocumentScannerProperty = applyDocumentScannerProperty;
module.exports.applyDocumentScannerExclude = applyDocumentScannerExclude;
module.exports.DOCUMENT_SCANNER_PROPERTY = DOCUMENT_SCANNER_PROPERTY;
module.exports.DOCUMENT_SCANNER_GROUP = DOCUMENT_SCANNER_GROUP;
module.exports.DOCUMENT_SCANNER_MODULE = DOCUMENT_SCANNER_MODULE;
module.exports.EXCLUDE_MARKER = EXCLUDE_MARKER;
