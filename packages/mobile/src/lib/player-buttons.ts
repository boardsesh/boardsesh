import type { SectionLayout, SectionLayoutSpec } from './section-layout';

// The player buttons a climber can show, hide and put in order (#6229, #7000).
// Pure: the store lives in `player-buttons-preference.ts`.
//
// Log and the wall button are not here. They are the loop the player exists
// for, so they never move and never hide. Previous and next is one switch of
// its own, not an entry in this list: the pair keeps its two slots either side
// of Log. These five share the first row's two end slots; the rest live in ⋯.

export const PLAYER_BUTTON_IDS = ['mirror', 'favorite', 'queue', 'share', 'angle'] as const;
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
 * Marco's bar (#7000): `⇄ ⏮ ✓ ⏭ ☰` on a board that mirrors, with the heart in
 * ⋯, and `♡ ⏮ ✓ ⏭ ☰` on one that doesn't. The first button on fills the
 * leading slot and the last the trailing one (`resolveActionBarLayout`). Share
 * and Angle start in ⋯.
 */
export const DEFAULT_PLAYER_BUTTONS: PlayerButtonsLayout = Object.freeze({
  order: PLAYER_BUTTON_IDS,
  visible: Object.freeze({ mirror: true, favorite: true, queue: true, share: false, angle: false }),
});

export const PLAYER_BUTTONS_LAYOUT: SectionLayoutSpec<PlayerButtonId> = {
  ids: PLAYER_BUTTON_IDS,
  defaults: DEFAULT_PLAYER_BUTTONS,
};

export const DEFAULT_PLAYER_PREVIOUS_NEXT = true;
export const DEFAULT_PLAYER_BUTTONS_POSITION: PlayerButtonsPosition = 'below';

/** A stored position this build doesn't know (a newer bundle's) reads as the default. */
export function sanitisePlayerButtonsPosition(stored: unknown): PlayerButtonsPosition {
  return stored === 'above' ? 'above' : DEFAULT_PLAYER_BUTTONS_POSITION;
}

/** Only an explicit `false` hides the pair. */
export function sanitisePlayerPreviousNext(stored: unknown): boolean {
  return stored !== false;
}
