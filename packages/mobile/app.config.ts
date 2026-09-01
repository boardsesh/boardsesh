import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * Languages the binary ships, as iOS language codes. Single source for two things
 * that must agree: `ios.infoPlist.CFBundleLocalizations` (what the App Store lists
 * under "Languages", and what iOS matches the device locale against) and the
 * top-level `locales` map (which Expo turns into <lang>.lproj/InfoPlist.strings at
 * prebuild). Must cover every language in SUPPORTED_LOCALES —
 * scripts/mobile-locales-parity.test.ts enforces that, and that each code has a
 * matching locales/<code>.json translating the same keys.
 */
export const APP_LOCALIZATIONS = ['en', 'de', 'es', 'fr'] as const;

/** Where the InfoPlist strings for a declared localization live, relative to this config. */
export function localeStringsPath(language: string): string {
  return `./locales/${language}.json`;
}

type WebPlatformResolution = {
  platforms: NonNullable<ExpoConfig['platforms']>;
  web?: NonNullable<ExpoConfig['web']>;
  baseUrl?: string;
};

/** Keep web opt-in without adding any native fingerprint source files. */
export function resolveWebPlatforms(envValue: string | undefined): WebPlatformResolution {
  if (envValue !== '1') return { platforms: ['ios', 'android'] };

  // Serve the SPA under /app by default (the Next dev proxy + the legacy
  // prod-static path). Set BOARDSESH_WEB_BASE_URL=/ to build the standalone
  // export a host/CDN serves at the root of app.boardsesh.com. Read ONLY inside
  // this web branch so native builds (BOARDSESH_WEB unset) resolve a
  // byte-identical config and keep their OTA fingerprint.
  //
  // Expo's experiments.baseUrl must be '' for root serving, never a bare '/'.
  // Expo prepends the base to every asset path, so '/' produces
  // '/' + '/assets/...' = '//assets/...', which a browser resolves as the HOST
  // `assets` (https://assets/...). That breaks every icon font and board-art
  // image on app.boardsesh.com while the root-absolute /_expo/* JS and CSS keep
  // working, so the app boots but renders no icons or board backgrounds.
  // Normalize a root base to '' so Expo emits root-absolute /assets/... URLs.
  const rawWebBaseUrl = process.env.BOARDSESH_WEB_BASE_URL ?? '/app';
  const webBaseUrl = rawWebBaseUrl === '/' ? '' : rawWebBaseUrl;

  return {
    platforms: ['ios', 'android', 'web'],
    web: { output: 'single', bundler: 'metro' },
    baseUrl: webBaseUrl,
  };
}

export function resolveWebHeadOrigin(
  webFlag: string | undefined,
  publicWebUrl: string | undefined,
): string | undefined {
  if (webFlag !== '1' || !publicWebUrl) return undefined;

  const parsedUrl = new URL(publicWebUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('EXPO_PUBLIC_WEB_URL must use http or https');
  }
  return parsedUrl.origin;
}

const DEFAULT_EAS_PROJECT_ID = '87499648-655e-4fb8-9856-65da37e55fb1';
const EAS_PROJECT_ID = process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? DEFAULT_EAS_PROJECT_ID;
// V3 OTA app id (the `expo-app-id` header the self-hosted server routes on). Inlined
// here — NOT imported — because Expo's config loader compiles only app.config.ts and
// can't resolve a sibling .ts import at config-read time (bundle check fails with
// "Cannot find module './src/lib/ota-app-id'"). The identical value lives in
// src/lib/ota-app-id.ts for the EAS preview-build branch switcher;
// mobile-ci-env-parity.test.ts
// asserts the two stay equal. NOT the EAS project id (that value is only the cert CN).
export const OTA_APP_ID = process.env.EXPO_PUBLIC_OTA_APP_ID ?? '007e6fd7-f200-448c-9449-8d48ba5d51fc';
const IOS_APP_STORE_URL = 'https://apps.apple.com/app/boardsesh/id6761350784';
const ANDROID_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.boardsesh.app';
const HEALTH_UPDATE_USAGE_DESCRIPTION = 'Boardsesh saves your finished climbing sessions to Apple Health as workouts.';
const HEALTH_SHARE_USAGE_DESCRIPTION =
  'Boardsesh reads your body weight to estimate calories and your saved Boardsesh workouts to prevent duplicates.';

// Public code-signing certificate for self-hosted OTA. certs/certificate.pem is the
// V3 app's public cert, exported from the expo-open-ota (control-plane) dashboard —
// the server generates and seals the private key; it never leaves the server. The
// cert's presence is a hard gate (see resolveUpdatesConfig) so we never ship a
// self-hosted OTA binary that can't verify update signatures.
const CODE_SIGNING_CERT_PATH = './certs/certificate.pem';

