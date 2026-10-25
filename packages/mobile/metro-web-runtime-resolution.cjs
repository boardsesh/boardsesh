const path = require('node:path');

function resolveWebRuntimeModulePath(runtimeModules, moduleName) {
  // SVG's browser renderer still imports the registry package removed in RN
  // 0.88. Use the same registry as RN Web's Image and Metro's browser assets.
  if (moduleName === '@react-native/assets-registry/registry' && runtimeModules['react-native-web']) {
    return path.join(runtimeModules['react-native-web'], 'dist/modules/AssetRegistry');
  }
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
