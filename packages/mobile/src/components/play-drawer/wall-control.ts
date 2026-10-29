/**
 * The player's board control (#7000): what it says about the climb on screen,
 * whose board it is, and what a tap or a hold on it does. One model
 * (`resolveWallControl`) for every view of it: the full-width wall button, the
 * narrower one in a workout's top row, the first row's bulb, and the open
 * iPhone Duo's MiniPlayer bulb. The views draw the model and nothing else, and
 * one handler (`use-wall-control.ts`) runs its tap and hold.
 *
 * Pure like `wall-state.ts`, so every state and every tap is table-tested
 * rather than rendered through PlayCore.
 */

import type { ActionBarLayout } from './action-bar-layout';
import type { PlayDrawerLightbulbPressAction } from './lightbulb-control';

/**
 * The purple wash behind Connect board and Put on the wall: 20% of the brand
 * fill, up from the 14% that read as disabled. About the most the brand-violet
 * label keeps 4.5:1 on: 4.6:1 at worst on every Liquid Glass and Material
 * sheet, light and dark (`wall-control-button-contrast` test).
 */
export const WALL_CONTROL_TONAL_ALPHA = 0.2;

/**
 * - `connect` — no board linked: a tap connects (and lights the climb).
 * - `on_wall_unlinked` — no live link, but board presence says the climb on
 *   screen is the wall's, lit under an hour ago (QA #147): Aurora and MoonBoard
 *   boxes keep their LEDs after a disconnect, so "Put on the wall" would be
 *   wrong. A tap still connects and lights it again, in case it went dark.
 * - `put_on_wall` — a preview or crew browse: a tap puts the climb up.
 * - `lit` — this phone holds the link and the climb on screen is lit.
 * - `dark` — this phone holds the link and the climb on screen isn't lit (the
 *   lights were turned off, the #4979 hold kept it dark, or another climb is up).
 * - `crew` — a crewmate's phone holds the board.
 * - `take_wall` / `release_wall` — a wall with no lights (`ledless`).
 * - `move_to_board` — the climb on screen is on another board at this gym: a
 *   tap moves there (a crew session too), connects, and lights it. Linked to
 *   this board or not, solo or in a crew.
 * - `null` — nothing to offer: no board selected, no climb, or a climb this
 *   wall can't light (see `offWall`).
 */
export type WallControlState =
  | 'connect'
  | 'on_wall_unlinked'
  | 'put_on_wall'
  | 'lit'
  | 'dark'
  | 'crew'
  | 'take_wall'
  | 'release_wall'
  | 'move_to_board'
  | null;

export type WallControlStateInput = {
  /** The browse latch's control (`resolveCommitButton`). */
  commitButton: 'putOnWall' | 'confirm' | null;
  /** What a bare bulb tap would do (`useLightbulbControl().pressAction`). */
  pressAction: PlayDrawerLightbulbPressAction;
  /** A session peer authoritatively holds the board. */
  holderIsAuthoritative: boolean;
  /** This phone holds the Bluetooth link. */
  localConnected: boolean;
  /** A connect or disconnect is in flight. */
  pending: boolean;
  /** The climb on screen is lit on the wall (`resolveWallLit` says `lit`). */
  displayedLit: boolean;
  /**
   * The connected wall can't light the climb on screen: the switch-board
   * overlay is up, the climb belongs to another board, or the board has no
   * lights. A tap would only re-send the queue head, so there is no control.
   */
  offWall: boolean;
  /** Board presence names the climb on screen as the wall's climb. */
  displayedIsWallClimb?: boolean;
  /** Presence's wall climb was lit under an hour ago (`isPresenceFresh`). */
  presenceFresh?: boolean;
  /**
   * The climb on screen is on another board at this gym (#7076): that board's
   * name, as the button says it. `offWall` is still true for it, because the
   * connected wall can't light it, but there is somewhere to go.
   */
  gymBoardName?: string | null;
};

