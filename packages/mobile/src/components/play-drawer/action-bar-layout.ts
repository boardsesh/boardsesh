import { visibleSectionIds } from '../../lib/section-layout';
import type { PlayerBoardControl, PlayerButtonId, PlayerButtonsLayout } from '../../lib/player-buttons';
import type { PlayDrawerHiddenButtons } from './play-drawer-menu-rows';

/**
 * What the first row's leftmost slot holds: the first of the climber's buttons
 * that is on and applies here. Slot 5 is `trailingSlot`.
 */
export type ActionBarLeadingSlot = PlayerButtonId | null;

/** The first row's rightmost slot: the climber's last button on, or the bulb while the second row is taken. */
export type ActionBarTrailingSlot = PlayerButtonId | 'lightbulb' | null;

/**
 * One entry in the second row, left to right. `wallControl` is the wall button
 * (`WallControlButton`): the whole row for a member with the wall button
 * chosen, or Put on the wall in the gap with the bulb chosen. A button id is a
 * small button on one side of the bulb mode's row; `angle`, `share` and
 * `spacer` are also the signed-out reader's row.
 */
export type ActionBarSecondaryItem = 'wallControl' | 'spacer' | PlayerButtonId;

/**
 * The browse latch's control. `putOnWall` is one of the wall button's states.
 * `confirm`: someone else moved the wall while you looked around, so the wall
 * button's row becomes "Keep Sam's / Put mine up" (`BusyWallQuestionGroup`).
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
  /** The browse latch's control, if it wants one (`resolveCommitButton`). */
  commitButton: ActionBarCommitButton;
  /**
   * The climb up is in a timed workout block (#6231, #5380), so the second row
   * becomes one-tap Fell / Sent. A session state, not a button the climber
   * places: the host decides it (`shouldShowWorkoutOutcome`).
   */
  workoutOutcome: boolean;
  /** A Bluetooth transport exists on this platform at all. */
  showLightbulb: boolean;
  /**
   * There is a wall with lights to put a climb on: a Bluetooth transport and a
   * selected board that has lights (not a spray wall or a ledless board). With
   * none, the wall button has nothing to say and its row folds away, unless a
   * preview needs its Set active. Omitted reads as a wall.
   */
  hasWall?: boolean;
  /** The climb can be shared. A draft can't: a link to it opens for nobody else (#5960). */
  hasShare: boolean;
  /** The angle pill has an angle to show and a sheet to open: a board whose angle can change. */
  angleAvailable: boolean;
  /** The climber's buttons: their order and switches. An anonymous reader's are ignored. */
  buttons: PlayerButtonsLayout;
  /** The Previous and next switch. Ignored for an anonymous reader. */
  previousNext: boolean;
  /** View options › Buttons › Board control: the wall button (the default) or the bulb. */
  boardControl?: PlayerBoardControl;
  /**
   * The MiniPlayer beside the player stands in for its first row (#7000, the
   * tablet rule: the open Duo's pane, a tablet's player route). Its ⏮ ⏭, the
   * climber's buttons, ⋯ and ✓ live in the bar, so the player's first row is
   * the full-width wall button (or nothing, with the bulb chosen: the bar has
   * the bulb). `playerMirroredByMiniPlayer` decides it.
   */
  miniPlayerMirrors?: boolean;
};

/**
 * The first row: Log in the middle of the climber's buttons (`tick`); the
 * narrower wall button between ⏮ and ⏭ in a timed block (`wallControl`); the
 * full-width wall button alone, beside a MiniPlayer that has the rest
 * (`wallControlFull`), or the busy-wall question's pair in its place
 * (`confirm`); or no first row at all there with the bulb chosen (`none`).
 */
export type ActionBarPrimaryCenter = 'tick' | 'wallControl' | 'wallControlFull' | 'confirm' | 'none';

export type ActionBarLayout = {
  primaryCenter: ActionBarPrimaryCenter;
  leadingSlot: ActionBarLeadingSlot;
  /** The position beside Log, available to an action while navigation arrows are off. */
  innerLeadingSlot: ActionBarLeadingSlot;
  innerTrailingSlot: ActionBarLeadingSlot;
  trailingSlot: ActionBarTrailingSlot;
  /** ⏮ and ⏭. Off makes their positions available to the climber's actions. */
  showPreviousNext: boolean;
  /** The busy-wall question, the workout's Fell / Sent, or the row's items left to right. Empty: no second row. */
  secondaryRow: ActionBarSecondaryRow;
  /** Buttons this viewer may use that the bar is not showing. ⋯ carries a row for each. */
  hidden: PlayDrawerHiddenButtons;
};

