// Which playlist filter controls need an active board. A playlist applies some
// filters only to climbs on the active board (`PLAYLIST_ACTIVE_BOARD_ONLY_FILTERS`
// in @boardsesh/climb-filters, kept equal to the query's own list by a test in
// @boardsesh/db). With no active board those filters match nothing, so the
// sheet hides their rows and the chip row drops their chips. Both lists below
// are derived from the filter fields each control sets, so a filter moving
// between classes moves its controls with it.

import {
  PLAYLIST_ACTIVE_BOARD_ONLY_FILTERS,
  type ClimbBoardFilterState,
  type ClimbFilterState,
} from '@boardsesh/climb-filters';
import type { ClimbFilterSheetSections } from '../../components/ClimbFilterSheet';
import { PLAYLIST_PINNABLE_CHIP_KINDS, type PlaylistPinnableChipKind } from '../playlist-pinnable-chips';

/** A field a playlist filter control sets, by its search-param name. */
type PlaylistFilterField = keyof ClimbFilterState | keyof ClimbBoardFilterState | 'onlyActiveBoard';

const ACTIVE_BOARD_ONLY_FIELDS = new Set<string>(PLAYLIST_ACTIVE_BOARD_ONLY_FILTERS);

function needsActiveBoard(fields: readonly PlaylistFilterField[]): boolean {
  return fields.some((field) => ACTIVE_BOARD_ONLY_FIELDS.has(field));
}

const PROGRESS_FIELDS = [
  'hideAttempted',
  'hideCompleted',
  'showOnlyAttempted',
  'showOnlyCompleted',
  'minUserRating',
  'onlyRatedByMe',
] as const satisfies readonly PlaylistFilterField[];

/** The fields each playlist chip sets. */
const CHIP_FILTER_FIELDS: Record<PlaylistPinnableChipKind, readonly PlaylistFilterField[]> = {
  grade: ['minGrade', 'maxGrade'],
  accuracy: ['gradeAccuracy'],
  progress: PROGRESS_FIELDS,
  climbType: ['boulders', 'routes'],
  beta: ['onlyWithBetaVideos'],
  popularity: ['minAscents', 'status'],
  rating: ['minRating'],
  boardFit: ['onlyActiveBoard'],
  sort: [],
};

/** The chips that leave a playlist's row while there is no active board. */
export const PLAYLIST_ACTIVE_BOARD_ONLY_CHIPS: readonly PlaylistPinnableChipKind[] =
  PLAYLIST_PINNABLE_CHIP_KINDS.filter((kind) => needsActiveBoard(CHIP_FILTER_FIELDS[kind]));

/**
 * The sheet rows a playlist always hides. Recent and My drafts mean nothing
 * inside a playlist, and Other angles is ignored by the playlist query. The
 * Setters, Hold types and Board region pickers stay: they open the Discover
 * stack's picker routes (`pickers` on the sheet).
 */
const PLAYLIST_SHEET_SECTIONS: ClimbFilterSheetSections = {
  recent: false,
  drafts: false,
  otherAngles: false,
};

/** The sheet rows whose filters may need an active board, and the fields each one sets. */
const BOARD_SCOPED_SECTION_FIELDS = {
  progress: PROGRESS_FIELDS,
  liked: ['onlyFavorited'],
  following: ['onlyFollowedAuthors'],
  beta: ['onlyWithBetaVideos'],
  holds: ['holdsFilter'],
  zone: ['zoneBox'],
} as const satisfies Partial<Record<keyof ClimbFilterSheetSections, readonly PlaylistFilterField[]>>;

/** `sections` with every row whose filter passes only active-board climbs turned off as well. */
export function withoutActiveBoardSections(sections: ClimbFilterSheetSections): ClimbFilterSheetSections {
  const withoutBoard: ClimbFilterSheetSections = { ...sections };
  for (const [section, fields] of Object.entries(BOARD_SCOPED_SECTION_FIELDS) as [
    keyof typeof BOARD_SCOPED_SECTION_FIELDS,
    readonly PlaylistFilterField[],
  ][]) {
    if (needsActiveBoard(fields)) withoutBoard[section] = false;
  }
  return withoutBoard;
}

/**
 * The rows hidden as well while there is no active board: each row above whose
 * filter passes only active-board climbs. Today that is all six (the setter
 * filter reads every row, so Setters stays); a filter that moved to every row in
 * `PLAYLIST_ACTIVE_BOARD_ONLY_FILTERS` would bring its row back here on its own.
 */
const PLAYLIST_SHEET_SECTIONS_WITHOUT_BOARD = withoutActiveBoardSections(PLAYLIST_SHEET_SECTIONS);

/** The playlist sheet's rows, for a screen with or without an active board. Same object each call. */
export function playlistSheetSections(hasActiveBoard: boolean): ClimbFilterSheetSections {
  return hasActiveBoard ? PLAYLIST_SHEET_SECTIONS : PLAYLIST_SHEET_SECTIONS_WITHOUT_BOARD;
}
