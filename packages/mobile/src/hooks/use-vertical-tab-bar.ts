import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNativeTabContentInsetSideAtLeast } from '../lib/native-tab-content-inset-store';
import { resolveVerticalTabBar, VERTICAL_TAB_BAR_MIN_SIDE_INSET } from './vertical-tab-bar';

/**
 * Whether the native tab bar is on screen as a vertical rail (iPhone Duo). Call it
 * where the tab bar is configured, outside the tabs' own safe-area providers: the
 * window inset answers there, and the in-tab measurement published by
 * `NativeTabContentInsetProbe` covers the rest. See `resolveVerticalTabBar`.
 */
export function useVerticalTabBar(): boolean {
  const { width, height } = useWindowDimensions();
  const { left, right } = useSafeAreaInsets();
  // A boolean, so the tab layout re-renders only when the answer flips.
  const tabContentSideInsetReached = useNativeTabContentInsetSideAtLeast(VERTICAL_TAB_BAR_MIN_SIDE_INSET);
  return resolveVerticalTabBar({
    platformOS: Platform.OS,
    isPad: Platform.OS === 'ios' && Platform.isPad === true,
    windowWidth: width,
    windowHeight: height,
    windowInsets: { left, right },
    tabContentSideInsetReached,
  });
}
