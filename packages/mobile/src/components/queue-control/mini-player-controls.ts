import { visibleSectionIds } from '../../lib/section-layout';
import type { MiniPlayerButtonId, MiniPlayerButtonsLayout } from '../../lib/mini-player-buttons';
import {
  PLAYER_BUTTON_IDS,
  type PlayerButtonId,
  type PlayerButtonsLayout,
  type PlayerButtonsPosition,
} from '../../lib/player-buttons';
import { resolveActionBarLayout } from '../play-drawer/action-bar-layout';

/**
 * The least room the climb name keeps before a wide bar gives up a slot. About
 * 20 characters of a subheadline name: enough that most names read without
 * scrolling.
 */
export const ACCESSORY_MIN_NAME_WIDTH = 160;

/**
 * The iPhone name floor: a 402pt phone's 360pt content fits three controls;
 * a 375pt phone's 333pt content fits two. Smaller windows and the Duo's
 * closed display can keep only one.
 */
export const PHONE_ACCESSORY_MIN_NAME_WIDTH = 140;

// Measured against Apple Music's platter (iOS 27): the artwork starts 16pt in, and
// the last control's centre sits ~30pt from the right edge (8pt + half its 44pt slot).
export const ACCESSORY_LEADING_INSET = 16;
export const ACCESSORY_TRAILING_INSET = 8;
// One artwork size in both placements, as Music uses (~30pt).
export const ACCESSORY_PLATTER_THUMBNAIL_SIZE = 32;
// `labelInner`'s gap after the artwork and its trailing padding.
export const ACCESSORY_THUMBNAIL_GAP = 8;
export const ACCESSORY_LABEL_TRAILING_PADDING = 4;
// Between the climber's buttons and ⏮ ⏭, and before 💡 ✓, on a wide bar.
export const ACCESSORY_GROUP_GAP = 12;

/** One control's tap target. Every slot on the bar is this wide. */
export const ACCESSORY_SLOT_WIDTH = 44;

/**
 * At most this many controls on an iPhone's open bar, Board light and Log
 * included (#6940): one button of the climber's beside them. Music keeps its
 * iPhone MiniPlayer this short too.
 */
export const PHONE_MINI_PLAYER_MAX_SLOTS = 3;

/**
 * Window-to-regular-content difference measured on iOS 27 simulators:
 * iPhone 17 Pro 402 -> 360pt; iPhone 13 mini 375 -> 333pt.
 * This includes UIKit's platter margins and content padding, separately from
 * our internal insets above. It is a phone sizing budget, not a UIKit API.
 */
const PHONE_ACCESSORY_CONTENT_GUTTER = 42;

/**
 * Both pre-mounted placement trees receive the same changing wrapper width.
 * Horizontal phones therefore size regular controls from the stable viewport,
 * so the hidden regular tree stays ready while the wrapper is inline. The
 * returned width is only a control budget; UIKit still sizes the actual row.
 * Rails, tablets and split layouts keep their real container measurements.
 */
export function miniPlayerCapacityWidth({
  windowWidth,
  rowWidth,
  wide,
  verticalTabBar,
}: {
  windowWidth: number;
  rowWidth: number | null;
  wide: boolean;
  verticalTabBar: boolean;
}): number | null {
  return wide || verticalTabBar ? rowWidth : Math.max(0, windowWidth - PHONE_ACCESSORY_CONTENT_GUTTER);
}

/** How the bar is drawn right now. */
export type MiniPlayerBarShape = {
  placement: 'regular' | 'inline';
  /** Regular capacity width, or a live measured width for rails/wide layouts. */
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
 *   light and Log included: three at 360pt, two at 333pt, one on the Duo's
 *   closed display and a 320pt Display Zoom iPhone.
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

export type MiniPlayerAvailability = {
  /**
   * The climb on the wall is in a timed workout block (#6231): its stage moves
   * the wall on its own beat, so ⏮ ⏭ would skip a rep. True even where the bar
   * can't offer Fell / Sent (signed out, a draft, another board's climb).
   */
  inTimedBlock: boolean;
  /** The climb's board mirrors (Tension, Decoy, Woods...): `boardSupportsMirroring`. */
  mirror: boolean;
  signedIn: boolean;
  isDraft: boolean;
  angleAdjustable: boolean;
  /** The `/play` route is up: the host's angle sheet would present behind it, so the bar has no Angle (the player has its own). */
  playerRouteUp: boolean;
};

/**
 * Whether a button can take a place on the bar right now. No ⏮ ⏭ in a timed
 * workout block; Mirror only on a board that mirrors; Favorite and Queue need an account; a draft has no link
 * to share; a fixed-angle board has no angle to change, and neither does the bar while
 * the player route is up.
 */
export function isMiniPlayerButtonAvailable(
  buttonId: MiniPlayerButtonId,
  { inTimedBlock, mirror, signedIn, isDraft, angleAdjustable, playerRouteUp }: MiniPlayerAvailability,
): boolean {
  switch (buttonId) {
    case 'previous':
    case 'next':
      return !inTimedBlock;
    case 'mirror':
      return mirror;
    case 'favorite':
    case 'queue':
      return signedIn;
    case 'share':
      return !isDraft;
    case 'angle':
      return angleAdjustable && !playerRouteUp;
  }
}

/** One-tap Fell / Sent for the climb on the wall, in a timed workout block (#6940). */
export type MiniPlayerWorkoutButton = 'fell' | 'sent';

/** One slot on the bar. `lightbulb` and `log` are the fixed pair at the trailing edge. */
export type MiniPlayerSlot = MiniPlayerButtonId | MiniPlayerWorkoutButton | 'lightbulb' | 'log';

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
   * How the open Duo's bar relates to the player in the split's pane
   * (`miniPlayerPaneMode`); `none` everywhere else. In `carry` the pane's big
   * row has ⏮ ⏭ 💡 ✓ right above the bar, so the bar does not repeat them.
   */
  paneMode: MiniPlayerPaneMode;
  /**
   * In `carry`, claim from these, in this order, instead of the climber's
   * MiniPlayer list: the player's small row, which the bar covers
   * (`miniPlayerPaneCoveredButtons`). Ignored in the other modes.
   */
  paneCoveredButtons?: readonly MiniPlayerButtonId[];
  /**
   * The bar offers one-tap Fell / Sent: the climb on the wall is in a timed
   * workout block and the climber can log it here, or the bar is holding the
   * pair for the climb the wall just left (`useMiniPlayerWorkoutOutcome`).
   */
  workoutOutcome: boolean;
};

