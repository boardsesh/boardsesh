'use client';

import { useRef, useCallback, useEffect } from 'react';

// ── Shared constants ──────────────────────────────────────────────────────────

export const DECELERATE_EASING = 'cubic-bezier(0.0, 0, 0.2, 1)';
export const CLOSE_ANIMATION_MS = 200;
// Total timeout used as the fallback for `onTransformSettled` (and as the
// post-animation delay when snapping back), a hair longer than the transition so
// it never cuts the animation short. NOT an additive delay on top of the
// transition — it's the whole budget.
export const ANIMATION_FALLBACK_MS = 210; // CLOSE_ANIMATION_MS + safety margin

/**
 * Invoke `cb` once the element's `transform` transition ends, falling back to a
 * timer when `transitionend` never fires (an interrupted transition, or jsdom,
 * which has no layout engine). Callers use this to flip React state only AFTER
 * an off-screen close animation has actually finished — so MUI's `Slide` exit
 * (triggered by the `open=false` flip) runs from the already-off-screen position
 * and stays a single monotonic slide instead of snapping back toward open.
 *
 * Returns a cleanup that cancels the pending callback without invoking it; call
 * it on unmount so a half-finished close can't fire `cb` after teardown.
 */
export function onTransformSettled(el: HTMLElement, fallbackMs: number, cb: () => void): () => void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function finish(invoke: boolean) {
    if (done) return;
    done = true;
    el.removeEventListener('transitionend', onEnd);
    if (timer) clearTimeout(timer);
    if (invoke) cb();
  }
  const onEnd = (event: Event) => {
    if ((event as TransitionEvent).propertyName === 'transform') finish(true);
  };
  el.addEventListener('transitionend', onEnd);
  timer = setTimeout(() => finish(true), fallbackMs);
  return () => finish(false);
}

// ── Scroll container utility ──────────────────────────────────────────────────

/**
 * Walk up the DOM tree from `target` looking for the nearest element with
 * `overflow-y: auto` or `overflow-y: scroll`. Returns null if none is found
 * before reaching `stopAt` (or the document root).
 */
