const AUTOLINKING_SOURCE_IDS = new Set([
  'expoAutolinkingConfig:ios',
  'expoAutolinkingConfig:android',
  'rncoreAutolinkingConfig:ios',
  'rncoreAutolinkingConfig:android',
]);

// Bun's isolated linker appends a peer-resolution hash to a package's store
// directory. It describes the JS install graph, not native compatibility. Match
// the full store boundary so arbitrary `.bun/<text>+<hex>` strings cannot be
// rewritten, and verify that the encoded store package is the package installed
// below node_modules before removing the final peer token.
const BUN_STORE_MODULE_BOUNDARY =
  /((?:^|[/\\])node_modules[/\\]\.bun[/\\])([^/\\]+)([/\\]node_modules[/\\])((?:@[^/\\]+[/\\])?[^/\\]+)/g;
const ENCODED_PACKAGE_NAME = '((?:@[a-z0-9][a-z0-9._~-]*\\+)?[a-z0-9][a-z0-9._~-]*)';
const SEMVER_NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)';
const SEMVER_NON_NUMERIC_IDENTIFIER = '(?:\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_PRERELEASE_IDENTIFIER = `(?:${SEMVER_NUMERIC_IDENTIFIER}|${SEMVER_NON_NUMERIC_IDENTIFIER})`;
const SEMVER_BUILD_IDENTIFIER = '[0-9A-Za-z-]+';
const SEMVER_SHAPED_VERSION =
  `((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)` +
  `(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?` +
  `(?:\\+${SEMVER_BUILD_IDENTIFIER}(?:\\.${SEMVER_BUILD_IDENTIFIER})*)?)`;
const BUN_STORE_ENTRY_WITH_PEER_SUFFIX = new RegExp(
  `^${ENCODED_PACKAGE_NAME}@${SEMVER_SHAPED_VERSION}\\+([0-9a-f]{16})$`,
  'i',
);

function decodeBunStorePackageName(encodedPackageName) {
  if (!encodedPackageName.startsWith('@')) return encodedPackageName;
  const scopeSeparator = encodedPackageName.indexOf('+');
  if (scopeSeparator === -1) return encodedPackageName;
  return `${encodedPackageName.slice(0, scopeSeparator)}/${encodedPackageName.slice(scopeSeparator + 1)}`;
}

function normalizeTerminalBunPeerSuffixes(filePath) {
  return filePath.replace(
    BUN_STORE_MODULE_BOUNDARY,
    (storePath, storePrefix, storeEntry, nodeModulesBoundary, installedPackagePath) => {
      const entryMatch = storeEntry.match(BUN_STORE_ENTRY_WITH_PEER_SUFFIX);
      if (entryMatch === null) return storePath;

      const [, encodedPackageName, version] = entryMatch;
      const installedPackageName = installedPackagePath.replaceAll('\\', '/');
      if (decodeBunStorePackageName(encodedPackageName) !== installedPackageName) return storePath;

      return `${storePrefix}${encodedPackageName}@${version}${nodeModulesBoundary}${installedPackagePath}`;
    },
  );
}

function normalizeAutolinkingValue(value) {
  if (typeof value === 'string') return normalizeTerminalBunPeerSuffixes(value);
  if (Array.isArray(value)) return value.map(normalizeAutolinkingValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeAutolinkingValue(nestedValue)]),
    );
  }
  return value;
}

function fileHookTransform(source, chunk) {
  if (source.type !== 'contents' || !AUTOLINKING_SOURCE_IDS.has(source.id) || typeof chunk !== 'string') {
    return chunk;
  }
  return JSON.stringify(normalizeAutolinkingValue(JSON.parse(chunk)));
}

module.exports = {
  // @expo/fingerprint discovers patches only below packages/mobile by default.
  // Bun's patchedDependencies live at the monorepo root, so make their bodies a
  // first-class native input. Hash this config too: otherwise edits to the hook
  // could silently move runtimeVersion without showing which input changed.
  extraSources: [
    {
      type: 'file',
      filePath: 'fingerprint.config.js',
      reasons: ['boardseshFingerprintConfig'],
      overrideHashKey: 'boardseshFingerprintConfig',
    },
    {
      type: 'dir',
      filePath: 'locales',
      reasons: ['iosInfoPlistLocales'],
      overrideHashKey: 'iosInfoPlistLocales',
      // app.config.ts points `locales` at these files by PATH, and the fingerprint
      // hashes the config's resolved value (the paths), not the files behind it.
      // Expo's iOS Locales plugin writes each one into <lang>.lproj/InfoPlist.strings
      // at prebuild, so a permission-string edit is a native change no OTA can
      // deliver — without this it would leave runtimeVersion untouched and ship to
      // binaries whose prompts still read the old text.
      //
      // `overrideHashKey` names the source in the hash tree; it does NOT replace the
      // content digest (see createSourceId in @expo/fingerprint's hash/Hash.js —
      // the key is only the source id, contents are hashed either way). Confirmed by
      // Scope note: this hashes the dir for BOTH platforms, so an iOS-only wording
      // tweak also bumps the Android fingerprint and costs an Android rebuild it
      // doesn't strictly need. Accepted deliberately — Android's prebuild output
      // does depend on the *set* of languages here (Expo writes an empty
      // res/values-b+<lang>/strings.xml per entry), so a narrower per-platform
      // source would be wrong, not just fiddlier.
      //
      // probe: editing one string in locales/de.json moves the resolved iOS
      // runtimeVersion.
    },
    {
      type: 'dir',
      filePath: '../../patches',
      reasons: ['bunPatchedDependencies'],
      overrideHashKey: 'bunPatchedDependencies',
      // The whole dir is hashed, so a future patch to a WEB-ONLY dependency
      // would also move the fingerprint and force a store-build train. That
      // fails in the safe direction (over-triggering); if web patches ever
      // become common, narrow this to the mobile-reachable patch files.
    },
  ],
  fileHookTransform,
  // Ignored by @expo/fingerprint's config loader; exported only for focused unit
  // tests so the exact allowlist and normalization boundary cannot widen silently.
  __test: {
    AUTOLINKING_SOURCE_IDS,
    decodeBunStorePackageName,
    normalizeAutolinkingValue,
    normalizeTerminalBunPeerSuffixes,
  },
};
