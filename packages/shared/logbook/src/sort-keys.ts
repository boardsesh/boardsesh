import { DEFAULT_LOGBOOK_SORT } from './defaults';
import type { LogbookSortDirection, LogbookSortField, LogbookSortKey, LogbookSortState } from './types';

/** The "Sort by" choices, in display order. */
export const LOGBOOK_SORT_KEYS: readonly LogbookSortKey[] = [
  'date',
  'grade',
  'loggedGrade',
  'climbName',
  'attemptCount',
];

const presetSort = (preset: LogbookSortState['preset']): LogbookSortState => ({
  ...DEFAULT_LOGBOOK_SORT,
  mode: 'preset',
  preset,
});

const customSort = (primaryField: LogbookSortField, primaryDirection: LogbookSortDirection): LogbookSortState => ({
  mode: 'custom',
  // Unused in custom mode; kept at the default so the stored shape stays valid.
  preset: DEFAULT_LOGBOOK_SORT.preset,
  primaryField,
  primaryDirection,
  // Newest first breaks ties. A date primary needs no tie-break on itself.
  secondaryField: primaryField === 'date' ? '' : 'date',
  secondaryDirection: 'desc',
});

/**
 * The sort state a "Sort by" key + order writes. The three server presets keep
 * their meaning: Date desc = `recent`, Grade desc = `hardest`, Grade asc =
 * `easiest` (both sort on the grade the row shows: the climber's, else the
 * consensus). Everything else is a custom field sort, newest first on ties.
 */
export function logbookSortFor(key: LogbookSortKey, direction: LogbookSortDirection): LogbookSortState {
  switch (key) {
    case 'date':
      return direction === 'desc' ? presetSort('recent') : customSort('date', 'asc');
    case 'grade':
      return presetSort(direction === 'desc' ? 'hardest' : 'easiest');
    case 'loggedGrade':
    case 'climbName':
    case 'attemptCount':
      return customSort(key, direction);
    default:
      return presetSort('recent');
  }
}

/**
 * The "Sort by" key + order a stored sort reads as. A custom sort saved before
 * the key picker existed maps by its primary field: a consensus-grade sort reads
 * as Grade; anything unrecognised reads as Date desc (the default).
 */
export function logbookSortKeyOf(sort: LogbookSortState): { key: LogbookSortKey; direction: LogbookSortDirection } {
  if (sort.mode === 'preset') {
    if (sort.preset === 'hardest') return { key: 'grade', direction: 'desc' };
    if (sort.preset === 'easiest') return { key: 'grade', direction: 'asc' };
    return { key: 'date', direction: 'desc' };
  }
  const direction: LogbookSortDirection = sort.primaryDirection === 'asc' ? 'asc' : 'desc';
  switch (sort.primaryField) {
    case 'date':
      return { key: 'date', direction };
    case 'consensusGrade':
      return { key: 'grade', direction };
    case 'loggedGrade':
    case 'climbName':
    case 'attemptCount':
      return { key: sort.primaryField, direction };
    default:
      return { key: 'date', direction: 'desc' };
  }
}
