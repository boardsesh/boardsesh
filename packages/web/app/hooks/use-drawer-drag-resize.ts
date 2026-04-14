'use client';

import { useCallback, useEffect, useRef } from 'react';
import { themeTokens } from '@/app/theme/theme-config';

export const DRAG_MOVE_THRESHOLD = 10;
/** Minimum velocity (px/ms) for a flick to close the drawer. */
export const FLICK_VELOCITY_THRESHOLD = 0.5;

export type DragResult = 'expand' | 'collapse' | 'close' | 'none';

/** Pure decision function: determines if finger movement qualifies as a drag gesture. */
export function isDragGestureDetected(startY: number, currentY: number, threshold = DRAG_MOVE_THRESHOLD): boolean {
  return Math.abs(currentY - startY) > threshold;
}

/**
 * Pure decision function for the final drawer state after a drag ends.
 *
 * - Fast downward flick (velocity > threshold) → close
 * - Dragged past the bottom edge of the initial height → close
 * - Dragged to a position between initial and expanded → snap to nearest
 * - Dragged upward → expand
 */
export function computeDragResult(
  currentHeightPx: number,
  viewportHeight: number,
  velocity: number,
  initialFraction: number,
  expandedFraction: number,
): DragResult {
  const currentFraction = currentHeightPx / viewportHeight;

  // Fast downward flick always closes
  if (velocity > FLICK_VELOCITY_THRESHOLD) return 'close';

  // Below half of initial height → close
  if (currentFraction < initialFraction * 0.5) return 'close';

  // Snap to nearest of initial or expanded
  const midpoint = (initialFraction + expandedFraction) / 2;
  if (currentFraction < midpoint) return 'collapse';
  return 'expand';
}

export interface DrawerDragResizeOptions {
  /** Whether the drawer is currently open. Height resets to initialHeight when false. */
  open: boolean;
  /** Called when a drag-down from the initial height should close the drawer. */
  onClose: () => void;
  /** Initial/collapsed height. Defaults to '60%'. */
  initialHeight?: string;
  /** Expanded height. Defaults to '90%'. */
  expandedHeight?: string;
  /** Optional external scroll element for auto-expand detection.
   *  When provided, the hook listens on this element instead of auto-detecting. */
  scrollElement?: HTMLElement | null;
}

export interface DrawerDragResizeResult {
  /** Ref to forward to SwipeableDrawer's paperRef prop. */
  paperRef: React.RefObject<HTMLDivElement | null>;
  /** Touch handlers to spread onto the drag header zone element. */
  dragHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
  };
}

function parseFraction(pct: string): number {
  return parseFloat(pct) / 100;
}

/**
 * Hook that implements Spotify-style drag-to-resize for bottom drawers.
 *
 * The drawer follows the finger during drags and snaps to the nearest
 * resting height (60% or 90%) on release. A fast downward flick closes.
 */
