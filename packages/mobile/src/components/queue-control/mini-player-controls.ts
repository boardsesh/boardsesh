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

/**
 * iPadOS gives the open accessory a ~62pt platter, not the iPhone's 48pt
 * (#7048). From this height up the platter counts as tall: the artwork grows to
 * sit concentric with the rounded end, and ✓ centres in the other end.
 */
export const TALL_PLATTER_MIN_HEIGHT = 56;
const TALL_PLATTER_THUMBNAIL_SIZE = 40;
const TALL_PLATTER_LEADING_INSET = 12;
const TALL_PLATTER_TRAILING_INSET = 10;

export type AccessoryPlatterGeometry = {
  leadingInset: number;
  trailingInset: number;
  thumbnailSize: number;
  /** ✓'s glyph. The iPhone bar draws it a size up; the tall bar matches its neighbours' 22pt. */
  logGlyphSize: number;
};

/** The row's insets and artwork size for the platter height UIKit gave it. */
export function accessoryPlatterGeometry(platterHeight: number): AccessoryPlatterGeometry {
  return platterHeight >= TALL_PLATTER_MIN_HEIGHT
    ? {
        leadingInset: TALL_PLATTER_LEADING_INSET,
        trailingInset: TALL_PLATTER_TRAILING_INSET,
        thumbnailSize: TALL_PLATTER_THUMBNAIL_SIZE,
        logGlyphSize: 22,
      }
    : {
        leadingInset: ACCESSORY_LEADING_INSET,
        trailingInset: ACCESSORY_TRAILING_INSET,
        thumbnailSize: ACCESSORY_PLATTER_THUMBNAIL_SIZE,
        logGlyphSize: 24,
      };
}

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

/**
 * The open row's measured width, as `NativeAccessoryClimbRow` records it: the
 * widest and the latest measurement under one window shape (`rowLayoutKey`).
 */
export type MeasuredRowWidth = {
  /** The window shape the row was measured under. */
  layoutKey: string;
  widest: number;
  latest: number;
};

/**
 * What a wide row's width follows besides the bar itself: the window width
 * (rotation, Split View, Stage Manager) and the tab content's side insets (the
 * iPad sidebar shown or hidden, the Duo's rail). Null insets are "not measured
 * yet".
 */
export function rowLayoutKey({
  windowWidth,
  sideInsetLeft,
  sideInsetRight,
}: {
  windowWidth: number;
  sideInsetLeft: number | null;
  sideInsetRight: number | null;
}): string {
  return `${Math.round(windowWidth)}|${sideInsetLeft === null ? '-' : Math.round(sideInsetLeft)}|${
    sideInsetRight === null ? '-' : Math.round(sideInsetRight)
  }`;
}

/** Folds one `onLayout` width into the record. A new window shape starts it over. */
export function recordRowWidth(
  previous: MeasuredRowWidth | null,
  { layoutKey, measured }: { layoutKey: string; measured: number },
): MeasuredRowWidth {
  if (previous === null || previous.layoutKey !== layoutKey) {
    return { layoutKey, widest: measured, latest: measured };
  }
  if (previous.widest >= measured && previous.latest === measured) return previous;
  return { layoutKey, widest: Math.max(previous.widest, measured), latest: measured };
}

/**
 * The row width a wide bar (iPad, the open Duo) counts its slots from.
 *
 * UIKit keeps the regular row mounted while the bar is inline and squeezes it
 * to the inline width. Counting slots from that width would drop the leading
 * cluster, which sits before the art on a wide bar, and bring it back
 * mid-expand: the art and the name slide sideways while UIKit snapshots the
 * platter (the doubled-text case), and ⋯ remounts on its new row set. So under
 * one window shape the wide bar keeps the widest width it measured:
 *
 * - a shrink under the same shape is the squeeze, and is ignored;
 * - a new shape (rotation, a window resize, the sidebar shown or hidden) counts
 *   from the latest measurement, and the first measurement under it starts the
 *   record over, so the bar narrows when its platter really does.
 *
 * Measured on the iPad Pro 11" simulator (iOS 27, 2026-10-29): the iPad's top
 * tab bar never minimizes in either orientation, and the Duo's rail is set to
 * `never`, so today the squeeze needs a narrow iPad window (Split View, Slide
 * Over, Stage Manager), where the tab bar moves to the bottom and minimizes on
 * scroll.
 */
