import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';

/** What the climber chose to add: the builder, the add-a-wall wizard, or the gym finder. */
export type BoardPickerAddKind = 'board' | 'spraywall' | 'gym_map';

/**
 * Where the choice was made: the + in the picker's top bar, the + on Manage
 * boards, the buttons under "No boards yet", or "Where do you climb?".
 */
export type BoardPickerAddSurface = 'picker' | 'manage' | 'empty_state' | 'first_run';

export type BoardPickerAddSelectedEvent = {
  kind: BoardPickerAddKind;
  surface: BoardPickerAddSurface;
};

/** `Board Picker Add Selected`: one way to add a board picked. See SHARED_EVENTS. */
export function trackBoardPickerAddSelected({ kind, surface }: BoardPickerAddSelectedEvent): void {
  track(SHARED_EVENTS.BoardPickerAddSelected, { kind, surface });
}
