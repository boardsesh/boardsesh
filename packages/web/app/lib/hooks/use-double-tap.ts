import { useRef, useCallback, type RefCallback } from 'react';

export const DOUBLE_TAP_THRESHOLD = 300;

/**
 * Hook that handles double-tap on touch devices without triggering iOS Safari's
 * double-tap-to-zoom behavior. Also supports desktop double-click.
 *
 * Returns a ref callback and an onDoubleClick handler to spread onto the element.
 */
export function useDoubleTap(callback: (() => void) | undefined) {
  const lastTapTimeRef = useRef(0);
  const elementRef = useRef<HTMLElement | null>(null);
  // Once any touch event is detected, permanently disable onDoubleClick
  // to prevent the browser's synthesized dblclick from double-firing.
  const isTouchDeviceRef = useRef(false);
  // Track whether the current gesture involves multiple touches (pinch, etc.)
  const wasMultiTouchRef = useRef(false);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if ((e.touches?.length ?? 0) > 1) {
      wasMultiTouchRef.current = true;
    }
  }, []);

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      isTouchDeviceRef.current = true;

      const remainingTouches = e.touches?.length ?? 0;

      // If other fingers are still down, this is part of a multi-touch gesture
      if (remainingTouches > 0) {
        wasMultiTouchRef.current = true;
        return;
      }

      // All fingers lifted — if this was a multi-touch gesture (pinch), skip it
      if (wasMultiTouchRef.current) {
        wasMultiTouchRef.current = false;
        lastTapTimeRef.current = 0;
        return;
      }

      if (!callback) return;

      const now = Date.now();
      const timeSinceLastTap = now - lastTapTimeRef.current;

      if (timeSinceLastTap > 0 && timeSinceLastTap < DOUBLE_TAP_THRESHOLD) {
        e.preventDefault();
        lastTapTimeRef.current = 0;
        callback();
      } else {
        lastTapTimeRef.current = now;
      }
    },
    [callback],
  );

  const ref: RefCallback<HTMLElement> = useCallback(
    (node: HTMLElement | null) => {
      // Cleanup previous listeners
      if (elementRef.current) {
        elementRef.current.removeEventListener('touchstart', handleTouchStart);
        elementRef.current.removeEventListener('touchend', handleTouchEnd);
      }

      elementRef.current = node;

      // Attach new listeners
      if (node) {
        node.addEventListener('touchstart', handleTouchStart, { passive: true });
        node.addEventListener('touchend', handleTouchEnd, { passive: false });
      }
    },
    [handleTouchStart, handleTouchEnd],
  );

  const onDoubleClick = useCallback(() => {
    // On touch devices, ignore synthesized dblclick events entirely
    if (isTouchDeviceRef.current) return;
    callback?.();
  }, [callback]);

  return { ref, onDoubleClick };
}
