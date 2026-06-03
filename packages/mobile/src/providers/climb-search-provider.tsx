// Single source of truth for the climbs search screen's filter + name + view
// state. Replaces the per-screen useState soup so the grade popover, the
// search bar / sticky strip, the filter sheet, and the results list all read
// and write one place. Mirrors web's UISearchParamsProvider in spirit
// (immediate local apply; the screen owns debouncing the GraphQL query and
// persisting per-board memory).
//
// Pure in-memory state only — no storage or network here. Per-board
// restoration and result counting are wired by the climbs screen so this
// provider stays trivially testable and renderer-agnostic.

import { createContext, useCallback, useContext, useMemo, useReducer, type PropsWithChildren } from 'react';
import {
  DEFAULT_CLIMB_FILTER_STATE,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../lib/climb-filter-types';

/** Lower/upper grade bounds as difficulty ids; undefined = unbounded side. */
export type GradeBound = { minGradeId: number | undefined; maxGradeId: number | undefined };

export type ClimbSearchState = {
  filters: ClimbFilters;
  /** Board-renderer-dependent filters (benchmark now; holds/zone later). */
  boardFilters: ClimbBoardFilterState;
  /** Committed (already-debounced) name term used for the query. */
  name: string;
};

const DEFAULT_STATE: ClimbSearchState = {
  filters: DEFAULT_CLIMB_FILTER_STATE,
  boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE,
  name: '',
};

type Action =
  | { type: 'setFilters'; filters: ClimbFilters }
  | { type: 'patchFilters'; patch: Partial<ClimbFilters> }
  | { type: 'setGrade'; grade: GradeBound }
  | { type: 'setBoardFilters'; boardFilters: ClimbBoardFilterState }
  | { type: 'patchBoardFilters'; patch: Partial<ClimbBoardFilterState> }
  | { type: 'setName'; name: string }
  | { type: 'replaceSearch'; filters: ClimbFilters; boardFilters: ClimbBoardFilterState; name: string }
  | { type: 'reset' };

function reducer(state: ClimbSearchState, action: Action): ClimbSearchState {
  switch (action.type) {
    case 'setFilters':
      return { ...state, filters: action.filters };
    case 'patchFilters':
      return { ...state, filters: { ...state.filters, ...action.patch } };
    case 'setGrade':
      return {
        ...state,
        filters: { ...state.filters, minGrade: action.grade.minGradeId, maxGrade: action.grade.maxGradeId },
      };
    case 'setBoardFilters':
      return { ...state, boardFilters: action.boardFilters };
    case 'patchBoardFilters':
      return { ...state, boardFilters: { ...state.boardFilters, ...action.patch } };
    case 'setName':
      return { ...state, name: action.name };
    case 'replaceSearch':
      return { ...state, filters: action.filters, boardFilters: action.boardFilters, name: action.name };
    case 'reset':
      return { ...DEFAULT_STATE };
    default:
      return state;
  }
}

export type ClimbSearchContextValue = ClimbSearchState & {
  setFilters: (filters: ClimbFilters) => void;
  patchFilters: (patch: Partial<ClimbFilters>) => void;
  setGrade: (grade: GradeBound) => void;
  setBoardFilters: (boardFilters: ClimbBoardFilterState) => void;
  patchBoardFilters: (patch: Partial<ClimbBoardFilterState>) => void;
  setName: (name: string) => void;
  /** Apply a saved filter+name (+board filters) set atomically (recent pill, per-board restore). */
  replaceSearch: (filters: ClimbFilters, name: string, boardFilters?: ClimbBoardFilterState) => void;
  reset: () => void;
};

const ClimbSearchContext = createContext<ClimbSearchContextValue | null>(null);

export function ClimbSearchProvider({ children, initial }: PropsWithChildren<{ initial?: Partial<ClimbSearchState> }>) {
  const [state, dispatch] = useReducer(reducer, { ...DEFAULT_STATE, ...initial });

  // Actions get STABLE identities (dispatch is stable) so consumers like the
  // climbs screen's debounced name handler don't churn the nav header on every
  // keystroke/grade tap. State spreads in separately.
  const actions = useMemo(
    () => ({
      setFilters: (filters: ClimbFilters) => dispatch({ type: 'setFilters', filters }),
      patchFilters: (patch: Partial<ClimbFilters>) => dispatch({ type: 'patchFilters', patch }),
      setGrade: (grade: GradeBound) => dispatch({ type: 'setGrade', grade }),
      setBoardFilters: (boardFilters: ClimbBoardFilterState) => dispatch({ type: 'setBoardFilters', boardFilters }),
      patchBoardFilters: (patch: Partial<ClimbBoardFilterState>) => dispatch({ type: 'patchBoardFilters', patch }),
      setName: (name: string) => dispatch({ type: 'setName', name }),
      replaceSearch: (
        filters: ClimbFilters,
        name: string,
        boardFilters: ClimbBoardFilterState = DEFAULT_CLIMB_BOARD_FILTER_STATE,
      ) => dispatch({ type: 'replaceSearch', filters, name, boardFilters }),
      reset: () => dispatch({ type: 'reset' }),
    }),
    [],
  );

  const value = useMemo<ClimbSearchContextValue>(() => ({ ...state, ...actions }), [state, actions]);

  return <ClimbSearchContext.Provider value={value}>{children}</ClimbSearchContext.Provider>;
}

export function useClimbSearch(): ClimbSearchContextValue {
  const value = useContext(ClimbSearchContext);
  if (!value) {
    throw new Error('useClimbSearch must be used within a ClimbSearchProvider');
  }
  return value;
}

/** Non-throwing variant for components that may render outside the provider. */
export function useOptionalClimbSearch(): ClimbSearchContextValue | null {
  return useContext(ClimbSearchContext);
}

// Re-export the callback so test/setup code can build a default state without
// importing the shared package directly.
export const DEFAULT_CLIMB_SEARCH_STATE = DEFAULT_STATE;
