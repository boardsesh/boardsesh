// Queue navigation (#6940): Next and Previous, and opening the queue sheet.
//
// Why these exist: the MiniPlayer's default buttons (⏮ ⏭ beside the climb) were
// chosen without data. Mobile fired nothing when a climber stepped through the
// queue, so a button press could not be told from a swipe, Previous could not be
// counted at all, and nobody knew how often the queue sheet opened or from where.
//
// The contract, mirroring board-qr-events.ts:
//
//  * The names live in `SHARED_EVENTS` (events.ts). `Queue Navigation` is the
//    event www fired from its play drawer and queue bar until the climbing UI
//    moved to the app (W-16, #4435). Mobile reuses the name rather than minting
//    a second one, keeping www's `direction` and `sessionMode`. www's `method`
//    values (`playViewDrawer`, `swipeQueueBar`, ...) are not mobile's: filter on
//    `$lib` or on `surface`, which www never sent, to read one platform.
//  * The builder returns `{ name, properties }` TOGETHER, so a call site cannot
//    pair these props with another event's name.
//  * Every property is a closed union, a boolean, `boardType` (one of the nine
//    board types or null, via `boardTypeProperty`) or a layout id. A spray wall's
//    layout id is minted per wall, so it is sent as null on a spray wall: the
//    spray telemetry rule is that no event identifies a wall
//    (docs/spray-walls.md, "Telemetry").
//  * Only a climber's own deliberate step fires it. The rest timer's
//    auto-advance and the workout runner call the same `nextClimb`, but they are
//    not navigation and stay silent: counting them would read as presses.

import { boardTypeProperty, type BoardTypeProperty } from './board-type-property';
import { SHARED_EVENTS } from './events';

export type QueueNavigationDirection = 'next' | 'previous';

/**
 * How the step was asked for. `button` is a ⏮ or ⏭ tap. `swipe` is a swipe on
 * the player's board, and also the board's VoiceOver / TalkBack adjust action,
 * which stands in for the swipe for a screen-reader user.
 */
export type QueueNavigationMethod = 'button' | 'swipe';

/** Where the step was taken: the open player, or the MiniPlayer bar with it closed. */
export type QueueNavigationSurface = 'player' | 'mini_player';

/**
 * What the step did. `moved` put the next climb on the wall. `preview` showed it
 * without moving the wall: in a crew, or with Light on swipe off, a step only
 * looks (the MiniPlayer opens the player on the climb as a preview).
 */
export type QueueNavigationOutcome = 'moved' | 'preview';

/** The board the step happened on, as the call site knows it. */
export type QueueNavigationBoard = {
  /** The board's type (`kilter`, `spray`, ...). Anything outside the nine is sent as null. */
  boardType: string | null | undefined;
  layoutId: number | null | undefined;
};

export type QueueNavigationInput = QueueNavigationBoard & {
  direction: QueueNavigationDirection;
  method: QueueNavigationMethod;
  surface: QueueNavigationSurface;
  outcome: QueueNavigationOutcome;
  /** Someone else is in the session with this climber. */
  inSharedSession: boolean;
  /** The Light on swipe setting at the time of the step. */
  lightOnSwipe: boolean;
  /**
   * The climber was driving the wall (#7113): a swipe on the wall button made
   * every change of climb light it, in a crew too. Defaults to false.
   */
  driving?: boolean;
};

export type QueueNavigationProps = BoardTypeProperty & {
  direction: QueueNavigationDirection;
  method: QueueNavigationMethod;
  surface: QueueNavigationSurface;
  outcome: QueueNavigationOutcome;
  /** www's name and values, kept so the two platforms read alike. */
  sessionMode: 'party' | 'solo';
  lightOnSwipe: boolean;
  /** Driving the wall (#7113): the step lit the wall whatever the session or the setting said. */
  driving: boolean;
  /** Null on a spray wall (its layout id names the wall) and with no board. */
  layoutId: number | null;
};

/**
 * Where the queue sheet was opened from. `player` is the queue button on the
 * player's action bar, `player_menu` the player's ⋯ menu, `mini_player` the
 * MiniPlayer's queue button, `mini_player_menu` the MiniPlayer's ⋯ menu on a
 * wide bar, `snackbar` the "Open" on the added-to-queue snackbar.
 */
export type QueueSheetSurface = 'player' | 'player_menu' | 'mini_player' | 'mini_player_menu' | 'snackbar';

export type QueueSheetOpenedInput = {
  surface: QueueSheetSurface;
  boardType: string | null | undefined;
};

export type QueueSheetOpenedProps = BoardTypeProperty & { surface: QueueSheetSurface };

/** A name paired with the exact properties that name expects. */
export type QueueNavigationPayload<TName extends string, TProperties> = {
  name: TName;
  properties: TProperties;
};

function layoutIdProperty({ boardType, layoutId }: QueueNavigationBoard): number | null {
  if (boardType === 'spray') return null;
  return typeof layoutId === 'number' ? layoutId : null;
}

