// What the filter session means on a smart list (#6651): which lists take a
// view, their sorts and what each calls its own order, the sheet rows and
// chips that would only repeat the list itself, and the request's `view`.
//
// Views run on the four logbook lists only. The RECOMMENDED_* lists are already
// ranked for the climber and the server rejects a view on one, so they get no
// filter bar and never send one.

import type { TFunction } from 'i18next';
import { PLAYLIST_SORT_DEFAULT_ORDER, type PlaylistSortOption, type SortOrder } from '@boardsesh/climb-filters';
import type { SmartPlaylistType } from '@boardsesh/graphql/operations/playlists';
import type { PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import type { ClimbFilterSheetSections } from '../../components/ClimbFilterSheet';
import type { ClimbFilterSessionSelection, SessionSortModel } from '../climb-filter-session-reducer';
import type { FilterChipKind } from '../pinnable-chips';
import { isLogbookSmartType, LOGBOOK_SMART_TYPES, type LogbookSmartType } from '../smart-playlists';
import { playlistSheetSections } from './playlist-board-scope';
import { makeListSortModel } from './playlist-sort-model';
import { toPlaylistViewInput, type PlaylistViewOptions } from './playlist-view';

/**
 * A smart list's sorts. `position` is the list's own order and the default.
 * "Recently added" is left out: on Liked it is the list's own order again, and
 * the other lists have no add of their own, so it would repeat that order under
 * another name.
 */
export const SMART_LIST_SORT_OPTIONS = [
  'position',
  'difficulty',
  'quality',
  'ascents',
  'name',
  'random',
] as const satisfies readonly PlaylistSortOption[];
export type SmartListSortOption = (typeof SMART_LIST_SORT_OPTIONS)[number];
export type SmartListSelection = ClimbFilterSessionSelection<SmartListSortOption>;

const SMART_LIST_SORT_DEFAULT_ORDER: Readonly<Record<SmartListSortOption, SortOrder>> = {
  position: PLAYLIST_SORT_DEFAULT_ORDER.position,
  difficulty: PLAYLIST_SORT_DEFAULT_ORDER.difficulty,
  quality: PLAYLIST_SORT_DEFAULT_ORDER.quality,
  ascents: PLAYLIST_SORT_DEFAULT_ORDER.ascents,
  name: PLAYLIST_SORT_DEFAULT_ORDER.name,
  random: PLAYLIST_SORT_DEFAULT_ORDER.random,
};

/** The sorts of a smart list whose own order `ownOrderLabel` names (null: the generic "Playlist order"). */
function smartListSortModel(
  ownOrderLabel: ((t: TFunction<'climbs'>) => string) | null,
): SessionSortModel<SmartListSortOption> {
  return makeListSortModel({
    options: SMART_LIST_SORT_OPTIONS,
    defaultSort: { sortBy: 'position', sortOrder: PLAYLIST_SORT_DEFAULT_ORDER.position },
    defaultOrder: SMART_LIST_SORT_DEFAULT_ORDER,
    singleDirection: ['position', 'random'],
    ownKeyLabel: ownOrderLabel ? (sortBy, t) => (sortBy === 'position' ? ownOrderLabel(t) : null) : undefined,
  });
}

// One model per list, built once: the session runs each model's `useLabels` as a hook.
// Liked: the newest like first.
const LIKED_SORT_MODEL = smartListSortModel((t) => t('mobile.filter.sort.recentlyLiked'));
// Five Stars: the latest five-star tick first.
const FIVE_STARS_SORT_MODEL = smartListSortModel((t) => t('mobile.filter.sort.recentlyClimbed'));
// Projects and Most repeated: the most attempts first.
const MOST_TRIES_SORT_MODEL = smartListSortModel((t) => t('mobile.filter.sort.mostTries'));
// The recommendations show no sort, but the session still needs a model.
const RECOMMENDED_SORT_MODEL = smartListSortModel(null);

/** A smart list's sort model. The same object for the same type, every call. */
export function smartListSortModelFor(type: SmartPlaylistType): SessionSortModel<SmartListSortOption> {
  switch (type) {
    case 'LIKED_CLIMBS':
      return LIKED_SORT_MODEL;
    case 'FIVE_STARS':
      return FIVE_STARS_SORT_MODEL;
    case 'PROJECTS':
    case 'MOST_REPEATED':
      return MOST_TRIES_SORT_MODEL;
    default:
      return RECOMMENDED_SORT_MODEL;
  }
}

/**
 * The sheet rows each logbook list turns off on top of a playlist's, because
 * every row of the list already passes them: every Liked climb is liked, every
 * Projects climb is tried and not sent, every Five Stars climb has your five
 * stars. A hidden option still shows while it is the active value.
 */
const SMART_LIST_OWN_SECTIONS: Readonly<Record<LogbookSmartType, ClimbFilterSheetSections>> = {
  LIKED_CLIMBS: { liked: false },
  FIVE_STARS: { myRating: false },
  PROJECTS: { progress: false },
  MOST_REPEATED: {},
};

/** Every list's rows, with and without an active board, built once so each call hands back the same object. */
const SMART_LIST_SHEET_SECTIONS = Object.fromEntries(
  LOGBOOK_SMART_TYPES.map((type) => [
    type,
    {
      withBoard: { ...playlistSheetSections(true), ...SMART_LIST_OWN_SECTIONS[type] },
      withoutBoard: { ...playlistSheetSections(false), ...SMART_LIST_OWN_SECTIONS[type] },
    },
  ]),
) as Record<LogbookSmartType, { withBoard: ClimbFilterSheetSections; withoutBoard: ClimbFilterSheetSections }>;

/** A logbook list's sheet rows, for a screen with or without an active board. Same object each call. */
export function smartListSheetSections(type: LogbookSmartType, hasActiveBoard: boolean): ClimbFilterSheetSections {
  const sections = SMART_LIST_SHEET_SECTIONS[type];
  return hasActiveBoard ? sections.withBoard : sections.withoutBoard;
}

const NO_HIDDEN_CHIPS: readonly FilterChipKind[] = [];
/** Projects' rows are all tried and unsent, so Your progress has nothing to narrow. */
const PROJECTS_HIDDEN_CHIPS: readonly FilterChipKind[] = ['progress'];

/** The chips a list leaves off its row, on top of the board rules. Same array each call. */
export function smartListHiddenChips(type: SmartPlaylistType): readonly FilterChipKind[] {
  return type === 'PROJECTS' ? PROJECTS_HIDDEN_CHIPS : NO_HIDDEN_CHIPS;
}

/**
 * The `view` for a smart-list request. Undefined for a recommendation (the
 * server rejects one there) and for the list's own order with no filter, so a
 * plain request stays byte-identical to the one sent before views existed.
 */
export function smartListViewInput(
  type: SmartPlaylistType,
  selection: SmartListSelection,
  options: PlaylistViewOptions = {},
): PlaylistClimbViewInput | undefined {
  return isLogbookSmartType(type) ? toPlaylistViewInput(selection, options) : undefined;
}

/** The sort memory key for one smart list type: one remembered sort per list, whoever's list it is. */
export function smartSortMemoryKey(type: SmartPlaylistType): string {
  return `smart:${type}`;
}
