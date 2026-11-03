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
//  * `heldArtState` and `heldMs` ride only on the rare swipe that went before
//    the next climb's board had painted (the dead-swipe fix, November 2026). Every other
//    step sends neither, so the event costs nothing more and an ordinary
//    step's properties are what they were.
//  * Only a climber's own deliberate step fires it. The rest timer's
//    auto-advance and the workout runner call the same `nextClimb`, but they are
//    not navigation and stay silent: counting them would read as presses.
//  * `track`, `from`, `upNextBucket` and `crossed` (the then-signposts, November
//    2026) say which walk the step took. Every step carries all four. A Previous
//    right after a `crossed` Next is a climber the crossing from Up next into
//    the list surprised; Up next is bucketed so no count identifies a queue.

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
 * without moving the wall: outside a drive a step only looks (the MiniPlayer
 * opens the player on the climb as a preview).
 */
export type QueueNavigationOutcome = 'moved' | 'preview';

/**
 * What the next climb's board was doing when a swipe went to it anyway.
 * `loading`: still painting 700 ms after its page was mounted. `failed`: it
 * never will, so the swipe went at once. `ready`: it had painted, but the
 * release still waited past 700 ms in all, most of it for the app to mount the
 * climb's page.
 */
export type QueueNavigationArtState = 'ready' | 'loading' | 'failed';

/** A swipe that went before its board had painted, or after waiting past the deadline. */
export type QueueNavigationArtWait = {
  artState: QueueNavigationArtState;
  /** From finger-up to the step, in milliseconds. A swipe repeated toward the same climb counts from the first. */
  waitedMs: number;
};

/**
 * Which walk the step landed on. `list`: the list named at the top. `upNext`:
 * Up next, played in the middle of that list. `queue`: no list steers the walk,
 * so it walks the queue.
 */
export type QueueNavigationTrack = 'list' | 'upNext' | 'queue';

/** Where the step was taken from: a preview, or the climber's own climb. */
export type QueueNavigationFrom = 'preview' | 'current';

/** The walk the step took, as the call site knows it. */
export type QueueNavigationWalk = {
  track: QueueNavigationTrack;
  from: QueueNavigationFrom;
  /**
   * Climbs Up next before the step: after the queue's Now, or from the History
   * line with nothing current (`upNextStart`), the count the queue sheet's
   * header shows.
   */
  upNextCount: number;
  /** The step left Up next for the list. */
  crossed: boolean;
};

/** How many climbs were Up next when the step was taken, in coarse buckets. */
export type QueueNavigationUpNextBucket = '0' | '1-3' | '4-10' | '11+';

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
  /** Always drive the wall (`alwaysDrive`) at the time of the step. */
  alwaysDrive: boolean;
  /**
   * The climber was driving the wall (#7113): a swipe on the wall button, Put
   * on board or Always drive the wall made every change of climb light it, in a
   * crew too. Defaults to false.
   */
  driving?: boolean;
  /** Set only on a swipe that went before its board had painted. Absent on every other step. */
  artWait?: QueueNavigationArtWait;
  /** Which walk the step took. */
  walk: QueueNavigationWalk;
};

export type QueueNavigationProps = BoardTypeProperty & {
  direction: QueueNavigationDirection;
  method: QueueNavigationMethod;
  surface: QueueNavigationSurface;
  outcome: QueueNavigationOutcome;
  /** www's name and values, kept so the two platforms read alike. */
  sessionMode: 'party' | 'solo';
  /** Always drive the wall was on. Replaced `lightOnSwipe` (Light the board as I swipe) in 2026-11. */
  alwaysDrive: boolean;
  /** Driving the wall (#7113): the step lit the wall whatever the session said. */
  driving: boolean;
  /** Null on a spray wall (its layout id names the wall) and with no board. */
  layoutId: number | null;
  track: QueueNavigationTrack;
  from: QueueNavigationFrom;
  upNextBucket: QueueNavigationUpNextBucket;
  crossed: boolean;
  /** Only on a swipe that went before its board had painted: what the board was doing. */
  heldArtState?: QueueNavigationArtState;
  /** Only with `heldArtState`: how long the release waited, in whole milliseconds. */
  heldMs?: number;
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
  /**
   * What the player (or the MiniPlayer, with the player closed) showed when the
   * sheet opened (Then-signposts, 2026-11-02): `preview` for a climb that isn't
   * the queue's current one (a list tap, a swipe that only looked, the
   * MiniPlayer's last pick), `current` for the climb up. Opens from a preview
   * while Up next has climbs are climbers looking for their queue.
   */
  from: QueueNavigationFrom;
  /** Climbs in Up next when the sheet opened: the count its header shows. Sent as {@link upNextBucket}. */
  upNextCount: number;
};

