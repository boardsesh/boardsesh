// Expo includes React Native's native environment initializer in its legacy
// run-before-main list. If a dependency puts that module in the browser graph,
// Metro evaluates it before Expo Router and asks for a native bridge that does
// not exist. Keep Expo's browser polyfills/runtime, but never start native RN.
function filterWebStartupModules(modulePaths) {
  return modulePaths.filter(
    (modulePath) => !modulePath.replaceAll('\\', '/').endsWith('/react-native/Libraries/Core/InitializeCore.js'),
  );
}

module.exports = { filterWebStartupModules };
