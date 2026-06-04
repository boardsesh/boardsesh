import { execSync } from 'node:child_process';
import type { ExpoConfig, ConfigContext } from 'expo/config';

const DEFAULT_EAS_PROJECT_ID = '87499648-655e-4fb8-9856-65da37e55fb1';
const EAS_PROJECT_ID = process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? DEFAULT_EAS_PROJECT_ID;

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

export default ({ config }: ConfigContext): ExpoConfig & { newArchEnabled?: boolean } => {
  const devMetadata = resolveDevMetadata();
  const hasDevMetadata = devMetadata.branchName || devMetadata.qaNotes || devMetadata.qaNotesFilePath;
  const tailscaleHosts = resolveTailscaleHosts();
  const isDevBuild = isDevBuildProfile();

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
      'expo-router',
      'expo-secure-store',
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
      'expo-web-browser',
      'react-native-ble-plx',
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
      // org/project make `expo prebuild` write a valid ios/sentry.properties so
      // the build-phase source-map + dSYM upload can find the Sentry project.
      // The auth token is supplied via the SENTRY_AUTH_TOKEN env var in CI
      // (never committed); url defaults to https://sentry.io/ (US region).
      ['@sentry/react-native/expo', { organization: 'boardsesh', project: 'boardsesh' }],
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
