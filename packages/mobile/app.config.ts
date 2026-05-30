import { execSync } from 'node:child_process';
import type { ExpoConfig, ConfigContext } from 'expo/config';
import { resolveLanHosts } from './src/lib/resolve-lan-hosts';

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
  const isDevBuild = isDevBuildProfile();
  // Hosts the in-app dev-server switcher will probe for live Metro bundlers.
  // localhost covers the simulator, LAN IPs cover same-Wi-Fi devices, tailnet
  // names cover off-LAN devices on the same tailnet. Dev-build only so
  // preview/production binaries don't ship a list that triggers runtime probes.
  const devBundlerHosts = isDevBuild
    ? Array.from(new Set(normalizeHostValues(['localhost', ...resolveLanHosts(), ...resolveTailscaleHosts()])))
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
      permissions: ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'ACCESS_FINE_LOCATION'],
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-localization',
      'expo-status-bar',
      'expo-updates',
      'expo-web-browser',
      'react-native-ble-plx',
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
      ...(devBundlerHosts.length > 0 ? { devBundlerHosts } : {}),
    },
  };
};
