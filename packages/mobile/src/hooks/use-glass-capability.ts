import { Platform } from 'react-native';
import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';

/**
 * Whether the device can render real iOS 26 Liquid Glass. This is the pure
 * *capability* check — it deliberately excludes Reduce Transparency, which is an
 * orthogonal render-mode concern handled in `GlassSurface`/`useEffectiveSurfaceMode`.
 *
 * Used to resolve the `'auto'` UI-variant preference and to gate the Settings
 * "Liquid Glass" option. The native answer is stable per process, so this is a
 * plain synchronous check exposed as a hook for naming consistency — letting the
 * first paint pick the correct variant without awaiting async storage.
 */
export function useGlassCapability(): boolean {
  return Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
}
