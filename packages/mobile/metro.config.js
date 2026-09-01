// getSentryExpoConfig wraps Expo's getDefaultConfig to add the Sentry source-map
// serializer (debug-id injection) so production stack traces symbolicate. It
// returns the same Expo config object, so every customisation below applies
// unchanged.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const path = require('path');
const { applyExpoWebResponseHeaders } = require('./expo-web-response-headers.cjs');
const { resolveWebRuntimeModulePath } = require('./metro-web-runtime-resolution.cjs');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getSentryExpoConfig(projectRoot);

config.watchFolders = [monorepoRoot];

function escapedPathPattern(filePath) {
  return path
    .resolve(filePath)
    .split(path.sep)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[/\\\\]');
}

function ignoredRootPattern(filePath) {
  return new RegExp(`^${escapedPathPattern(filePath)}(?:[/\\\\].*)?$`);
}

// Exclude non-source directories from Metro's crawl/watch:
//  - <root>/.agents/*, <root>/.claude/*, and <root>/.codex/* — agent config
//    and hooks. Anchor
//    these to the repo root because this checkout itself may live under
//    .claude/worktrees.
//  - <root>/.local-work/* — local tooling scratch (e.g. an Android SDK install
//    whose ephemeral unzip temp dirs vanish mid-watch and crash the file watcher
//    with ENOENT, exit code 7).
//  - <root>/.boardsesh/* — local dev artifacts such as Xcode DerivedData and
//    Metro logs.
// Nothing the app imports lives in these directories, so pruning them is safe
// and lets the dev server boot in seconds.
const ignoredRoots = ['.agents', '.claude', '.codex', '.local-work', '.boardsesh'].map((name) =>
  ignoredRootPattern(path.join(monorepoRoot, name)),
);
config.resolver.blockList = config.resolver.blockList
  ? [].concat(config.resolver.blockList, ignoredRoots)
  : ignoredRoots;

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Bundle Android XML vector drawables (assets/material-icons/*.xml) as ASSETS so
// @expo/ui's Compose `Icon` can load them via require() — the Material leading
// icons on the MoreForm nav rows. The board renderer uses react-native-svg's
// INLINE <Path> components (no .svg/.xml file imports, no svg/xml transformer, no
// custom sourceExts), so nothing parses .xml through a transformer — moving `xml`
// into assetExts is safe and doesn't affect react-native-svg.
config.resolver.assetExts = [...(config.resolver.assetExts ?? []), 'xml'];

// Force a single instance of the React-context singletons. pnpm's isolated
// linker can materialise more than one physical copy of these (e.g. a shared
// package like @boardsesh/board-react resolves its own peer-dep copy of
// react-query / react under packages/shared/board-react/node_modules). Two
// copies = two React contexts, so the app's <QueryClientProvider> is invisible
// to the shared hooks' useQueryClient() → "No QueryClient set". Redirecting the
// bare specifier to the mobile app's copy guarantees one context across app +
// shared packages, while leaving relative/absolute paths to Metro's resolver.
const SINGLETON_MODULES = [
  'react',
  'react-dom',
  '@tanstack/react-query',
  'react-native-gesture-handler',
  'react-native-reanimated',
  'react-native-worklets',
];
const singletonRoots = Object.fromEntries(
  SINGLETON_MODULES.map((name) => [name, path.resolve(projectRoot, 'node_modules', name)]),
);
const webReactDomRoot = path.resolve(projectRoot, 'web-runtime/node_modules/react-dom');

// Redirects used only by the Expo web target. Shims match exact bare
// specifiers; isolated runtime packages also preserve their imported subpaths.
// Native resolution never enters these tables, preserving the existing
// iOS/Android module graph and OTA fingerprint.
const WEB_SHIM_MODULES = {
  '@expo/ui/community/bottom-sheet': path.resolve(projectRoot, 'src/web-shims/bottom-sheet'),
  '@react-native-google-signin/google-signin': path.resolve(projectRoot, 'src/web-shims/google-signin'),
  '@react-native-async-storage/async-storage': path.resolve(projectRoot, 'src/web-shims/async-storage'),
  '@react-native-community/blur': path.resolve(projectRoot, 'src/web-shims/community-blur'),
  'expo-secure-store': path.resolve(projectRoot, 'src/web-shims/secure-store'),
  'expo-sqlite': path.resolve(projectRoot, 'src/web-shims/sqlite'),
  'expo-apple-authentication': path.resolve(projectRoot, 'src/web-shims/apple-authentication'),
};
const WEB_RUNTIME_MODULES = {
  '@gorhom/bottom-sheet': path.resolve(projectRoot, 'web-runtime/node_modules/@gorhom/bottom-sheet'),
  'react-native-web': path.resolve(projectRoot, 'web-runtime/node_modules/react-native-web'),
};
const WEB_SHIMS_DIR = path.resolve(projectRoot, 'src/web-shims');

function isWebShimOrigin(originModulePath) {
  return (
    originModulePath === WEB_SHIMS_DIR ||
    (originModulePath && originModulePath.startsWith(`${WEB_SHIMS_DIR}${path.sep}`))
  );
}

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const webRuntimeModulePath = platform === 'web' ? resolveWebRuntimeModulePath(WEB_RUNTIME_MODULES, moduleName) : null;
  if (webRuntimeModulePath) {
    return context.resolveRequest(context, webRuntimeModulePath, platform);
  }

  if (platform === 'web' && Object.hasOwn(WEB_SHIM_MODULES, moduleName) && !isWebShimOrigin(context.originModulePath)) {
    return context.resolveRequest(context, WEB_SHIM_MODULES[moduleName], platform);
  }

  // Only rewrite bare specifiers for the singleton packages — `react`,
  // `@tanstack/react-query`, and their subpaths (`react/jsx-runtime`, etc.).
  // Relative ('./x') and absolute imports fall straight through untouched.
  for (const name of SINGLETON_MODULES) {
    if (moduleName === name || moduleName.startsWith(`${name}/`)) {
      const singletonRoot = platform === 'web' && name === 'react-dom' ? webReactDomRoot : singletonRoots[name];
      const redirected = path.join(singletonRoot, moduleName.slice(name.length));
      return context.resolveRequest(context, redirected, platform);
    }
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

const existingEnhanceMiddleware = config.server?.enhanceMiddleware;

function nullableEnv(name) {
  const value = process.env[name];
  return value && value.length > 0 ? value : null;
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware, server) => {
    const enhancedMiddleware = existingEnhanceMiddleware ? existingEnhanceMiddleware(middleware, server) : middleware;

    return (request, response, next) => {
      const pathName = request.url?.split('?')[0];
      if (pathName === '/_boardsesh/metro-info') {
        sendJson(response, 200, {
          version: 1,
          branchName: nullableEnv('BOARDSESH_DEV_BRANCH_NAME'),
          commitSha: nullableEnv('BOARDSESH_DEV_COMMIT_SHA'),
          rootDir: nullableEnv('BOARDSESH_DEV_ROOT_DIR'),
          label: nullableEnv('BOARDSESH_DEV_WORKTREE_LABEL'),
          port: process.env.BOARDSESH_METRO_PORT ? Number(process.env.BOARDSESH_METRO_PORT) : null,
          startedAt: nullableEnv('BOARDSESH_DEV_STARTED_AT'),
          qaNotes: nullableEnv('BOARDSESH_DEV_QA_NOTES'),
          qaNotesFilePath: nullableEnv('BOARDSESH_DEV_QA_NOTES_FILE'),
        });
        return;
      }

      // The Next external rewrite forwards Metro's final response. Emit the
      // utility-surface directive upstream so it survives that proxy boundary;
      // +html.tsx provides the equivalent meta tag for static exports.
      applyExpoWebResponseHeaders(response, process.env.BOARDSESH_WEB, request.url);
      enhancedMiddleware(request, response, next);
    };
  },
};

module.exports = config;