export type QueueSheetOpenedProps = BoardTypeProperty & {
  surface: QueueSheetSurface;
  from: QueueNavigationFrom;
  upNextBucket: QueueNavigationUpNextBucket;
};

/** A name paired with the exact properties that name expects. */
export type QueueNavigationPayload<TName extends string, TProperties> = {
  name: TName;
  properties: TProperties;
};

/** Up next in the buckets `upNextBucket` reports: none, a few, a session's worth, a long queue. */
export function upNextBucket(upNextCount: number): QueueNavigationUpNextBucket {
  if (!(upNextCount >= 1)) return '0';
  if (upNextCount <= 3) return '1-3';
  if (upNextCount <= 10) return '4-10';
  return '11+';
}

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
      alwaysDrive: input.alwaysDrive,
      driving: input.driving ?? false,
      ...boardTypeProperty(input.boardType),
      layoutId: layoutIdProperty(input),
      track: input.walk.track,
      from: input.walk.from,
      upNextBucket: upNextBucket(input.walk.upNextCount),
      crossed: input.walk.crossed,
      ...(input.artWait
        ? { heldArtState: input.artWait.artState, heldMs: Math.max(0, Math.round(input.artWait.waitedMs)) }
        : {}),
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
 * in it, or its setting was turned off. `always_off`: Always drive the wall's
 * drive ended because the switch went off, or a crew formed (or In a session
 * too went off in one) where it doesn't drive; the link stays.
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
  | 'window_ended'
  | 'always_off';

/**
 * What started the drive (#7113): the wall button's swipe, a press on Put on
 * board that keeps lighting (the keep-lighting window, or an open-ended drive
 * where the setting says Until I stop; a MoonBoard's default until 2026-11), the
 * screen-reader action or the board sheet's row, (2.7) a Lock Screen,
 * Dynamic Island or Android notification Next / Previous that opened the
 * window: natively on iOS, adopted once the app ran again, and in the app on
 * Android, armed at the press like Put on board, or (2026-11) Light
 * automatically: this phone's own link came up, the switch turned on, or a
 * Put on board resumed it after a stop. `solo_carry` (a solo climber driving
 * by Light the board as I swipe when a crew formed) went with that switch.
 */
export type DriveModeStartedBy = 'swipe' | 'tap' | 'action' | 'lock_screen' | 'always';

/**
 * Who had the board after a drive's link dropped on its own (board plan item
 * 8): `named`, a climber the app named ("Sam took the board"); `anonymous`,
 * another phone it couldn't name ("Another phone has the board"). Null: no
 * one took it, the board only disconnected.
 */
export type DriveModeTakenBy = 'named' | 'anonymous';

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
  /**
   * Set only on a `link_dropped` end the phone didn't cause (a radio drop, or
   * another climber taking the board): who had the board after it, or null
   * when no one took it. Left off a link this phone let go of (a hang-up or a
   * board switch mid-drive) and every other reason, so `takenBy` set splits
   * the drops a climber heard about from the ones they made.
   */
  takenBy?: DriveModeTakenBy | null;
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
  /** As the input's: present only on a `link_dropped` end the phone didn't cause. */
  takenBy?: DriveModeTakenBy | null;
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
      ...(input.takenBy !== undefined ? { takenBy: input.takenBy } : {}),
    },
  };
}

/** The climber asked for the queue sheet. */
export function queueSheetOpened(
  input: QueueSheetOpenedInput,
): QueueNavigationPayload<typeof SHARED_EVENTS.QueueSheetOpened, QueueSheetOpenedProps> {
  return {
    name: SHARED_EVENTS.QueueSheetOpened,
    properties: {
      surface: input.surface,
      ...boardTypeProperty(input.boardType),
      from: input.from,
      upNextBucket: upNextBucket(input.upNextCount),
    },
  };
}
