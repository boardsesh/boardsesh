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
  // SDK 58 defaults to package-version hashing. Keep hashing native source
  // and local config plugins so crash-fix edits require a matching binary.
  preset: 'strict',
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
      filePath: 'targets',
      reasons: ['iosAppleTargets'],
      overrideHashKey: 'iosAppleTargets',
      // @bacons/apple-targets compiles every file under targets/<name>/ into its
      // own Xcode target: today the BoardseshWidgets Live Activity extension's
      // Swift, Info.plist and Localizable.strings. The plugin finds those files by
      // PATH at prebuild, so the fingerprint only saw expo-target.config.js (a
      // module the config plugin require()s). A widget-only Swift edit therefore
      // resolved an unchanged runtimeVersion: PR CI skipped the iOS build, Main
      // Native Release cut no binary, and the OTA check said "Ships over-the-air"
      // for code no OTA can deliver (#7215). Dedup folds the expo-target.config.js
      // file source into this dir source.
      //
      // Scope: hashed for BOTH platforms, so a widget-only change also moves
      // Android's runtimeVersion and costs an Android build plus an Android OTA
      // cut-off it doesn't need (Android's prebuild never reads targets/). This
      // file can't scope a source to one platform: @expo/fingerprint require()s
      // it once with no platform argument, extraSources has no platform field,
      // and fileHookTransform isn't told the platform. Reading `--platform` off
      // argv would break for resolvers that pass it differently (the Xcode phase,
      // eoas) and for a process that resolves both platforms from one cached
      // require(). Like `../../patches` below, it over-triggers: the safe
      // direction.
      //
      // Nothing under targets/ is written at prebuild with today's config:
      // apple-targets 5 writes entitlements to ios/.targets/, writes Info.plist
      // only when it is missing, and writes Assets.xcassets only for
      // `icon`/`colors`/`images` in expo-target.config.js (none are set). The
      // widget's entitlements come from the `entitlements` object in
      // expo-target.config.js. Don't add a generated.entitlements here: the
      // plugin ignores it while that object exists (and warns in red at every
      // prebuild), yet it would still be hashed. .DS_Store and .swiftpm are in
      // @expo/fingerprint's default ignores; editor and patch leftovers are
      // covered by `ignorePaths` below.
      //
      // probe: appending a comment line to ClimbSessionLiveActivity.swift moves
      // the resolved iOS and Android runtimeVersions.
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
  // Dir sources hash every file on disk, tracked or not: @expo/fingerprint does
  // not read .gitignore and skips only its DEFAULT_IGNORE_PATHS (.DS_Store,
  // .swiftpm, build dirs). An open vim buffer under targets/, plugins/,
  // modules/ or locales/ would otherwise move a local resolve, and a manual
  // `vp run mobile:publish` from that tree would mint a runtimeVersion no binary
  // carries. None of these files is ever compiled. CI resolves from clean
  // checkouts, so this only guards local trees. collectIgnorePathsAsync in
  // Options.js APPENDS these to the defaults; it does not replace them.
  ignorePaths: ['**/*.swp', '**/*.swo', '**/*~', '**/*.orig', '**/*.rej'],
  // Keep the marketing version and the build numbers out of the fingerprint.
  // `ExpoConfigVersions` drops `version`, `android.versionCode` and
  // `ios.buildNumber` from the hashed Expo config (sourcer/Expo.js), so a
  // 2.6.0 -> 2.6.1 bump with no native change keeps runtimeVersion where it is
  // and installed binaries keep receiving OTAs. Without it every release bump
  // cut the whole store fleet off until the new binary was installed.
  //
  // `PackageJsonAndroidAndIosScriptsIfNotContainRun` is @expo/fingerprint's own
  // default (DEFAULT_SOURCE_SKIPS in Options.js). Options.js spreads this config
  // over the defaults, so naming `sourceSkips` here REPLACES that default rather
  // than adding to it. It is restated so behaviour stays the library's: scripts
  // without "run" in them (what `expo prebuild` leaves behind) stay unhashed.
  //
  // Names are looked up in the SourceSkips enum and an unknown name is ignored
  // without an error (Config.js normalizeSourceSkips), so a typo silently turns
  // a skip off. scripts/mobile-fingerprint-config.test.ts checks each name
  // against the installed enum and pins the resolved bitmask at 513 (1 | 512).
  //
  // Consequence: two marketing versions can share one fingerprint. A push that
  // only bumps the version does not move runtimeVersion, so it does not trigger
  // a native build on its own.
  sourceSkips: ['ExpoConfigVersions', 'PackageJsonAndroidAndIosScriptsIfNotContainRun'],
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
