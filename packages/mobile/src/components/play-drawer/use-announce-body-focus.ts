import { useEffect } from 'react';
import type { RefObject } from 'react';
import { AccessibilityInfo, findNodeHandle, type View } from 'react-native';

/**
 * Lands the screen reader on the sentence the climber just asked for, rather
 * than wherever the focus happened to be when the card claimed the modal.
 *
 * Native-only: `findNodeHandle` and `AccessibilityInfo.setAccessibilityFocus`
 * both require a real host-view "tag", which only exists on iOS/Android. See
 * `use-announce-body-focus.web.ts` for the browser equivalent — react-native-web
 * doesn't have a node-handle concept (a ref already IS the DOM node), and its
 * `findNodeHandle` throws unconditionally (#5301).
 *
 * `enabled` is false for the notice variant, which asked for nothing and so
 * never yanks focus off whatever the climber was already reading.
 */
export function useAnnounceBodyFocus(bodyRef: RefObject<View | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const nodeHandle = findNodeHandle(bodyRef.current);
    if (nodeHandle == null) return;
    AccessibilityInfo.setAccessibilityFocus(nodeHandle);
  }, [bodyRef, enabled]);
}
