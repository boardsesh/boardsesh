const path = require('node:path');

function resolveWebRuntimeModulePath(runtimeModules, moduleName) {
  for (const [packageName, packageRoot] of Object.entries(runtimeModules)) {
    // React Native's bare API aliases to RN Web. Its package metadata and
    // private subpaths are different packages' contracts, not RN Web paths.
    if (moduleName === packageName || (packageName !== 'react-native' && moduleName.startsWith(`${packageName}/`))) {
      return path.join(packageRoot, moduleName.slice(packageName.length));
    }
  }

  return null;
}

module.exports = { resolveWebRuntimeModulePath };
