import { useEffect, useRef, useState } from 'react';
import { useHasAccessoryClimb } from './use-has-accessory-climb';

// Hold the native bottom accessory mounted for this long after a climb's presence
// drops. Board-presence reconnects and queue rehydration can blip presence
// false→true within a frame or two; the grace window swallows that blip.
const PRESENCE_DROP_GRACE_MS = 500;

/**
 * Sticky wrapper over {@link useHasAccessoryClimb} for the iOS 26 bottom-accessory
 * mount gate. Returns `true` immediately when a climb is present; when presence
 * drops it holds the previous `true` for a short grace window and only reports
 * `false` if presence stays gone past it.
 *
 * Why: the native `NativeTabs.BottomAccessory` host is gated on presence. A
 * board-presence reconnect (socket drop → `boardId`/feed gap) or a cold-restore
 * queue rehydrate can flip the underlying presence false→true within a frame.
 * Without this hold the host unmounts and remounts on that blip, and UIKit leaves
 * a stale snapshot of the glass platter stacked under the new one — the doubled
 * climb name. Collapsing the blip into a continuous `true` keeps the host's
 * identity stable so no snapshot is orphaned. The grace window's exact length is a
 * heuristic; the hold logic itself is what matters.
 */
export function useStickyAccessoryPresence(graceMs: number = PRESENCE_DROP_GRACE_MS): boolean {
  const hasClimb = useHasAccessoryClimb();
  const [sticky, setSticky] = useState(hasClimb);
  // Mirror the latest sticky value so the cleanup-less true branch can no-op
  // without listing `sticky` as an effect dependency.
  const stickyRef = useRef(sticky);
  stickyRef.current = sticky;

  useEffect(() => {
    if (hasClimb) {
      if (!stickyRef.current) setSticky(true);
      return;
    }
    const dropHandle = setTimeout(() => setSticky(false), graceMs);
    return () => clearTimeout(dropHandle);
  }, [hasClimb, graceMs]);

  return sticky;
}