export type MiniPlayerControls = {
  /** Left to right: the climber's other buttons, then ⏮ ⏭. */
  leading: readonly MiniPlayerButtonId[];
  /** Left to right after them: Fell and Sent in a timed workout block, or Sent alone in one slot. */
  workout: readonly MiniPlayerWorkoutButton[];
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
 *
 * In a timed workout block the bar logs each go instead (`workoutOutcome`), as
 * the player's small row does:
 *
 * ```
 * iPad, Duo open    [thumb] Name ··········· [Fell] [Sent] · [💡] [✓]
 * iPhone            [thumb] Name ···················· [Fell] [Sent] [💡]
 * One slot          [thumb] Name ································ [Sent]
 * Duo, pane carry   [thumb] Name ························ [Fell] [Sent]
 * ```
 *
 * The climber's other buttons step aside for the block, so a mis-tap mid-4x4
 * never flips the wall or skips a rep. Fell and Sent claim their slots first,
 * then the bulb, then the tick: an iPhone's ✓ steps aside, since Fell and Sent
 * already log each go. With the player in the Duo's pane (`carry`) the bar
 * covers the pane's own Fell / Sent and the pane's big row shows 💡 ✓, so the
 * bar carries Fell and Sent only. While the pane shows a preview, or its
 * controls sit above the board (`stepAside`), the bar keeps 💡 ✓, as it does
 * outside a block.
 */
export function resolveMiniPlayerControls({
  slotCount,
  layout,
  isAvailable,
  singleSlotShowsBulb,
  paneMode,
  paneCoveredButtons,
  workoutOutcome,
}: MiniPlayerControlsInput): MiniPlayerControls {
  const carry = paneMode === 'carry';
  if (workoutOutcome && paneMode !== 'stepAside') {
    if (slotCount <= 1) return { leading: [], workout: ['sent'], trailing: [] };
    const room = carry ? 0 : slotCount - 2;
    const trailing: ('lightbulb' | 'log')[] = room >= 2 ? ['lightbulb', 'log'] : room === 1 ? ['lightbulb'] : [];
    return { leading: [], workout: ['fell', 'sent'], trailing };
  }
  const trailing: ('lightbulb' | 'log')[] = carry
    ? []
    : slotCount <= 1
      ? [singleSlotShowsBulb ? 'lightbulb' : 'log']
      : ['lightbulb', 'log'];
  // A preview in the pane, or its controls above the board: the covered buttons
  // would act on a climb the pane isn't showing, or repeat ones in plain view.
  if (paneMode === 'stepAside') return { leading: [], workout: [], trailing };
  const room = Math.max(0, slotCount - trailing.length);
  const canClaim = (buttonId: MiniPlayerButtonId) =>
    isAvailable(buttonId) && !(carry && TRANSPORT_ORDER.includes(buttonId));
  const claimed = (carry ? (paneCoveredButtons ?? []).filter(canClaim) : visibleSectionIds(layout, canClaim)).slice(
    0,
    room,
  );
  const others = claimed.filter((buttonId) => !TRANSPORT_ORDER.includes(buttonId));
  const transport = TRANSPORT_ORDER.filter((buttonId) => claimed.includes(buttonId));
  return { leading: [...others, ...transport], workout: [], trailing };
}

/**
 * How the open Duo's bar relates to the player in the split's pane (#6940).
 *
 * - `none`: no pane player above the bar (no split, or a screen fills the pane).
 *   The bar is itself.
 * - `carry`: the pane shows the queue's current climb with its controls below the
 *   board, so the bar sits on the small row. It drops what the pane's big row
 *   shows right above (⏮ ⏭ 💡 ✓) and carries the covered buttons instead.
 * - `stepAside`: the pane shows a preview (a browse, a view-only swipe, a feed
 *   climb), or its controls sit above the board where nothing is covered. The
 *   covered buttons would act on a climb the pane isn't showing, or repeat ones
 *   in plain view, so the bar keeps only Board light and Log for the climb it
 *   names, as it did before the split carried anything.
 */
export type MiniPlayerPaneMode = 'none' | 'carry' | 'stepAside';

export function miniPlayerPaneMode({
  phoneSplit,
  paneTaken,
  paneShowsPreview,
  controlsPosition,
}: {
  phoneSplit: boolean;
  paneTaken: boolean;
  paneShowsPreview: boolean;
  controlsPosition: PlayerButtonsPosition;
}): MiniPlayerPaneMode {
  if (!phoneSplit || paneTaken) return 'none';
  return !paneShowsPreview && controlsPosition === 'below' ? 'carry' : 'stepAside';
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
 * come and go with the moment, and the bar keeps its buttons through them,
 * except in a timed workout block, when it carries Fell / Sent in their place
 * (`resolveMiniPlayerControls`).
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
