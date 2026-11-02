import { useIsSharedSession } from '../../providers/queue-provider';
import { getSetting, useSetting } from '../../settings';
import {
  drivingAtPick,
  getDriveMode,
  isDrivingStoppedForLink,
  useDriveModePhase,
  useDrivingStoppedForLink,
} from './drive-mode-store';
import { climbChangeStaysViewOnly } from './play-drawer-navigation';

/** Which change of climb: a swipe, Next or Prev, or a tap on a climb in a list. */
export type ClimbChangeKind = 'swipe' | 'tap';

/**
 * Whether a change of climb of this kind lights the wall right now
 * (`climbChangeStaysViewOnly`, #7113): driving the wall, or solo with the
 * matching setting on and no press-to-stop on this link. The MiniPlayer's ⏮
 * and ⏭ read it (`swipe`).
 */
export function useClimbChangeLights(kind: ClimbChangeKind): boolean {
  const drivePhase = useDriveModePhase();
  const stoppedForLink = useDrivingStoppedForLink();
  const inSharedSession = useIsSharedSession();
  const [lightOnSwipe] = useSetting('lightOnSwipe');
  const [lightOnClimbTap] = useSetting('lightOnClimbTap');
  return !climbChangeStaysViewOnly({
    driving: drivePhase === 'live',
    inSharedSession,
    lightSetting: kind === 'swipe' ? lightOnSwipe : lightOnClimbTap,
    stoppedForLink,
  });
}

/**
 * A live drive on this phone's link, read at the tap (#7113). A keep-lighting
 * window past its end is not one, even before the watcher has ended it (#7038).
 */
export function isDrivingWall(): boolean {
  return drivingAtPick(getDriveMode()?.phase === 'live');
}

/**
 * The same rule as `useClimbChangeLights`, read at the moment of a tap, for the
 * list taps (`usePlaylistActivation`, a board-history row, a row with nothing
 * to draw) that read the setting at the tap so their handlers keep one
 * identity. `inSharedSession` is the caller's own read of the crew. Explicit
 * list Play follows the same preference as a row tap: only the board control
 * can put a preview on the wall without opting in to automatic lighting.
 */
export function readClimbChangeLights(
  kind: ClimbChangeKind,
  { inSharedSession }: { inSharedSession: boolean },
): boolean {
  return !climbChangeStaysViewOnly({
    driving: isDrivingWall(),
    inSharedSession,
    lightSetting: getSetting(kind === 'swipe' ? 'lightOnSwipe' : 'lightOnClimbTap'),
    stoppedForLink: isDrivingStoppedForLink(),
  });
}
