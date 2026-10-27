import { visibleSectionIds } from '../../lib/section-layout';
import type { MiniPlayerButtonId, MiniPlayerButtonsLayout } from '../../lib/mini-player-buttons';
import { PLAYER_BUTTON_IDS, type PlayerButtonId, type PlayerButtonsLayout } from '../../lib/player-buttons';
import { resolveActionBarLayout } from '../play-drawer/action-bar-layout';

/**
 * The least room the climb name keeps before a wide bar gives up a slot. About
 * 20 characters of a subheadline name: enough that most names read without
 * scrolling.
 */
export const ACCESSORY_MIN_NAME_WIDTH = 160;

/**
 * The same floor on an iPhone, a little lower so a 375pt iPhone's 343pt bar
 * keeps its three controls (#6940): the name gets ~143pt there. Below it the
 * bar keeps fewer, down to today's one slot on iPhone Duo's closed display
 * (~290pt) and a 320pt Display Zoom iPhone (~288pt).
 */
export const PHONE_ACCESSORY_MIN_NAME_WIDTH = 140;

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
  /** What a wide bar spends between its groups (others · ⏮ ⏭ · 💡 ✓), at most twice. */
  groupGap: number;
};

/** Before the first layout a wide bar is taken to fit everything: no wide bar measured so far is short of that. */
const UNMEASURED_WIDE_SLOTS = 99;

/**
 * How many 44pt controls the bar holds.
 *
 * - Inline (the tab bar minimized) holds one, as Music's MiniPlayer drops its
 *   controls there (WWDC25 "Build a UIKit app with the new design").
 * - An iPhone holds as many as fit beside a 140pt name, three at most, Board
 *   light and Log included: three on every current iPhone (343pt and up), one
 *   on iPhone Duo's closed display and a 320pt Display Zoom iPhone.
 * - iPad and the open Duo hold as many as fit beside a 160pt name and the two
 *   group gaps, which is every button the climber has on.
 * - Before the first layout the row guesses the answer most bars measure (three
 *   on an iPhone, everything when wide), so the common bar never redraws on its
 *   first measurement: UIKit snapshots the platter, and a redraw then is the
 *   doubled-text case.
 */
export function miniPlayerSlotCount({
  placement,
  rowWidth,
  widthBesideName,
  wide,
  groupGap,
}: MiniPlayerBarShape): number {
  if (placement === 'inline') return 1;
  if (rowWidth === null) return wide ? UNMEASURED_WIDE_SLOTS : PHONE_MINI_PLAYER_MAX_SLOTS;
  const nameFloor = wide ? ACCESSORY_MIN_NAME_WIDTH + 2 * groupGap : PHONE_ACCESSORY_MIN_NAME_WIDTH;
  const fit = Math.max(1, Math.floor((rowWidth - widthBesideName - nameFloor) / ACCESSORY_SLOT_WIDTH));
  return wide ? fit : Math.min(PHONE_MINI_PLAYER_MAX_SLOTS, fit);
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
  /**
   * Claim from these, in this order, instead of the climber's MiniPlayer list.
   * The open Duo passes the player's small row, which the bar covers
   * (`miniPlayerPaneCoveredButtons`).
   */
  buttonIds?: readonly MiniPlayerButtonId[];
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
  buttonIds,
}: MiniPlayerControlsInput): MiniPlayerControls {
  const trailing: ('lightbulb' | 'log')[] = playerPaneShowsTransport
    ? []
    : slotCount <= 1
      ? [singleSlotShowsBulb ? 'lightbulb' : 'log']
      : ['lightbulb', 'log'];
  const room = Math.max(0, slotCount - trailing.length);
  const canClaim = (buttonId: MiniPlayerButtonId) =>
    isAvailable(buttonId) && !(playerPaneShowsTransport && TRANSPORT_ORDER.includes(buttonId));
  const claimed = (buttonIds ? buttonIds.filter(canClaim) : visibleSectionIds(layout, canClaim)).slice(0, room);
  const others = claimed.filter((buttonId) => !TRANSPORT_ORDER.includes(buttonId));
  const transport = TRANSPORT_ORDER.filter((buttonId) => claimed.includes(buttonId));
  return { leading: [...others, ...transport], trailing };
}

function isPlayerButtonId(item: string): item is PlayerButtonId {
  return (PLAYER_BUTTON_IDS as readonly string[]).includes(item);
}

export type PaneCoveredButtonsInput = {
  /** The climber's player buttons (`usePlayerButtonsPreference`), not their MiniPlayer ones. */
  buttons: PlayerButtonsLayout;
  previousNext: boolean;
  supportsMirroring: boolean;
  /** The climb can be shared: not a draft. */
  hasShare: boolean;
  /** The board's angle can change. */
  angleAvailable: boolean;
};

/**
 * What the open Duo's bar carries while the player fills the split's pane
 * (#6940): the buttons of the player's small row, which the bar sits on top of,
 * left to right. The pane's big row (its lead ⇄ or ☰, ⏮ ⏭, the bulb and the
 * tick) stays in view above the bar, so none of those repeat.
 *
 * It is the player's own layout for the climber's player buttons, in its plain
 * state: no connect pill, no Put on the wall, no workout Fell / Sent. Those
 * come and go with the moment, and the bar keeps its buttons through them.
 */
export function miniPlayerPaneCoveredButtons({
  buttons,
  previousNext,
  supportsMirroring,
  hasShare,
  angleAvailable,
}: PaneCoveredButtonsInput): PlayerButtonId[] {
  const { secondaryRow } = resolveActionBarLayout({
    supportsMirroring,
    isAnonymous: false,
    connectPill: false,
    commitButton: null,
    workoutOutcome: false,
    showLightbulb: true,
    hasShare,
    angleAvailable,
    buttons,
    previousNext,
  });
  if (typeof secondaryRow === 'string') return [];
  return secondaryRow.filter(isPlayerButtonId);
}
