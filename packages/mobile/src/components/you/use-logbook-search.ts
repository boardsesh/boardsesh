import { useCallback, useEffect, useMemo, useReducer } from 'react';
import {
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  type LogbookFilterState,
  type LogbookSortPreset,
  type LogbookSortState,
} from '@boardsesh/logbook';
import { loadLogbookPrefs, saveLogbookPrefs } from '../../lib/logbook-prefs-store';

/**
 * Logbook search state for the mobile Logbook tab: the climb-name term, the
 * filter set, and the sort. The tab owns this and feeds it to the filter sheet
 * (props) and to `toAscentFeedInput` for the feed query, mirroring the climbs
 * screen's `ClimbSearchProvider` but as a hook (single consumer, no context).
 *
 * Filters + sort persist across app restarts (AsyncStorage); the climb-name
 * term is transient and is not persisted.
 */
export type LogbookSearchState = {
  filters: LogbookFilterState;
  sort: LogbookSortState;
  /** Committed climb-name search term (not persisted). */
  name: string;
  /** True once persisted prefs have loaded (or been confirmed absent). */
  hydrated: boolean;
};

const DEFAULT_STATE: LogbookSearchState = {
  filters: DEFAULT_LOGBOOK_FILTERS,
  sort: DEFAULT_LOGBOOK_SORT,
  name: '',
  hydrated: false,
};

type Action =
  | { type: 'setName'; name: string }
  | { type: 'setPreset'; preset: LogbookSortPreset }
  | { type: 'apply'; filters: LogbookFilterState; sort: LogbookSortState }
  | { type: 'hydrate'; filters: LogbookFilterState; sort: LogbookSortState }
  | { type: 'reset' };

function reducer(state: LogbookSearchState, action: Action): LogbookSearchState {
  switch (action.type) {
    case 'setName':
      return { ...state, name: action.name };
    case 'setPreset':
      return { ...state, sort: { ...DEFAULT_LOGBOOK_SORT, mode: 'preset', preset: action.preset } };
    case 'apply':
      return { ...state, filters: action.filters, sort: action.sort };
    case 'hydrate':
      return { ...state, filters: action.filters, sort: action.sort, hydrated: true };
    case 'reset':
      return { ...DEFAULT_STATE, hydrated: true };
    default:
      return state;
  }
}

export type UseLogbookSearch = LogbookSearchState & {
  setName: (name: string) => void;
  setPreset: (preset: LogbookSortPreset) => void;
  apply: (filters: LogbookFilterState, sort: LogbookSortState) => void;
  reset: () => void;
};

export function useLogbookSearch(): UseLogbookSearch {
  const [state, dispatch] = useReducer(reducer, DEFAULT_STATE);

  // Hydrate persisted filter/sort once on mount. The feed waits on `hydrated`
  // (see LogbookTab) so it fetches once with the restored prefs, not twice.
  useEffect(() => {
    let cancelled = false;
    void loadLogbookPrefs().then((prefs) => {
      if (cancelled) return;
      dispatch({
        type: 'hydrate',
        filters: prefs?.filters ?? DEFAULT_LOGBOOK_FILTERS,
        sort: prefs?.sort ?? DEFAULT_LOGBOOK_SORT,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist filter/sort across restarts once hydrated (the name stays transient).
  useEffect(() => {
    if (!state.hydrated) return;
    void saveLogbookPrefs({ filters: state.filters, sort: state.sort });
  }, [state.hydrated, state.filters, state.sort]);

  // Stable action identities so the toolbar / name handler don't churn.
  const actions = useMemo(
    () => ({
      setName: (name: string) => dispatch({ type: 'setName', name }),
      setPreset: (preset: LogbookSortPreset) => dispatch({ type: 'setPreset', preset }),
      apply: (filters: LogbookFilterState, sort: LogbookSortState) => dispatch({ type: 'apply', filters, sort }),
      reset: () => dispatch({ type: 'reset' }),
    }),
    [],
  );

  return useMemo(() => ({ ...state, ...actions }), [state, actions]);
}

/** Number of active (non-default) logbook filters — drives the filter-button badge. */
export function countActiveLogbookFilters(filters: LogbookFilterState): number {
  let count = 0;
  if (!filters.includeSends || !filters.includeAttempts) count += 1;
  if (filters.flashOnly) count += 1;
  if (filters.minGrade !== '' || filters.maxGrade !== '') count += 1;
  if (filters.fromDate || filters.toDate) count += 1;
  // The angle range is one filter even when both bounds are narrowed.
  if (
    filters.angleRange[0] !== DEFAULT_LOGBOOK_FILTERS.angleRange[0] ||
    filters.angleRange[1] !== DEFAULT_LOGBOOK_FILTERS.angleRange[1]
  ) {
    count += 1;
  }
  if (filters.benchmarkOnly) count += 1;
  return count;
}