// Resolves the expo-observe ingest endpoint, read by the SDK from
// `extra.eas.observe.endpointUrl`.
//
// Derived from EXPO_UPDATES_URL rather than hardcoded, so the telemetry and the
// manifest can never point at different servers: one env var moves both. Gated
// on the same two conditions as the self-hosted updates path below — an
// EAS-hosted build has no server of ours to report to, and neither does a build
// with no server URL. Those builds simply collect nothing.
//
// The path is `/observe/{APP_ID}`; xprem's ingest router mounts
// `/observe/{APP_ID}/{PROJECT_ID}/v1/{logs,metrics}` and ignores PROJECT_ID
// (internal/router/routes_ingest.go), which the SDK appends.
//
// Exported for unit tests, like resolveUpdatesConfig.
export function resolveObserveEndpoint(otaAppId: string): string | undefined {
  if (process.env.EAS_BUILD) return undefined;

  const selfHostUrl = process.env.EXPO_UPDATES_URL;
  if (!selfHostUrl) return undefined;

  return `${new URL(selfHostUrl).origin}/observe/${otaAppId}`;
}

// Resolves the expo-updates block. Two distinct hosting paths:
//   • Preview/dev builds (made with `eas build`, EAS_BUILD set) stay on EAS
//     free-tier hosting at u.expo.dev — channel comes from eas.json. Unchanged.
//   • Production builds (bare `expo prebuild` in the TestFlight/Android
//     workflows) point at our self-hosted expo-open-ota server. The server URL
//     is supplied via EXPO_UPDATES_URL and the path is gated on the signing cert
//     existing (fail closed — see below). Until both are in place we fall back to
//     the EAS URL so the build still succeeds and OTA is simply inert. `eoas
//     publish` also reads updates.url to find the server, so the same env var
//     must be present at publish time.
// `projectRoot` is the ConfigContext's project root (packages/mobile) — the same
// base Expo resolves `codeSigningCertificate` against. We resolve the cert
// existence check against it too, rather than `process.cwd()`, so the fail-closed
// gate can't silently mis-fire if `expo prebuild` is ever invoked from a different
// directory (e.g. the monorepo root). Exported for unit tests.
export function resolveUpdatesConfig(easProjectId: string, projectRoot: string): ExpoConfig['updates'] {
  const easUrl = `https://u.expo.dev/${easProjectId}`;

  if (process.env.EAS_BUILD) {
    return { url: easUrl };
  }

  // Fail closed: only point a production binary at the self-hosted server when
  // BOTH the server URL and the public signing cert are present. Baking the
  // self-hosted update URL without code signing would let a compromised manifest
  // host (or a network MITM) push arbitrary JS to every installed app — the
  // device would have no way to verify the manifest came from us. Until the cert
  // is generated and committed we stay on the EAS URL (nothing is published there
  // for production, so OTA is simply inert), keeping every build safe to ship.
  const selfHostUrl = process.env.EXPO_UPDATES_URL;
  if (!selfHostUrl) {
    return { url: easUrl };
  }
  // Check the cert only once the server URL is set (skips the filesystem stat in
  // the common no-infra case, and avoids touching projectRoot when unused).
  if (!existsSync(resolve(projectRoot, CODE_SIGNING_CERT_PATH))) {
    return { url: easUrl };
  }

  return {
    url: selfHostUrl,
    enabled: true,
    // Written into Expo.plist (EXUpdatesRequestHeaders) and AndroidManifest by
    // `expo prebuild`. expo-app-id identifies the app to the V3 (control-plane)
    // server on every manifest/asset request, and `eoas@3` refuses to publish
    // without it — so it's baked unconditionally (present at both runtime and
    // publish). The production channel is a literal native-build invariant, not
    // workflow plumbing. xprem's official ControlCenter overrides only
    // xprem-branch while branch surfing, leaving the production channel fixed.
    requestHeaders: {
      'expo-app-id': OTA_APP_ID,
      'expo-channel-name': 'production',
      'xprem-branch': '',
    },
    // Verifies the manifest signature on-device so a compromised manifest host
    // can't push arbitrary JS. Private key lives only on the server.
    codeSigningCertificate: CODE_SIGNING_CERT_PATH,
    codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' as const },
  };
}

function resolveDevMetadata(): {
  branchName: string | null;
  qaNotes: string | null;
  qaNotesFilePath: string | null;
} {
  const branchName = process.env.BOARDSESH_DEV_BRANCH_NAME ?? null;
  const qaNotes = process.env.BOARDSESH_DEV_QA_NOTES ?? null;
  const qaNotesFilePath = process.env.BOARDSESH_DEV_QA_NOTES_FILE ?? null;

  if (!branchName && !qaNotes) {
    return { branchName: null, qaNotes: null, qaNotesFilePath: null };
  }

  return { branchName, qaNotes, qaNotesFilePath };
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\.$/, '');
}

function normalizeHostValues(hostValues: readonly string[]): string[] {
  return hostValues.map(normalizeHost).filter((host) => host.length > 0);
}

