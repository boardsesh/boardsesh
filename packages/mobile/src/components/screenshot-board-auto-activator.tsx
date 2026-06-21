import { useEffect } from 'react';
import { useMyBoards } from '../lib/graphql/hooks';
import { useActiveBoard, useSetActiveBoard } from '../lib/graphql/use-active-board';
import { useAuth } from '../providers/auth-provider';

/**
 * Screenshot builds only: make the signed-in user's first saved board (Marco's
 * board) active so the board-backed screens (Climbs, Board View) render real
 * content instead of the "No board selected" picker. Replaces the Maestro flow's
 * fragile board-picker coordinate tap.
 *
 * Reactive + self-healing on purpose. It uses the SAME `useMyBoards` /
 * `useSetActiveBoard` hooks the real board picker uses — so it inherits React
 * Query's auth/retry/timing instead of a hand-rolled fetch wedged into the auth
 * boot sequence (which raced the token + the query cache GC and silently no-op'd).
 * Because it keeps `useActiveBoard` observed, the activated board is never
 * garbage-collected, and if anything clears it (e.g. a sign-out cleanup on a boot
 * AppState race) the effect re-runs and re-activates.
 *
 * Mount only behind an inlined `EXPO_PUBLIC_SCREENSHOT_MODE === '1'` check so it
 * dead-strips in normal builds and never runs for real users.
 */
export function ScreenshotBoardAutoActivator(): null {
  const { isAuthenticated } = useAuth();
  const { data: activeBoard } = useActiveBoard();
  // Same call shape as the board picker. Keeping it observed also keeps the
  // boards data warm in the React Query cache for the re-activation path.
  const { data: boardConnection } = useMyBoards(undefined, { enabled: isAuthenticated });
  const setActiveBoard = useSetActiveBoard();

  useEffect(() => {
    if (!isAuthenticated || activeBoard) return;
    const firstBoard = boardConnection?.boards?.[0];
    if (!firstBoard) return;
    // Logged so a screenshot run is debuggable from the Metro output the
    // orchestrator tees (a missing line means the boards fetch came back empty).
    console.log(`[screenshot] auto-activating board ${firstBoard.uuid} (${firstBoard.boardType})`);
    void setActiveBoard(firstBoard);
  }, [isAuthenticated, activeBoard, boardConnection, setActiveBoard]);

  return null;
}
