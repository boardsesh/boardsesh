import { Platform } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { useReduceTransparency } from './use-reduce-transparency';
import { useGlassCapability } from './use-glass-capability';
import { assertNever } from '../lib/assert-never';

/**
 * How a translucent surface should actually render on this device, for this
 * user, right now. One ordered decision so every consumer agrees:
 *
 *   solid    — Reduce Transparency on (a11y wins, any platform/variant)
 *   material — the Material variant (opaque M3 tonal surface), even on iOS 26
 *   glass    — iOS 26 Liquid Glass (the preferred path)
 *   blur     — iOS < 26 frosted blur (the Liquid Glass fallback)
 *   solid    — anything else (e.g. Android forced onto Liquid Glass)
 *
 * `GlassSurface` switches on this; `useNativeGlass()` is `mode === 'glass'`.
 */
export type SurfaceMode = 'glass' | 'blur' | 'material' | 'solid';

export function useEffectiveSurfaceMode(): SurfaceMode {
  const { variant } = useTheme();
  const reduceTransparency = useReduceTransparency();
  const glassCapable = useGlassCapability();

  // a11y wins regardless of variant.
  if (reduceTransparency) return 'solid';
  switch (variant) {
    case 'material':
      return 'material';
    case 'liquidGlass':
      if (glassCapable) return 'glass';
      if (Platform.OS === 'ios') return 'blur';
      return 'solid';
    // A new UiVariant must declare its surface mode.
    default:
      return assertNever(variant);
  }
}
