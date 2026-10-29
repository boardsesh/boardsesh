import { createContext, useContext } from 'react';

/**
 * The climb list's thumbnail cell, and the column rule that picks its size.
 *
 * Kept separate from `ClimbListThumbnail` so list-adjacent components can align
 * placeholders and separators without importing the native image renderer.
 * Pure apart from the context at the bottom: no react-native import, so the
 * rules unit-test as plain functions.
 */

/** A portrait thumbnail cell, in points. */
export type ClimbListThumbnailSize = Readonly<{ width: number; height: number }>;

/** How many climbs sit side by side in the Climbs list. */
export type ClimbListColumns = 1 | 2;

/** The climber's Layout choice in Settings → Climb list. Two columns is the default. */
export type ClimbListLayoutPreference = 'one' | 'two';

export const DEFAULT_CLIMB_LIST_LAYOUT: ClimbListLayoutPreference = 'two';

/**
 * The cell every phone list has always drawn: 76×96. Portrait (not square) so
 * the portrait board image fills the cell instead of letterboxing.
 */
const ONE_COLUMN_THUMBNAIL: ClimbListThumbnailSize = Object.freeze({ width: 76, height: 96 });

/**
 * Two columns give each row about 450pt, where 76×96 left the board art small
 * beside a lot of empty row. 88×112 keeps nearly the same aspect.
 */
const TWO_COLUMN_THUMBNAIL: ClimbListThumbnailSize = Object.freeze({ width: 88, height: 112 });

/**
 * The narrowest list that gets two columns: each column then keeps about 450pt,
 * as wide as a large iPhone's row. Measured on the list itself, not the window,
 * so whatever sits beside it (the iPad sidebar, 280pt in landscape; the iPhone
 * Duo's player pane and tab rail) is already taken off.
 *
 * Worked examples, native iPad (sidebar in landscape, top tab bar in portrait):
 * 11" portrait 834 → one; 11" landscape 1194 − 280 = 914 → two; 13" portrait
 * 1032 → two; 13" landscape 1366 − 280 = 1086 → two; a ⅓ split (~320–440) →
 * one. iPad mini landscape is 1133 − 280 = 853 → one, and two with the sidebar
 * hidden. iPhone Duo open in landscape: the player takes the leading half, so
 * the list is 951 − 476 − 84 (rail) = 391 → one.
 */
export const CLIMB_LIST_TWO_COLUMN_MIN_WIDTH = 900;

/**
 * How many columns the Climbs list draws: two when the list is at least
 * {@link CLIMB_LIST_TWO_COLUMN_MIN_WIDTH} wide and the climber has not chosen one
 * column. Width only, not the device: any list that wide has the room.
 */
export function climbListColumns({
  listWidth,
  preference,
}: {
  listWidth: number;
  preference: ClimbListLayoutPreference;
}): ClimbListColumns {
  return preference !== 'one' && listWidth >= CLIMB_LIST_TWO_COLUMN_MIN_WIDTH ? 2 : 1;
}

/** The thumbnail for a column count: 88×112 in two columns, 76×96 in one (every phone). */
export function climbListThumbnailSize(columns: ClimbListColumns): ClimbListThumbnailSize {
  return columns === 2 ? TWO_COLUMN_THUMBNAIL : ONE_COLUMN_THUMBNAIL;
}

/**
 * Whether this device can ever give the list two columns, which is when the
 * Layout choice is worth showing. A tablet (iPad, Android tablet, a wide browser
 * screen) whose physical long side clears the floor: every iPad, also in a
 * narrow split it can widen out of. Among iPhones only the Duo's open inner
 * display (951pt long) qualifies, and only while it is open: the closed outer
 * display (466pt) and every other iPhone are portrait-locked at phone width.
 * On the open Duo the player pane takes half the window today, so the list
 * measures about 391pt and stays one column; the choice is there for the
 * moment the list gets the room.
 */
export function climbListTwoColumnsPossible({
  isTablet,
  foldableInnerDisplay,
  screenLongSide,
}: {
  isTablet: boolean;
  /** `useDeviceLayout().foldableInnerDisplay`: the iPhone Duo, open. Live. */
  foldableInnerDisplay: boolean;
  screenLongSide: number;
}): boolean {
  return (isTablet || foldableInnerDisplay) && screenLongSide >= CLIMB_LIST_TWO_COLUMN_MIN_WIDTH;
}

/** Reads a stored Layout choice; anything unknown is the default. */
export function sanitiseClimbListLayout(value: unknown): ClimbListLayoutPreference {
  return value === 'one' || value === 'two' ? value : DEFAULT_CLIMB_LIST_LAYOUT;
}

/**
 * The thumbnail size of the rows below. The Climbs list provides the size its
 * column count picked; every other host of the row visual (queue, playlists,
 * sheets, the Settings preview) reads the one-column default.
 */
export const ClimbListThumbnailSizeContext = createContext<ClimbListThumbnailSize>(ONE_COLUMN_THUMBNAIL);

export function useClimbListThumbnailSize(): ClimbListThumbnailSize {
  return useContext(ClimbListThumbnailSizeContext);
}
