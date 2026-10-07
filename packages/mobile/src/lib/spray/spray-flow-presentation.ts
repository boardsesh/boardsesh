import { Platform } from 'react-native';
import type { NativeStackNavigationOptions } from 'expo-router';

/**
 * Whether the spray flows (add a wall, edit its holds, reset it) cover the
 * whole screen: on iPad only.
 *
 * As a `modal` they are a page card on iPad, a box in the middle of the screen
 * with the app dimmed around it, which is the wrong size for a pan-and-pinch
 * editor. iPad never mounts the iOS 26 NativeTabs (`app/(tabs)/_layout.tsx`
 * keeps it on JS tabs), so the `fullScreenModal` ban in
 * `docs/mobile-sheets-vs-routes.md` rule 2 does not reach it. Phones and Android
 * keep the presentation they had.
 *
 * Read on every call rather than once at load, so a test can vary the device.
 * A Mac running the iPad build reports `isPad` too, and gets a full-window cover.
 */
export function sprayFlowCoversScreen(): boolean {
  return Platform.OS === 'ios' && Platform.isPad === true;
}

/**
 * What the nested spray screens add to their options. On iPad: the full-screen
 * cover, for when the screen is pushed over the picker, and the home indicator
 * fading out after a few seconds, so it is not a bar across the bottom of the
 * photo. Nowhere else does it add a key, not even an `undefined` one, which
 * would override the stack's `screenOptions` when the two are merged.
 *
 * The status bar stays. Hiding it from a screen's options needs the
 * view-controller-based status bar appearance, which Expo turns off.
 */
export function sprayFlowScreenOptions(): Pick<NativeStackNavigationOptions, 'presentation' | 'autoHideHomeIndicator'> {
  return sprayFlowCoversScreen() ? { presentation: 'fullScreenModal', autoHideHomeIndicator: true } : {};
}

/**
 * The widest the form steps of the spray flows (name and angle, photo, upload,
 * publish) are drawn when the flow covers an iPad screen. Full width there is a
 * line of text a metre long; this keeps the column a readable width, centred.
 */
export const SPRAY_FORM_MAX_WIDTH = 640;
