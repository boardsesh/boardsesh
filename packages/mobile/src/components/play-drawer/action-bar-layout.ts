import { visibleSectionIds } from '../../lib/section-layout';
import { DEFAULT_PLAYER_BUTTONS, type PlayerButtonId, type PlayerButtonsLayout } from '../../lib/player-buttons';
import type { PlayDrawerHiddenButtons } from './play-drawer-menu-rows';

/** What the first row's leftmost slot holds. Slot 5 (the bulb) is `trailingSlot`. */
export type ActionBarLeadingSlot = 'mirror' | 'queue' | null;

/**
 * One entry in the second row, left to right. `spacer` is the flex gap.
 * `putOnWall` is the browse latch's one button, sitting in that gap.
 */
export type ActionBarSecondaryItem = PlayerButtonId | 'spacer' | 'connectPill' | 'putOnWall';

/**
 * What the browse latch needs from the second row. `putOnWall`: one button in
 * the middle of the usual row. `confirm`: someone else moved the wall while you
 * looked around, so the whole row becomes "Keep Sam's / Put mine up".
 */
export type ActionBarCommitButton = 'putOnWall' | 'confirm' | null;

/**
 * What the second row is: the busy-wall question, the timed workout block's
 * Fell / Sent pair, or the items left to right.
 */
export type ActionBarSecondaryRow = 'confirm' | 'workoutOutcome' | readonly ActionBarSecondaryItem[];

export type ActionBarLayoutInput = {
  supportsMirroring: boolean;
  /** The signed-out web reader: every write affordance is removed, not disabled. */
  isAnonymous: boolean;
  /**
   * The connect-step test asked for its pill (#5654, PR 7). It shows only where
   * the bulb would have been offered, and never in commit mode or anonymously.
   */
  connectPill: boolean;
  /** The browse latch's control in the second row, if it wants one. */
  commitButton: ActionBarCommitButton;
  /**
   * The climb up is in a timed workout block (#6231, #5380), so the second row
   * becomes one-tap Fell / Sent. A session state, not a button the climber
   * places: the host decides it (`shouldShowWorkoutOutcome`).
   */
  workoutOutcome: boolean;
  /** A Bluetooth transport exists on this platform at all. */
  showLightbulb: boolean;
  /** The climb can be shared. A draft can't: a link to it opens for nobody else (#5960). */
  hasShare: boolean;
  /** The angle pill has an angle to show and a sheet to open: a board whose angle can change. */
  angleAvailable: boolean;
  /** The climber's buttons: their order and switches. An anonymous reader's are ignored. */
  buttons: PlayerButtonsLayout;
  /** The Previous and next switch. Ignored for an anonymous reader. */
  previousNext: boolean;
};

export type ActionBarLayout = {
  leadingSlot: ActionBarLeadingSlot;
  trailingSlot: 'lightbulb' | null;
  /** ⏮ and ⏭. Off leaves both slots empty, so Log stays in the middle. */
  showPreviousNext: boolean;
  /**
   * The busy-wall question, the workout's Fell / Sent, or the row's items left
   * to right. Empty means there is no second row at all, and the board gets its
   * height.
   */
  secondaryRow: ActionBarSecondaryRow;
  showConnectPill: boolean;
  /** Buttons this viewer may use that the bar has put away. ⋯ carries a row for each. */
  hidden: PlayDrawerHiddenButtons;
};

const NOTHING_HIDDEN: PlayDrawerHiddenButtons = Object.freeze({
  favorite: false,
  share: false,
  queue: false,
  mirror: false,
  angle: false,
});

function isLeadingButton(buttonId: PlayerButtonId): buttonId is 'mirror' | 'queue' {
  return buttonId === 'mirror' || buttonId === 'queue';
}

