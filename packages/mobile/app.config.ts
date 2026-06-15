import { execSync } from 'node:child_process';
import type { ExpoConfig, ConfigContext } from 'expo/config';

const DEFAULT_EAS_PROJECT_ID = '87499648-655e-4fb8-9856-65da37e55fb1';
const EAS_PROJECT_ID = process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? DEFAULT_EAS_PROJECT_ID;
const HEALTH_UPDATE_USAGE_DESCRIPTION = 'Boardsesh saves your finished climbing sessions to Apple Health as workouts.';
const HEALTH_SHARE_USAGE_DESCRIPTION =
  'Boardsesh reads your body weight to estimate calories and your saved Boardsesh workouts to prevent duplicates.';

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

export default ({ config }: ConfigContext): ExpoConfig & { newArchEnabled?: boolean } => {
  const devMetadata = resolveDevMetadata();
  const hasDevMetadata = devMetadata.branchName || devMetadata.qaNotes || devMetadata.qaNotesFilePath;
  const tailscaleHosts = resolveTailscaleHosts();
  const isDevBuild = isDevBuildProfile();

  // Only register the Google Sign-In config plugin when we can supply a valid
  // iosUrlScheme; without Google credentials the entry is omitted (Apple-only).
  const googleIosUrlScheme = resolveGoogleIosUrlScheme();
  type PluginEntry = NonNullable<ExpoConfig['plugins']>[number];
  const googleSignInPlugin: PluginEntry[] = googleIosUrlScheme
    ? [['@react-native-google-signin/google-signin', { iosUrlScheme: googleIosUrlScheme }]]
    : [];

  return {
    ...config,
    name: 'Boardsesh',
    slug: 'boardsesh',
    owner: 'boardsesh',
    version: '2.0.0',
    scheme: 'com.boardsesh.app',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    // Mobile-only; opting out of web keeps `expo export --platform=all` from
    // failing on missing `react-native-web` during EAS Update publishes.
    platforms: ['ios', 'android'],
    // Board backgrounds are bundled via explicit require() in
    // src/lib/board-backgrounds-manifest.ts (canonical files live in
    // packages/web/public/images, no duplication), so they're picked up
    // by Metro regardless of this pattern. Keep the default-ish glob for
    // anything we drop under assets/ later.
    assetBundlePatterns: ['assets/**/*'],
    ...(EAS_PROJECT_ID
      ? {
          runtimeVersion: { policy: 'appVersion' as const },
          updates: { url: `https://u.expo.dev/${EAS_PROJECT_ID}` },
        }
      : {}),
    ios: {
      bundleIdentifier: 'com.boardsesh.app',
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
      supportsTablet: false,
      // Entitlements for the App Group (shared with the BoardseshWidgets target),
      // shared keychain (so SharedKeychain.swift can read auth + push tokens),
      // and APNs (so ActivityKit can register Live Activity push tokens).
      // Matches the Capacitor app at repo-root mobile/ios/App/App/App.entitlements.
      entitlements: {
        'com.apple.security.application-groups': ['group.com.boardsesh.app'],
        'keychain-access-groups': ['$(AppIdentifierPrefix)group.com.boardsesh.app'],
        'aps-environment': 'production',
      },
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
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
      package: 'com.boardsesh.app',
      // App Links for the multiplayer join flow:
      // https://www.boardsesh.com/join/{sessionId} (and the apex domain).
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
        foregroundImage: './assets/adaptive-icon.png',
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
      // Do NOT add `neverForLocation` to BLUETOOTH_SCAN here: react-native-ble-plx
      // caps ACCESS_FINE_LOCATION at maxSdkVersion=30 when it's set, which would
      // break expo-location (board/session discovery) and expo-maps (Google Maps)
      // on Android 12+. We keep fine location uncapped on purpose.
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
      'expo-status-bar',
      // Android 12+ system splash + the launch screen on every platform. The
      // transparent brand mark sits on a black background for a consistent
      // icon-to-app handoff. app/_layout.tsx already drives
      // SplashScreen.preventAutoHideAsync()/hideAsync() once auth is ready.
      [
        'expo-splash-screen',
        {
          image: './assets/splash-icon.png',
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: '#000000',
          dark: { image: './assets/splash-icon.png', backgroundColor: '#000000' },
        },
      ],
      'expo-updates',
      // PostHog source-map upload for readable $exception stack traces. Adds an
      // Xcode build phase (iOS) + Gradle task (Android) that run @posthog/cli
      // during `expo prebuild` → archive/assemble. Gated on POSTHOG_CLI_API_KEY:
      // those scripts call the CLI WITHOUT --no-fail, so they hard-fail the build
      // when the CLI can't authenticate — applying the plugin only when the key is
      // present keeps local prebuilds, dev, and fork CI green (no key → no upload
      // phase added). The debug IDs that make uploads matchable are injected by
      // getPostHogExpoConfig in metro.config.js regardless of this gate, so OTA
      // (EAS Update) uploads — handled in mobile-eas-update.yml — keep working.
      // The plugin also disables Xcode User Script Sandboxing by default so the
      // upload phase can run (same approach as Sentry's RN plugin).
      ...(process.env.POSTHOG_CLI_API_KEY ? ['posthog-react-native/expo'] : []),
      'expo-web-browser',
      'react-native-ble-plx',
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
      // Adds the <service android:foregroundServiceType="connectedDevice"> + the
      // notification-action <receiver> for the background BLE session (the
      // Android counterpart to the iOS Live Activity). EAS-safe manifest-only mod.
      './plugins/with-android-session-service',
      // Caps Gradle heap + parallel workers so the heavy native build (CMake ×4
      // ABIs + Kotlin + JS bundle + R8) doesn't OOM-kill the daemon. EAS-safe.
      './plugins/with-android-gradle-memory',
      // Register this before @bacons/apple-targets so Expo's mod chain runs it
      // after the widget target has been created, while keeping the provider last.
      './plugins/with-boardsesh-widget-build-settings',
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
    ],
    extra: {
      ...config.extra,
      ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
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
