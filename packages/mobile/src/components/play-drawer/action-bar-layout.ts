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
  trailingSlot: ActionBarTrailingSlot;
  /** ⏮ and ⏭. Off leaves both slots empty, so Log stays in the middle. */
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
  mirror: false,
  angle: false,
});

/**
 * Where each action-bar button sits, for one bar state (#7000).
 *
 * ```
 * Mirror board (Tension, Decoy, Woods)   [⇄]  [⏮]  [✓]  [⏭]  [☰]      (♡ in ⋯)
 *                                        [ 💡    You are driving the wall   (S) ]
 * Other boards (Kilter, MoonBoard)       [♡]  [⏮]  [✓]  [⏭]  [☰]
 *                                        [ 💡        Put on board             ]
 * Fell / Sent                            [⏮]  [ 💡  Disconnect board ]  [⏭]    (♡ ✓ ☰ in ⋯)
 *                                        [ Fell              Sent             ]
 * The busy-wall question                 [♡]  [⏮]  [✓]  [⏭]  [☰]
 *                                        [ (T) Keep Test2's ] [ 💡 Put mine up ]
 * Anonymous                              [⇄ or  ]  [⏮]  [✓]  [⏭]  [ ]
 *                                        [40°] ···················· [⬆]
 * ```
 *
 * Those are the defaults (Mirror, Favourite, Queue on; Share and Angle off).
 * The climber's buttons (View options) move things inside the same frame:
 *
 * - The buttons that are on and apply here, in the climber's order, fill the
 *   first row's two ends: the first takes the leading slot, the last the
 *   trailing one, and any between them live in ⋯. One alone takes the leading
 *   slot. Mirror applies only on a board that mirrors, Angle only on a board
 *   whose angle can change, Favourite and Queue only for a member. Share
 *   applies everywhere and leaves its slot empty on a draft, so nothing jumps
 *   between climbs.
 * - The second row is the wall button alone, full width, in every wall state
 *   (`WallControlButton`), so nothing moves between states. With no wall to
 *   light (no Bluetooth, a spray wall, a board without lights) it folds away,
 *   except for a preview's Set active.
 * - Log, ⏮ ⏭ and the wall button never move. Previous and next off leaves both
 *   slots empty, so Log stays centred.
 * - A timed block's Fell / Sent takes the whole second row, and the board
 *   control keeps the climber's chosen look: with the wall button, the top row
 *   becomes `⏮ [wall button] ⏭` and ♡ / ⇄, ✓ and ☰ wait in ⋯ (Fell / Sent log
 *   each go); with the bulb, it stays in the trailing slot.
 * - The busy-wall question (#7017) is the wall button's row as two segments,
 *   Keep theirs and Put mine up, and the first row stays as it was. Put mine up
 *   carries the bulb, so the bulb doesn't come back. Beside a MiniPlayer the
 *   pair takes the full-width wall button's place in the first row.
 *
 * With the bulb chosen (View options › Buttons › Board control):
 *
 * ```
 * Mirror board                           [⇄]  [⏮]  [✓]  [⏭]  [💡]      (♡ ☰ in ⋯)
 * A preview, the busy wall, Fell / Sent  the same row, over the second row
 *                                        (the busy wall's is the same pair)
 * ```
 *
 * The bulb takes the trailing slot whenever there is a wall to light. The
 * second row stays on boards with lights, as the bar before #7000 did, so the
 * board never jumps mid-swipe: the climber's other buttons on, small, on its
 * two sides (the first half left, the rest right), and Put on the wall in the
 * gap for a preview, which pushes nothing into ⋯. Fell / Sent and the busy-wall
 * question still take the whole row. It folds only where there is no wall to
 * light, as with the wall button.
 *
 * - Every button that applies here and is not drawn is flagged in `hidden`, and
 *   ⋯ carries a row for it.
 * - An anonymous reader gets the read-only bar whatever is stored on the
 *   device: no account to favourite with, no queue that means anything, no wall
 *   to light, and no ⋯ to bring a hidden button back, so Angle and Share stay
 *   in the row and nothing is flagged.
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
      trailingSlot: null,
      showPreviousNext: false,
      secondaryRow,
      // The player's ⋯ still has every action for the climb on screen.
      hidden: {
        tick: true,
        favorite: true,
        share: hasShare,
        queue: true,
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
  let leadingSlot: ActionBarLeadingSlot = placed[0] ?? null;
  let trailingSlot: ActionBarTrailingSlot = placed.length > 1 ? (placed.at(-1) ?? null) : null;
  let primaryCenter: ActionBarPrimaryCenter = 'tick';
  const bulbMode = boardControl === 'lightbulb';
  // A wall to light: the bulb or the wall button has something to say.
  const controlShown = showLightbulb && hasWall;

  // The bulb's row: the buttons the leading slot leaves, half each side.
  const bulbRow = bulbMode && controlShown;
  const sideButtons = bulbRow ? placed.slice(1) : [];
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
    trailingSlot = null;
  } else if (bulbMode ? controlShown : secondaryRow === 'workoutOutcome' && showLightbulb) {
    // The bulb chosen; or Fell / Sent where the wall button has no wall to
    // light. The busy-wall question needs neither: Put mine up has the bulb.
    trailingSlot = 'lightbulb';
  }

  const inSecondRow = (buttonId: PlayerButtonId) => typeof secondaryRow !== 'string' && secondaryRow.includes(buttonId);
  const drawn = (buttonId: PlayerButtonId) =>
    leadingSlot === buttonId || trailingSlot === buttonId || inSecondRow(buttonId);
  return {
    primaryCenter,
    leadingSlot,
    trailingSlot,
    showPreviousNext: previousNext,
    secondaryRow,
    hidden: {
      tick: primaryCenter !== 'tick',
      favorite: !drawn('favorite'),
      share: hasShare && !drawn('share'),
      queue: !drawn('queue'),
      mirror: supportsMirroring && !drawn('mirror'),
      angle: angleAvailable && !drawn('angle'),
    },
  };
}
