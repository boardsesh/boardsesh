import { useIsSharedSession } from '../../providers/queue-provider';
import { useSetting } from '../../settings';
import { useDriveModePhase, useDrivingStoppedForLink } from './drive-mode-store';
import { climbChangeStaysViewOnly } from './play-drawer-navigation';

/** Which change of climb: a swipe, Next or Prev, or a tap on a climb in a list. */
export type ClimbChangeKind = 'swipe' | 'tap';

/**
 * Whether a change of climb of this kind lights the wall right now
 * (`climbChangeStaysViewOnly`, #7113): driving the wall, or solo with the
 * matching setting on and no press-to-stop on this link. Today only the
 * MiniPlayer's ⏮ and ⏭ read it (`swipe`); `tap` is for the list taps #7113
 * PR 2 moves onto it.
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
