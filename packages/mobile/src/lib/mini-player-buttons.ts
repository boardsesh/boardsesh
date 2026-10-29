import type { SectionLayout, SectionLayoutSpec, SectionMoveDirection } from './section-layout';

// The MiniPlayer buttons a climber can show, hide and put in order (#6940). Pure:
// the store lives in `mini-player-buttons-preference.ts`.
//
// Board light and Log are not here. They sit at the bar's trailing edge on every
// width, as they always have, so they never move and never hide (the same rule
// as the player's buttons, `player-buttons.ts`).
//
// The order is the claim order: on a bar too short for every button that is on,
// the first ones in this list get the slots. Where each one is drawn is fixed
// (`resolveMiniPlayerControls`): the others, then ⏮ ⏭, then 💡 ✓. Wall display
// is the one exception: a tablet-only button drawn after ⋯ in the trailing
// cluster, where Apple Music's iPad bar puts lyrics.

export const MINI_PLAYER_BUTTON_IDS = [
  'next',
  'previous',
  'mirror',
  'favorite',
  'wallDisplay',
  'queue',
  'share',
  'angle',
] as const;
export type MiniPlayerButtonId = (typeof MINI_PLAYER_BUTTON_IDS)[number];
export type MiniPlayerButtonsLayout = SectionLayout<MiniPlayerButtonId>;

/**
 * Next first, so it is the one button an iPhone adds beside the bulb and the
 * tick. Mirror is on, but only boards that mirror give it a place. Favorite is
 * on too: the most-used optional action, and it only shows where the bar has
 * room beyond Next (iPad, the open Duo), since an iPhone's one slot goes to Next.
 * Wall display is on as well, and only ever shows on a tablet: it sits in the
 * defaults straight after Favorite, so a saved layout from before it existed
 * gets it in that place, switched on (`sanitiseSectionOrder`).
 */
export const DEFAULT_MINI_PLAYER_BUTTONS: MiniPlayerButtonsLayout = Object.freeze({
  order: MINI_PLAYER_BUTTON_IDS,
  visible: Object.freeze({
    next: true,
    previous: true,
    mirror: true,
    favorite: true,
    wallDisplay: true,
    queue: false,
    share: false,
    angle: false,
  }),
});

export const MINI_PLAYER_BUTTONS_LAYOUT: SectionLayoutSpec<MiniPlayerButtonId> = {
  ids: MINI_PLAYER_BUTTON_IDS,
  defaults: DEFAULT_MINI_PLAYER_BUTTONS,
};

/** Buttons only a tablet's bar draws, so a phone lists no switch for them. */
const TABLET_ONLY_BUTTONS: ReadonlySet<MiniPlayerButtonId> = new Set(['wallDisplay']);

/** The buttons this device lists, in the climber's order. */
export function listedMiniPlayerButtons(order: readonly MiniPlayerButtonId[], tablet: boolean): MiniPlayerButtonId[] {
  return tablet ? [...order] : order.filter((buttonId) => !TABLET_ONLY_BUTTONS.has(buttonId));
}

/**
 * How many one-place swaps move a button past its listed neighbour: one, plus
 * one for each button between them this device does not list. Zero when there
 * is no listed neighbour that way.
 */
export function miniPlayerMoveSteps(
  buttons: MiniPlayerButtonsLayout,
  buttonId: MiniPlayerButtonId,
  direction: SectionMoveDirection,
  tablet: boolean,
): number {
  const listed = listedMiniPlayerButtons(buttons.order, tablet);
  const listedIndex = listed.indexOf(buttonId);
  const neighbour = listedIndex < 0 ? undefined : listed[listedIndex + direction];
  if (neighbour === undefined) return 0;
  return Math.abs(buttons.order.indexOf(neighbour) - buttons.order.indexOf(buttonId));
}
