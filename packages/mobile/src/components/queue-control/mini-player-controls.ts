import { visibleSectionIds } from '../../lib/section-layout';
import type { MiniPlayerButtonId, MiniPlayerButtonsLayout } from '../../lib/mini-player-buttons';

/**
 * The least room the climb name keeps before the bar gives up a slot. About 20
 * characters of a subheadline name: enough that most names read without scrolling.
 */
export const ACCESSORY_MIN_NAME_WIDTH = 160;

/** One control's tap target. Every slot on the bar is this wide. */
export const ACCESSORY_SLOT_WIDTH = 44;

/**
 * At most this many controls on an iPhone's open bar, Board light and Log
 * included (#6940): one button of the climber's beside them. Music keeps its
 * iPhone MiniPlayer this short too.
 */
export const PHONE_MINI_PLAYER_MAX_SLOTS = 3;

/** How the bar is drawn right now. */
export type MiniPlayerBarShape = {
  placement: 'regular' | 'inline';
  /** The row's measured width, `null` before its first layout. */
  rowWidth: number | null;
  /** Everything in the row that is not the name or a slot: insets, the artwork and its gap, the label padding. */
  widthBesideName: number;
  /** iPad, or iPhone Duo open: no cap but the width. Otherwise an iPhone, capped at three. */
  wide: boolean;
};

/**
 * How many 44pt controls the bar holds.
 *
 * - Inline (the tab bar minimized) holds one, as Music's MiniPlayer drops its
 *   controls there (WWDC25 "Build a UIKit app with the new design").
 * - Before the first layout the row holds two, today's open platter, so most
 *   bars never change on their first measurement.
 * - An iPhone holds three, Board light and Log included. A bar too narrow for
 *   two beside a readable name (iPhone Duo closed, ~290pt; a 320pt Display Zoom
 *   iPhone, ~288pt) holds one, as before #6940. A 375pt iPhone's 343pt bar gets
 *   three, leaving the name ~143pt.
 * - iPad and the open Duo hold as many as fit beside a 160pt name, which is
 *   every button the climber has on.
 */
export function miniPlayerSlotCount({ placement, rowWidth, widthBesideName, wide }: MiniPlayerBarShape): number {
  if (placement === 'inline') return 1;
  if (rowWidth === null) return 2;
  const fit = Math.floor((rowWidth - widthBesideName - ACCESSORY_MIN_NAME_WIDTH) / ACCESSORY_SLOT_WIDTH);
  if (!wide) return fit >= 2 ? PHONE_MINI_PLAYER_MAX_SLOTS : 1;
  return Math.max(1, fit);
}

/** One slot on the bar. `lightbulb` and `log` are the fixed pair at the trailing edge. */
export type MiniPlayerSlot = MiniPlayerButtonId | 'lightbulb' | 'log';

export type MiniPlayerControlsInput = {
  slotCount: number;
  /** The climber's buttons: order and switches. */
  layout: MiniPlayerButtonsLayout;
  /** Whether a button can take a place here right now (a board that mirrors, a signed-in climber...). */
  isAvailable: (buttonId: MiniPlayerButtonId) => boolean;
  /**
   * With one slot: the bulb while there is a board to connect and nobody holds
   * it, so connecting stays one tap away; the tick otherwise.
   */
  singleSlotShowsBulb: boolean;
  /**
   * iPhone Duo open with the player in the split's pane. Its big row already
   * has ⏮ ⏭ 💡 ✓ right above the bar, so the bar does not repeat them.
   */
  playerPaneShowsTransport: boolean;
};

export type MiniPlayerControls = {
  /** Left to right: the climber's other buttons, then ⏮ ⏭. */
  leading: readonly MiniPlayerButtonId[];
  /** Left to right at the trailing edge: 💡 ✓, or the one of them a single slot keeps. */
  trailing: readonly ('lightbulb' | 'log')[];
};

const TRANSPORT_ORDER: readonly MiniPlayerButtonId[] = ['previous', 'next'];

/**
 * What the bar holds, left to right (#6940).
 *
 * ```
 * iPad, Duo open    [thumb] Name ····· [⇄] [♡] · [⏮] [⏭] · [💡] [✓]
 * iPhone            [thumb] Name ················ [⏭] · [💡] [✓]
 * One slot          [thumb] Name ······················· [💡] or [✓]
 * ```
 *
 * Board light and Log claim their slots first and sit at the trailing edge, as
 * they always have. The climber's buttons that are on and can show here claim
 * the rest in the climber's order, so on a short bar the last ones in that list
 * are the ones left out (the player's ⋯ still has every action). Where a
 * claimed button is drawn does not follow that order: ⏮ ⏭ sit together just
 * before the bulb, and the others keep the climber's order before them.
 */
export function resolveMiniPlayerControls({
  slotCount,
  layout,
  isAvailable,
  singleSlotShowsBulb,
  playerPaneShowsTransport,
}: MiniPlayerControlsInput): MiniPlayerControls {
  const trailing: ('lightbulb' | 'log')[] = playerPaneShowsTransport
    ? []
    : slotCount <= 1
      ? [singleSlotShowsBulb ? 'lightbulb' : 'log']
      : ['lightbulb', 'log'];
  const room = Math.max(0, slotCount - trailing.length);
  const claimed = visibleSectionIds(
    layout,
    (buttonId) => isAvailable(buttonId) && !(playerPaneShowsTransport && TRANSPORT_ORDER.includes(buttonId)),
  ).slice(0, room);
  const others = claimed.filter((buttonId) => !TRANSPORT_ORDER.includes(buttonId));
  const transport = TRANSPORT_ORDER.filter((buttonId) => claimed.includes(buttonId));
  return { leading: [...others, ...transport], trailing };
}