/** First match wins. */
export function resolveWallControlState({
  commitButton,
  pressAction,
  holderIsAuthoritative,
  localConnected,
  pending,
  displayedLit,
  offWall,
  displayedIsWallClimb = false,
  presenceFresh = false,
  gymBoardName = null,
}: WallControlStateInput): WallControlState {
  // No live link, on the climb presence says is on the wall (QA #147): trust
  // presence for an hour, then ask to connect. Never "Put on the wall": the
  // climb is the wall's, so that would claim it isn't up.
  const ledlessWall = pressAction === 'takeWall' || pressAction === 'releaseWall';
  if (!localConnected && !holderIsAuthoritative && displayedIsWallClimb && !offWall && !ledlessWall) {
    if (presenceFresh) return 'on_wall_unlinked';
    if (pressAction === 'connect' || pending) return 'connect';
  }
  // Another board at this gym draws the climb on screen. Put on the wall would
  // light it on a wall that can't draw it, so this wins over a preview's commit.
  if (gymBoardName) return 'move_to_board';
  if (commitButton === 'putOnWall') return 'put_on_wall';
  if (pressAction === 'takeWall') return 'take_wall';
  if (pressAction === 'releaseWall') return 'release_wall';
  if (offWall) return null;
  if (localConnected) return displayedLit ? 'lit' : 'dark';
  if (holderIsAuthoritative) return 'crew';
  // A connect in flight keeps the state, so the control doesn't flicker away
  // while the board is found.
  if (pressAction === 'connect' || pending) return 'connect';
  return null;
}

/**
 * Whose board it is, for the face at the wall button's trailing edge: this
 * phone's (a Bluetooth link, or a wall with no lights it holds), a crewmate's,
 * or nobody's.
 */
export type WallHolder = 'self' | 'crew' | null;

export function resolveWallHolder({
  localConnected,
  wallHeldLocally,
  holderIsAuthoritative,
}: {
  localConnected: boolean;
  wallHeldLocally: boolean;
  holderIsAuthoritative: boolean;
}): WallHolder {
  if (localConnected || wallHeldLocally) return 'self';
  return holderIsAuthoritative ? 'crew' : null;
}

/**
 * What a tap does, for the handler and for Wall Control Tapped.
 *
 * - `disconnect` — on You have the board: this phone lets go of the board,
 *   the board sheet's Disconnect. A hold opens that sheet instead (the
 *   handler's job, not this table's).
 * - `connect` — connect, then the connect lights the climb.
 * - `put_on_wall` — make the preview current (connecting first if needed).
 * - `relight` — re-send the current climb to a connected board.
 * - `relay`, `take_wall`, `release_wall` — as the bulb always has.
 * - `move_to_board` — move to the gym board that draws the climb, connect
 *   there, and light it (a preview is put up first).
 * - `noop` — nothing to do (a connect already in flight, say).
 */
export type WallControlAction =
  | 'disconnect'
  | 'connect'
  | 'put_on_wall'
  | 'relight'
  | 'relay'
  | 'take_wall'
  | 'release_wall'
  | 'move_to_board'
  | 'noop';

export type WallControlActionInput = {
  state: WallControlState;
  pressAction: PlayDrawerLightbulbPressAction;
  /**
   * The busy-wall question is up. Its Put mine up is the only way to take the
   * wall from here, so a tap waits instead of answering it.
   */
  confirmArmed: boolean;
  /** The climb on screen is the climber's own current climb, not a preview. */
  displayedIsOwnCurrent?: boolean;
};

/**
 * A tap lights the climb on screen, relays it, or on You have the board (this
 * phone holds the link and the climb is lit) lets go of the board.
 */
export function resolveWallControlAction({
  state,
  pressAction,
  confirmArmed,
  displayedIsOwnCurrent = false,
}: WallControlActionInput): WallControlAction {
  if (confirmArmed) return 'noop';
  switch (state) {
    // On the wall per presence, no link: connect and light it again, in case
    // it went dark (Marco). The climber's own climb is re-lit; a preview is put
    // up.
    case 'on_wall_unlinked':
      return displayedIsOwnCurrent ? 'relight' : 'put_on_wall';
    case 'lit':
      return 'disconnect';
    case 'dark':
      return 'relight';
    case 'put_on_wall':
      return 'put_on_wall';
    case 'connect':
      return pressAction === 'connect' ? 'connect' : 'noop';
    case 'crew':
      return pressAction === 'relay' ? 'relay' : 'noop';
    case 'take_wall':
      return 'take_wall';
    case 'release_wall':
      return 'release_wall';
    case 'move_to_board':
      return 'move_to_board';
    case null:
      return 'noop';
  }
}

