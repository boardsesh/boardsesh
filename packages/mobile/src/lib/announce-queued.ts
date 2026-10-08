import { AccessibilityInfo } from 'react-native';

/**
 * Announce to VoiceOver without cutting off whatever it is reading — two toasts
 * in a row, or a toast over an Undo snackbar, are both heard. `queue` is iOS's
 * own option; the plain call is the fallback where the options form is absent.
 * Call it on iOS only: Android reads `accessibilityLiveRegion` already.
 */
export function announceQueued(message: string): void {
  if (typeof AccessibilityInfo.announceForAccessibilityWithOptions === 'function') {
    AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
  } else {
    AccessibilityInfo.announceForAccessibility(message);
  }
}
