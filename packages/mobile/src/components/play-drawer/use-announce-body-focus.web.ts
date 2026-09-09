import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { View } from 'react-native';

/**
 * react-native-web has no node-handle concept — a `ref` on a `View` already
 * IS the underlying DOM element — so `findNodeHandle` is an unconditional
 * throw (`findNodeHandle is not supported on web. Use the ref property on the
 * component instead.`) and `AccessibilityInfo.setAccessibilityFocus` is a
 * silent no-op even when a handle exists. Calling either from this effect is
 * exactly issue #5301: the wall-state pill's callout crashed the whole app on
 * app.boardsesh.com every single time it opened in a browser.
 *
 * The DOM equivalent of "accessibility focus" is a real `.focus()` call. The
 * body sentence isn't natively focusable (it's a `<div>`, not a control), so
 * this gives it `tabindex="-1"` first — focusable programmatically, but never
 * part of Tab order — then focuses it, which is what actually lands a screen
 * reader on the sentence in a browser.
 *
 * `enabled` is false for the notice variant, which asked for nothing and so
 * never yanks focus off whatever the climber was already reading.
 */
export function useAnnounceBodyFocus(bodyRef: RefObject<View | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const node = bodyRef.current as unknown as HTMLElement | null;
    if (node == null || typeof node.focus !== 'function') return;
    if (!node.hasAttribute('tabindex')) {
      node.setAttribute('tabindex', '-1');
    }
    node.focus({ preventScroll: true });
  }, [bodyRef, enabled]);
}
