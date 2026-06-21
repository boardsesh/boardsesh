/**
 * Serializes imperative open() requests against a gorhom BottomSheetModal's
 * dismiss animation. Calling `present()` while the modal is still animating
 * closed races its `onDismiss`: the stale dismissal callback fires AFTER the
 * re-present and wipes the open state (`isSheetOpen` → false), leaving the
 * sheet visibly presented but with its deferred content gated off forever —
 * the intermittent "drawer opens but no board renders" bug.
 *
 * Instead of presenting mid-dismiss, callers ask the serializer first:
 * `requestOpen` returns 'open-now' when no dismissal is in flight, or stashes
 * the request (last one wins) and returns 'deferred'. The stash is flushed via
 * `takePendingOpen()` from the modal's `onDismiss`, once the dismissal has
 * fully completed and the state reset has run — so the re-present always
 * targets a cleanly dismissed modal.
 *
 * Pure TS (no React, no timers) so the open/dismiss interleavings are unit
 * testable; the consuming component owns the refs and any timeout fallback.
 */

export type SheetOpenSerializer<OpenArgs> = {
  /**
   * Ask to open the sheet. Returns 'open-now' when it's safe to present
   * immediately; otherwise stashes `args` (replacing any earlier stash) and
   * returns 'deferred' — the caller opens later via `takePendingOpen()`.
   */
  requestOpen: (args: OpenArgs) => 'open-now' | 'deferred';
  /**
   * Wire to the modal's `onAnimate(fromIndex, toIndex)` with `toIndex`. The
   * sheet is dismissing exactly while it's settling toward index -1; settling
   * to any on-screen index (present, or a spring-back from an aborted swipe)
   * clears the dismissing flag AND drops any stashed open — that stash's only
   * legitimate consumer is the dismissal's `onDismiss`, which won't fire if the
   * sheet is staying on screen, so leaving it would replay an old climb on the
   * next real close.
   */
  handleAnimate: (toIndex: number) => void;
  /**
   * Take the stashed open request, if any, clearing it and the dismissing
   * flag. Wire to the modal's `onDismiss` (after the close-state reset) and to
   * any caller-side timeout fallback — idempotent, so whichever flush runs
   * first wins and the other is a no-op.
   */
  takePendingOpen: () => OpenArgs | null;
};

export function createSheetOpenSerializer<OpenArgs>(): SheetOpenSerializer<OpenArgs> {
  let isDismissing = false;
  let pendingOpen: OpenArgs | null = null;

  return {
    requestOpen: (args) => {
      if (!isDismissing) return 'open-now';
      pendingOpen = args;
      return 'deferred';
    },
    handleAnimate: (toIndex) => {
      if (toIndex === -1) {
        isDismissing = true;
        return;
      }
      // Settled back on screen (spring-back from an aborted close, or a
      // present): the dismissal that stashed an open is no longer happening, so
      // its `onDismiss` won't fire to consume the stash. Drop it now so it can't
      // replay on the next, unrelated close.
      isDismissing = false;
      pendingOpen = null;
    },
    takePendingOpen: () => {
      isDismissing = false;
      const taken = pendingOpen;
      pendingOpen = null;
      return taken;
    },
  };
}
