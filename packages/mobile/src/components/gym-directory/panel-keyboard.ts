// The gym panel's box while the keyboard is up. Neither platform resizes these
// screens for it: iOS never does, and Android draws the keyboard over
// edge-to-edge routes. So a panel snapped to its top detent for typing would
// keep its last results, and the pinned "Add my gym" footer, under the
// keyboard, and its scroll extent would count space nobody can see. The box
// shrinks by what the keyboard covers instead, and the panel re-snaps to it.

import { Platform } from 'react-native';
import { useKeyboardHeight } from '../../hooks/use-keyboard-height';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';

/**
 * How much of a box that reaches the window's bottom edge the keyboard covers.
 * iOS reports the keyboard from the screen's bottom edge, home indicator
 * included. Android reports the IME inset minus the system bars, so a box drawn
 * edge-to-edge over the navigation bar adds the window inset back.
 */
export function keyboardOverlap({
  keyboardHeight,
  platform,
  windowBottomInset,
}: {
  keyboardHeight: number;
  platform: string;
  windowBottomInset: number;
}): number {
  if (keyboardHeight <= 0) return 0;
  return keyboardHeight + (platform === 'android' ? windowBottomInset : 0);
}

/** The height left to the panel: the box above the keyboard, never below 0. */
export function panelBoxHeight(boxHeight: number, overlap: number): number {
  return Math.max(0, boxHeight - overlap);
}

/** What the keyboard covers of a box that reaches the window's bottom edge, live. */
export function useKeyboardOverlap(): number {
  const keyboardHeight = useKeyboardHeight();
  const windowBottomInset = useWindowBottomInset();
  return keyboardOverlap({ keyboardHeight, platform: Platform.OS, windowBottomInset });
}