export function wideRowCapacityWidth(record: MeasuredRowWidth | null, layoutKey: string): number | null {
  if (record === null) return null;
  return record.layoutKey === layoutKey ? record.widest : record.latest;
}

/** How the bar is drawn right now. */
/** Everything in the row that is not the name or a slot: insets, the artwork and its gap, the label padding. */
export function accessoryWidthBesideName(geometry: AccessoryPlatterGeometry, hasThumbnail: boolean): number {
  return (
    geometry.leadingInset +
    (hasThumbnail ? geometry.thumbnailSize + ACCESSORY_THUMBNAIL_GAP : 0) +
    ACCESSORY_LABEL_TRAILING_PADDING +
    geometry.trailingInset
  );
}

export type MiniPlayerBarShape = {
  placement: 'regular' | 'inline';
  /** Regular capacity width, or a live measured width for rails/wide layouts. */
  rowWidth: number | null;
  /** Everything in the row that is not the name or a slot: insets, the artwork and its gap, the label padding. */
  widthBesideName: number;
  /** iPad, or iPhone Duo open: no cap but the width. Otherwise an iPhone, capped at three. */
  wide: boolean;
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
 * - iPad and the open Duo hold as many as fit beside a 160pt name, which is
 *   every button the climber has on. The slots sit at one even pitch, as on
 *   Music's bar (#7048).
 * - Before the first layout the row guesses the answer most bars measure (three
 *   on an iPhone, everything when wide), so the common bar never redraws on its
 *   first measurement: UIKit snapshots the platter, and a redraw then is the
 *   doubled-text case.
 */
export function miniPlayerSlotCount({ placement, rowWidth, widthBesideName, wide }: MiniPlayerBarShape): number {
  if (placement === 'inline') return 1;
  if (rowWidth === null) return wide ? UNMEASURED_WIDE_SLOTS : PHONE_MINI_PLAYER_MAX_SLOTS;
  const nameFloor = wide ? ACCESSORY_MIN_NAME_WIDTH : PHONE_ACCESSORY_MIN_NAME_WIDTH;
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
  /**
   * An iPad or an Android tablet (`useDeviceLayout().isTablet`, launch-fixed):
   * the only devices that offer Wall display, as `WallDisplayEntry` does. The
   * open Duo is a phone, so it has none.
   */
  tablet: boolean;
};

/**
 * Whether a button can take a place on the bar right now. No ⏮ ⏭ in a timed
 * workout block; Mirror only on a board that mirrors; Favorite and Queue need an account; a draft has no link
 * to share; a fixed-angle board has no angle to change, and neither does the bar while
 * the player route is up. Wall display is for a tablet mounted at the board, and
 * is not offered over the player either (the player covers the tabs it opens over).
 */
export function isMiniPlayerButtonAvailable(
  buttonId: MiniPlayerButtonId,
  { inTimedBlock, mirror, signedIn, isDraft, angleAdjustable, playerRouteUp, tablet }: MiniPlayerAvailability,
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
    case 'wallDisplay':
      return tablet && !playerRouteUp;
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
   * A board is bound, so the bulb draws something. With none it renders
   * nothing, and in a timed block its slot goes to the tick instead.
   */
  bulbAvailable: boolean;
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
  /**
   * A wide bar (iPad, the open Duo) in its regular placement: it draws Apple
   * Music's iPad layout, ⏮ ⏭ first at the leading edge and a ⋯ before 💡 ✓
   * (`miniPlayerUsesWideLayout`). False on an iPhone and on every inline bar,
   * which keep the layout they always had.
   */
  wideLayout: boolean;
  /**
   * The ⋯ menu can open: false while the `/play` route is up, whose sheets
   * would present behind it (the player has its own ⋯).
   */
  moreAvailable: boolean;
};

export type MiniPlayerControls = {
  /**
   * Left to right. On a wide bar ⏮ ⏭ first, then the climber's other buttons,
   * all before the climb. Elsewhere the climber's other buttons, then ⏮ ⏭,
   * after the climb.
   */
  leading: readonly MiniPlayerButtonId[];
  /** Fell and Sent in a timed workout block, or Sent alone in one slot. Where `leading` is drawn. */
  workout: readonly MiniPlayerWorkoutButton[];
  /** ⋯, in the slot just before 💡 ✓ on a wide bar. Never on an iPhone or an inline bar. */
  more: boolean;
  /**
   * ⛶ Wall display, between ⋯ and 💡 on a wide bar, where Music's iPad bar puts
   * lyrics. It claims its slot in the climber's order like the buttons in
   * `leading`, but is drawn in the trailing cluster, so it is never in `leading`.
   */
  wallDisplay: boolean;
  /** Left to right at the trailing edge: 💡 ✓, or the one of them a single slot keeps. */
  trailing: readonly ('lightbulb' | 'log')[];
};

/** A wide bar in its regular placement draws Music's iPad layout (`wideLayout`). */
export function miniPlayerUsesWideLayout({ wide, placement }: { wide: boolean; placement: 'regular' | 'inline' }) {
  return wide && placement === 'regular';
}

const TRANSPORT_ORDER: readonly MiniPlayerButtonId[] = ['previous', 'next'];

/**
 * What the bar holds, left to right (#6940).
 *
 * ```
 * iPad              [⏮] [⏭] [⇄] [♡] · [thumb] Name ··· [⋯] [⛶] [💡] [✓]
 * Duo open          [⏮] [⏭] [⇄] [♡] · [thumb] Name ········ [⋯] [💡] [✓]
 * iPhone            [thumb] Name ················ [⏭] · [💡] [✓]
 * One slot          [thumb] Name ······················· [💡] or [✓]
 * ```
 *
 * Board light and Log claim their slots first and sit at the trailing edge, as
 * they always have. On a wide bar (iPad, the open Duo, regular placement) ⋯
 * claims the next slot and sits just before them, as on Apple Music's iPad
 * MiniPlayer; it holds every action the bar has no button for. The climber's
 * buttons that are on and can show here claim the rest in the climber's order,
 * so on a short bar the last ones in that list are the ones left out (⋯, or the
 * player's ⋯, still has every action). Where a claimed button is drawn does not
 * follow that order: on a wide bar ⏮ ⏭ lead the row and the others follow them,
 * before the climb; on an iPhone the others come after the climb and ⏮ ⏭ sit
 * together just before the bulb. Wall display (tablets only, so only ever on a
 * wide bar) claims in the same order but is drawn after ⋯ (`wallDisplay`).
 *
 * In a timed workout block the bar logs each go instead (`workoutOutcome`), as
 * the player's small row does:
 *
 * ```
 * iPad              [Fell] [Sent] · [thumb] Name ······· [⋯] [⛶] [💡] [✓]
 * Duo open          [Fell] [Sent] · [thumb] Name ··········· [⋯] [💡] [✓]
 * iPhone            [thumb] Name ···················· [Fell] [Sent] [💡]
 * One slot          [thumb] Name ································ [Sent]
 * Duo, pane carry   [Fell] [Sent] · [thumb] Name ························ [⋯]
 * ```
 *
 * The climber's other buttons step aside for the block, so a mis-tap mid-4x4
 * never flips the wall or skips a rep. Fell and Sent claim their slots first,
 * then the bulb, then the tick, then ⋯, then Wall display while it is on: an
 * iPhone's ✓ steps aside, since Fell and Sent already log each go. Wall display
 * stays because it changes neither the wall nor the queue. With no board bound the bulb draws nothing, so
 * the tick takes its place. With the player in the Duo's pane (`carry`) the bar
 * covers the pane's own Fell / Sent and the pane's big row shows 💡 ✓, so the
 * bar carries Fell and Sent, and ⋯. While the pane shows a preview, or its
 * controls sit above the board (`stepAside`), the bar keeps ⋯ 💡 ✓, as it does
 * outside a block.
 */
export function resolveMiniPlayerControls({
  slotCount,
  layout,
  isAvailable,
  singleSlotShowsBulb,
  bulbAvailable,
  paneMode,
  paneCoveredButtons,
  workoutOutcome,
  wideLayout,
  moreAvailable,
}: MiniPlayerControlsInput): MiniPlayerControls {
  const carry = paneMode === 'carry';
  const offersMore = wideLayout && moreAvailable;
  // Drawn only in a wide bar's trailing cluster; an iPhone or an inline bar never claims it.
  const wallDisplayOn = wideLayout && !carry && layout.visible.wallDisplay && isAvailable('wallDisplay');
  if (workoutOutcome && paneMode !== 'stepAside') {
    if (slotCount <= 1) return { leading: [], workout: ['sent'], more: false, wallDisplay: false, trailing: [] };
    const room = carry ? 0 : slotCount - 2;
    // With no board bound the bulb draws nothing, so the tick keeps its slot.
    const fixed: ('lightbulb' | 'log')[] = bulbAvailable ? ['lightbulb', 'log'] : ['log'];
    const trailing = fixed.slice(0, room);
    const more = offersMore && slotCount - 2 - trailing.length >= 1;
    return {
      leading: [],
      workout: ['fell', 'sent'],
      more,
      wallDisplay: wallDisplayOn && slotCount - 2 - trailing.length - (more ? 1 : 0) >= 1,
      trailing,
    };
  }
  const trailing: ('lightbulb' | 'log')[] = carry
    ? []
    : slotCount <= 1
      ? [singleSlotShowsBulb ? 'lightbulb' : 'log']
      : ['lightbulb', 'log'];
  const more = offersMore && slotCount > trailing.length;
  // A preview in the pane, or its controls above the board: the covered buttons
  // would act on a climb the pane isn't showing, or repeat ones in plain view.
  if (paneMode === 'stepAside') return { leading: [], workout: [], more, wallDisplay: false, trailing };
  const room = Math.max(0, slotCount - trailing.length - (more ? 1 : 0));
  const canClaim = (buttonId: MiniPlayerButtonId) =>
    buttonId === 'wallDisplay'
      ? wallDisplayOn
      : isAvailable(buttonId) && !(carry && TRANSPORT_ORDER.includes(buttonId));
  const claimed = (carry ? (paneCoveredButtons ?? []).filter(canClaim) : visibleSectionIds(layout, canClaim)).slice(
    0,
    room,
  );
  const others = claimed.filter((buttonId) => !TRANSPORT_ORDER.includes(buttonId) && buttonId !== 'wallDisplay');
  const transport = TRANSPORT_ORDER.filter((buttonId) => claimed.includes(buttonId));
  return {
    leading: wideLayout ? [...transport, ...others] : [...others, ...transport],
    workout: [],
    more,
    wallDisplay: claimed.includes('wallDisplay'),
    trailing,
  };
}

/** A fixed frame at the bar's trailing edge. */
export type TrailingControlSlot = 'more' | 'wallDisplay' | 'lightbulb' | 'log';

/**
 * Where the trailing slots sit. The slots keep fixed frames inside one pair
 * (see the comment at the render), so instead of resizing a slot the pair
 * shifts right past the empty slots after the last control, and the frame
 * around it spans the first control to the last. A lone bulb on an iPhone
 * shifts one slot, as it always has.
 */
export function trailingSlotFrame(
  slots: readonly TrailingControlSlot[],
  shown: (slot: TrailingControlSlot) => boolean,
): { slotsShown: number; trailingShift: number } {
  const shownIndices = slots.flatMap((slot, index) => (shown(slot) ? [index] : []));
  if (shownIndices.length === 0) return { slotsShown: 0, trailingShift: 0 };
  const first = shownIndices[0];
  const last = shownIndices[shownIndices.length - 1];
  return { slotsShown: last - first + 1, trailingShift: slots.length - 1 - last };
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