function resolveTailscaleHosts(): string[] {
  // Explicit override — accepted as comma-separated hosts. Honoured even when
  // empty so cloud builds (EAS, CI) can short-circuit the tailscale probe by
  // setting TAILSCALE_HOSTS= without paying the 2s subprocess timeout.
  const envHosts = process.env.TAILSCALE_HOSTS;

  if (envHosts !== undefined) {
    return normalizeHostValues(envHosts.split(','));
  }

  // Skip the subprocess on known cloud build environments — tailscale CLI
  // never exists there, and the failing exec still costs the 2s timeout.
  if (process.env.CI || process.env.EAS_BUILD || process.env.EAS_BUILD_RUNNER) {
    return [];
  }

  try {
    const rawStatus = execSync('tailscale status --json', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).toString();

    const status = JSON.parse(rawStatus) as {
      Self?: { DNSName?: string };
      Peer?: Record<string, { DNSName?: string; Online?: boolean }>;
    };
    const onlinePeers = Object.values(status.Peer ?? {}).filter((peer) => peer.Online);
    const hosts = [
      ...(status.Self?.DNSName ? [status.Self.DNSName] : []),
      ...onlinePeers.flatMap((peer) => (peer.DNSName ? [peer.DNSName] : [])),
    ];

    return Array.from(new Set(normalizeHostValues(hosts)));
  } catch {
    return [];
  }
}

function isDevBuildProfile(): boolean {
  // EAS_BUILD_PROFILE is set by `eas build` per the profile in eas.json.
  // Treat unset (local `expo prebuild` / dev runs) as a dev build too.
  const profile = process.env.EAS_BUILD_PROFILE;
  return profile === undefined || profile === 'development' || profile === 'development-device';
}

