import { useEffect } from 'react';
import { useRouter } from 'expo-router';

// Where a route lands when it has nothing to go back to. The climbs tab is the
// home of every board-scoped route that uses this hook, so it is always a valid
// destination — unlike `router.back()` on a cold deep link, which has no history.
const CLIMBS_TAB = '/(tabs)/climbs' as const;

/**
 * Leave a board-scoped route the current board cannot answer for.
 *
 * The app's universal-link entry is a wildcard, so a hand-built link can open
 * any route with any `boardName` — including one whose feature is gated off for
 * that board (creating a climb, or the hold/zone search pickers, both of which
 * Woods can't do yet). Those routes used to fall through to a bare spinner that
 * never resolves. Bail out instead: pop back to wherever the user came from, or
 * land on the climbs tab when a cold link left no history to pop.
 *
 * Pass `false` and this is inert, so a route can call it unconditionally.
 */
export function useUnsupportedBoardExit(shouldExit: boolean): void {
  const router = useRouter();

  useEffect(() => {
    if (!shouldExit) return;
    if (router.canGoBack()) router.back();
    else router.replace(CLIMBS_TAB);
  }, [shouldExit, router]);
}
