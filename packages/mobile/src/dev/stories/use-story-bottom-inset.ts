import { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { useNativeTabBar } from '../../hooks/use-bottom-accessory';
import { resolveHideOnScrollTabBar } from '../../lib/tab-bar-visibility';
import { useTheme } from '../../providers/theme-provider';
import { MATERIAL_TAB_BAR_HEIGHT } from '../../theme/layout';
/** Root tab versus a pushed view, supplied by the isolated navigator's story metadata. */
export const StoryTabRootContext = createContext(true);
export function useStoryTabBarOverlay(): boolean {
  const tabRoot = useContext(StoryTabRootContext);
  const { isTablet } = useDeviceLayout();
  return tabRoot && resolveHideOnScrollTabBar({ platformOS: Platform.OS, isTablet, flagEnabled: true });
}
/** Same scroll reserve as production with no queue, timer or connectivity banner.
 * Native tabs already contribute their bar to the in-tab safe-area measurement. */
export function useStoryBottomInset(): number {
  const insets = useSafeAreaInsets();
  const nativeBar = useNativeTabBar();
  const layout = useDeviceLayout();
  const sidebar = layout.isTablet && layout.widthClass === 'regular' && !nativeBar;
  return insets.bottom + (!nativeBar && !sidebar ? MATERIAL_TAB_BAR_HEIGHT : 0);
}
/** Fixed controls clear an overlay, while the in-flow Material bar already reduces their host. */
export function useStoryFixedFooterBottom(): number {
  const insets = useSafeAreaInsets();
  const nativeBar = useNativeTabBar();
  const overlay = useStoryTabBarOverlay();
  const layout = useDeviceLayout();
  const sidebar = layout.isTablet && layout.widthClass === 'regular' && !nativeBar;
  return nativeBar || sidebar ? insets.bottom : overlay ? insets.bottom + MATERIAL_TAB_BAR_HEIGHT : 0;
}

/** Session Start uses the glass safe-area floor even where its fallback bar is in flow. */
export function useStorySessionFooterBottom(): number {
  const fixed = useStoryFixedFooterBottom();
  const insets = useSafeAreaInsets();
  const { variant } = useTheme();
  return variant === 'material' ? fixed : Math.max(fixed, insets.bottom);
}
