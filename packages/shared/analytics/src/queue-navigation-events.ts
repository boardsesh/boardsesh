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
};

export type QueueNavigationProps = BoardTypeProperty & {
  direction: QueueNavigationDirection;
  method: QueueNavigationMethod;
  surface: QueueNavigationSurface;
  outcome: QueueNavigationOutcome;
  /** www's name and values, kept so the two platforms read alike. */
  sessionMode: 'party' | 'solo';
  lightOnSwipe: boolean;
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
      ...boardTypeProperty(input.boardType),
      layoutId: layoutIdProperty(input),
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
