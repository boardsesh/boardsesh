// Leaving the player for a plain card route (a climber's profile, climber
// search).
//
// On iPhone the player is the root-stack `transparentModal` `/play`, and the
// native stack keeps a modal above every card: a card pushed while the player is
// up lands beneath it and only shows once the player is closed
// (docs/mobile-sheets-vs-routes.md). So the player goes first, the native
// transition is waited out, and only then does the route push. The setter
// playlist link in PlayDrawer does the same.
//
// The iPad pane has no `/play` route to dismiss; it passes no waiter and the
// push runs straight away.
import { useCallback, useRef } from 'react';
import type { DismissSurfaceAndWait } from '../create-climb/use-create-climb-navigation';
import { reportHandledError } from '../../lib/error-reporting';

export function usePushAfterPlayerDismiss(dismissPlayerAndWait: DismissSurfaceAndWait | undefined) {
  // One handoff at a time: a second tap during the dismiss would push twice.
  const leavingRef = useRef(false);
  return useCallback(
    (push: () => void) => {
      if (!dismissPlayerAndWait) {
        push();
        return;
      }
      if (leavingRef.current) return;
      leavingRef.current = true;
      void (async () => {
        try {
          if ((await dismissPlayerAndWait()).status === 'aborted') return;
          push();
        } catch (error) {
          reportHandledError(error, { tags: { source: 'play-drawer-route-handoff' } });
        } finally {
          leavingRef.current = false;
        }
      })();
    },
    [dismissPlayerAndWait],
  );
}
