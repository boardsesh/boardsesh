const path = require('node:path');

function resolveWebRuntimeModulePath(runtimeModules, moduleName) {
  for (const [packageName, packageRoot] of Object.entries(runtimeModules)) {
    if (moduleName === packageName || moduleName.startsWith(`${packageName}/`)) {
      return path.join(packageRoot, moduleName.slice(packageName.length));
    }
  }

  return null;
}

module.exports = { resolveWebRuntimeModulePath };