/** One deliberate Next or Previous by the climber. */
export function queueNavigation(
  input: QueueNavigationInput,
): QueueNavigationPayload<typeof SHARED_EVENTS.QueueNavigation, QueueNavigationProps> {
  return {
    name: SHARED_EVENTS.QueueNavigation,
    properties: {
      direction: input.direction,
      method: input.method,
      surface: input.surface,
      outcome: input.outcome,
      sessionMode: input.inSharedSession ? 'party' : 'solo',
      lightOnSwipe: input.lightOnSwipe,
      driving: input.driving ?? false,
      ...boardTypeProperty(input.boardType),
      layoutId: layoutIdProperty(input),
    },
  };
}

/**
 * Why driving the wall ended (#7113). `stopped`: a press on the frosted wall
 * button, or on the keep-lighting window's (the link stays). `link_dropped`: this
 * phone's link went. `connect_failed`, `commit_failed` and `arming_timed_out`: the
 * swipe (or Put on board) never reached the wall. `session_changed`,
 * `board_changed`, `signed_out`: the drive's session, board or account went away.
 * `window_ended`: Put on board's keep-lighting window ran out with no climb lit
 * in it, or its setting was turned off.
 */
export type DriveModeEndReason =
  | 'stopped'
  | 'link_dropped'
  | 'connect_failed'
  | 'commit_failed'
  | 'arming_timed_out'
  | 'session_changed'
  | 'board_changed'
  | 'signed_out'
  | 'window_ended';

/**
 * What started the drive (#7113): the wall button's swipe, a press on Put on
 * board that keeps lighting (the keep-lighting window, or an open-ended drive
 * where the setting says Until I stop, the MoonBoard default), the
 * screen-reader action or the board sheet's row, or a solo climber driving by
 * Light the board as I swipe when a crew formed.
 */
export type DriveModeStartedBy = 'swipe' | 'tap' | 'action' | 'solo_carry';

export type DriveModeStartedInput = {
  startedBy: DriveModeStartedBy;
  /** The drive started in a party session. */
  inSession: boolean;
  /**
   * The board type driven ('kilter', 'moonboard', ...), or null when unknown,
   * so the MoonBoard keep-lighting field test reads its own drives.
   */
  boardType: string | null;
};

export type DriveModeStartedProps = {
  startedBy: DriveModeStartedBy;
  inSession: boolean;
  boardType: string | null;
};

/** A drive started (2.7): what started it, whether in a party session, and on which board type. */
export function driveModeStarted(
  input: DriveModeStartedInput,
): QueueNavigationPayload<typeof SHARED_EVENTS.DriveModeStarted, DriveModeStartedProps> {
  return {
    name: SHARED_EVENTS.DriveModeStarted,
    properties: { startedBy: input.startedBy, inSession: input.inSession, boardType: input.boardType },
  };
}

export type DriveModeEndedInput = {
  reason: DriveModeEndReason;
  startedBy: DriveModeStartedBy;
  /** `Date.now()` when the swipe landed. */
  startedAt: number;
  /** `Date.now()` when it ended. */
  endedAt: number;
  /** Climbs lit on this phone's link while driving, the swipe's own included. */
  climbsLit: number;
  /** The drive started in a party session. */
  inSession: boolean;
  /**
   * How many lit climbs renewed Put on board's keep-lighting window (the climb
   * that opened it not counted). 0 for a drive with no window.
   */
  windowRenewals: number;
  /** Put on board's keep-lighting window length, in milliseconds; null for an open-ended drive. */
  windowMs: number | null;
  /** The board type driven, as Drive Mode Started. */
  boardType: string | null;
};

export type DriveModeEndedProps = {
  reason: DriveModeEndReason;
  startedBy: DriveModeStartedBy;
  /** Whole seconds, never negative. */
  durationSec: number;
  climbsLit: number;
  inSession: boolean;
  windowRenewals: number;
  /** The keep-lighting window's length in whole seconds (30, 45, 60); null for an open-ended drive. */
  windowSec: number | null;
  boardType: string | null;
};

/** A drive ended (#7113): how long it lasted and how many climbs it lit. */
export function driveModeEnded(
  input: DriveModeEndedInput,
): QueueNavigationPayload<typeof SHARED_EVENTS.DriveModeEnded, DriveModeEndedProps> {
  return {
    name: SHARED_EVENTS.DriveModeEnded,
    properties: {
      reason: input.reason,
      startedBy: input.startedBy,
      durationSec: Math.max(0, Math.round((input.endedAt - input.startedAt) / 1000)),
      climbsLit: Math.max(0, input.climbsLit),
      inSession: input.inSession,
      windowRenewals: Math.max(0, input.windowRenewals),
      windowSec: input.windowMs === null ? null : Math.max(0, Math.round(input.windowMs / 1000)),
      boardType: input.boardType,
    },
  };
}

/** The climber asked for the queue sheet. */
export function queueSheetOpened(
  input: QueueSheetOpenedInput,
): QueueNavigationPayload<typeof SHARED_EVENTS.QueueSheetOpened, QueueSheetOpenedProps> {
  return {
    name: SHARED_EVENTS.QueueSheetOpened,
    properties: { surface: input.surface, ...boardTypeProperty(input.boardType) },
  };
}
