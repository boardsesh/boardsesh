import type { SectionLayout, SectionLayoutSpec } from './section-layout';

// The player buttons a climber can show, hide and put in order (#6229). Pure:
// the store lives in `player-buttons-preference.ts`.
//
// Log and Board light are not here. They are the loop the player exists for,
// so they never move and never hide. Previous and next is one switch of its
// own, not an entry in this list: the pair keeps its two slots either side of
// Log.

export const PLAYER_BUTTON_IDS = ['mirror', 'favorite', 'angle', 'share', 'queue'] as const;
export type PlayerButtonId = (typeof PLAYER_BUTTON_IDS)[number];
export type PlayerButtonsLayout = SectionLayout<PlayerButtonId>;

/** Where the controls block sits: under the board (where it always has), or between the climb name and the board. */
export type PlayerButtonsPosition = 'below' | 'above';

/**
 * Today's bars. Mirror leads, so it takes the big slot on a board that mirrors;
 * the queue is last, so it takes that slot on a board that doesn't and sits at
 * the right of the small row on one that does.
 */
export const DEFAULT_PLAYER_BUTTONS: PlayerButtonsLayout = Object.freeze({
  order: PLAYER_BUTTON_IDS,
  visible: Object.freeze({ mirror: true, favorite: true, angle: true, share: true, queue: true }),
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
