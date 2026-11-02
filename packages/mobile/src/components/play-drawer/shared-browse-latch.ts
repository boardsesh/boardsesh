import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * How long the session must stay solo before an armed browse latch lets go.
 *
 * Longer than the provider's arming dwell, and deliberately so: arming late is a
 * mild inconvenience, but releasing early re-arms wall control under a climber
 * who is still mid-browse with a crew that is merely reconnecting. Ten seconds
 * outlasts a wifi handover and a backgrounded peer's socket teardown, which are
 * the flaps worth surviving, while still guaranteeing that a climber left alone
 * gets their board back without having to find a button.
 */
export const SHARED_BROWSE_LATCH_RELEASE_MS = 10_000;

/**
 * The crew browse latch (see PlayCore's "shared-session browse latch"): armed
 * while a crew is here and the climber is looking at a preview, held through a
 * crew that flaps, and let go once the session has been solo for
 * {@link SHARED_BROWSE_LATCH_RELEASE_MS}. The player and the MiniPlayer's ⏮ ⏭
 * on a last pick read it the same way, so a step from the bar stays a look
 * exactly when the player's swipe would.
 *
 * Returns the setter too: the player's own exits (Back, a commit) drop it at once.
 */
export function useSharedBrowseLatch(
  isSharedSession: boolean,
  browsing: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (isSharedSession && browsing) setLatched(true);
  }, [isSharedSession, browsing]);
  useEffect(() => {
    if (isSharedSession) return;
    const timer = setTimeout(() => {
      setLatched(false);
    }, SHARED_BROWSE_LATCH_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [isSharedSession]);
  return [latched, setLatched];
}
