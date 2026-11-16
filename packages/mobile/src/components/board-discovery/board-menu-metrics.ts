// Sizes a board's card and its row share, so the ⋯, the hold and the subtitle
// glyphs read the same on a Near you card and in the picker's lists.

import { Platform } from 'react-native';

/**
 * The ⋯ beside a board's name. iOS draws the glyph in a 44pt square, the HIG's
 * tap floor; Android's M3 IconButton keeps its own 48dp target whatever size it
 * is asked for.
 */
export const BOARD_MENU_BUTTON_SIZE = 44;
export const BOARD_MENU_BUTTON_FOOTPRINT = Platform.OS === 'android' ? 48 : BOARD_MENU_BUTTON_SIZE;

/** Matches `delayLongPress` in AppMenu.android and the browser AppMenu's timer. */
export const BOARD_MENU_LONG_PRESS_DELAY_MS = 400;

/** The pin, download and "On it" glyphs at the head of a subtitle line. */
export const BOARD_SUBTITLE_GLYPH_SIZE = 12;
