// One path policy for automatic OTA and standalone browser builds. Keep this
// dependency-free: trusted preview gates load it before executing any PR code.
const APP_PACKAGE_PREFIXES = [
  'packages/mobile/',
  'packages/shared/',
  'packages/shared-schema/',
  'packages/board-constants/',
  'packages/board-renderer/',
];

// The app's static board-background manifest imports these across the package
// boundary. Other website images and retained PNG originals are not bundled.
const BUNDLED_BOARD_ART_PATH =
  /^packages\/web\/public\/images\/(?:decoy|grasshopper|kilter|moonboard|soill|tension|touchstone|woods)\/.*\.webp$/;

const COMMON_BUILD_INPUTS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/lib/app-build-inputs.mjs',
]);

const BROWSER_BUILD_INPUTS = new Set([
  'scripts/build-expo-web-export.sh',
  'scripts/lib/patch-expo-web-pwa-manifest.mjs',
  'scripts/lib/inspect-expo-web-export.mjs',
  'scripts/lib/carry-over-expo-web-chunks.mjs',
  'scripts/lib/expo-web-inputs.mjs',
  'scripts/lib/expo-web-preview-controller.cjs',
  'scripts/lib/expo-web-preview-cloudflare.mjs',
  '.github/workflows/expo-web-preview.yml',
  '.github/workflows/expo-web-preview-publish.yml',
  '.github/workflows/expo-web-preview-lifecycle.yml',
  'deploy/app-subdomain/_headers',
  'deploy/app-subdomain/_redirects',
  'deploy/app-subdomain/_routes.json',
  'deploy/app-subdomain/robots.txt',
]);

const NATIVE_BUILD_INPUTS = new Set([
  'scripts/mobile-publish.ts',
  'scripts/lib/mobile-publish-retry.ts',
  'scripts/lib/ota-branch-probe.ts',
  'scripts/lib/eoas.ts',
]);

const NATIVE_PREVIEW_INPUTS = new Set([
  'scripts/mobile-ota-boot-check.ts',
  'scripts/mobile-ota-boot-fixture.gradle',
  'scripts/mobile-ota-boot-preview.ts',
  'scripts/mobile-ota-preview-candidates.ts',
  'scripts/mobile-ota-preview-source.ts',
  'scripts/mobile-ota-preview-reuse.ts',
  'scripts/lib/mobile-release-policy.ts',
  'scripts/lib/ota-boot-check.ts',
  'scripts/lib/ota-preview-boot-receipt.ts',
  'scripts/lib/ota-publish-protocol.ts',
  '.github/workflows/mobile-ota-boot-check.yml',
  '.github/workflows/mobile-ota-preview.yml',
]);

const NATIVE_PRODUCTION_INPUTS = new Set([
  'scripts/mobile-ota-promote.ts',
  'scripts/mobile-ota-unreleased-native.ts',
  'scripts/mobile-ota-schema-ready.mjs',
  'scripts/mobile-ota-server-ready.mjs',
  'scripts/mobile-ota-stage-verify.ts',
  '.github/workflows/mobile-ota-production.yml',
]);

function isDocumentationOrTest(filePath) {
  return (
    /\.(?:md|mdx)$/i.test(filePath) ||
    /(?:^|\/)(?:docs|__tests__|__mocks__)(?:\/|$)/.test(filePath) ||
    /\.(?:test|spec)\.[^/]+$/.test(filePath) ||
    filePath.startsWith('packages/mobile/.maestro/') ||
    filePath.startsWith('packages/mobile/screenshot-fixtures/') ||
    filePath === 'packages/mobile/vite.config.ts'
  );
}

function isCommonAppInput(filePath) {
  return (
    APP_PACKAGE_PREFIXES.some((prefix) => filePath.startsWith(prefix)) ||
    filePath.startsWith('patches/') ||
    BUNDLED_BOARD_ART_PATH.test(filePath) ||
    COMMON_BUILD_INPUTS.has(filePath)
  );
}

function isBrowserOnly(filePath) {
  return (
    /\.web\.[cm]?[jt]sx?$/.test(filePath) ||
    filePath.startsWith('packages/mobile/web-runtime/') ||
    filePath.startsWith('packages/mobile/src/web-shims/') ||
    filePath.startsWith('packages/mobile/public/')
  );
}

/** Whether a path can change the native app or the selected OTA pipeline. */
export function isNativeAppAffecting(filePath, scope = 'preview') {
  if (isDocumentationOrTest(filePath) || isBrowserOnly(filePath)) return false;
  return (
    isCommonAppInput(filePath) ||
    NATIVE_BUILD_INPUTS.has(filePath) ||
    (scope === 'production' ? NATIVE_PRODUCTION_INPUTS : NATIVE_PREVIEW_INPUTS).has(filePath)
  );
}

/** Native app paths, in their original order. Shared and dependency files stay conservative. */
export function nativeAppAffectingPaths(filePaths, scope = 'preview') {
  return Array.from(filePaths).filter((filePath) => isNativeAppAffecting(filePath, scope));
}

export function hasNativeAppAffectingChanges(filePaths, scope = 'preview') {
  for (const filePath of filePaths) {
    if (isNativeAppAffecting(filePath, scope)) return true;
  }
  return false;
}

/** Whether a path can change the standalone Expo browser app or its hosting. */
export function isBrowserAppAffecting(filePath) {
  if (isDocumentationOrTest(filePath)) return false;
  return (
    isCommonAppInput(filePath) ||
    filePath.startsWith('deploy/app-subdomain/functions/') ||
    BROWSER_BUILD_INPUTS.has(filePath)
  );
}

export function browserAppAffectingPaths(filePaths) {
  return Array.from(filePaths).filter(isBrowserAppAffecting);
}

export function hasBrowserAppAffectingChanges(filePaths) {
  for (const filePath of filePaths) {
    if (isBrowserAppAffecting(filePath)) return true;
  }
  return false;
}
