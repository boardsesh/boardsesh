import { Platform, useWindowDimensions } from 'react-native';
import { useHingePartiallyOpen } from '../lib/device-hinge-store';
import { resolveTabletopFoldTop } from '../theme/size-class';

/**
 * Where the top half ends while the iPhone Duo stands in tabletop (half open,
 * inner display upright), in window points; null in every other pose and on
 * every other device. Live: it follows the hinge (`device-hinge-store`, fed by
 * `FoldHingeObserver`) and the window. See `resolveTabletopFoldTop`, which is
 * iOS-only, where a tablet is exactly `Platform.isPad`.
 */
export function useTabletopFoldTop(): number | null {
  const { width, height } = useWindowDimensions();
  const partiallyFolded = useHingePartiallyOpen();
  return resolveTabletopFoldTop({
    platformOS: Platform.OS,
    isTablet: Platform.OS === 'ios' && Platform.isPad === true,
    width,
    height,
    partiallyFolded,
  });
}
