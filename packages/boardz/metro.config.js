const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so edits to the @boardsesh/* shared packages reload.
config.watchFolders = [monorepoRoot];

function ignoredRootPattern(directory) {
  const escaped = path
    .resolve(directory)
    .split(path.sep)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[/\\\\]');
  return new RegExp(`^${escaped}(?:[/\\\\].*)?$`);
}

// Directories Boardz never imports from: agent tooling, local build output, and
// the upstream mobile app (its nested web runtime would otherwise be crawled too).
const ignoredRoots = ['.agents', '.claude', '.codex', '.local-work', '.boardsesh', 'packages/mobile'].map((directory) =>
  ignoredRootPattern(path.join(monorepoRoot, directory)),
);
config.resolver.blockList = config.resolver.blockList
  ? [].concat(config.resolver.blockList, ignoredRoots)
  : ignoredRoots;

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// pnpm's isolated linker can give a shared package its own copy of a peer
// dependency. Two copies of React or React Query means two contexts, and a shared
// hook can't see the app's provider. Send every bare import of these to this
// app's copy. Same list as packages/mobile/metro.config.js.
const SINGLETON_MODULES = [
  'react',
  '@tanstack/react-query',
  'react-native-gesture-handler',
  'react-native-reanimated',
  'react-native-worklets',
];
const singletonRoots = Object.fromEntries(
  SINGLETON_MODULES.map((name) => [name, path.resolve(projectRoot, 'node_modules', name)]),
);

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
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

module.exports = config;
