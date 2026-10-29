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

/** The climber's Columns choice in Settings → Climb list. Two columns is the default. */
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
  return climbListColumnsForRoom({ hasRoomForTwo: climbListHasRoomForTwoColumns(listWidth), preference });
}

/** Whether a list this wide fits two columns. A boolean, so a screen can keep it in state and skip re-renders. */
export function climbListHasRoomForTwoColumns(listWidth: number): boolean {
  return listWidth >= CLIMB_LIST_TWO_COLUMN_MIN_WIDTH;
}

/** {@link climbListColumns} from the room already decided. */
export function climbListColumnsForRoom({
  hasRoomForTwo,
  preference,
}: {
  hasRoomForTwo: boolean;
  preference: ClimbListLayoutPreference;
}): ClimbListColumns {
  return preference !== 'one' && hasRoomForTwo ? 2 : 1;
}

/**
 * The native iPad sidebar in landscape (DEVICE_VERIFIED 280pt, iPadOS 27.0; see
 * `measuredTabContentInsetLeft` in `bottom-chrome-metrics.ts`). In portrait the
 * tabs sit in a bar at the top and take no width.
 */
export const IPAD_LANDSCAPE_SIDEBAR_WIDTH = 280;

/**
 * The list's width before it has been measured, for the first render: the
 * window less the side safe area and, on a regular-width iPad in landscape, the
 * sidebar. The measured content-column inset wins when the probe has one. The
 * list's own `onLayout` replaces the guess; a right guess means that replacement
 * changes nothing.
 */
export function estimateClimbListWidth({
  windowWidth,
  windowHeight,
  safeAreaLeft,
  safeAreaRight,
  measuredContentColumnLeft,
  isPad,
  regularWidth,
}: {
  windowWidth: number;
  windowHeight: number;
  safeAreaLeft: number;
  safeAreaRight: number;
  /** `useBottomChromeMetrics().contentColumnLeft`: 0 until measured, and off the native tab bar. */
  measuredContentColumnLeft: number;
  isPad: boolean;
  regularWidth: boolean;
}): number {
  const sidebar =
    measuredContentColumnLeft > 0
      ? measuredContentColumnLeft
      : isPad && regularWidth && windowWidth > windowHeight
        ? IPAD_LANDSCAPE_SIDEBAR_WIDTH
        : 0;
  return windowWidth - Math.max(safeAreaLeft, sidebar) - safeAreaRight;
}

/** The thumbnail for a column count: 88×112 in two columns, 76×96 in one (every phone). */
export function climbListThumbnailSize(columns: ClimbListColumns): ClimbListThumbnailSize {
  return columns === 2 ? TWO_COLUMN_THUMBNAIL : ONE_COLUMN_THUMBNAIL;
}

/**
 * Whether this device's list can ever be wide enough for two columns, which is
 * when the choice is worth showing: a tablet (iPad, Android tablet, a wide
 * browser screen) whose physical long side clears the floor. Every iPad
 * qualifies, also in a narrow split it can widen out of, because with the
 * sidebar hidden its list spans the screen. Every iPhone is left out: they are
 * portrait-locked at phone width, and on the open iPhone Duo the player pane
 * takes half the inner display, so its list measures about 391pt (475pt with
 * the rail collapsed) and two columns never happen there.
 */
export function climbListTwoColumnsPossible({
  isTablet,
  screenLongSide,
}: {
  isTablet: boolean;
  screenLongSide: number;
}): boolean {
  return isTablet && screenLongSide >= CLIMB_LIST_TWO_COLUMN_MIN_WIDTH;
}

/** Reads a stored Columns choice; anything unknown is the default. */
export function sanitiseClimbListLayout(value: unknown): ClimbListLayoutPreference {
  return value === 'one' || value === 'two' ? value : DEFAULT_CLIMB_LIST_LAYOUT;
}

/** The overlay width every list cell renders at, and the MiniPlayer accessory's: the `_w400_` cache key. */
const LIST_RENDER_WIDTH_FLOOR = 400;

/**
 * Overlay + background width, in pixels, for a climb list cell: its pixel width
 * with 25% headroom, never under 400. 76pt at 3× is 285px and 88pt at 2× (iPad)
 * is 220px, so both land on 400 and share the `_w400_` key with the MiniPlayer
 * accessory (`AccessoryClimbThumbnail`): a climb seen in the list paints there
 * from cache. 5× would have made the 88pt cell 440px and its own key. One
 * function, because the width is part of the overlay cache key: the thumbnail
 * and its prewarm have to ask for the same PNG.
 */
export function climbListThumbnailRenderWidth(cellWidth: number, pixelRatio: number): number {
  return Math.max(LIST_RENDER_WIDTH_FLOOR, Math.ceil(cellWidth * pixelRatio * 1.25));
}

/**
 * Overlay + background width for a cell whose caller passed its own `size` (feed
 * cards, notifications, the session hero): ~5× the cell width, at least 400px,
 * so expo-image never has to downscale a ~1080px source on the main thread while
 * scrolling. Unchanged since those sizes shipped, so their cached PNGs stay valid.
 */
export function sizedThumbnailRenderWidth(cellWidth: number): number {
  return Math.max(LIST_RENDER_WIDTH_FLOOR, Math.round(cellWidth * 5));
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
