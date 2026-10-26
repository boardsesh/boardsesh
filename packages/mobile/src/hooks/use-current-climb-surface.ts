import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { useTabChrome } from './use-bottom-accessory';
import { useDeviceLayout } from './use-device-layout';
import { usePhoneSplit } from './use-phone-split';
import { resolveCurrentClimbSurface, type CurrentClimbSurface } from './current-climb-surface';

/** Where the current climb shows right now. See `resolveCurrentClimbSurface`. */
export function useCurrentClimbSurface(): CurrentClimbSurface {
  const { isTablet, widthClass } = useDeviceLayout();
  const { width: windowWidth } = useWindowDimensions();
  const { nativeTabBar, nativeAccessory } = useTabChrome();
  const phoneSplit = usePhoneSplit();
  const { sidebarShell, home } = resolveCurrentClimbSurface({
    isTablet,
    widthClass,
    windowWidth,
    nativeTabBar,
    nativeAccessory,
    phoneSplit,
  });
  return useMemo(() => ({ sidebarShell, home }), [sidebarShell, home]);
}
