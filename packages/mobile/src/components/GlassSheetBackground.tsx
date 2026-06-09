import { StyleSheet } from 'react-native';
import type { BottomSheetBackgroundProps } from '@gorhom/bottom-sheet';
import { GlassSurface } from './GlassSurface';
import { useTheme } from '../providers/theme-provider';
import { sheetStyles } from '../theme/tokens';

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
};

export function GlassSheetBackground({ style, pointerEvents, flatTop }: GlassSheetBackgroundProps) {
  const { systemColors, sheet } = useTheme();
  return (
    <GlassSurface
      glassEffectStyle="regular"
      fallbackColor={systemColors.secondaryBackground}
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
