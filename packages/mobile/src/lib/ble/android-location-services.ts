// Android system Location *services* toggle — separate from the location
// *permission* handled in android-location-permission.ts.
//
// On API 23-30 (Android 6-11), AOSP's BLE scan-result delivery is gated on the
// system-wide Location switch being on, regardless of whether the app holds
// ACCESS_FINE_LOCATION. See android-scan-location-gate.ts for the full picture
// and androidScanRequiresLocationServices for the API-level predicate.
//
// This module is split out from android-location-permission.ts (which
// deliberately imports only `react-native`, so it stays loadable under Vitest
// without pulling in a native module) because reading the services toggle
// needs `expo-location`. expo-location is a NATIVE module already shipped in
// every current binary, but we still import it lazily — the same pattern as
// use-device-location.ts — so a build that somehow predates it degrades to
// "unknown" instead of crashing.

import { Linking, Platform } from 'react-native';

/**
 * Whether the system-wide Location toggle is currently on. `null` off Android,
 * or if the state can't be determined (module missing, or the read throws) —
 * callers should treat `null` as "unknown" and fall back to the generic
 * troubleshooting copy rather than asserting either state.
 */
export async function getAndroidLocationServicesState(): Promise<boolean | null> {
  if (Platform.OS !== 'android') return null;

  try {
    const Location = await import('expo-location');
    return await Location.hasServicesEnabledAsync();
  } catch {
    return null;
  }
}

/**
 * Prompts the user to turn Location on. Tries expo-location's in-app Google
 * Play services dialog first (resolves `true` once the user enables it from
 * that dialog); on any failure — declined, or no Play services on this device,
 * which `enableNetworkProviderAsync` throws for — falls back to opening the
 * system Location settings screen directly, and resolves `false` (the caller
 * can't know when or whether the user actually flips the toggle there, so it
 * should re-check the state when the app returns to the foreground instead of
 * assuming success).
 *
 * Never throws: every native call is wrapped, so a caller can always `await`
 * this without a try/catch of its own.
 */
export async function promptEnableAndroidLocationServices(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;

  try {
    const Location = await import('expo-location');
    await Location.enableNetworkProviderAsync();
    return true;
  } catch {
    try {
      await Linking.sendIntent?.('android.settings.LOCATION_SOURCE_SETTINGS');
    } catch {
      // Nothing more we can do — leave the user where they were rather than
      // throwing out of a button handler.
    }
    return false;
  }
}
