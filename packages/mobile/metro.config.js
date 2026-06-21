const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

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
//  - <root>/.agents/* and <root>/.claude/* — agent config and hooks. Anchor
//    these to the repo root because this checkout itself may live under
//    .claude/worktrees.
//  - <root>/.local-work/* — local tooling scratch (e.g. an Android SDK install
//    whose ephemeral unzip temp dirs vanish mid-watch and crash the file watcher
//    with ENOENT, exit code 7).
//  - <root>/.boardsesh/* — local dev artifacts such as Xcode DerivedData and
//    Metro logs.
// Nothing the app imports lives in these directories, so pruning them is safe
// and lets the dev server boot in seconds.
const ignoredRoots = ['.agents', '.claude', '.local-work', '.boardsesh'].map((name) =>
  ignoredRootPattern(path.join(monorepoRoot, name)),
);
config.resolver.blockList = config.resolver.blockList
  ? [].concat(config.resolver.blockList, ignoredRoots)
  : ignoredRoots;

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Force a single instance of the React-context singletons. bun's isolated
// linker can materialise more than one physical copy of these (e.g. a shared
// package like @boardsesh/board-react resolves its own peer-dep copy of
// react-query / react under packages/shared/board-react/node_modules). Two
// copies = two React contexts, so the app's <QueryClientProvider> is invisible
// to the shared hooks' useQueryClient() → "No QueryClient set". Redirecting the
// bare specifier to the mobile app's copy guarantees one context across app +
// shared packages, while leaving relative/absolute paths to Metro's resolver.
const SINGLETON_MODULES = ['react', 'react-dom', '@tanstack/react-query'];
const singletonRoots = Object.fromEntries(
  SINGLETON_MODULES.map((name) => [name, path.resolve(projectRoot, 'node_modules', name)]),
);

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Only rewrite bare specifiers for the singleton packages — `react`,
  // `@tanstack/react-query`, and their subpaths (`react/jsx-runtime`, etc.).
  // Relative ('./x') and absolute imports fall straight through untouched.
  for (const name of SINGLETON_MODULES) {
    if (moduleName === name || moduleName.startsWith(`${name}/`)) {
      const redirected = path.join(singletonRoots[name], moduleName.slice(name.length));
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

      enhancedMiddleware(request, response, next);
    };
  },
};

module.exports = config;