const NOTHING_HIDDEN: PlayDrawerHiddenButtons = Object.freeze({
  tick: false,
  favorite: false,
  share: false,
  queue: false,
  playNext: false,
  mirror: false,
  angle: false,
});

/**
 * One placement rule for the bar, its overflow menu and the settings preview.
 *
 * With navigation off the first row has four actions around Log. When too many
 * apply, the first action and the final three take those positions. The default
 * Mirror, Angle, Favorite, Share, Queue order gives Mirror / Favorite / Log /
 * Share / Queue where mirroring applies, and Angle in Mirror's place elsewhere.
 * Navigation on reserves the inner positions for Previous / Next and retains
 * today's first / last action priority at the two ends.
 *
 * The wall button owns the second row. In Lightbulb mode its bulb owns the last
 * primary position and remaining enabled actions share the secondary row. A
 * busy wall or timed workout may take that row; their displaced actions remain
 * in the overflow menu. Beside a MiniPlayer the player delegates the icon row.
 *
 * Draft Share keeps an empty position rather than moving the other buttons.
 * Anonymous readers retain their read-only layout and have no overflow menu.
 */
export function resolveActionBarLayout({
  supportsMirroring,
  isAnonymous,
  commitButton,
  workoutOutcome,
  showLightbulb,
  hasWall = true,
  hasShare,
  angleAvailable,
  buttons,
  previousNext,
  boardControl = 'wallButton',
  miniPlayerMirrors = false,
}: ActionBarLayoutInput): ActionBarLayout {
  if (isAnonymous) {
    return {
      primaryCenter: 'tick',
      leadingSlot: supportsMirroring ? 'mirror' : null,
      innerLeadingSlot: null,
      innerTrailingSlot: null,
      trailingSlot: null,
      showPreviousNext: true,
      secondaryRow: [...(angleAvailable ? ['angle' as const] : []), 'spacer', ...(hasShare ? ['share' as const] : [])],
      hidden: NOTHING_HIDDEN,
    };
  }

  if (miniPlayerMirrors) {
    // Beside a MiniPlayer that stands in for the first row (#7000): the wall
    // button moves up into it, full width, and the second row is only the
    // busy-wall question or Fell / Sent; otherwise it folds and the board gets
    // the height. With the bulb chosen the bar has the bulb, so there is no
    // first row, and a preview's Put on the wall takes the second.
    const bulbChosen = boardControl === 'lightbulb';
    // The busy-wall question takes the wall button's row: the first row here,
    // the second with the bulb chosen (there is no first row then).
    const confirmUp = commitButton === 'confirm' && !bulbChosen;
    let secondaryRow: ActionBarSecondaryRow;
    if (commitButton === 'confirm') secondaryRow = confirmUp ? [] : 'confirm';
    else if (workoutOutcome && commitButton === null) secondaryRow = 'workoutOutcome';
    else if (bulbChosen && commitButton === 'putOnWall') secondaryRow = ['wallControl'];
    else secondaryRow = [];
    const wallButtonUp = !bulbChosen && ((showLightbulb && hasWall) || commitButton === 'putOnWall');
    return {
      primaryCenter: confirmUp ? 'confirm' : wallButtonUp ? 'wallControlFull' : 'none',
      leadingSlot: null,
      innerLeadingSlot: null,
      innerTrailingSlot: null,
      trailingSlot: null,
      showPreviousNext: false,
      secondaryRow,
      // The player's ⋯ still has every action for the climb on screen.
      hidden: {
        tick: true,
        favorite: true,
        share: hasShare,
        queue: true,
        playNext: true,
        mirror: supportsMirroring,
        angle: angleAvailable,
      },
    };
  }

  // Whether a button takes part on this board at all.
  const applies = (buttonId: PlayerButtonId): boolean => {
    if (buttonId === 'mirror') return supportsMirroring;
    if (buttonId === 'angle') return angleAvailable;
    return true;
  };
  const placed = visibleSectionIds(buttons, applies);
  // Preserve the first/last priority of the two-position bar. Without arrows,
  // the extra room goes to the final three actions instead of only the last.
  // The default Mirror, Angle, Favorite, Share, Queue order therefore uses
  // Angle when Mirror does not apply, keeping Favorite, Share and Queue up.
  const capacity = previousNext ? 2 : 4;
  const selected = placed.length <= capacity ? placed : [placed[0], ...placed.slice(-(capacity - 1))];
  let leadingSlot: ActionBarLeadingSlot = selected[0] ?? null;
  let innerLeadingSlot: ActionBarLeadingSlot = !previousNext && selected.length > 2 ? (selected[1] ?? null) : null;
  let innerTrailingSlot: ActionBarLeadingSlot = !previousNext && selected.length > 3 ? (selected[2] ?? null) : null;
  let trailingSlot: ActionBarTrailingSlot = selected.length > 1 ? (selected.at(-1) ?? null) : null;
  let primaryCenter: ActionBarPrimaryCenter = 'tick';
  const bulbMode = boardControl === 'lightbulb';
  // A wall to light: the bulb or the wall button has something to say.
  const controlShown = showLightbulb && hasWall;

  // The bulb takes the trailing position. Everything not already in the top
  // row may use its second row, split evenly around the preview's wall button.
  const bulbRow = bulbMode && controlShown;
  if (bulbRow) trailingSlot = 'lightbulb';
  const sideButtons = bulbRow
    ? placed.filter(
        (buttonId) => buttonId !== leadingSlot && buttonId !== innerLeadingSlot && buttonId !== innerTrailingSlot,
      )
    : [];
  const leftSide = sideButtons.slice(0, Math.ceil(sideButtons.length / 2));
  const rightSide = sideButtons.slice(leftSide.length);

  let secondaryRow: ActionBarSecondaryRow;
  if (commitButton === 'confirm') {
    secondaryRow = 'confirm';
  } else if (workoutOutcome && commitButton === null) {
    secondaryRow = 'workoutOutcome';
  } else if (bulbRow) {
    // Always there on a board with lights, so the board never jumps; a preview's
    // Put on the wall takes the gap between the two sides.
    secondaryRow = [...leftSide, commitButton === 'putOnWall' ? 'wallControl' : 'spacer', ...rightSide];
  } else if (commitButton === 'putOnWall') {
    // Put on the wall is one of the wall button's states, so a preview moves nothing.
    secondaryRow = ['wallControl'];
  } else if (hasWall && !bulbMode) {
    secondaryRow = ['wallControl'];
  } else {
    // No wall to light (no Bluetooth, a spray wall, a board without lights):
    // the row folds and the board gets its height. The board doesn't change
    // mid-swipe, so nothing jumps.
    secondaryRow = [];
  }

  if (!bulbMode && secondaryRow === 'workoutOutcome' && controlShown) {
    // Fell / Sent takes the second row: the wall button moves into the top row
    // between ⏮ and ⏭, and the climber's buttons and Log wait in ⋯ (#7000).
    // It never turns back into the bulb.
    primaryCenter = 'wallControl';
    leadingSlot = null;
    innerLeadingSlot = null;
    innerTrailingSlot = null;
    trailingSlot = null;
  } else if (bulbMode ? controlShown : secondaryRow === 'workoutOutcome' && showLightbulb) {
    // The bulb chosen; or Fell / Sent where the wall button has no wall to
    // light. The busy-wall question needs neither: Put mine up has the bulb.
    trailingSlot = 'lightbulb';
  }

  const inSecondRow = (buttonId: PlayerButtonId) => typeof secondaryRow !== 'string' && secondaryRow.includes(buttonId);
  const drawn = (buttonId: PlayerButtonId) =>
    leadingSlot === buttonId ||
    innerLeadingSlot === buttonId ||
    innerTrailingSlot === buttonId ||
    trailingSlot === buttonId ||
    inSecondRow(buttonId);
  return {
    primaryCenter,
    leadingSlot,
    innerLeadingSlot,
    innerTrailingSlot,
    trailingSlot,
    showPreviousNext: previousNext,
    secondaryRow,
    hidden: {
      tick: primaryCenter !== 'tick',
      favorite: !drawn('favorite'),
      share: hasShare && !drawn('share'),
      queue: !drawn('queue'),
      playNext: !drawn('playNext'),
      mirror: supportsMirroring && !drawn('mirror'),
      angle: angleAvailable && !drawn('angle'),
    },
  };
}
