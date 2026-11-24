import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import { BOARD_HISTORY_WINDOW_MS, boardHistoryExpiresAt, filterRecentBoardHistory } from '@boardsesh/board-presence';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

// The platform's existing refresh action supplies foreground/reconnect signals.
// Keep them separate from current-climb state and transport identity.
export const BoardHistoryRefreshContext = createContext(0);

/** Display-only retention: never expire the reducer's live climb or sequence state. */
export function useRecentBoardHistory(entries: BoardPresenceClimb[], refreshVersion?: number) {
  const contextRefreshVersion = useContext(BoardHistoryRefreshContext);
  const [clockRevision, recheck] = useReducer((revision: number) => revision + 1, 0);
  const effectiveRefreshVersion = refreshVersion ?? contextRefreshVersion;
  const projection = useMemo(() => {
    const history = filterRecentBoardHistory(entries, Date.now());
    let expiresAt: number | null = null;
    for (const entry of history) {
      const entryExpiry = boardHistoryExpiresAt(entry.sentAt);
      if (entryExpiry !== null && (expiresAt === null || entryExpiry < expiresAt)) expiresAt = entryExpiry;
    }
    return { history, expiresAt };
    // Clock revisions deliberately re-evaluate the same retained entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, clockRevision, effectiveRefreshVersion]);

  const recheckHistory = useCallback(() => recheck(), []);
  useEffect(() => {
    if (projection.expiresAt === null) return;
    // One timer for the next expiry, bounded even for a future-dated live event.
    const delay = Math.max(1, Math.min(BOARD_HISTORY_WINDOW_MS, projection.expiresAt - Date.now()));
    const timer = setTimeout(recheckHistory, delay);
    return () => clearTimeout(timer);
  }, [projection, recheckHistory]);

  return { history: projection.history, recheckHistory };
}
