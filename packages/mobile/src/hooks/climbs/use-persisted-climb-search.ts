import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CLIMB_FILTER_STATE,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type BoardSearchConfig,
} from '@boardsesh/climb-filters';
import type { ClimbSearchContextValue } from '../../providers/climb-search-provider';
import { boardConfigKey, getLastSearch, saveLastSearch } from '../../lib/last-search-store';
import { statusForAuth } from '../../lib/climb-filter-types';

type Options = Pick<ClimbSearchContextValue, 'filters' | 'boardFilters' | 'name' | 'replaceSearch'> & {
  boardConfig: BoardSearchConfig | null;
  isAuthenticated: boolean;
};

/** Restore before querying or saving; a completed read belongs to one board/login scope. */
export function usePersistedClimbSearch(options: Options) {
  const { boardConfig, isAuthenticated, filters, boardFilters, name } = options;
  const boardKey = boardConfig ? boardConfigKey(boardConfig) : null;
  const scopeKey = boardKey === null ? null : `${boardKey}|${isAuthenticated}`;
  const [restoredScope, setRestoredScope] = useState<string | null>(null);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const { boardConfig: board, isAuthenticated: authenticated, replaceSearch: replace } = latest.current;
    setRestoredScope(null);
    if (!board || scopeKey === null) return;
    let cancelled = false;
    void getLastSearch(board, { isAuthenticated: authenticated })
      .catch(() => null)
      .then((saved) => {
        if (cancelled) return;
        replace(
          saved ? statusForAuth(saved.filters, authenticated) : DEFAULT_CLIMB_FILTER_STATE,
          saved?.searchText ?? '',
          saved?.boardFilters ?? DEFAULT_CLIMB_BOARD_FILTER_STATE,
        );
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
  }, [boardConfig, ready, scopeKey, filters, boardFilters, name]);
  return ready;
}
