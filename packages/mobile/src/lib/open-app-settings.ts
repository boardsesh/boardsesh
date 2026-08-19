import { Linking, Platform } from 'react-native';

/**
 * Whether this platform can deep-link into the OS settings app. iOS and
 * Android both implement `Linking.openSettings()`; the Expo web runtime does
 * not — react-native-web's `Linking` only implements
 * `addEventListener`/`removeEventListener`/`canOpenURL`/`getInitialURL`/`openURL`,
 * so calling `openSettings()` there throws `TypeError: openSettings is not a
 * function`. That crashed the gyms screen on app.boardsesh.com (BOARDSESH-DT).
 */
export function canOpenAppSettings(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

/**
 * Open the OS settings app, Platform-gated so it never throws on web. Returns
 * whether it actually opened. Mirrors `open-external-link.ts`'s try/catch
 * shape: a settings deep-link failing is not worth crashing a button handler
 * over.
 */
export async function openAppSettings(): Promise<boolean> {
  if (!canOpenAppSettings()) return false;
  try {
    // oxlint-disable-next-line no-restricted-properties -- the one sanctioned call site; gated by canOpenAppSettings() above
    await Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}
