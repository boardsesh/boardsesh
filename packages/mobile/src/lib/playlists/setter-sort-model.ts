// A setter page's sorts (#6651). The page is a Climbs search pinned to one
// setter, so its sorts are the Climbs list's: Newest (its default), then
// Difficulty, Quality, Ascents, Name and Random. Popular is left out: across
// one setter's climbs it ranks almost the same as Ascents.
//
// One remembered sort for every setter page (`SETTER_SORT_MEMORY_KEY`): a
// climber who reads setters hardest first wants that on the next setter too.

import type { SortOption, SortOrder } from '@boardsesh/climb-filters';
import type { ClimbFilterSessionSelection, SessionSort, SessionSortModel } from '../climb-filter-session-reducer';
import { makeListSortModel } from './playlist-sort-model';

export const SETTER_SORT_OPTIONS = [
  'creation',
  'difficulty',
  'quality',
  'ascents',
  'name',
  'random',
] as const satisfies readonly SortOption[];
export type SetterSortOption = (typeof SETTER_SORT_OPTIONS)[number];
export type SetterSessionSort = SessionSort<SetterSortOption>;
export type SetterSelection = ClimbFilterSessionSelection<SetterSortOption>;

/** Newest first, easiest first, best and most-climbed first, A to Z. */
const SETTER_SORT_DEFAULT_ORDER: Readonly<Record<SetterSortOption, SortOrder>> = {
  creation: 'desc',
  difficulty: 'asc',
  quality: 'desc',
  ascents: 'desc',
  name: 'asc',
  random: 'asc',
};

/** The page's own order: the setter's newest climbs first. */
export const DEFAULT_SETTER_SORT: SetterSessionSort = { sortBy: 'creation', sortOrder: 'desc' };

export const setterSortModel: SessionSortModel<SetterSortOption> = makeListSortModel({
  options: SETTER_SORT_OPTIONS,
  defaultSort: DEFAULT_SETTER_SORT,
  defaultOrder: SETTER_SORT_DEFAULT_ORDER,
  singleDirection: ['random'],
});

/** Every setter page shares one remembered sort. */
export const SETTER_SORT_MEMORY_KEY = 'setter-pages';
