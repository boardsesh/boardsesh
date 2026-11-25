import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';

/** What the climber chose to add: the builder, the add-a-wall wizard, or the gym finder. */
export type BoardPickerAddKind = 'board' | 'spraywall' | 'gym_map';

/**
 * Where the choice was made: the + in the picker's top bar, the + on Manage
 * boards, the buttons under "No boards yet", "Where do you climb?", or a gym
 * page's "Set up a board".
 */
export type BoardPickerAddSurface = 'picker' | 'manage' | 'empty_state' | 'first_run' | 'gym_page';

/**
 * Whether the board being set up is the climber's own or one at a gym (#8151).
 * A route and analytics value only: no board row records it.
 */
export type BoardKind = 'home' | 'gym';

export type BoardPickerAddSelectedEvent = {
  kind: BoardPickerAddKind;
  surface: BoardPickerAddSurface;
  /** Which of the gym-first menu's board rows, or the kind the entry already implies. */
  boardKind?: BoardKind;
};

/** `Board Picker Add Selected`: one way to add a board picked. See SHARED_EVENTS. */
export function trackBoardPickerAddSelected({ kind, surface, boardKind }: BoardPickerAddSelectedEvent): void {
  track(SHARED_EVENTS.BoardPickerAddSelected, boardKind ? { kind, surface, boardKind } : { kind, surface });
}

/** Where home-or-gym was answered. */
export type BoardKindSurface = 'picker' | 'manage' | 'where' | 'first_run' | 'in_range' | 'gym_page';

/**
 * `Board Kind Chosen` (#8151). See SHARED_EVENTS. `spray` only from the add-a-board
 * wizard's step 1, whose third answer is a spray wall.
 */
export function trackBoardKindChosen(event: {
  kind: BoardKind | 'spray';
  surface: BoardKindSurface;
  preAnswered: boolean;
}) {
  track(SHARED_EVENTS.BoardKindChosen, event);
}

/** Read a `kind` route param defensively: anything else is "not said". */
export function parseBoardKind(value: unknown): BoardKind | null {
  return value === 'home' || value === 'gym' ? value : null;
}
