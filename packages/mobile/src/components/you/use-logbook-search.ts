import { useEffect, useMemo, useReducer, useState } from 'react';
import {
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  isLogbookDateFilterActive,
  statusSegmentFor,
  type LogbookFilterState,
  type LogbookSortState,
} from '@boardsesh/logbook';
import { loadLogbookPrefs, saveLogbookPrefs } from '../../lib/logbook-prefs-store';

/**
 * Logbook search state for the mobile Logbook tab: the climb-name term, the
 * filter set, and the sort. The tab owns this and feeds it to the filter sheet
 * (props) and to `toAscentFeedInput` for the feed query, mirroring the climbs
 * screen's `ClimbSearchProvider` but as a hook (single consumer, no context).
 *
 * On your own logbook filters + sort persist across app restarts
 * (AsyncStorage); on someone else's they last the visit (`persist: false`).
 * The climb-name term is transient and is never persisted.
 */
export type LogbookSearchState = {
  filters: LogbookFilterState;
  sort: LogbookSortState;
  /** Committed climb-name search term (not persisted). */
  name: string;
  /** True once persisted prefs have loaded (or been confirmed absent). */
  hydrated: boolean;
  /**
   * True once the user has changed filters/sort this session. The capsules are
   * live before hydration finishes, so a late `hydrate` must keep the user's
   * change instead of clobbering it with the just-loaded prefs.
   */
  userModified: boolean;
};

const DEFAULT_STATE: LogbookSearchState = {
  filters: DEFAULT_LOGBOOK_FILTERS,
  sort: DEFAULT_LOGBOOK_SORT,
  name: '',
  hydrated: false,
  userModified: false,
};

type Action =
  | { type: 'setName'; name: string }
  | { type: 'setSort'; sort: LogbookSortState }
  | { type: 'setFilters'; filters: Partial<LogbookFilterState> }
  | { type: 'hydrate'; filters: LogbookFilterState; sort: LogbookSortState }
  | { type: 'reset' };

function reducer(state: LogbookSearchState, action: Action): LogbookSearchState {
  switch (action.type) {
    case 'setName':
      // The name is transient and not persisted, so typing one must NOT block a
      // pending hydrate from applying the user's saved filters/sort.
      return { ...state, name: action.name };
    case 'setSort':
      // Live commit of a whole sort (Sort by + Order); filters and name untouched.
      return { ...state, sort: action.sort, userModified: true };
    case 'setFilters':
      // Live per-field merge from the capsules, rails, tokens and the sheet. It
      // touches only the named fields and never the sort or the name.
      return { ...state, filters: { ...state.filters, ...action.filters }, userModified: true };
    case 'hydrate':
      // If the user changed filters/sort while prefs were still loading, keep
      // their values and only open the gate; otherwise apply the loaded prefs.
      return state.userModified
        ? { ...state, hydrated: true }
        : { ...state, filters: action.filters, sort: action.sort, hydrated: true };
    case 'reset':
      return { ...DEFAULT_STATE, hydrated: true, userModified: true };
    default:
      return state;
  }
}

export type UseLogbookSearch = LogbookSearchState & {
  setName: (name: string) => void;
  /** Live-commit a whole sort, e.g. `logbookSortFor(key, direction)`. */
  setSort: (sort: LogbookSortState) => void;
  /** Live-commit a partial filter patch (capsules, rails, tokens, the sheet). */
  setFilters: (partial: Partial<LogbookFilterState>) => void;
  reset: () => void;
};

export type UseLogbookSearchOptions = {
  /**
   * Load and save the filters + sort (your own logbook). False keeps them for
   * this visit only, so filtering someone else's logbook never changes yours.
   * Read once at mount: to switch, remount (key the caller on it), since a
   * mid-life switch could save defaults over the stored prefs before they load.
   */
  persist?: boolean;
};

export function useLogbookSearch({ persist = true }: UseLogbookSearchOptions = {}): UseLogbookSearch {
  const [persistOnMount] = useState(persist);
  // Session-only state has nothing to load, so it opens the feed at once.
  const [state, dispatch] = useReducer(reducer, persistOnMount, (persisting) => ({
    ...DEFAULT_STATE,
    hydrated: !persisting,
  }));

  // Hydrate persisted filter/sort once on mount. The feed waits on `hydrated`
  // (see LogbookTab) so it fetches once with the restored prefs, not twice.
  useEffect(() => {
    if (!persistOnMount) return;
    let cancelled = false;
    // Always complete hydration — even if loading throws (storage unavailable) —
    // so the feed, which is gated on `hydrated`, never stays stuck disabled.
    void loadLogbookPrefs()
      .then((prefs) => {
        if (cancelled) return;
        dispatch({
          type: 'hydrate',
          filters: prefs?.filters ?? DEFAULT_LOGBOOK_FILTERS,
          sort: prefs?.sort ?? DEFAULT_LOGBOOK_SORT,
        });
      })
      .catch(() => {
        if (cancelled) return;
        dispatch({ type: 'hydrate', filters: DEFAULT_LOGBOOK_FILTERS, sort: DEFAULT_LOGBOOK_SORT });
      });
    return () => {
      cancelled = true;
    };
  }, [persistOnMount]);

  // Persist filter/sort across restarts once hydrated (the name stays transient).
  useEffect(() => {
    if (!persistOnMount || !state.hydrated) return;
    void saveLogbookPrefs({ filters: state.filters, sort: state.sort });
  }, [persistOnMount, state.hydrated, state.filters, state.sort]);

  // Stable action identities so the capsule row and the name handler don't churn.
  const actions = useMemo(
    () => ({
      setName: (name: string) => dispatch({ type: 'setName', name }),
      setSort: (sort: LogbookSortState) => dispatch({ type: 'setSort', sort }),
      setFilters: (partial: Partial<LogbookFilterState>) => dispatch({ type: 'setFilters', filters: partial }),
      reset: () => dispatch({ type: 'reset' }),
    }),
    [],
  );

  return useMemo(() => ({ ...state, ...actions }), [state, actions]);
}

/**
 * Number of active (non-default) logbook filters — drives the filter-button
 * badge. Each dimension counts once however many of its fields are set (Flashes
 * is one status, a min+max grade is one range, a board + layouts is one board).
 * The climb-name search is not a filter field; the UI counts it separately.
 */
export function countActiveLogbookFilters(filters: LogbookFilterState): number {
  const activeDimensions = [
    // Status rests on All (sends + attempts); Sends, Flashes and Attempts count.
    statusSegmentFor(filters) !== 'all',
    filters.minGrade !== '' || filters.maxGrade !== '',
    filters.angleRange[0] !== DEFAULT_LOGBOOK_FILTERS.angleRange[0] ||
      filters.angleRange[1] !== DEFAULT_LOGBOOK_FILTERS.angleRange[1],
    // A Custom window with no date picked yet narrows nothing.
    isLogbookDateFilterActive(filters),
    filters.boardType !== '',
    filters.minQuality !== '',
    filters.setterUsernames.length > 0,
    filters.benchmarkOnly,
  ];
  return activeDimensions.filter(Boolean).length;
}
