import { blendOpaque } from '../../theme/colors';

type ColorSchemeName = 'light' | 'dark';

// Four-step intensity ramp: a busy day climbs from 40% → 100% of the accent
// composited over the card surface. Shared by the activity calendar and the
// wall-rhythm grid so the two heatmaps read as siblings.
export const INTENSITY_STEPS = [0.4, 0.6, 0.8, 1] as const;
// Opaque-composite alphas for the empty floor (kept faint, scheme-tuned).
const EMPTY_FLOOR_ALPHA_DARK = 0.14;
const EMPTY_FLOOR_ALPHA_LIGHT = 0.08;

/** The empty-cell floor + the four lit steps, as opaque `#RRGGBB` fills. */
export type IntensityFills = {
  emptyFill: string;
  stepFills: string[];
};

/**
 * Build the heatmap intensity ramp by alpha-compositing `primaryHex` over
 * `surfaceHex` at the empty-floor + four step alphas. Both inputs MUST be plain
 * hex (chart accent + secondary background) so the result stays an opaque hex a
 * react-native-svg `fill` / RN `backgroundColor` can take — never a PlatformColor.
 */
export function buildIntensityFills(primaryHex: string, surfaceHex: string, scheme: ColorSchemeName): IntensityFills {
  const floorAlpha = scheme === 'dark' ? EMPTY_FLOOR_ALPHA_DARK : EMPTY_FLOOR_ALPHA_LIGHT;
  return {
    emptyFill: blendOpaque(primaryHex, surfaceHex, floorAlpha),
    stepFills: INTENSITY_STEPS.map((step) => blendOpaque(primaryHex, surfaceHex, step)),
  };
}

/**
 * Map a cell `count` to its fill: the empty floor at 0, otherwise the step whose
 * band the count/`maxCount` ratio falls into (ceil so a single ascent always
 * lights the lowest step rather than rounding to empty).
 */
export function colorForCount(count: number, maxCount: number, fills: IntensityFills): string {
  if (count <= 0 || maxCount <= 0) return fills.emptyFill;
  const ratio = count / maxCount;
  const stepIndex = Math.min(fills.stepFills.length - 1, Math.max(0, Math.ceil(ratio * fills.stepFills.length) - 1));
  return fills.stepFills[stepIndex];
}
