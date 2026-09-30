import type { ConfigContext, ExpoConfig } from 'expo/config';

// The bundle id has to be one your Apple account can sign. Set it, and your
// team id, in packages/boardz/.env.local (gitignored; Expo CLI loads it):
//   BOARDZ_IOS_BUNDLE_ID=com.you.boardz
//   BOARDZ_APPLE_TEAM_ID=ABCDE12345
const bundleIdentifier = process.env.BOARDZ_IOS_BUNDLE_ID ?? 'com.dmucli.boardz';
const appleTeamId = process.env.BOARDZ_APPLE_TEAM_ID;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Boardz',
  slug: 'boardz',
  version: '0.1.0',
  scheme: 'boardz',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  platforms: ['ios'],
  experiments: {
    ...config.experiments,
    // Automatic memoization, so screens don't need hand-written useMemo/useCallback.
    reactCompiler: true,
  },
  ios: {
    bundleIdentifier,
    ...(appleTeamId ? { appleTeamId } : {}),
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSBluetoothAlwaysUsageDescription:
        'Boardz uses Bluetooth to light up the holds of the climb you pick on your board. No personal data is sent over Bluetooth.',
    },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'react-native-ble-plx',
    // The iOS 27 SDK won't launch an app without a UIScene life cycle.
    './plugins/with-scene-lifecycle',
    // Boardz only plays its workout beeps, but expo-audio links iOS recording
    // APIs, and App Store Connect rejects a build that links them without a
    // microphone purpose string. Boardz never asks for the microphone. The
    // plugin's default background audio mode is switched off: nothing plays
    // while the app is closed.
    [
      'expo-audio',
      {
        microphonePermission: 'Boardz only plays workout timer sounds. It never records audio.',
        enableBackgroundPlayback: false,
        recordAudioAndroid: false,
      },
    ],
  ],
});
