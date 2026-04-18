'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import { useSwipeable } from 'react-swipeable';
import { useSwipeDirection } from './use-swipe-direction';

// Threshold in pixels to trigger the swipe action
const DEFAULT_SWIPE_THRESHOLD = 100;
// Maximum swipe distance
const DEFAULT_MAX_SWIPE = 120;
// Duration the confirmation checkmark is shown before snapping back
const CONFIRMATION_DISPLAY_MS = 600;

export type SwipeZone = 'none' | 'left-short' | 'left-long' | 'right-short' | 'right-long';

export interface UseSwipeActionsOptions {
  /** Called when the user swipes left past the threshold */
  onSwipeLeft: () => void;
  /** Called when the user swipes left past the long-swipe threshold */
  onSwipeLeftLong?: () => void;
  /** Called when the user swipes right past the threshold */
  onSwipeRight: () => void;
  /** Called when the user swipes right past the long-swipe threshold */
  onSwipeRightLong?: () => void;
  /** Pixel threshold to trigger action (default: 100) */
  swipeThreshold?: number;
  /** Pixel threshold to trigger long left swipe action (optional) */
  longSwipeLeftThreshold?: number;
  /** Pixel threshold to trigger long right swipe action (optional) */
  longSwipeRightThreshold?: number;
  /** Called when swipe zone changes during gesture (e.g. short -> long threshold crossing) */
  onSwipeZoneChange?: (zone: SwipeZone) => void;
  /** Called with current swipe offset during gesture and reset */
  onSwipeOffsetChange?: (offset: number) => void;
  /** Maximum swipe distance in pixels (default: 120) */
  maxSwipe?: number;
  /** Maximum left swipe distance in pixels (overrides maxSwipe for left direction) */
  maxSwipeLeft?: number;
  /** Maximum right swipe distance in pixels (overrides maxSwipe for right direction) */
  maxSwipeRight?: number;
  /** Whether swipe is disabled (e.g. in edit mode) */
  disabled?: boolean;
  /** Pixels the content peeks left during confirmation to reveal the action icon.
   *  Should match the right action layer width so both states show the same area. */
  confirmationPeekOffset?: number;
}

export interface UseSwipeActionsReturn {
  /** Spread onto the swipeable container element */
  swipeHandlers: ReturnType<typeof useSwipeable>;
  /** Whether a left-swipe action was just confirmed (checkmark peek is visible) */
  swipeLeftConfirmed: boolean;
  /** Ref for the swipeable content element (applies transform) */
  contentRef: React.RefCallback<HTMLElement>;
  /** Ref for the left action background (visible on swipe right) */
  leftActionRef: React.RefCallback<HTMLElement>;
  /** Ref for the right action background (visible on swipe left) */
  rightActionRef: React.RefCallback<HTMLElement>;
}

/**
 * Hook for swipe-to-action gestures on list items.
 *
 * Unlike useState-based approaches, this hook directly manipulates
 * DOM element styles during the gesture to avoid React re-renders
 * at 60fps. React state is only updated on gesture completion
 * (action triggered) or cancellation (snap back).
 */
