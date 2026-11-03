import type { SectionLayout, SectionLayoutSpec } from './section-layout';

// The player buttons a climber can show, hide and put in order (#6229, #7000).
// Pure: the store lives in `player-buttons-preference.ts`.
//
// Log and the wall button are not here. They are the loop the player exists
// for, so they never move and never hide. Previous and next is one switch of
// its own, not an entry in this list: the pair keeps its two slots either side
// of Log when shown. With the pair hidden, these six share four positions
// around Log; with it shown, they share the two ends. The rest live in ⋯.

export const PLAYER_BUTTON_IDS = ['mirror', 'angle', 'playNext', 'favorite', 'share', 'queue'] as const;
export type PlayerButtonId = (typeof PLAYER_BUTTON_IDS)[number];
export type PlayerButtonsLayout = SectionLayout<PlayerButtonId>;

/** Where the controls block sits: under the board (where it always has), or between the climb name and the board. */
export type PlayerButtonsPosition = 'below' | 'above';

/**
 * How the player shows the board control (#7000): the full-width wall button
 * under the top row, or the bulb in the top row's last slot. One model and one
 * set of tap and hold rules behind both (`resolveWallControl`).
 */
export type PlayerBoardControl = 'wallButton' | 'lightbulb';
export const DEFAULT_PLAYER_BOARD_CONTROL: PlayerBoardControl = 'wallButton';

/** A stored value this build doesn't know reads as the default. */
export function sanitisePlayerBoardControl(stored: unknown): PlayerBoardControl {
  return stored === 'lightbulb' ? 'lightbulb' : DEFAULT_PLAYER_BOARD_CONTROL;
}

/**
 * The first candidate and last three fill the four positions around Log:
 * `⇄ ♡ ✓ Share ☰` on a board that mirrors, and `Angle ♡ ✓ Share ☰` on an
 * adjustable board that doesn't. Angle stays in ⋯ while Mirror takes its place.
 */
export const DEFAULT_PLAYER_BUTTONS: PlayerButtonsLayout = Object.freeze({
  order: PLAYER_BUTTON_IDS,
  visible: Object.freeze({ mirror: true, angle: true, playNext: true, favorite: true, share: true, queue: true }),
});

export const PLAYER_BUTTONS_LAYOUT: SectionLayoutSpec<PlayerButtonId> = {
  ids: PLAYER_BUTTON_IDS,
  defaults: DEFAULT_PLAYER_BUTTONS,
};

export const DEFAULT_PLAYER_PREVIOUS_NEXT = false;
export const DEFAULT_PLAYER_BUTTONS_POSITION: PlayerButtonsPosition = 'below';

/** A stored position this build doesn't know (a newer bundle's) reads as the default. */
export function sanitisePlayerButtonsPosition(stored: unknown): PlayerButtonsPosition {
  return stored === 'above' ? 'above' : DEFAULT_PLAYER_BUTTONS_POSITION;
}

/** Preserve a stored choice; a missing or unrecognized value uses today's default. */
export function sanitisePlayerPreviousNext(stored: unknown): boolean {
  return typeof stored === 'boolean' ? stored : DEFAULT_PLAYER_PREVIOUS_NEXT;
}