export function findScrollContainer(target: HTMLElement, stopAt?: HTMLElement | null): HTMLElement | null {
  let el: HTMLElement | null = target;
  while (el && el !== stopAt) {
    const style = window.getComputedStyle(el);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

// ── Pull-to-close state ───────────────────────────────────────────────────────

export type PullToCloseState = {
  startY: number;
  /** Y position where the pull gesture origin is measured from.
   *  When `trackPullOrigin` is true and the touch starts with scroll not at
   *  top, this is set to 0 and updated when scroll first reaches the top. */
  pullOriginY: number;
  scrollContainer: HTMLElement | null;
  isPulling: boolean;
  translateY: number;
};

function createInitialState(): PullToCloseState {
  return { startY: 0, pullOriginY: 0, scrollContainer: null, isPulling: false, translateY: 0 };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export type UsePullToCloseOptions = {
  /** The paper DOM element to apply transforms to. */
  paperEl: HTMLElement | null;
  /** Called when the gesture exceeds the close threshold. */
  onClose: () => void;
  /** Pixels of movement before pulling starts. Default: 10. */
  deadZone?: number;
  /** Pull distance in pixels to trigger close. Default: 80. */
  closeThreshold?: number;
  /**
   * When true, tracks where the scroll container first reaches the top
   * mid-gesture. Useful when the user starts a touch below the fold and
   * scrolls up to the top before pulling down. Default: false.
   */
  trackPullOrigin?: boolean;
  /**
   * When true, offsets the paper transform by the dead zone amount so the
   * paper starts moving from 0px (not from the dead zone distance). Default: false.
   */
  offsetByDeadZone?: boolean;
};

export type UsePullToCloseReturn = {
  /** Mutable ref to the current gesture state. Useful for consumers that need
   *  to read or adjust state (e.g., setting pullOriginY externally). */
  stateRef: React.MutableRefObject<PullToCloseState>;
  /** Call from touchstart. Pass clientY and the scroll container (or null). */
  onTouchStart: (clientY: number, scrollContainer: HTMLElement | null) => void;
  /** Call from touchmove. Pass clientY, touch count, and optional cancel flag. */
  onTouchMove: (clientY: number, touchCount: number, cancelled?: boolean) => void;
  /** Call from touchend. */
  onTouchEnd: () => void;
};

export function usePullToClose({
  paperEl,
  onClose,
  deadZone = 10,
  closeThreshold = 80,
  trackPullOrigin = false,
  offsetByDeadZone = false,
}: UsePullToCloseOptions): UsePullToCloseReturn {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const stateRef = useRef<PullToCloseState>(createInitialState());
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // Cancels a pending "fire onClose once the close animation settles" listener.
  const settleCleanupRef = useRef<(() => void) | null>(null);
  // Capture the paper element in a ref so callbacks don't depend on it
  const paperElRef = useRef(paperEl);
  paperElRef.current = paperEl;

  // Clean up timers and any pending settle listener on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const id of timers) {
        clearTimeout(id);
      }
      timers.clear();
      settleCleanupRef.current?.();
      settleCleanupRef.current = null;
    };
  }, []);

  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
  }, []);

  const setTransform = useCallback((translateY: number) => {
    const el = paperElRef.current;
    if (!el) return;
    el.style.transform = `translateY(${translateY}px)`;
    el.style.transition = 'none';
  }, []);

  const clearTransform = useCallback(() => {
    const el = paperElRef.current;
    if (!el) return;
    el.style.transform = '';
    el.style.transition = '';
  }, []);

  const onTouchStart = useCallback(
    (clientY: number, scrollContainer: HTMLElement | null) => {
      const atTop = !scrollContainer || scrollContainer.scrollTop <= 0;
      let pullOriginY: number;
      if (!trackPullOrigin) {
        pullOriginY = clientY;
      } else if (atTop) {
        pullOriginY = clientY;
      } else {
        pullOriginY = 0;
      }
      stateRef.current = {
        startY: clientY,
        pullOriginY,
        scrollContainer,
        isPulling: false,
        translateY: 0,
      };
    },
    [trackPullOrigin],
  );

  const onTouchMove = useCallback(
    (clientY: number, touchCount: number, cancelled?: boolean) => {
      const state = stateRef.current;

      // Multi-touch or externally cancelled — abort any active pull
      if (touchCount > 1 || cancelled) {
        if (state.isPulling) {
          state.isPulling = false;
          state.translateY = 0;
          clearTransform();
        }
        return;
      }

      const atTop = !state.scrollContainer || state.scrollContainer.scrollTop <= 0;
      const movingDown = clientY > state.startY;

      if (atTop && movingDown) {
        // Record where we first hit scroll top (for trackPullOrigin)
        if (trackPullOrigin && !state.pullOriginY) {
          state.pullOriginY = clientY;
        }

        const origin = trackPullOrigin ? state.pullOriginY : state.startY;
        const deltaY = clientY - origin;

        if (!state.isPulling && deltaY > deadZone) {
          state.isPulling = true;
        }
        if (state.isPulling) {
          const pullDistance = offsetByDeadZone ? deltaY - deadZone : deltaY;
          state.translateY = pullDistance;
          setTransform(pullDistance);
        }
      } else if (state.isPulling) {
        // User reversed direction or scrolled — cancel pull
        state.isPulling = false;
        state.translateY = 0;
        clearTransform();
      }
    },
    [deadZone, trackPullOrigin, offsetByDeadZone, setTransform, clearTransform],
  );

  const onTouchEnd = useCallback(() => {
    const state = stateRef.current;
    const el = paperElRef.current;

    if (!state.isPulling) {
      // Reset any lingering transform
      if (state.translateY > 0) {
        clearTransform();
      }
      return;
    }

    if (state.translateY > closeThreshold && el) {
      // Animate the paper fully off-screen, then flip React `open` only AFTER it
      // is off-screen — that's what stops the janky snap-back. Previously `open`
      // flipped on a fixed 210ms timer that raced the 200ms transition, and the
      // paper still carried its gesture transform when MUI's `Slide` exit ran, so
      // the Slide exit re-asserted the open position before sliding out. Firing
      // on `transitionend` (timer fallback) and leaving the transform pinned
      // makes the Slide exit a visual no-op. `offsetHeight` is the paper's layout
      // height (unaffected by the live transform — `getBoundingClientRect().top`
      // would already include the drag offset) and equals the Slide exit distance
      // for a bottom-anchored drawer, so the paper ends fully off-screen.
      const targetY = el.offsetHeight;
      el.style.transition = `transform ${CLOSE_ANIMATION_MS}ms ${DECELERATE_EASING}`;
      el.style.transform = `translateY(${targetY}px)`;
      settleCleanupRef.current?.();
      settleCleanupRef.current = onTransformSettled(el, ANIMATION_FALLBACK_MS, () => {
        settleCleanupRef.current = null;
        onCloseRef.current();
      });
    } else if (el) {
      // Snap back
      el.style.transition = `transform ${CLOSE_ANIMATION_MS}ms ${DECELERATE_EASING}`;
      el.style.transform = '';
      scheduleTimer(() => {
        const currentEl = paperElRef.current;
        if (currentEl) {
          currentEl.style.transition = '';
        }
      }, ANIMATION_FALLBACK_MS);
    }

    state.isPulling = false;
    state.translateY = 0;
  }, [closeThreshold, scheduleTimer, clearTransform]);

  return { stateRef, onTouchStart, onTouchMove, onTouchEnd };
}
