import { useGlassCapability } from './use-glass-capability';
import { useNativeRootHeader } from './use-native-root-header';

/**
 * Whether the root tab headers put their actions in native UIKit bar items
 * (`root-bar-items.ts`) instead of the custom glass capsules. Native items are
 * what iPhone Duo moves onto its side rail, and what UIKit lays out beside the
 * iPad's sidebar button and top tab bar; a custom view stays where it is put.
 *
 * iPhone and iPad on iOS 26 Liquid Glass. Before iOS 26 a native item is plain
 * text-and-glyph with no glass, so the capsules stay the closer look; Material
 * and Android never reach the native header at all.
 */
export function useNativeRootBarItems(): boolean {
  const nativeRootHeader = useNativeRootHeader();
  const glassCapable = useGlassCapability();
  return nativeRootHeader && glassCapable;
}
