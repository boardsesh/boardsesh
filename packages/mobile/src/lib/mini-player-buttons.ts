import type { SectionLayout, SectionLayoutSpec } from './section-layout';

// The MiniPlayer buttons a climber can show, hide and put in order (#6940). Pure:
// the store lives in `mini-player-buttons-preference.ts`.
//
// Board light and Log are not here. They sit at the bar's trailing edge on every
// width, as they always have, so they never move and never hide (the same rule
// as the player's buttons, `player-buttons.ts`).
//
// The order is the claim order: on a bar too short for every button that is on,
// the first ones in this list get the slots. Where each one is drawn is fixed
// (`resolveMiniPlayerControls`): the others, then ⏮ ⏭, then 💡 ✓.

export const MINI_PLAYER_BUTTON_IDS = ['next', 'previous', 'mirror', 'favorite', 'queue', 'share', 'angle'] as const;
export type MiniPlayerButtonId = (typeof MINI_PLAYER_BUTTON_IDS)[number];
export type MiniPlayerButtonsLayout = SectionLayout<MiniPlayerButtonId>;

/**
 * Next first, so it is the one button an iPhone adds beside the bulb and the
 * tick. Mirror is on, but only boards that mirror give it a place. Favorite is
 * on too: the most-used optional action, and it only shows where the bar has
 * room beyond Next (iPad, the open Duo), since an iPhone's one slot goes to Next.
 */
export const DEFAULT_MINI_PLAYER_BUTTONS: MiniPlayerButtonsLayout = Object.freeze({
  order: MINI_PLAYER_BUTTON_IDS,
  visible: Object.freeze({
    next: true,
    previous: true,
    mirror: true,
    favorite: true,
    queue: false,
    share: false,
    angle: false,
  }),
});

export const MINI_PLAYER_BUTTONS_LAYOUT: SectionLayoutSpec<MiniPlayerButtonId> = {
  ids: MINI_PLAYER_BUTTON_IDS,
  defaults: DEFAULT_MINI_PLAYER_BUTTONS,
};
