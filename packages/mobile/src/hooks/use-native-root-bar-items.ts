import { Platform } from 'react-native';
import { useGlassCapability } from './use-glass-capability';
import { useNativeRootHeader } from './use-native-root-header';

/**
 * Whether the root tab headers put their actions in native UIKit bar items
 * (`root-bar-items.ts`) instead of the custom glass capsules. Native items are
 * what iPhone Duo moves onto its side rail; a custom view stays in the bar.
 *
 * iPhone on iOS 26 Liquid Glass only. Before iOS 26 a native item is plain
 * text-and-glyph with no glass, so the capsules stay the closer look; iPad keeps
 * its capsules, which anchor popovers (the angle picker) and sit in the tablet
 * panes; Material and Android never reach the native header at all.
 */
export function useNativeRootBarItems(): boolean {
  const nativeRootHeader = useNativeRootHeader();
  const glassCapable = useGlassCapability();
  const isPad = Platform.OS === 'ios' && Platform.isPad === true;
  return nativeRootHeader && glassCapable && !isPad;
}
