const AUTOLINKING_SOURCE_IDS = new Set([
  'expoAutolinkingConfig:ios',
  'expoAutolinkingConfig:android',
  'rncoreAutolinkingConfig:ios',
  'rncoreAutolinkingConfig:android',
]);

// pnpm's isolated linker stores a real package below
//   node_modules/.pnpm/<entry>/node_modules/<name>
// where <entry> is @pnpm/deps.path's depPathToFilename() of the lockfile dep
// path: `@scope/name` is encoded `@scope+name`, and parenthesised suffixes are
// flattened into `_`-joined tails — the patch marker first, then peer ids.
// Once the name exceeds virtualStoreDirMaxLength (120, pinned in
// pnpm-workspace.yaml) pnpm truncates it and appends a 32-hex digest instead.
//
// The peer tail describes the JS install graph, not native compatibility: it
// moves whenever an unrelated dependency shifts a peer resolution, churning
// runtimeVersion and forcing a native build train for nothing. Strip exactly
// that tail while KEEPING the patch marker, which is content-addressed over a
// genuine native input.
//
// Match the full store boundary and verify the encoded store package really is
// the package installed below node_modules. Anything that does not parse is
// returned untouched. Fails closed.
const PNPM_STORE_MODULE_BOUNDARY =
  /((?:^|[/\\])node_modules[/\\]\.pnpm[/\\])([^/\\]+)([/\\]node_modules[/\\])((?:@[^/\\]+[/\\])?[^/\\]+)/g;
const ENCODED_PACKAGE_NAME = '((?:@[a-z0-9][a-z0-9._~-]*\\+)?[a-z0-9][a-z0-9._~-]*)';
const SEMVER_NUMERIC_IDENTIFIER = '(?:0|[1-9]\\d*)';
const SEMVER_NON_NUMERIC_IDENTIFIER = '(?:\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_PRERELEASE_IDENTIFIER = `(?:${SEMVER_NUMERIC_IDENTIFIER}|${SEMVER_NON_NUMERIC_IDENTIFIER})`;
const SEMVER_BUILD_IDENTIFIER = '[0-9A-Za-z-]+';
const SEMVER_SHAPED_VERSION =
  `((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)` +
  `(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?` +
  `(?:\\+${SEMVER_BUILD_IDENTIFIER}(?:\\.${SEMVER_BUILD_IDENTIFIER})*)?)`;
const PNPM_PATCH_HASH_SEGMENT = '(_patch_hash=[0-9a-f]+)?';
// `_` is not legal in SemVer, so everything from the first `_` after the
// version and optional patch marker is unambiguously install-graph noise.
const PNPM_STORE_ENTRY_WITH_PEER_SUFFIX = new RegExp(
  `^${ENCODED_PACKAGE_NAME}@${SEMVER_SHAPED_VERSION}${PNPM_PATCH_HASH_SEGMENT}_.+$`,
  'i',
);

// pnpm encodes `@scope/name` as `@scope+name`.
function decodeStorePackageName(encodedPackageName) {
  if (!encodedPackageName.startsWith('@')) return encodedPackageName;
  const scopeSeparator = encodedPackageName.indexOf('+');
  if (scopeSeparator === -1) return encodedPackageName;
  return `${encodedPackageName.slice(0, scopeSeparator)}/${encodedPackageName.slice(scopeSeparator + 1)}`;
}

function normalizeTerminalStorePeerSuffixes(filePath) {
  return filePath.replace(
    PNPM_STORE_MODULE_BOUNDARY,
    (storePath, storePrefix, storeEntry, nodeModulesBoundary, installedPackagePath) => {
      const entryMatch = storeEntry.match(PNPM_STORE_ENTRY_WITH_PEER_SUFFIX);
      if (entryMatch === null) return storePath;

      const [, encodedPackageName, version, patchHashSegment] = entryMatch;
      const installedPackageName = installedPackagePath.replaceAll('\\', '/');
      if (decodeStorePackageName(encodedPackageName) !== installedPackageName) return storePath;

      return `${storePrefix}${encodedPackageName}@${version}${patchHashSegment ?? ''}${nodeModulesBoundary}${installedPackagePath}`;
    },
  );
}

function normalizeAutolinkingValue(value) {
  if (typeof value === 'string') return normalizeTerminalStorePeerSuffixes(value);
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
  // Patched dependencies live in the root pnpm workspace, so make their bodies a
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
      reasons: ['rootPatchedDependencies'],
      overrideHashKey: 'rootPatchedDependencies',
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
    decodeStorePackageName,
    normalizeAutolinkingValue,
    normalizeTerminalStorePeerSuffixes,
  },
};
