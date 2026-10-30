import { driveModeEnded, SHARED_EVENTS, type DriveModeEndedInput } from '@boardsesh/analytics';
import { track } from './analytics';
import type { WallControlAction, WallControlState } from '../components/play-drawer/wall-control';

/**
 * Which view of the board control was tapped or held: the wall button (full
 * width, or narrower in a workout's top row), the first row's bulb, or the open
 * MiniPlayer's bulb, standing in for a tablet or open-Duo player's (#7000).
 */
export type WallControlSurface = 'button' | 'bulb' | 'mini_bar';

/** The player's wall button asked the climber to act (see `WallControlShown` in events.ts). */
export function trackWallControlShown({
  state,
  climbUuid,
}: {
  state: 'connect' | 'put_on_wall';
  climbUuid: string;
}): void {
  track(SHARED_EVENTS.WallControlShown, { state, climbUuid });
}

/** A tap on the player's wall button or bulb (see `WallControlTapped` in events.ts). */
export function trackWallControlTapped({
  state,
  action,
  control,
}: {
  state: WallControlState;
  action: WallControlAction;
  control: WallControlSurface;
}): void {
  track(SHARED_EVENTS.WallControlTapped, { state: state ?? 'none', action, control });
}

/**
 * What a swipe on the wall button came to (#7113): `drive` started driving the
 * wall, `cancelled` let go short of the commit point, `refused` let go past it
 * where nothing could start (presence says another account holds the board).
 */
export type WallControlSwipeOutcome = 'drive' | 'cancelled' | 'refused';

/** A swipe on the player's wall button, once per gesture (see `WallControlSwiped` in events.ts). */
export function trackWallControlSwiped({
  state,
  outcome,
  control,
}: {
  state: WallControlState;
  outcome: WallControlSwipeOutcome;
  control: WallControlSurface;
}): void {
  track(SHARED_EVENTS.WallControlSwiped, { state: state ?? 'none', outcome, control });
}

/** Driving the wall ended (#7113): once per drive, from the drive-mode store. */
export function trackDriveModeEnded(input: DriveModeEndedInput): void {
  const { name, properties } = driveModeEnded(input);
  track(name, properties);
}

/**
 * What a hand-off came to on the asking phone (#7113): `released` this phone got
 * the board, `timed_out` no connect got it (the retry included), `refused` no
 * connect got it and the server refused the request (or it never reached it).
 */
export type BoardHandoffOutcome = 'released' | 'timed_out' | 'refused';

/** Board Handoff Requested: once per request, when it resolves. No ids or names. */
export function trackBoardHandoffRequested({
  outcome,
  inSession,
}: {
  outcome: BoardHandoffOutcome;
  inSession: boolean;
}): void {
  track(SHARED_EVENTS.BoardHandoffRequested, { outcome, inSession });
}

/** Board Handed Off: this phone let go because a crewmate asked. No ids or names. */
export function trackBoardHandedOff({ wasDriving }: { wasDriving: boolean }): void {
  track(SHARED_EVENTS.BoardHandedOff, { wasDriving });
}