/**
 * The bulb's look: grey outline with no board, filled amber only while this
 * phone holds the board, in any state (Marco's QA: "Put on the wall" on a
 * preview with the link up, and "You have the board", fill too). Amber outline
 * when the board is on the wall but not this phone's: no link, or a crewmate's
 * board, lit or dark (#7015); their face says whose.
 */
export type WallBulbLook = 'off' | 'ready' | 'lit';

export function resolveWallBulbLook(state: WallControlState, selfHolds: boolean, displayedLit = true): WallBulbLook {
  if (state === 'lit' || state === 'release_wall' || selfHolds) return 'lit';
  // A crewmate's board: an outline (their face says whose); filled means yours.
  if (state === 'crew') return 'ready';
  // On the wall but not this phone's: an outline, never the filled "you have it".
  if (state === 'on_wall_unlinked') return 'ready';
  return 'off';
}

/** Wall Control Shown fires only for the states that ask the climber to act. */
export function isActionableWallControlState(state: WallControlState): state is 'connect' | 'put_on_wall' {
  return state === 'connect' || state === 'put_on_wall';
}

/**
 * Whether the control that asks (Wall Control Shown) is on screen: the wall
 * button in the second row, or for a connect the bulb back in the first row.
 */
export function isWallControlDrawn(
  layout: Pick<ActionBarLayout, 'secondaryRow' | 'trailingSlot' | 'primaryCenter'>,
  state: WallControlState,
): boolean {
  const row = typeof layout.secondaryRow === 'string' ? [] : layout.secondaryRow;
  if (
    row.includes('wallControl') ||
    layout.primaryCenter === 'wallControl' ||
    layout.primaryCenter === 'wallControlFull'
  )
    return true;
  // The bulb: the player's, or with no first row the MiniPlayer's standing in for it.
  return state === 'connect' && (layout.trailingSlot === 'lightbulb' || layout.primaryCenter === 'none');
}

/**
 * Board presence names this climber's own account as the holder: another
 * device's link, or this phone's own hold from before a relaunch. Keyed on
 * presence's NAMED holder only, never on whoever lit the climb, and never on
 * an unknown viewer (#7017 review).
 */
export function isHolderSelfAccount(holderUserId: string | null, viewerUserId: string | null): boolean {
  return holderUserId !== null && viewerUserId !== null && holderUserId === viewerUserId;
}

/** A face at the control's trailing edge. */
export type WallControlFace = { name: string | null; avatarUrl: string | null };

/** What the control says, as an id the text layer (`wall-control-text.ts`) turns into words. */
export type WallControlLabelKey =
  | 'connect'
  | 'onWall'
  | 'putOnWall'
  | 'setActive'
  | 'putOnBoard'
  | 'putOnCrewBoard'
  | 'youHaveBoard'
  | 'onBoard'
  | 'onCrewBoard'
  | 'onOtherPhone'
  | 'takeWall'
  | 'releaseWall'
  | 'putOnGymBoard';

/** What a screen reader hears first: the label, or for You have the board the longer "…, lit on the wall". */
export type WallControlA11yLabelKey = WallControlLabelKey | 'youHaveBoardLit';

/** Who has the board, spoken after the label (the face itself is hidden). */
export type WallControlA11yHolderKey = 'youHaveBoard' | 'holderHasBoard' | 'crewHasBoard';

/** What a tap does, spoken as the hint. */
export type WallControlA11yHintKey =
  | 'connectHint'
  | 'lightHint'
  | 'lightAgainHint'
  | 'litHint'
  | 'relayHint'
  | 'relayHintCrew'
  | 'relayHintOtherPhone'
  | 'moveToGymBoardHint';

/** The bulb's value, after its "Board lights" label. */
export type WallControlBulbValueKey =
  | 'youHaveBoardLit'
  | 'onWall'
  | 'onBoard'
  | 'onCrewBoard'
  | 'onOtherPhone'
  | 'valueOtherClimb'
  | 'valueOff';

