import { useCallback, useMemo, useState } from 'react';

/**
 * The open/close lifecycle for a card that enlarges into a sheet.
 *
 * Two ids, not one, and that is the whole point. `visibleId` follows the sheet's
 * open state and clears the moment the climber closes it; `contentId` is what
 * the sheet DRAWS and survives until the dismiss has really settled.
 *
 * Clearing both at once tore the hosted board out of the sheet mid-dismiss. The
 * sheet coordinator treats a host that disappears before its dismiss settles as
 * a settle it may never hear about natively, and a group whose dismiss never
 * settles refuses the next present — the sheet opened a couple of times and then
 * stopped opening at all.
 *
 * `onFullyDismissed` is also the backstop that resyncs the two: without it, an
 * unreported close leaves a stale id, and re-pressing the same card writes the
 * same state, which React drops — so nothing reopens.
 */
export function useEnlargedPreview<Id extends string>(): {
  /** Drives the sheet's `visible`. */
  visibleId: Id | null;
  /** What the sheet renders. Outlives `visibleId` by one dismiss animation. */
  contentId: Id | null;
  open: (id: Id) => void;
  close: () => void;
  handleFullyDismissed: () => void;
} {
  const [visibleId, setVisibleId] = useState<Id | null>(null);
  const [contentId, setContentId] = useState<Id | null>(null);

  const open = useCallback((id: Id) => {
    setContentId(id);
    setVisibleId(id);
  }, []);

  const close = useCallback(() => setVisibleId(null), []);
  const handleFullyDismissed = useCallback(() => setContentId(null), []);

  // Memoized because a caller that holds this object — rather than destructuring
  // it — would otherwise take a new dependency on every render, and a rail that
  // threads one of these callbacks down to a memoized row re-renders a board
  // image per card when that happens.
  return useMemo(
    () => ({ visibleId, contentId, open, close, handleFullyDismissed }),
    [visibleId, contentId, open, close, handleFullyDismissed],
  );
}
