import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNativeTabContentInsetSide } from '../lib/native-tab-content-inset-store';
import { resolveVerticalTabBar } from './vertical-tab-bar';

/**
 * Whether the native tab bar is on screen as a vertical rail (iPhone Duo). Call it
 * where the tab bar is configured, outside the tabs' own safe-area providers: the
 * window inset answers there, and the in-tab measurement published by
 * `NativeTabContentInsetProbe` covers the rest. See `resolveVerticalTabBar`.
 */
export function useVerticalTabBar(): boolean {
  const { width, height } = useWindowDimensions();
  const { left, right } = useSafeAreaInsets();
  const tabContentSideInset = useNativeTabContentInsetSide();
  return resolveVerticalTabBar({
    platformOS: Platform.OS,
    isPad: Platform.OS === 'ios' && Platform.isPad === true,
    windowWidth: width,
    windowHeight: height,
    windowInsets: { left, right },
    tabContentSideInset,
  });
}
