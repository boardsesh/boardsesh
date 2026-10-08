import type { ComponentProps } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { GlassSurface } from './GlassSurface';
import { useEffectiveSurfaceMode } from '../hooks/use-effective-surface-mode';

type ScreenBackgroundProps = Pick<ComponentProps<typeof GlassSurface>, 'role' | 'fallbackColor' | 'tintColor'> & {
  /** The opaque fill on Liquid Glass (and its iOS < 26 blur stand-in). */
  color: ColorValue;
};

/**
 * A full-screen, non-interactive background for a screen whose content is drawn
 * on top as a sibling.
 *
 * HIG Materials: Liquid Glass is the controls layer that floats over content,
 * never the content's own background. So where the surface mode is `glass` or
 * `blur`, this is a plain opaque `color` (a systemBackground token). Material and
 * the solid Reduce Transparency path keep GlassSurface, which is already opaque
 * there and carries the M3 tonal role and tint.
 *
 * `level0` and `pointerEvents="none"` are load-bearing on the GlassSurface path:
 * Android orders siblings by elevation, so the default `shadows.sm` cast would
 * lift the fill over the content drawn after it (#4209).
 */
export function ScreenBackground({ color, role, fallbackColor, tintColor }: ScreenBackgroundProps) {
  const mode = useEffectiveSurfaceMode();
  if (mode === 'glass' || mode === 'blur') {
    return (
      <View
        testID="screen-background-opaque"
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: color }]}
      />
    );
  }
  return (
    <GlassSurface
      style={StyleSheet.absoluteFill}
      glassEffectStyle="regular"
      role={role}
      level="level0"
      pointerEvents="none"
      fallbackColor={fallbackColor}
      tintColor={tintColor}
    />
  );
}