/**
 * Where each action-bar button sits, for one bar state.
 *
 * ```
 * Non-mirror (Kilter, MoonBoard)   [☰]  [⏮]  [✓]  [⏭]  [💡]
 *                                  [♡] [40°] ············ [⬆]
 * Mirror (Tension, Decoy, Woods)   [⇄]  [⏮]  [✓]  [⏭]  [💡]
 *                                  [♡] [40°] ········ [⬆] [☰]
 * Anonymous                        [ ]  [⏮]  [✓]  [⏭]  [ ]     (mirror boards keep [⇄])
 *                                  [40°] ················ [⬆]
 * ```
 *
 * Those are the defaults; the climber's buttons (#6229) move things around
 * inside the same frame:
 *
 * - The first of Mirror and Queue in their order that is on and can show here
 *   takes the big leading slot. Mirror can show only on a board that mirrors.
 *   With both off, the slot stays empty and the row keeps its five-slot spacing.
 * - Every other button that is on fills the small row in order, the last half
 *   at the right end (the odd one out goes left). Mirror counts only on a board
 *   that mirrors, and Favorite and Queue only for a member. Angle and Share
 *   count even where this board or climb can't draw them (a fixed-angle board,
 *   a draft): they leave their place empty instead, so nothing jumps sides
 *   between climbs and today's bars come out exactly as they were.
 * - Log, Board light and the ⏮ ⏭ slots never move. Previous and next off
 *   leaves both slots empty, so Log stays centred.
 * - The connect pill replaces the right-hand group. While browsing, Put on the
 *   wall takes the gap in the middle; the first button on the left and the last
 *   on the right stay where they were and the others step into ⋯ for as long
 *   as it shows. Only the busy-wall question replaces the whole row. Whatever goes is flagged in
 *   `hidden`, as is every button the climber switched off, and the player's ⋯
 *   menu picks it up.
 * - In a timed workout block the whole small row is Fell / Sent, so a fall or
 *   a send is one tap. It gives way to Put on the wall and the busy-wall
 *   question (both mean the climber is looking at another climb, where the
 *   host never asks for it anyway) and wins over the connect pill, whose bulb
 *   goes back to its slot. Every small-row button steps into ⋯ meanwhile.
 * - With nothing left to draw, no pill and no Put on the wall, there is no
 *   second row: the board gets its height back. Share switched on keeps the row even
 *   on a draft, where it can't draw: it is the one button that comes and goes
 *   climb to climb, and the board must not jump 52 pt mid-swipe.
 * - An anonymous reader gets today's bar whatever is stored on the device: no
 *   account to favourite with, no queue that means anything, and no ⋯ to bring
 *   a hidden button back, so nothing is flagged for them either.
 */
export function resolveActionBarLayout({
  supportsMirroring,
  isAnonymous,
  connectPill,
  commitButton,
  workoutOutcome,
  showLightbulb,
  hasShare,
  angleAvailable,
  buttons,
  previousNext,
}: ActionBarLayoutInput): ActionBarLayout {
  const commit = isAnonymous ? null : commitButton;
  // Confirm > Put on the wall > the workout's Fell / Sent > the connect pill > the buttons.
  const showWorkoutOutcome = workoutOutcome && !isAnonymous && commit === null;
  const showConnectPill = connectPill && showLightbulb && !isAnonymous && commit === null && !showWorkoutOutcome;
  const trailingSlot = showLightbulb && !isAnonymous && !showConnectPill ? 'lightbulb' : null;
  const layout = isAnonymous ? DEFAULT_PLAYER_BUTTONS : buttons;
  const showPreviousNext = isAnonymous || previousNext;

  // Whether a button takes a place in the bar for this board and viewer.
  const takesPlace = (buttonId: PlayerButtonId): boolean => {
    switch (buttonId) {
      case 'mirror':
        return supportsMirroring;
      case 'favorite':
      case 'queue':
        return !isAnonymous;
      case 'angle':
      case 'share':
        return true;
    }
  };
  // Whether it can be drawn in that place right now.
  const canDraw = (buttonId: PlayerButtonId): boolean => {
    if (buttonId === 'angle') return angleAvailable;
    if (buttonId === 'share') return hasShare;
    return true;
  };

  const placed = visibleSectionIds(layout, takesPlace);
  const leadingSlot: ActionBarLeadingSlot = placed.find(isLeadingButton) ?? null;
  const utilities = placed.filter((buttonId) => buttonId !== leadingSlot);
  const startCount = utilities.length - Math.floor(utilities.length / 2);
  const startGroup = utilities.slice(0, startCount).filter(canDraw);
  const endGroup = utilities.slice(startCount).filter(canDraw);

  let secondaryRow: ActionBarLayout['secondaryRow'];
  if (commit === 'confirm') {
    secondaryRow = 'confirm';
  } else if (commit === 'putOnWall') {
    // Room for the button: "Put on the wall" needs ~140pt in English and more in
    // German, and a mirror board's row (♡ 40° ⬆ ☰) leaves ~120pt on a 375pt
    // phone. So one button keeps its place on each side and the rest step into
    // ⋯ until the climb is up.
    secondaryRow = [...startGroup.slice(0, 1), 'spacer', 'putOnWall', 'spacer', ...endGroup.slice(-1)];
  } else if (showWorkoutOutcome) {
    secondaryRow = 'workoutOutcome';
  } else if (showConnectPill) {
    secondaryRow = [...startGroup, 'spacer', 'connectPill'];
  } else if (startGroup.length + endGroup.length === 0 && !utilities.includes('share')) {
    secondaryRow = [];
  } else {
    secondaryRow = [...startGroup, 'spacer', ...endGroup];
  }

  if (isAnonymous) {
    return { leadingSlot, trailingSlot, showPreviousNext, secondaryRow, showConnectPill, hidden: NOTHING_HIDDEN };
  }

  const shown = (buttonId: PlayerButtonId) =>
    leadingSlot === buttonId || (typeof secondaryRow !== 'string' && secondaryRow.includes(buttonId));
  return {
    leadingSlot,
    trailingSlot,
    showPreviousNext,
    secondaryRow,
    showConnectPill,
    hidden: {
      favorite: !shown('favorite'),
      share: hasShare && !shown('share'),
      queue: !shown('queue'),
      mirror: supportsMirroring && !shown('mirror'),
      angle: angleAvailable && !shown('angle'),
    },
  };
}
