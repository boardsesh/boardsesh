import { useCallback, useEffect, useRef } from 'react';
import { createSheetOpenSerializer } from './sheet-open-serializer';

/**
 * Bounded fallback for an open() deferred behind an in-flight dismiss
 * animation. The close animation runs ~250ms and normally completes with an
 * `onDismiss` that flushes the stash; 400ms comfortably outlasts that, so this
 * only actually fires when `onDismiss` is genuinely starved (the stall the
 * original deferral guards against). A tap is then still never dropped.
 */
const DEFAULT_FALLBACK_MS = 400;

type DeferredSheetOpen<OpenArgs> = {
  /**
   * Request an open. Opens immediately when no dismissal is in flight;
   * otherwise stashes the args (last wins) to replay once the dismissal
   * settles — via `flushOnDismiss`, or the bounded fallback timer.
   */
  requestOpen: (args: OpenArgs) => void;
  /** Wire to the modal's `onAnimate(fromIndex, toIndex)` with `toIndex`. */
  onAnimate: (toIndex: number) => void;
  /** Wire to the modal's `onDismiss`, after the close-state reset. */
  flushOnDismiss: () => void;
};

/**
 * Coordinates imperative sheet open() requests against a gorhom
 * BottomSheetModal's dismiss animation, so a re-present never races the
 * dismissal's `onDismiss` (the bug where the stale `onDismiss` wipes
 * `isSheetOpen` after the re-present, leaving the sheet open but its deferred
 * content gated off forever).
 *
 * Wraps the pure {@link createSheetOpenSerializer} with the React/timer
 * concerns:
 *   - the fallback timer always replays through the LATEST `openNow` (held in a
 *     ref) so a closure captured at schedule time can't reopen with stale state
 *     (e.g. a `currentClimbQueueItem` that changed during the dismiss window);
 *   - a spring-back / abort (`onAnimate` to an on-screen index) drops the
 *     pending timer alongside the serializer's stash, so nothing replays;
 *   - the timer is cleared on unmount.
 */
export function useDeferredSheetOpen<OpenArgs>(
  openNow: (args: OpenArgs) => void,
  fallbackMs: number = DEFAULT_FALLBACK_MS,
): DeferredSheetOpen<OpenArgs> {
  const serializerRef = useRef(createSheetOpenSerializer<OpenArgs>());
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always replay through the current openNow, never the one captured when the
  // timer was scheduled.
  const openNowRef = useRef(openNow);
  openNowRef.current = openNow;

  const clearFallback = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  // Flush a stashed open once the dismissal has settled. One-shot via
  // takePendingOpen, so whichever of onDismiss / the fallback timer runs first
  // wins and the other is a no-op.
  const flush = useCallback(() => {
    clearFallback();
    const pending = serializerRef.current.takePendingOpen();
    // Explicit null check: OpenArgs is generic and could itself be falsy, so a
    // truthy test would wrongly skip a legitimately stashed value.
    if (pending !== null) openNowRef.current(pending);
  }, [clearFallback]);

  const requestOpen = useCallback(
    (args: OpenArgs) => {
      if (serializerRef.current.requestOpen(args) === 'open-now') {
        openNowRef.current(args);
        return;
      }
      // Deferred behind an in-flight dismiss: present() now would race
      // onDismiss. Replay from onDismiss, or from this bounded fallback if
      // gorhom ever skips it.
      clearFallback();
      fallbackTimerRef.current = setTimeout(flush, fallbackMs);
    },
    [clearFallback, flush, fallbackMs],
  );

  const onAnimate = useCallback(
    (toIndex: number) => {
      serializerRef.current.handleAnimate(toIndex);
      // Settled back on screen: the serializer dropped the stash, so the
      // pending fallback can only no-op — drop it too.
      if (toIndex !== -1) clearFallback();
    },
    [clearFallback],
  );

  useEffect(() => clearFallback, [clearFallback]);

  return { requestOpen, onAnimate, flushOnDismiss: flush };
}