export function useSwipeActions({
  onSwipeLeft,
  onSwipeLeftLong,
  onSwipeRight,
  onSwipeRightLong,
  swipeThreshold = DEFAULT_SWIPE_THRESHOLD,
  longSwipeLeftThreshold,
  longSwipeRightThreshold,
  onSwipeZoneChange,
  onSwipeOffsetChange,
  maxSwipe = DEFAULT_MAX_SWIPE,
  maxSwipeLeft,
  maxSwipeRight,
  disabled = false,
  confirmationPeekOffset = 76,
}: UseSwipeActionsOptions): UseSwipeActionsReturn {
  const [swipeLeftConfirmed, setSwipeLeftConfirmed] = useState(false);
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DOM element refs (set via ref callbacks)
  const contentEl = useRef<HTMLElement | null>(null);
  const leftActionEl = useRef<HTMLElement | null>(null);
  const rightActionEl = useRef<HTMLElement | null>(null);

  // Clean up confirmation timer and DOM refs on unmount.
  // Nulling refs breaks reference chains that retain detached DOM trees.
  useEffect(() => {
    return () => {
      if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
      contentEl.current = null;
      leftActionEl.current = null;
      rightActionEl.current = null;
    };
  }, []);

  // Gesture state (not React state -- no re-renders)
  const offsetRef = useRef(0);
  const swipeZoneRef = useRef<SwipeZone>('none');
  const { detect: detectDirection, reset: resetDirection, isHorizontalRef } = useSwipeDirection();

  const updateSwipeZone = useCallback((zone: SwipeZone) => {
    if (swipeZoneRef.current === zone) return;
    swipeZoneRef.current = zone;
    onSwipeZoneChange?.(zone);
  }, [onSwipeZoneChange]);

  const contentRef = useCallback((node: HTMLElement | null) => {
    contentEl.current = node;
  }, []);

  const leftActionRef = useCallback((node: HTMLElement | null) => {
    leftActionEl.current = node;
  }, []);

  const rightActionRef = useCallback((node: HTMLElement | null) => {
    rightActionEl.current = node;
  }, []);

  /** Apply the current offset to the DOM elements directly */
  const applyOffset = useCallback((offset: number) => {
    offsetRef.current = offset;
    onSwipeOffsetChange?.(offset);

    if (contentEl.current) {
      contentEl.current.style.transform = `translateX(${offset}px)`;
      // Only apply transition when snapping back to zero
      contentEl.current.style.transition = offset === 0 ? 'transform 150ms ease-out, opacity 150ms ease-out' : 'none';
    }

    const absOffset = Math.abs(offset);
    const opacity = Math.min(1, absOffset / swipeThreshold);

    // Left action (revealed on swipe right, offset > 0)
    if (leftActionEl.current) {
      leftActionEl.current.style.opacity = String(offset > 0 ? opacity : 0);
      leftActionEl.current.style.visibility = offset > 0 ? 'visible' : 'hidden';
    }

    // Right action (revealed on swipe left, offset < 0)
    if (rightActionEl.current) {
      rightActionEl.current.style.opacity = String(offset < 0 ? opacity : 0);
      rightActionEl.current.style.visibility = offset < 0 ? 'visible' : 'hidden';
    }
  }, [swipeThreshold, onSwipeOffsetChange]);

  /** Snap offset back to zero (no action taken) */
  const resetOffset = useCallback(() => {
    applyOffset(0);
    updateSwipeZone('none');
  }, [applyOffset, updateSwipeZone]);

  const handleSwipeLeftComplete = useCallback(() => {
    // Guard against rapid double-swipes
    if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);

    // Fire action immediately — no delay
    onSwipeLeft();
    setSwipeLeftConfirmed(true);

    // Animate content to a peek offset so the action layer (checkmark) stays visible
    if (contentEl.current) {
      contentEl.current.style.transition = 'transform 120ms ease-out';
      contentEl.current.style.transform = `translateX(${-confirmationPeekOffset}px)`;
    }
    // Keep offsetRef in sync with the visual state (E4 fix)
    offsetRef.current = -confirmationPeekOffset;

    // Keep the right action layer fully visible during confirmation
    if (rightActionEl.current) {
      rightActionEl.current.style.opacity = '1';
      rightActionEl.current.style.visibility = 'visible';
    }

    // After the confirmation display, snap back
    confirmationTimerRef.current = setTimeout(() => {
      confirmationTimerRef.current = null;
      // Guard against unmounted element (E5 fix — safe for list virtualization)
      if (!contentEl.current) return;
      // Set transition on right action before applyOffset changes values so it fades out smoothly
      if (rightActionEl.current) {
        rightActionEl.current.style.transition = 'opacity 200ms ease-out, visibility 0s 200ms';
      }
      applyOffset(0);
      // Override content transition with a gentler one for the confirmation snap-back
      if (contentEl.current) {
        contentEl.current.style.transition = 'transform 200ms ease-out';
      }
      updateSwipeZone('none');
      setSwipeLeftConfirmed(false);
    }, CONFIRMATION_DISPLAY_MS);
  }, [onSwipeLeft, applyOffset, updateSwipeZone, confirmationPeekOffset]);

  const handleSwipeRightComplete = useCallback(() => {
    applyOffset(0);
    updateSwipeZone('none');
    onSwipeRight();
  }, [onSwipeRight, applyOffset, updateSwipeZone]);

  const handleSwipeLeftLongComplete = useCallback(() => {
    applyOffset(0);
    updateSwipeZone('none');
    onSwipeLeftLong?.();
  }, [applyOffset, onSwipeLeftLong, updateSwipeZone]);

  const handleSwipeRightLongComplete = useCallback(() => {
    applyOffset(0);
    updateSwipeZone('none');
    onSwipeRightLong?.();
  }, [applyOffset, onSwipeRightLong, updateSwipeZone]);

  const swipeHandlers = useSwipeable({
    onSwiping: (eventData) => {
      if (disabled) return;

      const { deltaX, deltaY, event } = eventData;

      // Determine swipe direction on first significant movement
      const isHorizontal = detectDirection(deltaX, deltaY);
      if (isHorizontal === null) return;

      // Let vertical swipes pass through for scrolling
      if (!isHorizontal) {
        updateSwipeZone('none');
        return;
      }

      // Horizontal swipe -- prevent scroll and update offset via DOM
      if ('nativeEvent' in event) {
        event.nativeEvent.preventDefault();
      } else {
        event.preventDefault();
      }

      const maxLeft = maxSwipeLeft ?? maxSwipe;
      const maxRight = maxSwipeRight ?? maxSwipe;
      const clampedOffset = Math.max(-maxLeft, Math.min(maxRight, deltaX));
      applyOffset(clampedOffset);

      const absOffset = Math.abs(clampedOffset);
      if (clampedOffset > 0) {
        if (typeof longSwipeRightThreshold === 'number' && absOffset >= longSwipeRightThreshold) {
          updateSwipeZone('right-long');
        } else {
          updateSwipeZone('right-short');
        }
      } else if (clampedOffset < 0) {
        if (typeof longSwipeLeftThreshold === 'number' && absOffset >= longSwipeLeftThreshold) {
          updateSwipeZone('left-long');
        } else {
          updateSwipeZone('left-short');
        }
      } else {
        updateSwipeZone('none');
      }
    },
    onSwipedLeft: (eventData) => {
      const swipeDistance = Math.abs(eventData.deltaX);
      const longSwipeReady = typeof longSwipeLeftThreshold === 'number' && swipeDistance >= longSwipeLeftThreshold;

      if (isHorizontalRef.current && longSwipeReady && onSwipeLeftLong) {
        handleSwipeLeftLongComplete();
      } else if (isHorizontalRef.current && swipeDistance >= swipeThreshold) {
        handleSwipeLeftComplete();
      } else {
        resetOffset();
      }
      resetDirection();
    },
    onSwipedRight: (eventData) => {
      const swipeDistance = Math.abs(eventData.deltaX);
      const longSwipeReady = typeof longSwipeRightThreshold === 'number' && swipeDistance >= longSwipeRightThreshold;

      if (isHorizontalRef.current && longSwipeReady && onSwipeRightLong) {
        handleSwipeRightLongComplete();
      } else if (isHorizontalRef.current && swipeDistance >= swipeThreshold) {
        handleSwipeRightComplete();
      } else {
        resetOffset();
      }
      resetDirection();
    },
    onTouchEndOrOnMouseUp: () => {
      if (Math.abs(offsetRef.current) < swipeThreshold) {
        resetOffset();
      }
      resetDirection();
      updateSwipeZone('none');
    },
    trackMouse: false,
    trackTouch: true,
    preventScrollOnSwipe: false,
  });

  return {
    swipeHandlers,
    swipeLeftConfirmed,
    contentRef,
    leftActionRef,
    rightActionRef,
  };
}
