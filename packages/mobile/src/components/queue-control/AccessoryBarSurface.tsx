import { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { GlassSurface } from '../GlassSurface';
import { useTheme } from '../../providers/theme-provider';
import { useEffectiveSurfaceMode } from '../../hooks/use-effective-surface-mode';
import { shadows } from '../../theme/tokens';
import { materialFloatingBarSurface, withAlpha } from '../../theme/colors';

/** Visual emphasis: `connected` lights the bar up when you're driving the wall. */
export type AccessoryBarSurfaceEmphasis = 'none' | 'connected';

type AccessoryBarSurfaceProps = {
  /** Surface height; the default radius is a full pill (`height / 2`). */
  height: number;
  borderRadius?: number;
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
 *   material → opaque M3 tonal surface (a floating pill or the MiniPlayer card)
 *   blur/solid → frosted/solid fill + hairline border + separation shadow
 *
 * Reduce Transparency is handled inside `GlassSurface`/`useEffectiveSurfaceMode`
 * (it resolves to the solid branch here), so a11y stays correct without this
 * component knowing about it.
 */
export function AccessoryBarSurface({
  height,
  borderRadius,
  emphasis = 'none',
  style,
  children,
}: AccessoryBarSurfaceProps) {
  const mode = useEffectiveSurfaceMode();
  const { systemColors, variant, m3, colorScheme, materialElevation, brandColors } = useTheme();
  const radius = borderRadius ?? height / 2;
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
    // M3 floating-bar surface + a level-2 cast, lifted as a pill or a card. No
    // clip on this View, so the cast shows.
    // When you hold control, step the cast to level-3 and lay the violet
    // `secondaryContainer` tone over the base. That role is opaque now, so it
    // simply covers the grey base; the base stays underneath so the bar's shape
    // and cast never depend on the overlay. M3 expresses "active" through tone +
    // elevation, not a drop-shadow glow.
    const surfaceElevation = connected ? materialElevation.level3 : materialElevation.level2;
    // It floats over cards, so it takes its own surface step and a hairline edge
    // (see `materialFloatingBarSurface`); a level-2 cast alone is invisible on a
    // near-black OLED page.
    const materialSurfaceStyle: ViewStyle = {
      backgroundColor: materialFloatingBarSurface[colorScheme],
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: m3.outlineVariant,
      ...surfaceElevation,
    };
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