export type WallControlInput = WallControlStateInput & {
  /** This phone holds a wall with no lights (`useLightbulbControl().wallHeldLocally`). */
  wallHeldLocally: boolean;
  /**
   * Board presence names this climber's own account as the holder: a stale
   * record of this phone, or another device. Never a face: only a live link is.
   */
  holderIsSelfAccount: boolean;
  /** This climber, for the face when this phone holds the board. */
  selfFace: WallControlFace | null;
  /** The crewmate presence names as the holder. Drawn only while their link is authoritative. */
  crewFace: WallControlFace | null;
  /** The busy-wall question is up: a tap waits for its answer. */
  confirmArmed: boolean;
  /** Put on the wall, or Set active where no wall is reachable. */
  commitLabel: 'putOnWall' | 'setActive';
  /** The climb on screen is the climber's own current climb, not a preview. */
  displayedIsOwnCurrent?: boolean;
  /** This phone is linked and a different climb is up, for the bulb's value. */
  otherClimbLit: boolean;
  /** A climb is on its way to the LEDs. */
  writing: boolean;
  /** Auto-disconnect is in its last ten seconds. */
  autoDisconnectWarning: boolean;
  /**
   * A swipe or Next from this screen commits to the wall: solo with lighting
   * on swipes, and not a browse (`swipeStaysViewOnly` false). In a crew swipes
   * open previews (#4281), so this is false there.
   */
  navigationCommits: boolean;
};

/**
 * Everything a view of the board control draws, and what the handler runs.
 *
 * - `holder` is set only while a live link exists: this phone's own, or a
 *   crewmate's authoritative one. Presence alone (a record left behind after a
 *   disconnect, or this account on another device) never puts a face up.
 * - `longPress` is the board sheet, whenever this phone holds the link.
 */
export type WallControlModel = {
  state: WallControlState;
  holder: WallHolder;
  holderName: string | null;
  holderFace: WallControlFace | null;
  /** The gym board a tap moves to, for `move_to_board`. */
  gymBoardName: string | null;
  tapAction: WallControlAction;
  longPress: 'sheet' | null;
  labelKey: WallControlLabelKey | null;
  a11yLabelKey: WallControlA11yLabelKey | null;
  a11yHolderKey: WallControlA11yHolderKey | null;
  a11yHintKey: WallControlA11yHintKey | null;
  bulbValueKey: WallControlBulbValueKey;
  /** The bulb's look; the wall button reads `lit` as its amber fill. */
  look: WallBulbLook;
  /** The control reads as selected: You have the board. */
  selected: boolean;
  /**
   * This climber is driving the board: the climb on screen is lit on this
   * phone's link (or this phone holds a wall with no lights), and a swipe from
   * here changes what the wall shows. Only then
   * does the wall button take its coloured lit look (the frost, or the amber
   * fill) (#7017, Marco). In a crew the holder's lit button keeps its label,
   * filled bulb and face on the plain tonal look.
   */
  driving: boolean;
  /** A connect or disconnect in flight: a spinner, and taps wait. */
  pending: boolean;
  writing: boolean;
  autoDisconnectWarning: boolean;
};

function labelKeyOf(
  state: WallControlState,
  holder: WallHolder,
  holderName: string | null,
  commitLabel: 'putOnWall' | 'setActive',
  holderIsSelfAccount: boolean,
): WallControlLabelKey | null {
  switch (state) {
    case 'connect':
      return 'connect';
    case 'on_wall_unlinked':
      return 'onWall';
    case 'put_on_wall':
      if (holder === 'crew') return holderName ? 'putOnBoard' : 'putOnCrewBoard';
      return commitLabel === 'putOnWall' ? 'putOnWall' : 'setActive';
    case 'dark':
      return 'putOnWall';
    case 'lit':
      return 'youHaveBoard';
    case 'crew':
      if (holderIsSelfAccount) return 'onOtherPhone';
      return holderName ? 'onBoard' : 'onCrewBoard';
    case 'take_wall':
      return 'takeWall';
    case 'release_wall':
      return 'releaseWall';
    case 'move_to_board':
      return 'putOnGymBoard';
    case null:
      return null;
  }
}

