import { requireOptionalNativeModule } from 'expo-modules-core';

type ExpoDevLauncherModule = {
  loadApp(url: string): Promise<boolean>;
};

// expo-dev-client's launcher native module is only linked into Debug / dev-client
// builds. requireOptionalNativeModule returns null in Expo Go and in any Release
// (App Store / TestFlight / Play) binary — so this doubles as our signal for
// "live Metro dev-server switching is possible on this build."
export const expoDevLauncher = requireOptionalNativeModule<ExpoDevLauncherModule>('ExpoDevLauncher');

export function isDevLauncherAvailable(): boolean {
  return expoDevLauncher !== null;
}
