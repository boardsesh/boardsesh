const { createRunOncePlugin, withPodfile } = require('expo/config-plugins');

const MODULAR_HEADER_PODS = ['GoogleUtilities', 'RecaptchaInterop'];
const INSERTION_MARKER = 'use_expo_modules!';
const COMMENT = '  # AppCheckCore is Swift and these transitive ObjC pods need module maps when linked statically.';

function podDeclaration(podName) {
  return `  pod '${podName}', :modular_headers => true`;
}

function hasModularHeaderDeclaration(contents, podName) {
  const escapedPodName = podName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`pod\\s+['"]${escapedPodName}['"][^\\n]*:modular_headers\\s*=>\\s*true`).test(contents);
}

function applyGoogleSwiftStaticPodHeaders(contents) {
  const missingPods = MODULAR_HEADER_PODS.filter((podName) => !hasModularHeaderDeclaration(contents, podName));
  if (missingPods.length === 0) return contents;

  const insertionIndex = contents.indexOf(INSERTION_MARKER);
  if (insertionIndex === -1) {
    throw new Error(`Could not find ${INSERTION_MARKER} in generated Podfile.`);
  }

  const lineEndIndex = contents.indexOf('\n', insertionIndex);
  if (lineEndIndex === -1) {
    throw new Error(`Could not insert modular-header pods after ${INSERTION_MARKER}; Podfile has no line break.`);
  }

  const insertedBlock = [COMMENT, ...missingPods.map(podDeclaration)].join('\n');
  return `${contents.slice(0, lineEndIndex + 1)}${insertedBlock}\n${contents.slice(lineEndIndex + 1)}`;
}

function withGoogleSwiftStaticPodHeaders(config) {
  return withPodfile(config, (modConfig) => {
    modConfig.modResults.contents = applyGoogleSwiftStaticPodHeaders(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withGoogleSwiftStaticPodHeaders, 'with-google-swift-static-pod-headers', '1.0.0');
module.exports.applyGoogleSwiftStaticPodHeaders = applyGoogleSwiftStaticPodHeaders;
module.exports.MODULAR_HEADER_PODS = MODULAR_HEADER_PODS;