function hintKeyOf(
  action: WallControlAction,
  holderName: string | null,
  holderIsSelfAccount: boolean,
): WallControlA11yHintKey | null {
  switch (action) {
    case 'disconnect':
      return 'litHint';
    case 'connect':
      return 'connectHint';
    case 'put_on_wall':
    case 'relight':
      return 'lightHint';
    case 'relay':
      if (holderIsSelfAccount) return 'relayHintOtherPhone';
      return holderName ? 'relayHint' : 'relayHintCrew';
    case 'move_to_board':
      return 'moveToGymBoardHint';
    default:
      return null;
  }
}

/** The one rule for every view of the board control. */
export function resolveWallControl(input: WallControlInput): WallControlModel {
  const state = resolveWallControlState(input);
  const selfHolds = input.localConnected || input.wallHeldLocally;
  const crewHolds = !selfHolds && input.holderIsAuthoritative && !input.holderIsSelfAccount;
  const holder: WallHolder = selfHolds ? 'self' : crewHolds ? 'crew' : null;
  const holderFace = holder === 'self' ? input.selfFace : holder === 'crew' ? input.crewFace : null;
  // Only a crewmate is named; this climber's own name is "You".
  const holderName = holder === 'crew' ? (input.crewFace?.name ?? null) : null;
  const tapAction = resolveWallControlAction({
    state,
    pressAction: input.pressAction,
    confirmArmed: input.confirmArmed,
    displayedIsOwnCurrent: input.displayedIsOwnCurrent,
  });
  // Presence names this climber's own account holding the board through
  // another device's link: "On your other phone", never their own name.
  const onOtherPhone = state === 'crew' && input.holderIsSelfAccount;
  const labelKey = labelKeyOf(state, holder, holderName, input.commitLabel, onOtherPhone);
  let a11yHolderKey: WallControlA11yHolderKey | null = null;
  if (holder === 'self') a11yHolderKey = 'youHaveBoard';
  else if (holder === 'crew') a11yHolderKey = holderName ? 'holderHasBoard' : 'crewHasBoard';
  let bulbValueKey: WallControlBulbValueKey = 'valueOff';
  if (state === 'lit') bulbValueKey = 'youHaveBoardLit';
  else if (state === 'on_wall_unlinked') bulbValueKey = 'onWall';
  else if (onOtherPhone) bulbValueKey = 'onOtherPhone';
  else if (state === 'crew') bulbValueKey = holderName ? 'onBoard' : 'onCrewBoard';
  else if (input.localConnected && input.otherClimbLit) bulbValueKey = 'valueOtherClimb';
  return {
    state,
    holder,
    holderName,
    holderFace,
    gymBoardName: state === 'move_to_board' ? (input.gymBoardName ?? null) : null,
    tapAction,
    longPress: input.localConnected ? 'sheet' : null,
    labelKey,
    // You have the board already says whose it is, so it says the climb is lit instead.
    a11yLabelKey: state === 'lit' ? 'youHaveBoardLit' : labelKey,
    a11yHolderKey: state === 'lit' ? null : a11yHolderKey,
    a11yHintKey:
      state === 'on_wall_unlinked' && tapAction !== 'noop'
        ? 'lightAgainHint'
        : hintKeyOf(tapAction, holderName, onOtherPhone),
    bulbValueKey,
    look: resolveWallBulbLook(state, selfHolds, input.displayedLit),
    selected: state === 'lit',
    // Driving: lit on this phone's link (or its hold on a wall with no
    // lights), and the next swipe moves the wall.
    driving: (state === 'lit' || state === 'release_wall') && holder === 'self' && input.navigationCommits,
    pending: input.pending,
    writing: input.writing,
    autoDisconnectWarning: input.autoDisconnectWarning,
  };
}

/** Nothing to offer: no board, no Bluetooth, or a reader with no wall. The views keep their room. */
export const EMPTY_WALL_CONTROL: WallControlModel = Object.freeze({
  state: null,
  holder: null,
  holderName: null,
  holderFace: null,
  gymBoardName: null,
  tapAction: 'noop',
  longPress: null,
  labelKey: null,
  a11yLabelKey: null,
  a11yHolderKey: null,
  a11yHintKey: null,
  bulbValueKey: 'valueOff',
  look: 'off',
  selected: false,
  driving: false,
  pending: false,
  writing: false,
  autoDisconnectWarning: false,
});
