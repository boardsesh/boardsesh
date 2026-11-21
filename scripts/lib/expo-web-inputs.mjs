// The production export and PR previews must agree on what changes the browser
// app. Keep this module dependency-free: trusted Actions tooling also imports it
// while inspecting PR paths, before any PR-authored code is executed.

const APP_PACKAGE_PREFIXES = [
  'packages/mobile/',
  'packages/shared/',
  'packages/shared-schema/',
  'packages/board-constants/',
  'packages/board-renderer/',
];

// Metro bundles these board backgrounds through the app's static require()
// manifest. Other web images are marketing assets; retained PNG originals are
// not bundled. A manifest-derived test guards newly consumed board-art roots.
const BUNDLED_BOARD_ART_PATH =
  /^packages\/web\/public\/images\/(?:decoy|grasshopper|kilter|moonboard|soill|tension|touchstone|woods)\/.*\.webp$/;

const APP_BUILD_INPUTS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
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

function isDocumentationOrTest(filePath) {
  return (
    /\.(?:md|mdx)$/i.test(filePath) ||
    /(?:^|\/)(?:__tests__|__mocks__)(?:\/|$)/.test(filePath) ||
    /\.(?:test|spec)\.[^/]+$/.test(filePath)
  );
}

/** Whether a repository-relative file can affect the standalone Expo web app. */
export function isAppAffecting(filePath) {
  if (isDocumentationOrTest(filePath)) return false;
  return (
    APP_PACKAGE_PREFIXES.some((prefix) => filePath.startsWith(prefix)) ||
    filePath.startsWith('patches/') ||
    filePath.startsWith('deploy/app-subdomain/functions/') ||
    BUNDLED_BOARD_ART_PATH.test(filePath) ||
    APP_BUILD_INPUTS.has(filePath)
  );
}

/** Retain app inputs from a changed-file list without reordering them. */
export function appAffectingPaths(filePaths) {
  return Array.from(filePaths).filter(isAppAffecting);
}

/** True for a PR or revision diff containing at least one browser-app input. */
export function hasAppAffectingChanges(filePaths) {
  for (const filePath of filePaths) {
    if (isAppAffecting(filePath)) return true;
  }
  return false;
}
