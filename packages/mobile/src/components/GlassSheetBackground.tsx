import { StyleSheet } from 'react-native';
import type { BottomSheetBackgroundProps } from '@gorhom/bottom-sheet';
import { GlassSurface } from './GlassSurface';
import { useTheme } from '../providers/theme-provider';
import { sheetStyles } from '../theme/tokens';
import { playDrawerMaterialTint } from '../theme/colors';

/**
 * Shared frosted-glass background for bottom sheets — the same Liquid-Glass
 * material the Play Drawer rises with, so every sheet reads as one piece of
 * chrome. Pass it straight to a gorhom sheet's `backgroundComponent`.
 *
 * `GlassSurface` resolves glass / blur / material / solid per UI variant and the
 * "Reduce Transparency" setting, so the Material variant and accessibility paths
 * get the correct opaque surface here without any per-call branching. `style`
 * from gorhom positions the fill; the sheet corner radii round the top and
 * `overflow: 'hidden'` clips the blur fallback to those corners.
 */
type GlassSheetBackgroundProps = BottomSheetBackgroundProps & {
  /**
   * Square off the top corners for full-screen presentations (the play drawer
   * now-playing takeover). Overrides both the iOS top radius and the Material
   * 28dp corners so the sheet reads as a screen, not a panel.
   */
  flatTop?: boolean;
  /**
   * Composite a scheme-aware tint over the material so the surface reads as a
   * denser, more opaque takeover than the lighter glass the other sheets use.
   * Used by the Play Drawer only; off by default so every other sheet keeps the
   * original glass.
   */
  opaqueMaterial?: boolean;
};

export function GlassSheetBackground({ style, pointerEvents, flatTop, opaqueMaterial }: GlassSheetBackgroundProps) {
  const { systemColors, sheet, colorScheme } = useTheme();
  return (
    <GlassSurface
      glassEffectStyle="regular"
      // Modal bottom sheet = M3 surfaceContainerLow; the scrim carries the
      // separation, so the sheet tone stays low (not "high because it floats").
      role="low"
      fallbackColor={systemColors.secondaryBackground}
      tintColor={opaqueMaterial ? playDrawerMaterialTint[colorScheme] : undefined}
      style={[style, sheetStyles.background, sheet.corners, flatTop && styles.flatTop, styles.clip]}
      pointerEvents={pointerEvents}
    />
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
  flatTop: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
  },
});
