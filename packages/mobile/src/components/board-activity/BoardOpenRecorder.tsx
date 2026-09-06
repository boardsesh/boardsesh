// Records "this climber opened this board" — the recency half of the
// "Your boards" ordering (#4884). Mounted once at the app root; renders null.
//
// Why one root-level watcher instead of instrumenting the activation paths:
// `useActivateBoard` is the funnel for the picker, the builder and onboarding,
// but a BLE connect, a deep link, the cross-board add gate, the drawer host, the
// queue provider, the gym list and the board editor all call `useSetActiveBoard`
// directly. Instrumenting the setter is wrong in the other direction — the angle
// controls rewrite the active board for an ANGLE change, which is not a board
// open. Watching the active board's UUID catches every real switch and nothing
// else: an angle rewrite keeps the same uuid.

import { useEffect } from 'react';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useRecordBoardOpened } from '../../lib/graphql/hooks';
import { useAuth } from '../../providers/auth-provider';
import { useStoredUserId } from '../../hooks/use-current-user-id';

/**
 * The last (user, board) pair recorded, at module scope rather than in a ref.
 *
 * A ref resets when the component remounts — which Fast Refresh and an OTA
 * reload both do — and would re-record the same board. Keyed by user as well as
 * board so two accounts on one device cannot dedupe against each other.
 */
let lastRecordedKey: string | null = null;

/** Test seam: the module-level dedupe outlives a test's render tree. */
export function resetBoardOpenRecorderForTests(): void {
  lastRecordedKey = null;
}

export function BoardOpenRecorder(): null {
  const { isAuthenticated } = useAuth();
  const { data: activeBoard, isPending } = useActiveBoard();
  const { userId } = useStoredUserId(isAuthenticated);
  const recordBoardOpened = useRecordBoardOpened();

  // The uuid scalar, never the board object: the query hands back a fresh object
  // identity on every refetch and on every angle write.
  const boardUuid = activeBoard?.uuid ?? null;
  const record = recordBoardOpened.mutate;

  useEffect(() => {
    // `data` is undefined while the AsyncStorage read is in flight; treating
    // that tick as "no board" would fire again the moment it resolves.
    if (isPending) return;
    if (!isAuthenticated || boardUuid == null || userId == null) return;
    // Screenshot builds drive the active board themselves to stage captures.
    // Recording those would reorder the store-shot account's board list between
    // runs. Inlined so it dead-strips from normal builds.
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;

    const key = `${userId}:${boardUuid}`;
    if (lastRecordedKey === key) return;
    lastRecordedKey = key;

    // Fire-and-forget. Offline this simply fails, and that is the right
    // outcome: an ordering nicety must never produce a toast, a retry storm or
    // a Sentry entry. The next open on a live connection records it.
    record(boardUuid, { onError: () => {} });
  }, [isPending, isAuthenticated, boardUuid, userId, record]);

  return null;
}
