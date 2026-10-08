import type { NativeStackNavigationOptions } from 'expo-router';
import { flowCoversScreen } from '../routing/flow-covers-screen';

/**
 * Whether the spray flows (add a wall, edit its holds, reset it) cover the
 * whole screen: on iPad only. The same rule as New climb; see
 * `flowCoversScreen` for why.
 */
export function sprayFlowCoversScreen(): boolean {
  return flowCoversScreen();
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
