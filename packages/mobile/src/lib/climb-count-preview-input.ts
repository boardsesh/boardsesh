import {
  mergeBoardFilters,
  toClimbSearchInput,
  type BoardSearchConfig,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { filtersForBoard, type ClimbFilters } from './climb-filter-types';
import { normalizeSearchName } from './search-name';

// The "Show N climbs" count input, shared by the climb filter sheet and the
// setters route it pushes. Both screens build the count query's input through
// these two functions, so the same picks hash to the same React Query key: the
// count the setters screen fetched is a cache hit when the sheet re-presents.

/**
 * The count input for a filter draft: page 0, one row, name included.
 *
 * Both inputs go through the same normalisation the committed search does, or
 * "Show N" would count a different list from the one Apply shows: the name is
 * trimmed like `normalizeSearchName` trims the search field (on Woods a lone space
 * would otherwise read as a by-name search and count every angle, #5642), and
 * `filtersForBoard` drops a filter this board has no switch for.
 */
export function buildCountPreviewInput(
  filters: ClimbFilters,
  boardFilters: ClimbBoardFilterState,
  boardConfig: BoardSearchConfig,
  name: string,
): ClimbSearchInput {
  return mergeBoardFilters(
    toClimbSearchInput(
      filtersForBoard(filters, boardConfig.boardName),
      boardConfig,
      { page: 0, pageSize: 1 },
      { name: normalizeSearchName(name) },
    ),
    boardFilters,
  );
}

/**
 * Swaps the setter selection on a count input. An empty selection omits
 * `setter` entirely, the same rule `toClimbSearchInput` applies, so the result
 * matches what the sheet builds once the picks are merged into its draft.
 */
export function withSetterSelection(input: ClimbSearchInput, setters: readonly string[]): ClimbSearchInput {
  const { setter: _previousSetters, ...inputWithoutSetters } = input;
  return setters.length > 0 ? { ...inputWithoutSetters, setter: [...setters] } : inputWithoutSetters;
}
