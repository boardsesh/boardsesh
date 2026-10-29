import { SHARED_EVENTS } from '@boardsesh/analytics';
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
