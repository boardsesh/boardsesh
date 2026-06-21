/**
 * Spring animation presets for react-native-reanimated's withSpring().
 *
 * Usage:
 *   import { springs } from '@/theme/animations';
 *   withSpring(targetValue, springs.snappy);
 */

export const springs = {
  /** Fast, crisp response for UI controls (toggles, switches, tabs). */
  snappy: { damping: 20, stiffness: 300, mass: 0.7 },

  /** Standard interactive feedback (dragging, swiping, pressing). */
  interactive: { damping: 20, stiffness: 250, mass: 1.0 },

  /** Slow, smooth transitions (sheet presentations, layout changes). */
  gentle: { damping: 15, stiffness: 150, mass: 1.0 },

  /** Playful overshoot (success states, celebrations). */
  bouncy: { damping: 10, stiffness: 200, mass: 0.7 },
} as const;

/**
 * Timing presets for simple opacity/fade animations with withTiming().
 *
 * Usage:
 *   import { timing } from '@/theme/animations';
 *   withTiming(targetValue, { duration: timing.fast });
 */
export const timing = {
  /** Near-instant feedback (50ms). */
  instant: 50,

  /** Quick transitions like fades and highlights (150ms). */
  fast: 150,

  /** Standard duration for most transitions (250ms). */
  normal: 250,

  /** Slower transitions for complex layout shifts (350ms). */
  slow: 350,
} as const;

export type SpringPreset = 'snappy' | 'interactive' | 'gentle' | 'bouncy';
export type TimingPreset = 'instant' | 'fast' | 'normal' | 'slow';

// Material 3 easing curves as raw cubic-bezier control points — NOT
// `Easing.bezier(...)`, so this module stays reanimated-free and safe to import from
// `makeThemeMock`/non-RN contexts; the curve is built at the call site via
// `theme/motion-config.ts`. Internal (only `motionByVariant` consumes them). Just the
// two curves the tokens use today — add more when a token needs one (dead-code rule).
//
// `standard` is M3's standard-easing. `emphasized` approximates M3's emphasized
// motion — a two-part accelerate→decelerate spline no single bezier captures — with
// its dominant emphasized-decelerate segment (so it reads distinctly from `standard`,
// a slower settle, not just a longer duration).
const m3Easing = {
  standard: [0.2, 0, 0, 1],
  emphasized: [0.05, 0.7, 0.1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

// Material 3 standard durations (ms). Internal; add more (M3 has short1–4 / medium1–4
// / long1–4) when a token needs them.
const m3Duration = {
  short: 200, // M3 short4 — small utility transitions
  medium: 350, // M3 medium3 — standard component/layout transitions
} as const;

/**
 * A variant-resolved timing config: a duration, plus (Material only) an M3 easing
 * curve. Pure DATA — `Easing.bezier` is built from `easingBezier` at the call site
 * (`timingFor`), so this stays importable anywhere. Liquid Glass omits the curve and
 * keeps reanimated's default ease, preserving its feel; only the durations are
 * shared, mapped to each variant's prior values.
 */
export type MotionConfig = {
  duration: number;
  easingBezier?: readonly [number, number, number, number];
};

export type Motion = {
  /** Utility transitions (fades, small moves). */
  standard: MotionConfig;
  /** Hero / emphasized transitions (sheet/FAB moves, larger layout shifts). */
  emphasized: MotionConfig;
};

/**
 * Per-variant motion. Material uses M3 easing curves + standard durations; Liquid
 * Glass keeps its prior `timing` durations (no easing override) so its feel is
 * unchanged. Springs (press/gesture feedback) stay separate — these tokens cover
 * the `withTiming` transitions the two variants share.
 */
export const motionByVariant = {
  liquidGlass: {
    standard: { duration: timing.fast },
    emphasized: { duration: timing.normal },
  },
  material: {
    standard: { duration: m3Duration.short, easingBezier: m3Easing.standard },
    emphasized: { duration: m3Duration.medium, easingBezier: m3Easing.emphasized },
  },
} as const satisfies Record<'liquidGlass' | 'material', Motion>;
