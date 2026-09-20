import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { useToast } from '../../providers/toast-provider';

// Where a route lands when it has nothing to go back to. The climbs tab is the
// home of every board-scoped route that uses this hook, so it is always a valid
// destination — unlike `router.back()` on a cold deep link, which has no history.
const CLIMBS_TAB = '/(tabs)/climbs' as const;

/**
 * Leave an unusable board route, falling back to the climbs tab for cold links.
 * The optional root-level toast outlives the route dismissal.
 * Dismisses at most once per mount; callers must unmount when navigation completes.
 */
export function useUnsupportedBoardExit(shouldExit: boolean, reason?: string): void {
  const router = useRouter();
  const { showToast } = useToast();
  // Reason changes before dismissal must not pop or toast twice.
  const exited = useRef(false);

  useEffect(() => {
    if (!shouldExit || exited.current) return;
    exited.current = true;
    if (reason) showToast(reason, 'error');
    if (router.canGoBack()) router.back();
    else router.replace(CLIMBS_TAB);
  }, [shouldExit, reason, router, showToast]);
}