export function useDrawerDragResize({
  open,
  onClose,
  initialHeight = '60%',
  expandedHeight = '90%',
  scrollElement,
}: DrawerDragResizeOptions): DrawerDragResizeResult {
  const paperRef = useRef<HTMLDivElement>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const cleanupScrollRef = useRef<(() => void) | null>(null);
  const heightRef = useRef(initialHeight);
  const dragStartY = useRef(0);
  const dragStartHeightPx = useRef(0);
  const isDragGesture = useRef(false);
  const lastTouchY = useRef(0);
  const lastTouchTime = useRef(0);
  const velocityRef = useRef(0);

  const updateHeight = useCallback((height: string) => {
    heightRef.current = height;
    if (paperRef.current) {
      paperRef.current.style.height = height;
    }
  }, []);

  // Reset height and clear cached scroll element when drawer closes
  useEffect(() => {
    if (!open) {
      updateHeight(initialHeight);
      scrollElRef.current = null;
    }
  }, [open, initialHeight, updateHeight]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const y = e.touches[0].clientY;
    dragStartY.current = y;
    lastTouchY.current = y;
    lastTouchTime.current = Date.now();
    velocityRef.current = 0;
    isDragGesture.current = false;
    // Capture the paper's current pixel height
    dragStartHeightPx.current = paperRef.current?.offsetHeight ?? 0;
    // Disable height transition during drag for instant feedback
    if (paperRef.current) {
      paperRef.current.style.transition = 'none';
    }
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const y = e.touches[0].clientY;
    const totalDelta = y - dragStartY.current;

    if (Math.abs(totalDelta) > DRAG_MOVE_THRESHOLD) {
      isDragGesture.current = true;
    }

    if (!isDragGesture.current) return;

    // Track velocity (positive = downward)
    const now = Date.now();
    const dt = now - lastTouchTime.current;
    if (dt > 0) {
      velocityRef.current = (y - lastTouchY.current) / dt;
    }
    lastTouchY.current = y;
    lastTouchTime.current = now;

    // Directly set the paper height to follow the finger.
    // Dragging down (positive delta) shrinks the drawer.
    const paper = paperRef.current;
    if (paper) {
      const newHeight = Math.max(0, dragStartHeightPx.current - totalDelta);
      paper.style.height = `${newHeight}px`;
    }
  }, []);

  /** Find and cache the scrollable element inside the paper.
   *  SwipeableDrawer structure: Paper > wrapperBox > [header, bodyBox, ...].
   *  The bodyBox (overflow: auto) is at depth 2, so we only check grandchildren. */
  const findScrollEl = useCallback((): HTMLElement | null => {
    if (scrollElRef.current && scrollElRef.current.isConnected) return scrollElRef.current;
    const paper = paperRef.current;
    if (!paper) return null;
    // Check direct children and grandchildren only (depth 2)
    for (const child of paper.children) {
      for (const grandchild of child.children) {
        const el = grandchild as HTMLElement;
        const overflow = getComputedStyle(el).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') {
          scrollElRef.current = el;
          return el;
        }
      }
    }
    return null;
  }, []);

  const scrollToTop = useCallback(() => {
    const el = findScrollEl();
    if (el && el.scrollTop > 0) el.scrollTop = 0;
  }, [findScrollEl]);

  const onTouchEnd = useCallback(() => {
    const paper = paperRef.current;

    // Re-enable transition for the snap animation
    if (paper) {
      paper.style.transition = themeTokens.transitions.drawerHeight;
    }

    if (!isDragGesture.current) return;

    const currentHeightPx = paper?.offsetHeight ?? 0;
    const viewportHeight = window.innerHeight;
    // Velocity: positive = finger moving down = closing direction
    const velocity = velocityRef.current;
    const initialFrac = parseFraction(initialHeight);
    const expandedFrac = parseFraction(expandedHeight);

    const result = computeDragResult(currentHeightPx, viewportHeight, velocity, initialFrac, expandedFrac);

    switch (result) {
      case 'expand':
        updateHeight(expandedHeight);
        break;
      case 'collapse':
        updateHeight(initialHeight);
        scrollToTop();
        break;
      case 'close':
        onClose();
        break;
    }
  }, [onClose, initialHeight, expandedHeight, updateHeight, scrollToTop]);

  // Auto-expand when the user scrolls content inside the drawer.
  useEffect(() => {
    if (!open) return;

    const attachListener = (scrollEl: HTMLElement) => {
      const handleScroll = () => {
        if (heightRef.current !== expandedHeight && scrollEl.scrollTop > 0) {
          updateHeight(expandedHeight);
        }
      };
      scrollEl.addEventListener('scroll', handleScroll, { passive: true });
      cleanupScrollRef.current = () => scrollEl.removeEventListener('scroll', handleScroll);
    };

    // If an external scroll element is provided, use it directly
    if (scrollElement) {
      attachListener(scrollElement);
      return () => {
        cleanupScrollRef.current?.();
        cleanupScrollRef.current = null;
      };
    }

    // Auto-detect: try immediately, then watch for DOM changes if not found yet
    const scrollEl = findScrollEl();
    if (scrollEl) {
      attachListener(scrollEl);
      return () => {
        cleanupScrollRef.current?.();
        cleanupScrollRef.current = null;
      };
    }

    // Scroll container not yet in DOM — observe mutations until it appears
    const paper = paperRef.current;
    if (!paper) return;
    const observer = new MutationObserver(() => {
      const el = findScrollEl();
      if (el) {
        observer.disconnect();
        attachListener(el);
      }
    });
    observer.observe(paper, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      cleanupScrollRef.current?.();
      cleanupScrollRef.current = null;
    };
  }, [open, expandedHeight, updateHeight, findScrollEl, scrollElement]);

  return {
    paperRef,
    dragHandlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
