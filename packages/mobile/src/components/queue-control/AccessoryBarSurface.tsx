import { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { GlassSurface } from '../GlassSurface';
import { useTheme } from '../../providers/theme-provider';
import { useEffectiveSurfaceMode } from '../../hooks/use-effective-surface-mode';
import { shadows } from '../../theme/tokens';
import { withAlpha } from '../../theme/colors';

export type AccessoryBarSurfaceTreatment = 'floating' | 'docked';

/** Visual emphasis: `connected` lights the bar up when you're driving the wall. */
export type AccessoryBarSurfaceEmphasis = 'none' | 'connected';

type AccessoryBarSurfaceProps = {
  /** Surface height; the default radius is a full pill (`height / 2`). */
  height: number;
  borderRadius?: number;
  /** Material can dock the surface to the tab bar instead of rendering a floating pill. */
  treatment?: AccessoryBarSurfaceTreatment;
  /**
   * `connected` = this device holds the board's BLE link. Expressed per platform:
   * a violet M3 tonal container + a level-3 cast on Material (matching the active
   * tab pill), a soft warm tint on the iOS glass/blur/solid capsule. Never on the
   * iOS 26 native platter (UIKit-owned — handled in the content layer instead).
   */
  emphasis?: AccessoryBarSurfaceEmphasis;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/**
 * The variant-aware background for a floating "active context" pill (the climb
 * capsule today, a workout timer later). It owns ONLY the surface + height so the
 * occupant content stays variant-agnostic:
 *
 *   glass    → Liquid Glass pill (native edge — no border/shadow)
 *   material → opaque M3 tonal surface (floating pill or docked bar)
 *   blur/solid → frosted/solid fill + hairline border + separation shadow
 *
 * Reduce Transparency is handled inside `GlassSurface`/`useEffectiveSurfaceMode`
 * (it resolves to the solid branch here), so a11y stays correct without this
 * component knowing about it.
 */
export function AccessoryBarSurface({
  height,
  borderRadius,
  treatment = 'floating',
  emphasis = 'none',
  style,
  children,
}: AccessoryBarSurfaceProps) {
  const mode = useEffectiveSurfaceMode();
  const { systemColors, variant, m3, m3SurfaceContainers, materialElevation, brandColors } = useTheme();
  const radius = treatment === 'docked' ? 0 : (borderRadius ?? height / 2);
  const shape: ViewStyle = { height, borderRadius: radius };
  const connected = emphasis === 'connected';
  // A soft warm tint for the iOS glass/blur/solid capsule when you hold control —
  // deliberately gentler than the lightbulb's own halo so a large surface doesn't
  // read as "tap me". Composited via GlassSurface's pointerEvents-none tint layer.
  const warmTint = connected ? withAlpha(brandColors.warning, 0.12) : undefined;

  // Native Liquid Glass draws its own refractive edge + lift.
  if (mode === 'glass') {
    return (
      <View style={[shape, style]}>
        <GlassSurface
          glassEffectStyle="regular"
          tintColor={warmTint}
          borderRadius={radius}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {children}
      </View>
    );
  }

  // Material is already opaque, so keep it on the Material surface path even when
  // Reduce Transparency resolves translucent surfaces to solid. Genuine dual-axis
  // check (surface capability OR aesthetic variant) — see theme/variants/README.md.
  if (mode === 'material' || variant === 'material') {
    // M3 bottom-bar surface: the `surfaceContainer` tone + a level-2 cast (the
    // canonical nav/bottom-bar role). Docked adds a hairline top separator;
    // floating is the same tone as a lifted pill. The grade colour lives in the
    // bar's leading accent, not here. No clip on this View, so the cast shows.
    // When you hold control, step the cast to level-3 and composite the violet
    // `secondaryContainer` tone OVER the opaque base (this codebase maps that role
    // to a low-alpha violet meant to layer, so painting it as the sole background
    // would let the list bleed through). M3 expresses "active" through tone +
    // elevation, not a drop-shadow glow.
    const surfaceElevation = connected ? materialElevation.level3 : materialElevation.level2;
    const materialSurfaceStyle: ViewStyle =
      treatment === 'docked'
        ? {
            backgroundColor: m3SurfaceContainers.base,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: systemColors.separator,
            ...surfaceElevation,
          }
        : { backgroundColor: m3SurfaceContainers.base, ...surfaceElevation };
    return (
      <View style={[shape, materialSurfaceStyle, style]}>
        {connected ? (
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: m3.secondaryContainer, borderRadius: radius }]}
          />
        ) : null}
        {children}
      </View>
    );
  }

  // Blur / solid fallback: the surface has no intrinsic edge, so add the hairline
  // border and separation shadow. When you hold control, warm the edge and tint
  // the fill amber.
  return (
    <View
      style={[
        shape,
        shadows.sm,
        {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: connected ? withAlpha(brandColors.warning, 0.4) : systemColors.separator,
        },
        style,
      ]}
    >
      <GlassSurface
        fallbackColor={systemColors.elevatedSurface}
        tintColor={warmTint}
        borderRadius={radius}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}
