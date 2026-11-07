import { makeMutable, withTiming, type SharedValue } from 'react-native-reanimated';
import { motionByVariant } from '../theme/animations';
import { timingFor } from '../theme/motion-config';
import { getTabBarHidden, getTabBarFlipInstant, subscribeTabBarHidden } from './tab-bar-visibility-store';

/**
 * 0 = the Android nav bar is shown, 1 = hidden. The bar, the MiniPlayer card, the
 * rest pill, the connectivity banner, the Discover create button, the Start
 * button, snackbars and toasts all read this one value on the UI thread, so they
 * move together and a hide never re-renders a screen.
 *
 * It follows `tab-bar-visibility-store`, which flips only when a scroll crosses
 * the threshold, so the value is written once per hide or show: an M3 standard
 * slide, or a jump under Reduce Motion.
 */
export const tabBarHiddenProgress: SharedValue<number> = makeMutable(0);

const SLIDE_TIMING = timingFor(motionByVariant.material.standard);

subscribeTabBarHidden(() => {
  const target = getTabBarHidden() ? 1 : 0;
  tabBarHiddenProgress.value = getTabBarFlipInstant() ? target : withTiming(target, SLIDE_TIMING);
});
