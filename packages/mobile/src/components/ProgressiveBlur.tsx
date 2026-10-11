import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from '@react-native-community/blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../providers/theme-provider';
import { useEffectiveSurfaceMode } from '../hooks/use-effective-surface-mode';

// A black→transparent vertical mask: MaskedView shows where the mask is opaque and
// hides where it's transparent, so each blur layer is full strength at the top and
// fades to clear by its `fadeEnd`.
const MASK_COLORS = ['#000000', 'transparent'] as const;
// Stacked layers fake a *variable* blur: a single masked blur only fades its
// opacity (uniform radius), which reads as an abrupt edge. Stacking N layers, each
// fading out higher than the last, means the top is covered by every layer (max
// blur) and the bottom by just one — so the effective blur radius ramps smoothly.
// Thin material is heavier than ultra-thin (closer to the native tab bar's chrome
// glass), so fewer layers reach the target darkness — which also helps scroll perf.
const DEFAULT_LAYERS = 3;
// In dark mode the thin material frosts to a medium grey, so the status-bar /
// dynamic-island band reads grey against the black island. A black wash, strongest
// at the very top and gone before the islands row, sinks that band to black without
// touching the grey frost lower down.
const DARK_SCRIM_COLORS = ['rgba(0,0,0,0.6)', 'rgba(0,0,0,0)'] as const;
const DARK_SCRIM_LOCATIONS = [0, 0.7] as const;
// No-live-blur paths (Android Material, or Reduce Transparency): fade the opaque
// scene background in from the top so content still tucks away cleanly. Concrete
// hexes (iOS systemBackground), not PlatformColor — expo-linear-gradient bakes a
// PlatformColor against the OS trait, which is the dark-mode white-band bug.
const SOLID_BG_DARK = '#000000';
const SOLID_BG_LIGHT = '#FFFFFF';
const SOLID_FADE_LOCATIONS = [0, 0.55, 1] as const;
// The same scene background as channels, so the wash can carry its own alpha and
// fade to a clear version of ITSELF: fading white to `transparent` (clear black)
// passes through grey.
const WASH_RGB_DARK = '0,0,0';
const WASH_RGB_LIGHT = '255,255,255';

type ProgressiveBlurProps = {
  /** Absolute position/size of the blur region (set by the caller). */
  style?: StyleProp<ViewStyle>;
  /** Blur strength per layer (honoured by the basic blur types; the material types
   *  define their own radius and the ramp comes from stacking). */
  blurAmount?: number;
  /** Number of stacked blur layers — higher is a smoother ramp, more GPU work. */
  layers?: number;
  /**
   * Hold full strength from the top down to `fadeLength` points above the bottom
   * edge, then fade out over that length. For a backdrop behind pinned controls:
   * the default ramp is strongest at the very top and nearly clear where the
   * lowest control row sits. Omit for the default ramp across the whole height.
   *
   * Live blur only. The one caller mounts it on iOS 26 glass and paints an opaque
   * band everywhere else, so the no-blur fallback below keeps its single fade.
   */
  fadeLength?: number;
  /**
   * Dark mode's black wash under the status bar (see `DARK_SCRIM_COLORS`). Switch
   * it off where the blur is not the screen's own always-on top band.
   */
  scrim?: boolean;
  /**
   * With `fadeLength`: opacity (0 to 1) of a scene-background wash laid over the
   * blur, holding and fading with it, in both colour schemes. It thins the content
   * behind the controls further than the material does (HIG Materials: a scroll
   * edge effect blurs the content behind and reduces its opacity). 0 (the
   * default) draws none.
   */
  washOpacity?: number;
};

/** Holds `colors[0]` down to `fadeLength` above the bottom, then runs the gradient. */
function PlateauFade({
  colors,
  fadeLength,
  fadeEnd = 1,
}: {
  colors: readonly [string, string];
  fadeLength: number;
  /** Fraction of `fadeLength` at which the gradient reaches `colors[1]`. */
  fadeEnd?: number;
}) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.plateau, { backgroundColor: colors[0] }]} />
      <LinearGradient colors={colors} locations={[0, fadeEnd]} pointerEvents="none" style={{ height: fadeLength }} />
    </View>
  );
}

/**
 * A top-down progressive (gradient) blur for the floating header chrome: a few
 * thin blur layers stacked so the blur radius ramps smoothly from strong at the
 * top to nothing at the bottom (a true variable blur, not just a faded uniform
 * one). The thin material matches the native tab bar's heavier glass so the header
 * and tab bar read as the same surface. The blur tint follows the app's resolved
 * colour scheme, so it honours the in-app light/dark override.
 *
 * With `fadeLength` it becomes a backdrop for controls pinned under a bar: full
 * strength behind them, fading out only along its lower edge.
 *
 * Only renders a live blur on the iOS glass / blur paths. On Material (Android) or
 * with Reduce Transparency on, `@react-native-community/blur` can't honour the iOS
 * material types and a11y wants no translucency, so it falls back to fading the
 * opaque scene background in from the top instead.
 */
export function ProgressiveBlur({
  style,
  blurAmount = 16,
  layers = DEFAULT_LAYERS,
  fadeLength,
  scrim = true,
  washOpacity = 0,
}: ProgressiveBlurProps) {
  const { colorScheme } = useTheme();
  const mode = useEffectiveSurfaceMode();
  const isDark = colorScheme === 'dark';

  // Android / Reduce Transparency: no live blur — fade the opaque scene background.
  if (mode !== 'glass' && mode !== 'blur') {
    return (
      <View pointerEvents="none" style={style}>
        <LinearGradient
          colors={[isDark ? SOLID_BG_DARK : SOLID_BG_LIGHT, isDark ? SOLID_BG_DARK : SOLID_BG_LIGHT, 'transparent']}
          locations={SOLID_FADE_LOCATIONS}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
      </View>
    );
  }

  // Thin material: heavier than ultra-thin, so it reads like the native tab bar's
  // chrome glass rather than a light grey. Stacking accumulates it toward the top.
  const blurType = isDark ? 'thinMaterialDark' : 'thinMaterialLight';
  const washRgb = isDark ? WASH_RGB_DARK : WASH_RGB_LIGHT;

  return (
    <View pointerEvents="none" style={style}>
      {Array.from({ length: layers }, (_, layer) => {
        // Later layers fade out higher up, so they accumulate toward the top (or,
        // with `fadeLength`, toward the top of the fade: every layer covers the
        // plateau above it).
        const fadeEnd = (layers - layer) / layers;
        return (
          <MaskedView
            key={layer}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
            maskElement={
              fadeLength == null ? (
                <LinearGradient colors={MASK_COLORS} locations={[0, fadeEnd]} style={StyleSheet.absoluteFill} />
              ) : (
                <PlateauFade colors={MASK_COLORS} fadeLength={fadeLength} fadeEnd={fadeEnd} />
              )
            }
          >
            <BlurView blurType={blurType} blurAmount={blurAmount} style={StyleSheet.absoluteFill} />
          </MaskedView>
        );
      })}
      {fadeLength != null && washOpacity > 0 ? (
        <PlateauFade colors={[`rgba(${washRgb},${washOpacity})`, `rgba(${washRgb},0)`]} fadeLength={fadeLength} />
      ) : null}
      {/* Dark-mode only: a black wash over the blur, strongest at the top, so the
          dynamic-island / status-bar band reads black rather than grey. Sits above
          the blur but below the floating islands (rendered later by the caller). */}
      {isDark && scrim ? (
        <LinearGradient
          colors={DARK_SCRIM_COLORS}
          locations={DARK_SCRIM_LOCATIONS}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  plateau: { flex: 1 },
});
