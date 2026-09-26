// Expo's Metro transform worker with one change: a CSS module's class map comes
// out in sorted key order, so one commit always exports the same bytes (#5808).
//
// lightningcss hands back a CSS module's class map as a Rust HashMap, whose
// iteration order is seeded per process. @expo/metro-config JSON-stringifies
// that map in the order it arrives, so expo-router's native-tabs CSS module
// shuffled its keys from one export to the next. That changed __common's bytes,
// and with them the Sentry debug id hashed from those bytes, and the eager
// brotli total moved by 1,334 bytes between two exports of the same commit.
// Sorting the keys changes no behaviour: consumers look class names up by key.
//
// metro.config.js points transformerPath here only when BOARDSESH_WEB=1, so
// native bundles and their transform cache keep Expo's own worker.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const expoRoot = path.dirname(require.resolve('expo/package.json'));
const upstreamWorkerPath = require.resolve('@expo/metro-config/build/transform-worker/transform-worker', {
  paths: [expoRoot],
});
// Resolve lightningcss the way Expo's css-modules.js does (from its own
// directory), so the module object patched below is the one it calls.
const lightningcssPath = require.resolve('lightningcss', { paths: [path.dirname(upstreamWorkerPath)] });

const SORTED_MARKER = Symbol.for('boardsesh.sortedCssModuleExports');

function sortCssModuleExports(cssModuleExports) {
  return Object.fromEntries(
    Object.keys(cssModuleExports)
      .sort()
      .map((className) => [className, cssModuleExports[className]]),
  );
}

// Expo's css-modules.js reads `require('lightningcss').transform` on every
// call, so replacing the property is enough; no patch file, which would move
// the native fingerprint (the root patches/ dir is a fingerprint input).
function installSortedCssModuleExports(lightningcss) {
  if (lightningcss.transform[SORTED_MARKER]) return;
  const upstreamTransform = lightningcss.transform;
  const transformWithSortedExports = function transformWithSortedExports(options) {
    const result = upstreamTransform.call(this, options);
    if (result && result.exports) result.exports = sortCssModuleExports(result.exports);
    return result;
  };
  transformWithSortedExports[SORTED_MARKER] = true;
  lightningcss.transform = transformWithSortedExports;
}

installSortedCssModuleExports(require(lightningcssPath));

const upstreamWorker = require(upstreamWorkerPath);

// Metro keys its transform cache on this file's contents, not the upstream
// worker's. Fold the upstream worker in too, so an Expo upgrade still misses.
const upstreamWorkerDigest = crypto.createHash('sha1').update(fs.readFileSync(upstreamWorkerPath)).digest('hex');

module.exports = {
  ...upstreamWorker,
  getCacheKey(...args) {
    return `${upstreamWorker.getCacheKey(...args)}$${upstreamWorkerDigest}`;
  },
  __test: { upstreamWorkerPath, sortCssModuleExports },
};
