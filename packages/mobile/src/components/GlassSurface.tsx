import { type ReactNode } from 'react';
import { StyleSheet, View, type ColorValue, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { BlurView } from '@react-native-community/blur';
import { GlassView, type GlassStyle } from 'expo-glass-effect';
import { useTheme } from '../providers/theme-provider';
import type { MaterialSurfaceContainers } from '../theme/colors';
import { iosDarkColors, iosLightColors } from '../theme/ios-colors';
import { shadows, type MaterialElevationLevel } from '../theme/tokens';
import { useEffectiveSurfaceMode } from '../hooks/use-effective-surface-mode';

type GlassSurfaceProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 'regular' = frosted, elevated chrome (tab bar, sheets); 'clear' = lighter, content-forward (floating bars). */
  glassEffectStyle?: GlassStyle;
  /**
   * Tint composited onto the glass / blur (e.g. a climb's grade hue). Keep it
   * translucent so the underlying content still shows through the glass.
   */
  tintColor?: string;
  /**
   * Fill layered over the surface on the no-glass paths (Material / Android /
   * Reduce Transparency). It composites on top of an opaque secondary-background
   * base, so a translucent token (e.g. `systemColors.fill`) reads as a tint —
   * not a see-through hole — and an opaque value fully covers the base. Omit it
   * to get the plain secondary-background surface.
   */
  fallbackColor?: ColorValue;
  /**
   * Corner radius for a shaped surface (pill / circle). On iOS 26 it is handed to
   * the native GlassView so the glass renders its own rounded shape with Apple's
   * clean edge — DON'T clip a square glass with a parent `overflow`/`borderWidth`
   * (an RN border on a circle seams at the 12/3/6/9 arc joins). The blur and solid
   * fallbacks clip to the radius themselves.
   */
  borderRadius?: number;
  /** Blur strength for the iOS < 26 fallback. */
  blurAmount?: number;
  /**
   * Let the native Liquid Glass react to touches with Apple's own press/highlight
   * (iOS 26 only — ignored on the blur/solid fallback, where the consumer's
   * PressableSurface supplies the feedback). Only takes effect when the GlassView
   * is the touch target; a `pointerEvents="none"` glass behind content won't see
   * the touch.
   */
  isInteractive?: boolean;
  pointerEvents?: ViewProps['pointerEvents'];
  /**
   * Material-only: the M3 surface-container TONE this surface carries (depth is
   * tonal first on Material). Omit to keep the legacy opaque `secondaryBackground`
   * base. Ignored on glass/blur (Liquid Glass expresses depth through the glass).
   * Pair with `level` per the canonical M3 role map (sheet → `low`, nav/menu →
   * `base`, dialog → `high`, filled card → `highest`).
   */
  role?: keyof MaterialSurfaceContainers;
  /**
   * Material-only: the M3 elevation CAST (level0–5). Omit to keep the legacy
   * `shadows.sm`. The material branch applies it on the same view as the
   * background + radius (no `overflow:'hidden'`), so a rounded surface still casts.
   */
  level?: MaterialElevationLevel;
};

/**
 * One background primitive for every translucent / tonal surface. Picks the
 * right material for the device, variant and a11y settings via
 * `useEffectiveSurfaceMode()`, and renders cleanly for each:
 *
 *   glass    → expo-glass-effect GlassView (iOS 26 Liquid Glass — preferred)
 *   blur     → @react-native-community/blur frosted blur (iOS < 26 fallback)
 *   material → opaque Material 3 tonal surface + elevation shadow
 *   solid    → flat themed surface (Reduce Transparency, or Android on glass)
 *
 * It fills its parent like gorhom's `backgroundComponent`; consumers stack
 * content on top either as children or as siblings.
 */
export function GlassSurface({
  children,
  style,
  glassEffectStyle = 'regular',
  tintColor,
  fallbackColor,
  borderRadius,
  blurAmount = 20,
  isInteractive = false,
  pointerEvents,
  role,
  level,
}: GlassSurfaceProps) {
  const { systemColors, colorScheme, m3SurfaceContainers, materialElevation } = useTheme();
  const mode = useEffectiveSurfaceMode();
  const isDark = colorScheme === 'dark';

  // The no-glass paths always start from an opaque base so the surface never
  // shows the screen through it (a `fallbackColor` may be a translucent token
  // like `fill`, meant as a tint over a surface, not a standalone background —
  // and a see-through surface would also defeat Reduce Transparency).
  const baseColor = systemColors.secondaryBackground;
  const radius = borderRadius != null ? { borderRadius } : null;
  // The blur/solid paths have no native shape, so clip them to the radius here.
  const clippedRadius = borderRadius != null ? { borderRadius, overflow: 'hidden' as const } : null;

  // Solid: Reduce Transparency (a11y) on any platform, or Android forced onto
  // the Liquid Glass variant. Opaque base + the fallback/tint layered on top.
  if (mode === 'solid') {
    return (
      <View style={[style, clippedRadius, { backgroundColor: baseColor }]} pointerEvents={pointerEvents}>
        {fallbackColor ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: fallbackColor }]} />
        ) : null}
        {tintColor ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]} />
        ) : null}
        {children}
      </View>
    );
  }

  // Material: opaque M3 tonal surface. Depth is tone-FIRST — `role` picks the
  // surface-container tone, `level` adds the elevation cast (both default to the
  // legacy base + `shadows.sm` so unmigrated consumers don't shift). Background +
  // radius + cast live on the SAME view (no `overflow: 'hidden'`, which would clip
  // the shadow) so even a rounded surface casts. Fallback/tint composite on top.
  if (mode === 'material') {
    const materialBg = role ? m3SurfaceContainers[role] : baseColor;
    const elevationStyle = level ? materialElevation[level] : shadows.sm;
    // When a `role` tone is given it IS the surface — an opaque `fallbackColor`
    // would paint over and hide it, so skip the fallback layer (the translucent
    // `tint` still composites). Without a role, keep the legacy fallback-over-base.
    return (
      <View style={[style, radius, elevationStyle, { backgroundColor: materialBg }]} pointerEvents={pointerEvents}>
        {!role && fallbackColor ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, radius, { backgroundColor: fallbackColor }]} />
        ) : null}
        {tintColor ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, radius, { backgroundColor: tintColor }]} />
        ) : null}
        {children}
      </View>
    );
  }

  // Glass: real iOS 26 Liquid Glass. The radius goes on the GlassView itself so
  // the native glass renders a rounded shape with its own clean edge (no parent
  // clip or RN border, which would seam at the cardinal points of a circle).
  if (mode === 'glass') {
    return (
      <View style={style} pointerEvents={pointerEvents}>
        <GlassView
          glassEffectStyle={glassEffectStyle}
          tintColor={tintColor}
          isInteractive={isInteractive}
          colorScheme={isDark ? 'dark' : 'light'}
          style={[StyleSheet.absoluteFill, radius]}
        />
        {children}
      </View>
    );
  }

  // Blur: iOS < 26 frosted approximation (matches the pre-Liquid-Glass tab bar).
  return (
    <View style={[style, clippedRadius]} pointerEvents={pointerEvents}>
      <BlurView
        blurType={isDark ? 'dark' : 'light'}
        blurAmount={blurAmount}
        reducedTransparencyFallbackColor={
          isDark ? iosDarkColors.secondaryBackground : iosLightColors.secondaryBackground
        }
        style={StyleSheet.absoluteFill}
      />
      {tintColor ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]} />
      ) : null}
      {children}
    </View>
  );
}
