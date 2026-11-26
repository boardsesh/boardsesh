import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CLIMB_FILTER_STATE,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type BoardSearchConfig,
} from '@boardsesh/climb-filters';
import type { ClimbSearchContextValue } from '../../providers/climb-search-provider';
import { getLastSearch, saveLastSearch } from '../../lib/last-search-store';
import { boardGeometryKey, withoutGeometryFilters } from '../../lib/climb-filter-session-reducer';
import { filtersForBoard, statusForAuth } from '../../lib/climb-filter-types';

type Options = Pick<ClimbSearchContextValue, 'filters' | 'boardFilters' | 'name' | 'replaceSearch'> & {
  boardConfig: BoardSearchConfig | null;
  isAuthenticated: boolean;
};

/**
 * Restores the climber's last search before querying or saving, then keeps it
 * saved. One search follows the climber everywhere: changing the angle keeps
 * all of it, and switching to another board keeps the filters but clears the
 * climb name and the hold and zone picks, which only mean something on the
 * board they were set on (the same rule as the playlist filter session).
 *
 * Storage is read once per sign-in state. A board switch after that works on
 * the search already in memory, so a change still inside the save debounce is
 * never lost to a stale read.
 */
export function usePersistedClimbSearch(options: Options) {
  const { boardConfig, isAuthenticated, filters, boardFilters, name } = options;
  const boardKey = boardConfig ? boardGeometryKey(boardConfig) : null;
  const scopeKey = boardKey === null ? null : `${boardKey}|${isAuthenticated}`;
  const [restoredScope, setRestoredScope] = useState<string | null>(null);
  // The sign-in state the in-memory search was last read from storage under.
  const readForAuthRef = useRef<boolean | null>(null);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const {
      boardConfig: board,
      isAuthenticated: authenticated,
      replaceSearch: replace,
      filters: currentFilters,
      boardFilters: currentBoardFilters,
    } = latest.current;
    if (!board || scopeKey === null) {
      setRestoredScope(null);
      return;
    }
    if (readForAuthRef.current === authenticated) {
      replace(filtersForBoard(currentFilters, board.boardName), '', withoutGeometryFilters(currentBoardFilters));
      setRestoredScope(scopeKey);
      return;
    }
    setRestoredScope(null);
    let cancelled = false;
    void getLastSearch(board, { isAuthenticated: authenticated })
      .catch(() => null)
      .then((saved) => {
        if (cancelled) return;
        replace(
          saved
            ? filtersForBoard(statusForAuth(saved.filters, authenticated), board.boardName)
            : DEFAULT_CLIMB_FILTER_STATE,
          saved?.searchText ?? '',
          saved?.boardFilters ?? DEFAULT_CLIMB_BOARD_FILTER_STATE,
        );
        readForAuthRef.current = authenticated;
        setRestoredScope(scopeKey);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeKey]);
  const ready = scopeKey !== null && restoredScope === scopeKey;
  useEffect(() => {
    if (!boardConfig || !ready) return;
    const timeout = setTimeout(() => {
      void saveLastSearch(boardConfig, filters, name, boardFilters);
    }, 600);
    return () => clearTimeout(timeout);
  }, [boardConfig, ready, filters, boardFilters, name]);
  return ready;
}