// Native Google Sign-In registers the reversed iOS OAuth client id as a
// CFBundleURLScheme so its account-picker redirect lands back in the app.
// Prefer an explicit override; otherwise derive it from the iOS client id.
// Returns null when neither is set (Apple-only dev builds) so `expo prebuild`
// stays valid without Google credentials — the real EAS build supplies them.
function resolveGoogleIosUrlScheme(): string | null {
  const explicit = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;
  if (explicit && explicit.length > 0) return explicit;
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  if (!iosClientId) return null;
  // 1234-abc.apps.googleusercontent.com → com.googleusercontent.apps.1234-abc
  const match = iosClientId.match(/^(.+)\.apps\.googleusercontent\.com$/);
  return match ? `com.googleusercontent.apps.${match[1]}` : null;
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig & { newArchEnabled?: boolean } => {
  const devMetadata = resolveDevMetadata();
  const hasDevMetadata = devMetadata.branchName || devMetadata.qaNotes || devMetadata.qaNotesFilePath;
  const tailscaleHosts = resolveTailscaleHosts();
  const isDevBuild = isDevBuildProfile();
  // The dedicated screenshots simulator build (scripts/mobile-build-sim-app.ts)
  // sets this so we bake dev-menu suppression into Info.plist — see
  // ./plugins/with-screenshot-dev-menu. Off for every other build.
  const isScreenshotBuild = process.env.BOARDSESH_SCREENSHOT_BUILD === '1';
  const webPlatform = resolveWebPlatforms(process.env.BOARDSESH_WEB);
  const webHeadOrigin = resolveWebHeadOrigin(process.env.BOARDSESH_WEB, process.env.EXPO_PUBLIC_WEB_URL);

  // The "Boardsesh Dev" variant (set by .github/workflows/android-apk-dev-client.yml
  // and `expo prebuild` runs that pass BOARDSESH_APP_VARIANT=dev). It ships under a
  // separate Android package so the dev-client APK installs side-by-side with the
  // production app, shows a distinct name, and wears reddish hue-shifted icons
  // (packages/mobile/dev-assets, regenerate via `vp run mobile:make-dev-icons`).
  // Deliberately scoped to Android identity + icons: `scheme`, ios.bundleIdentifier,
  // and the iOS entitlement/App-Group block stay on the production values (changing
  // the scheme breaks OAuth deep-link redirects; the iOS entitlements are irrelevant
  // to an Android-only build). See docs/android-sideload-build.md.
  const isDevVariant = process.env.BOARDSESH_APP_VARIANT === 'dev';
  const appName = isDevVariant ? 'Boardsesh Dev' : 'Boardsesh';
  const androidPackage = isDevVariant ? 'com.boardsesh.app.dev' : 'com.boardsesh.app';
  const iconPath = isDevVariant ? './dev-assets/icon.png' : './assets/icon.png';
  const adaptiveIconPath = isDevVariant ? './dev-assets/adaptive-icon.png' : './assets/adaptive-icon.png';
  const splashIconPath = isDevVariant ? './dev-assets/splash-icon.png' : './assets/splash-icon.png';

  // Only register the Google Sign-In config plugin when we can supply a valid
  // iosUrlScheme; without Google credentials the entry is omitted (Apple-only).
  const googleIosUrlScheme = resolveGoogleIosUrlScheme();
  type PluginEntry = NonNullable<ExpoConfig['plugins']>[number];
  const googleSignInPlugin: PluginEntry[] = googleIosUrlScheme
    ? [['@react-native-google-signin/google-signin', { iosUrlScheme: googleIosUrlScheme }]]
    : [];

  // Telemetry ingest for expo-observe. Undefined on EAS-hosted and
  // no-server builds, which is what keeps them from reporting anywhere.
  const observeEndpointUrl = resolveObserveEndpoint(OTA_APP_ID);

  return {
    ...config,
    name: appName,
    slug: 'boardsesh',
    owner: 'boardsesh',
    version: '2.4.0',
    scheme: 'com.boardsesh.app',
    orientation: 'portrait',
    icon: iconPath,
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    // PILOT (draft — measure before merge): React Compiler auto-memoization.
    // SDK 57's babel-preset-expo enables babel-plugin-react-compiler when Expo
    // CLI sees experiments.reactCompiler — it forwards it as the metro
    // `customTransformOptions.reactCompiler` flag, which the babel transformer
    // turns into the `supportsReactCompiler` babel caller the preset reads. No
    // babel.config.js is required (the project has none; the preset is applied
    // by Expo's metro transformer). Requires New Architecture (enabled above)
    // and is compiler-safe-by-default: it skips any component that violates the
    // Rules of React rather than miscompiling it. We don't use NativeWind (the
    // one SDK 57 incompatibility). This is a structural attack on the
    // missed-memoization re-render cliffs in the Android-16 freeze work, but it
    // changes memoization behaviour app-wide, so it MUST be measured on a
    // preview build (compiler on vs off) before this draft is promoted.
    experiments: {
      ...config.experiments,
      reactCompiler: true,
      ...(webPlatform.baseUrl ? { baseUrl: webPlatform.baseUrl } : {}),
    },
    // Web is opt-in so OTA/EAS jobs that do not set BOARDSESH_WEB continue to
    // resolve the historical mobile-only config and native fingerprint.
    platforms: webPlatform.platforms,
    ...(webPlatform.web ? { web: webPlatform.web } : {}),
    // Board backgrounds are bundled via explicit require() in
    // src/lib/board-backgrounds-manifest.ts (canonical files live in
    // packages/web/public/images, no duplication), so they're picked up
    // by Metro regardless of this pattern. Keep the default-ish glob for
    // anything we drop under assets/ later.
    assetBundlePatterns: ['assets/**/*'],
    // Localized system dialogs. Expo's built-in `locales` support writes each
    // file to <lang>.lproj/InfoPlist.strings during prebuild, so the permission
    // prompts follow the device language instead of always being English. The
    // `ios.infoPlist` values below stay as the base/en strings.
    //
    // Every string in those files sits under an `ios` key — keys at the TOP level
    // of a locale file are emitted for BOTH platforms, and Expo's Android Locales
    // plugin turns them into res/values-b+<lang>/strings.xml, so InfoPlist keys
    // would land as junk Android string resources.
    //
    // This is also what makes the App Store product page list German, Spanish
    // and French under "Languages" — Apple reads the localizations shipped in
    // the binary, not the storefront listings, so a de-DE listing alone would
    // still show "English" there.
    locales: Object.fromEntries(APP_LOCALIZATIONS.map((language) => [language, localeStringsPath(language)])),
    ...(EAS_PROJECT_ID
      ? {
          // `fingerprint` (not `appVersion`): the runtimeVersion is a hash of the
          // native project (deps, config plugins, entitlements, native dirs).
          // OTA updates only reach a binary whose native fingerprint matches, so a
          // JS-only change keeps the same fingerprint (OTA lands) while any native
          // change yields a new fingerprint (the OTA is intrinsically incompatible
          // with old binaries and isn't delivered — they keep their embedded bundle
          // until a store build with the new fingerprint ships). This removes the
          // `appVersion` footgun where a native change without a `version` bump
          // could push JS to a binary lacking the native capability it needs.
          //
          // The NATIVE BUILD sets EXPO_UPDATES_FINGERPRINT_OVERRIDE to the gate's
          // Linux fingerprint, so this returns it as a LITERAL runtimeVersion that
          // prebuild bakes into the binary's Expo.plist. That forces the iOS binary
          // onto the *Linux* fingerprint instead of the macOS one it would otherwise
          // resolve at build time — `@expo/fingerprint` is not deterministic across
          // Linux/macOS, and that divergence stranded iOS OTAs (the binary embedded a
          // hash the Linux publish never published under). The OTA publish does NOT
          // set the override: it resolves the CURRENT commit's fingerprint fresh (on
          // Linux), which matches the binary's embedded Linux value for a JS-only
          // commit, and on a native change resolves the NEW fingerprint so old
          // binaries are correctly excluded. Override unset => identical to before, so
          // the gate's canonical fingerprint is unchanged. See docs/mobile-ota-updates.md.
          runtimeVersion: process.env.EXPO_UPDATES_FINGERPRINT_OVERRIDE?.trim()
            ? process.env.EXPO_UPDATES_FINGERPRINT_OVERRIDE.trim()
            : { policy: 'fingerprint' as const },
          updates: resolveUpdatesConfig(EAS_PROJECT_ID, projectRoot),
        }
      : {}),
    ios: {
      bundleIdentifier: 'com.boardsesh.app',
      appStoreUrl: IOS_APP_STORE_URL,
      // Required by @bacons/apple-targets to assign the widget extension
      // target's DEVELOPMENT_TEAM build setting. Matches the existing main
      // target value baked into Boardsesh.xcodeproj/project.pbxproj.
      appleTeamId: '9L3HKPZBH3',
      // Universal Links for the multiplayer join flow:
      // https://www.boardsesh.com/join/{sessionId} (and the apex domain, since
      // either can appear in a shared link). The web /join page is the no-app
      // fallback. The matching apple-app-site-association is served by
      // packages/web at /.well-known/apple-app-site-association. Changing this
      // requires a native rebuild (it's baked into the entitlements).
      associatedDomains: ['applinks:www.boardsesh.com', 'applinks:boardsesh.com'],
      // Sign in with Apple. Expo injects the com.apple.developer.applesignin
      // entitlement; the capability must also be enabled on the com.boardsesh.app
      // App ID in the Apple Developer portal (manual, one-time). App Review
      // requires Apple sign-in whenever a third-party login (Google) is offered.
      usesAppleSignIn: true,
      // iPad gets a first-class adaptive UI (sidebar + panes). `requireFullScreen`
      // is intentionally left unset (false) so Slide Over / Split View work — a
      // narrow split falls back to the phone UI verbatim (see `size-class.ts`).
      supportsTablet: true,
      // Entitlements for the App Group (shared with the BoardseshWidgets target),
      // shared keychain (so SharedKeychain.swift can read auth + push tokens),
      // and APNs (so ActivityKit can register Live Activity push tokens).
      // These carried over from the retired Capacitor app's App.entitlements.
      entitlements: {
        'com.apple.security.application-groups': ['group.com.boardsesh.app'],
        'keychain-access-groups': ['$(AppIdentifierPrefix)group.com.boardsesh.app'],
        'aps-environment': 'production',
      },
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        CFBundleLocalizations: [...APP_LOCALIZATIONS],
        // iPad rotates freely — landscape is the primary canvas for the sidebar +
        // panes — while iPhone stays portrait-locked via the top-level
        // `orientation: 'portrait'`. This `~ipad` key overrides the base
        // UISupportedInterfaceOrientations for iPad only.
        'UISupportedInterfaceOrientations~ipad': [
          'UIInterfaceOrientationPortrait',
          'UIInterfaceOrientationPortraitUpsideDown',
          'UIInterfaceOrientationLandscapeLeft',
          'UIInterfaceOrientationLandscapeRight',
        ],
        NSHealthUpdateUsageDescription: HEALTH_UPDATE_USAGE_DESCRIPTION,
        NSHealthShareUsageDescription: HEALTH_SHARE_USAGE_DESCRIPTION,
        NSBluetoothAlwaysUsageDescription:
          'Boardsesh uses Bluetooth to connect to your Kilter Board, Tension Board, or MoonBoard and light up climbing holds. No personal data is sent over Bluetooth.',
        NSBluetoothPeripheralUsageDescription:
          'Boardsesh uses Bluetooth to connect to your climbing board and control the LED holds.',
        NSLocationWhenInUseUsageDescription:
          'Boardsesh uses your location to find nearby boards to climb on and to discover nearby climbing sessions in Party Mode.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'Boardsesh uses your location to find nearby boards to climb on and to discover nearby climbing sessions in Party Mode.',
        NSSupportsLiveActivities: true,
        // bluetooth-central: continuous BLE reconnect + write-during-background.
        // remote-notification: lets the backend's 90s APNs heartbeat update
        // the Live Activity payload while the app is suspended.
        UIBackgroundModes: ['bluetooth-central', 'remote-notification'],
        // Read by SharedKeychain.swift to derive the keychain access group
        // (the expanded $(AppIdentifierPrefix) is only available in Info.plist
        // build settings, not in Swift code). Must match the value in the
        // keychain-access-groups entitlement above.
        BoardseshKeychainAccessGroup: '$(AppIdentifierPrefix)group.com.boardsesh.app',
      },
    },
    android: {
      package: androidPackage,
      playStoreUrl: ANDROID_PLAY_STORE_URL,
      // App Links for the multiplayer join flow and retired OTA preview links:
      // https://www.boardsesh.com/join/{sessionId} and
      // https://www.boardsesh.com/preview/pr-N (plus the apex domain).
      // The preview ingress remains for old shared links; +native-intent maps it
      // to What's New, where xprem's marker is the only branch picker.
      // autoVerify lets Android open the link directly in the app once the
      // Digital Asset Links file (served by packages/web at
      // /.well-known/assetlinks.json) verifies the package signature. The web
      // /join page is the no-app fallback. Changing this requires a native
      // rebuild (it's baked into AndroidManifest.xml).
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [
            { scheme: 'https', host: 'www.boardsesh.com', pathPrefix: '/join' },
            { scheme: 'https', host: 'boardsesh.com', pathPrefix: '/join' },
            { scheme: 'https', host: 'www.boardsesh.com', pathPrefix: '/preview' },
            { scheme: 'https', host: 'boardsesh.com', pathPrefix: '/preview' },
          ],
          category: ['BROWSABLE', 'DEFAULT'],
        },
        {
          action: 'VIEW',
          autoVerify: true,
          data: [
            { scheme: 'https', host: 'www.boardsesh.com', pathPrefix: '/auth/reset-password' },
            { scheme: 'https', host: 'boardsesh.com', pathPrefix: '/auth/reset-password' },
          ],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
      // Keep the legacy predictive back gesture OFF. Enabling it
      // (android.predictiveBackGestureEnabled: true) currently breaks
      // cross-screen back navigation with Expo Router + react-native-screens —
      // Android stops dispatching the back event so the activity exits instead
      // of popping the stack (https://github.com/expo/expo/issues/39092). The
      // default is already false; we set it explicitly so nobody flips it on
      // before that regression is fixed upstream.
      predictiveBackGestureEnabled: false,
      // Adaptive launcher icon. The foreground is a transparent, safe-zone
      // padded version of the brand mark; the black background keeps launchers
      // from placing the dark mark inside a white squircle.
      // TODO(Phase 6): add `monochromeImage` (single-colour silhouette) for
      // Android 13+ themed icons, supplied by a designer (no AI-generated art).
      adaptiveIcon: {
        foregroundImage: adaptiveIconPath,
        backgroundColor: '#000000',
      },
      permissions: [
        'BLUETOOTH_SCAN',
        'BLUETOOTH_CONNECT',
        'ACCESS_FINE_LOCATION',
        // Background BLE session: a connectedDevice foreground service keeps the
        // board connection alive while backgrounded; POST_NOTIFICATIONS (Android
        // 13+) lets its ongoing media-style notification show. The <service> +
        // <receiver> elements are added by ./plugins/with-android-session-service.
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_CONNECTED_DEVICE',
        'POST_NOTIFICATIONS',
      ],
      // BLUETOOTH_SCAN needs `android:usesPermissionFlags="neverForLocation"` on
      // Android 12+ or the OS silently drops every scan result for a caller
      // without location permission. It is set in
      // ./plugins/with-android-bluetooth-feature, NOT here (this list can only
      // carry bare permission names) and NOT via react-native-ble-plx's
      // `neverForLocation: true` prop. Verified by running `expo prebuild
      // --platform android` both ways: the prop caps ACCESS_COARSE/FINE_LOCATION
      // at maxSdkVersion=30 — which would break expo-location (board/session
      // discovery) and expo-maps (Google Maps) on Android 12+ — and leaves
      // BLUETOOTH_SCAN untouched, because Expo's base permissions mod declares
      // it first and ble-plx's addScanPermissionToManifest early-returns on an
      // existing element. Our own mod gets the flag without the cap:
      //   <uses-permission-sdk-23 android:name="android.permission.ACCESS_FINE_LOCATION"/>   <!-- uncapped -->
      //   <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>          <!-- uncapped -->
      //   <uses-permission android:name="android.permission.BLUETOOTH_SCAN"
      //       android:usesPermissionFlags="neverForLocation" tools:targetApi="31"/>
      // Keep fine location uncapped on purpose.
      blockedPermissions: ['android.permission.BLUETOOTH_ADVERTISE'],
      // expo-maps on Android renders Google Maps, which needs an API key. iOS
      // uses Apple Maps and needs none. Supplied via env so iOS works out of the
      // box; the Android map stays blank until GOOGLE_MAPS_API_KEY is set + a
      // rebuild. Only emit the block when the key exists to keep config clean.
      ...(process.env.GOOGLE_MAPS_API_KEY
        ? { config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_API_KEY } } }
        : {}),
    },
    plugins: [
      // MUST stay FIRST — do not move it after expo-share-intent. @expo/config-
      // plugins composes withEntitlementsPlist mods so they execute in REVERSE
      // registration order (the earliest-registered plugin's callback runs
      // LAST). So registering this first is exactly what makes it run last and
      // observe the final merged array after expo-share-intent has prepended its
      // App Group. Verified against the installed @expo/config-plugins: with this
      // plugin first the chain runs [share-intent, dedup] → one group; moving it
      // after expo-share-intent runs [dedup, share-intent] → the duplicate
      // survives. Same ordering rule the BoardseshWidgets build-settings plugin
      // relies on below.
      './plugins/with-share-intent-app-group-dedup',
      'expo-router',
      'expo-secure-store',
      // Native Sign in with Apple (adds the entitlement alongside usesAppleSignIn).
      'expo-apple-authentication',
      // Native Google Sign-In — only when an iosUrlScheme is resolvable (see above).
      ...googleSignInPlugin,
      'expo-localization',
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Boardsesh uses your location to find nearby boards to climb on and to discover nearby climbing sessions in Party Mode.',
        },
      ],
      // Board search map. Location permissions are already handled by
      // expo-location above; the Android Google Maps key is set via
      // android.config.googleMaps.apiKey (env-gated). iOS uses Apple Maps.
      'expo-maps',
      // Android 15/16 edge-to-edge theme. REQUIRED — do not remove (commit
      // 5235c8ba0 removed it and reintroduced the Pixel 10 / Galaxy S24+ freeze).
      // Android 16 forces edge-to-edge at the WINDOW level, but Expo SDK 56's
      // unversioned `withEdgeToEdge` runs `withRestoreDefaultTheme`, which forces
      // the Android `AppTheme` parent back to `Theme.AppCompat.DayNight.NoActionBar`
      // (a NON-edge-to-edge theme) unless THIS plugin reapplies the edge-to-edge
      // parent (`Theme.EdgeToEdge`). With edge-to-edge windows on a non-edge-to-edge
      // theme, the autolinked react-native-edge-to-edge native layer (and <SystemBars>)
      // resolves `Theme.EdgeToEdge` styleables that don't exist — logcat fills with
      // `Invalid resource ID 0x000000xx` and touch dies on most of the app until a
      // configuration change (e.g. split-screen) re-runs window metrics. Do NOT add
      // `android.edgeToEdgeEnabled` — Expo SDK 56 rejects it with a warning (Android 16
      // makes edge-to-edge mandatory); the parent theme is the only knob, and this
      // plugin is the supported way to set it (Expo's restore step explicitly defers
      // to it). The runtime <SystemBars> in app/_layout.tsx drives bar icon contrast.
      'react-native-edge-to-edge',
      // Android 12+ system splash + the launch screen on every platform. The
      // transparent brand mark sits on a black background for a consistent
      // icon-to-app handoff. app/_layout.tsx already drives
      // SplashScreen.preventAutoHideAsync()/hideAsync() once auth is ready.
      [
        'expo-splash-screen',
        {
          image: splashIconPath,
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: '#000000',
          dark: { image: splashIconPath, backgroundColor: '#000000' },
        },
      ],
      'expo-updates',
      'expo-web-browser',
      // Photo-library access for picking a profile avatar (Edit Profile screen).
      // Library-only — the editor doesn't open the camera, so we don't request
      // NSCameraUsageDescription. Adds NSPhotoLibraryUsageDescription on iOS and
      // the READ_MEDIA_IMAGES permission on Android; native change, ships on the
      // next build (not OTA).
      [
        'expo-image-picker',
        {
          photosPermission: 'Boardsesh uses your photo library so you can pick a profile picture.',
        },
      ],
      'react-native-ble-plx',
      // Brand tint #8C4A52 matches brandColors.tint — kept as a literal here
      // because app.config.ts runs at build time, before any theme provider.
      [
        'expo-notifications',
        {
          color: '#8C4A52',
        },
      ],
      // Makes Boardsesh a share target so a beta video link shared from
      // Instagram/TikTok (the OS share sheet) opens the app. iOS gets a no-UI
      // Share Extension that redirects into the host app; Android gets an
      // ACTION_SEND text intent filter. Restricted to links/text only (no
      // image/movie/file activation rules) so it never appears for raw media.
      // iosAppGroupIdentifier reuses the existing group.com.boardsesh.app (also
      // the plugin default of group.<bundleId>) shared with the widget target;
      // ./plugins/with-share-intent-app-group-dedup collapses the duplicate the
      // plugin otherwise leaves in the main app's entitlements. Registered
      // before @bacons/apple-targets — the share extension and the widget are
      // independent Xcode targets, but EAS managed credentials must extend
      // provisioning profiles for both com.boardsesh.app.share-extension and
      // com.boardsesh.app.widgets on the next native build (NOT deliverable via
      // OTA). androidIntentFilters only accepts text/* | image/* | video/* | */*.
      //
      // iosShareExtensionName MUST NOT sanitize to the main app target name
      // 'Boardsesh' (Expo names the main target after `name`, project is
      // Boardsesh.xcodeproj). expo-share-intent derives the extension's Xcode
      // target name from this value via .replace(/[^a-zA-Z0-9]/g,''), then bails
      // ("already exists … Skipping") if a target with that name exists — so
      // 'Boardsesh' collided with the main app and the extension was silently
      // never created (the share option never appeared in any iOS build). The
      // raw value is also the extension's CFBundleDisplayName, i.e. the label in
      // the share sheet's top app-icon row, so keep it short to avoid truncation.
      [
        'expo-share-intent',
        {
          iosActivationRules: {
            NSExtensionActivationSupportsWebURLWithMaxCount: 1,
            NSExtensionActivationSupportsText: true,
          },
          iosShareExtensionName: 'Boardsesh Beta',
          iosAppGroupIdentifier: 'group.com.boardsesh.app',
          androidIntentFilters: ['text/*'],
        },
      ],
      // Signs the Android `release` build type with our keystore when the
      // ANDROID_KEYSTORE_* env vars are set (CI), falling back to debug signing
      // for local `expo prebuild`. Lets the android-apk-rn workflow produce a
      // sideloadable release APK without committing the android/ project.
      // Excluded under EAS: `eas build` manages release signing through its own
      // credentials, and injecting our debug-fallback signingConfig there would
      // mis-sign EAS preview/production Android builds.
      ...(process.env.EAS_BUILD ? [] : ['./plugins/with-android-release-signing']),
      // Declares <uses-feature android.hardware.bluetooth_le required=false> for
      // Play device filtering. Unconditional (EAS-safe) — it's a pure manifest
      // addition with no signing/credential implications.
      './plugins/with-android-bluetooth-feature',
      // Lets sw600dp tablets rotate to landscape (the adaptive-shell canvas) while
      // phones stay portrait — the Android counterpart to the iOS `~ipad`
      // orientation override, set at runtime in MainActivity since
      // android:screenOrientation can't be resource-qualified by screen size.
      './plugins/with-android-tablet-orientation',
      // Declares com.android.vending as a visible package under Android 11+
      // package-visibility filtering, so the Play Install Referrer native module
      // (packages/mobile/modules/install-referrer) can bind to the Play Store
      // service instead of always resolving FEATURE_NOT_SUPPORTED. EAS-safe pure
      // manifest addition.
      './plugins/with-android-install-referrer-queries',
      // Adds the <service android:foregroundServiceType="connectedDevice"> + the
      // notification-action <receiver> for the background BLE session (the
      // Android counterpart to the iOS Live Activity). EAS-safe manifest-only mod.
      './plugins/with-android-session-service',
      // Caps Gradle heap + parallel workers so the heavy native build (CMake ×4
      // ABIs + Kotlin + JS bundle + R8) doesn't OOM-kill the daemon. EAS-safe.
      './plugins/with-android-gradle-memory',
      // Pins the generated Android wrapper below Gradle 9 until React Native's
      // included Foojay toolchain resolver plugin is compatible with Gradle 9.
      './plugins/with-android-gradle-wrapper-version',
      // Register this before @bacons/apple-targets so Expo's mod chain runs it
      // after the widget target has been created, while keeping the provider last.
      './plugins/with-boardsesh-widget-build-settings',
      // Boardsesh is iPhone-only. Keep App Store Connect from validating the
      // generated app target as a "Designed for iPhone/iPad" macOS binary.
      './plugins/with-ios-app-store-build-settings',
      // Adds the BoardseshWidgets Xcode target on every `expo prebuild`. The
      // widget bundle hosts the Live Activity UI (lock screen + Dynamic
      // Island) plus the Next/Previous AppIntents. Target sources live in
      // packages/mobile/targets/BoardseshWidgets/.
      '@bacons/apple-targets',
      // Adds an HTTP exception for Tailscale MagicDNS development bundlers
      // (e.g. marcosmbp-1.<tailnet>.ts.net). Only registered for development
      // builds — preview/production keep stock Expo ATS so we don't ship an
      // arbitrary-loads relaxation through App Store review.
      ...(isDevBuild ? ['./plugins/with-boardsesh-dev-networking'] : []),
      // Screenshots build only: bake dev-menu suppression (onboarding sheet /
      // floating gear / show-at-launch) into Info.plist so the dev-client chrome
      // can't cover the captured screens across a cold relaunch. See the plugin
      // for why per-launch args aren't enough on CI.
      ...(isScreenshotBuild ? ['./plugins/with-screenshot-dev-menu'] : []),
      // Apple Health entitlement + usage strings for the health-workouts native
      // module (writes finished sessions as HKWorkouts, reads body mass for the
      // calorie estimate). iOS-only mod; the module is skipped on Android. No
      // entitlement-merge ordering concern like the share-intent dedup above —
      // it sets its own distinct keys.
      './plugins/with-healthkit',
      // AppCheckCore (pulled in by Google Sign-In) is a Swift pod that depends
      // on GoogleUtilities and RecaptchaInterop, which don't define modules by
      // default. Without this fix CocoaPods refuses to link them as static
      // libraries and pod install fails. The plugin patches the generated
      // Podfile to add :modular_headers => true for both pods.
      './plugins/with-podfile-app-check-fix',
      // org/project make `expo prebuild` write a valid ios/sentry.properties so
      // the build-phase source-map + dSYM upload can find the Sentry project.
      // The auth token is supplied via the SENTRY_AUTH_TOKEN env var in CI
      // (never committed); url defaults to https://sentry.io/ (US region).
      ['@sentry/react-native/expo', { organization: 'boardsesh', project: 'boardsesh' }],
    ],
    extra: {
      ...config.extra,
      ...(webHeadOrigin ? { router: { headOrigin: webHeadOrigin } } : {}),
      // `eas` carries two unrelated things the SDKs read positionally: the EAS
      // project id, and the expo-observe endpoint. Kept in one spread so an
      // unset EAS_PROJECT_ID cannot take the observe endpoint down with it.
      ...(EAS_PROJECT_ID || observeEndpointUrl
        ? {
            eas: {
              ...(EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : {}),
              ...(observeEndpointUrl ? { observe: { endpointUrl: observeEndpointUrl } } : {}),
            },
          }
        : {}),
      ...(hasDevMetadata
        ? {
            devMetadata: {
              branchName: devMetadata.branchName,
              qaNotes: devMetadata.qaNotes,
              qaNotesFilePath: devMetadata.qaNotesFilePath,
            },
          }
        : {}),
      ...(tailscaleHosts.length > 0 ? { tailscaleHosts } : {}),
    },
  };
};
