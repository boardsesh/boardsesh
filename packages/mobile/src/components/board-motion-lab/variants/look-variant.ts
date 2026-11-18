/**
 * The swap-look variants (D onward): each is the wall swap's state machine with
 * its own timing, plus a native swap look (`play-drawer/swap-look.ts`) and the
 * look driver (`play-drawer/swap-look-driver.ts`), which the player runs too.
 * One factory, so every variant gets the same slider names, ranges and
 * plumbing; a variant lists which sliders it shows, its defaults (the Subtle
 * preset) and its Bold preset.
 */
import type { BoardTransition } from '../../play-drawer/board-transition';
import type { SwapLook } from '../../play-drawer/swap-look';
import { swapLookTransition, type SwapLookSpec } from '../../play-drawer/swap-look-driver';
import { WALL_SWAP_SHARED_NATIVE_API, type BezierControls, type WallSwapTuning } from '../../play-drawer/wall-swap';
import type { BoardMotionVariant, ParamSpec, ParamValues } from '../types';
import { paramOr, tuningFromParams } from './tuning-params';

/** The native lab mode these variants need (`variantAvailability`). */
export const SWAP_LOOK_LAB_MODE = 'swap-look';

/** CSS `linear`, for a side weight the look's fronts ease per hold instead. */
export const LINEAR: BezierControls = [0, 0, 1, 1];

/**
 * Everything a look variant starts from: a swap look (`SwapLookSpec`, what the
 * player runs too), plus the lab's `linear` slider. I's is the player's own
 * (`PLAYER_SWAP_LOOK`).
 */
export type LookVariantDefaults = SwapLookSpec & {
  /** 0 keeps the tuning's curves; 1 makes both side weights linear, so the fronts travel at an even pace. */
  readonly linear: number;
};

type SliderRange = Omit<ParamSpec, 'default'>;

/** Every slider a look variant can show, with its range. Keys match `WallSwapTuning`, `SwapLook` and the driver. */
const SLIDERS = {
  dimFloor: { key: 'dimFloor', label: 'Drag floor', min: 0.1, max: 0.9, step: 0.05 },
  durationMs: { key: 'durationMs', label: 'Swap length', min: 80, max: 600, step: 10, unit: 'ms' },
  outgoingEndMs: { key: 'outgoingEndMs', label: 'Outgoing gone by', min: 20, max: 400, step: 10, unit: 'ms' },
  incomingStartMs: { key: 'incomingStartMs', label: 'Incoming starts at', min: 0, max: 300, step: 10, unit: 'ms' },
  linear: { key: 'linear', label: 'Linear sweep (0 eased)', min: 0, max: 1, step: 0.25 },
  holdWindow: { key: 'holdWindow', label: 'Hold window (1 = all together)', min: 0.05, max: 1, step: 0.05 },
  lowWindow: { key: 'lowWindow', label: 'Below-floor window', min: 0.05, max: 1, step: 0.05 },
  arrivalFloorShare: {
    key: 'arrivalFloorShare',
    label: 'Arrival floor (× drag floor, 0 = one front)',
    min: 0,
    max: 1,
    step: 0.05,
  },
  climbUp: { key: 'climbUp', label: 'Climb-up order (0 sideways)', min: 0, max: 1, step: 1 },
  jitter: { key: 'jitter', label: 'Jitter', min: 0, max: 0.5, step: 0.05 },
  ghost: { key: 'ghost', label: 'Ghost glow (0 off)', min: 0, max: 1, step: 0.05 },
  markLag: { key: 'markLag', label: 'Mark trails glow', min: 0, max: 1, step: 0.05 },
  swell: { key: 'swell', label: 'Arrival swell', min: 0, max: 0.35, step: 0.01 },
  swellTail: { key: 'swellTail', label: 'Swell settle', min: 0, max: 0.6, step: 0.05 },
  focus: { key: 'focus', label: 'Arrival focus', min: 0, max: 0.35, step: 0.01 },
  focusShape: { key: 'focusShape', label: 'Focus shape (2 early, 0.5 late)', min: 0.25, max: 3, step: 0.25 },
  tighten: { key: 'tighten', label: 'Leaving tighten', min: 0, max: 0.8, step: 0.05 },
  topBoost: { key: 'topBoost', label: 'Top swells most', min: 0, max: 1, step: 0.1 },
  sharedFloor: { key: 'sharedFloor', label: 'Shared floor (1 = never dip)', min: 0, max: 1, step: 0.05 },
  runWindowMs: { key: 'runWindowMs', label: 'Flick run window (0 off)', min: 0, max: 800, step: 10, unit: 'ms' },
  runSwapMs: { key: 'runSwapMs', label: 'Flick run swap (0 same)', min: 0, max: 300, step: 10, unit: 'ms' },
} as const satisfies Record<string, SliderRange>;

export type LookSliderKey = keyof typeof SLIDERS;

/** A slider, optionally relabelled for this variant. */
export type LookSlider = LookSliderKey | { key: LookSliderKey; label: string };

function defaultFor(key: LookSliderKey, defaults: LookVariantDefaults): number {
  switch (key) {
    case 'dimFloor':
    case 'durationMs':
    case 'outgoingEndMs':
    case 'incomingStartMs':
      return defaults.tuning[key];
    case 'climbUp':
      return defaults.look.climbUp ? 1 : 0;
    case 'sharedFloor':
    case 'runWindowMs':
    case 'runSwapMs':
    case 'arrivalFloorShare':
    case 'linear':
      return defaults[key];
    default:
      return defaults.look[key];
  }
}

/** The look's own numbers from slider values; anything without a slider keeps the variant's default. */
export function lookFromParams(params: ParamValues, defaults: LookVariantDefaults): SwapLookSpec['look'] {
  const base = defaults.look;
  const lookParam = (key: Exclude<keyof SwapLook, 'floor' | 'arrivalFloor' | 'climbUp'>) =>
    paramOr(params, key, base[key]);
  return {
    holdWindow: lookParam('holdWindow'),
    lowWindow: lookParam('lowWindow'),
    climbUp: paramOr(params, 'climbUp', base.climbUp ? 1 : 0) >= 0.5,
    jitter: lookParam('jitter'),
    ghost: lookParam('ghost'),
    markLag: lookParam('markLag'),
    swell: lookParam('swell'),
    swellTail: lookParam('swellTail'),
    focus: lookParam('focus'),
    focusShape: lookParam('focusShape'),
    tighten: lookParam('tighten'),
    topBoost: lookParam('topBoost'),
  };
}

function towardLinear(curve: BezierControls, amount: number): BezierControls {
  return [
    curve[0] + (LINEAR[0] - curve[0]) * amount,
    curve[1] + (LINEAR[1] - curve[1]) * amount,
    curve[2] + (LINEAR[2] - curve[2]) * amount,
    curve[3] + (LINEAR[3] - curve[3]) * amount,
  ];
}

/** The swap look a variant runs with these slider values; anything without a slider keeps its default. */
export function lookSpecFromParams(params: ParamValues, defaults: LookVariantDefaults): SwapLookSpec {
  return {
    tuning: lookVariantTuning(params, defaults),
    look: lookFromParams(params, defaults),
    arrivalFloorShare: paramOr(params, 'arrivalFloorShare', defaults.arrivalFloorShare),
    sharedFloor: paramOr(params, 'sharedFloor', defaults.sharedFloor),
    runWindowMs: paramOr(params, 'runWindowMs', defaults.runWindowMs),
    runSwapMs: paramOr(params, 'runSwapMs', defaults.runSwapMs),
    ghostDrag: defaults.ghostDrag,
    calmRuns: defaults.calmRuns,
  };
}

/** The transition a look variant runs with these slider values: the player's builder, so both run the same code. */
export function lookTransition(params: ParamValues, defaults: LookVariantDefaults): BoardTransition {
  return swapLookTransition(lookSpecFromParams(params, defaults));
}

/** Each look variant's defaults, for tests and the preview renderer. */
const DEFAULTS = new WeakMap<BoardMotionVariant, LookVariantDefaults>();

/** What `variant` was built from, or undefined when it is not a look variant. */
export function lookVariantDefaults(variant: BoardMotionVariant): LookVariantDefaults | undefined {
  return DEFAULTS.get(variant);
}

/** The full tuning a look variant runs with these slider values (curves included). */
export function lookVariantTuning(params: ParamValues, defaults: LookVariantDefaults): WallSwapTuning {
  const tuning = tuningFromParams(params, defaults.tuning);
  const linear = paramOr(params, 'linear', defaults.linear);
  if (!(linear > 0)) return tuning;
  const amount = linear < 1 ? linear : 1;
  return { ...tuning, easeIn: towardLinear(tuning.easeIn, amount), easeOut: towardLinear(tuning.easeOut, amount) };
}

export function lookVariant(spec: {
  id: string;
  letter: string;
  name: string;
  summary: string;
  defaults: LookVariantDefaults;
  sliders: readonly LookSlider[];
  /** The Bold preset: slider values over the defaults. Every key must be one of `sliders`. */
  bold: Readonly<Partial<Record<LookSliderKey, number>>>;
}): BoardMotionVariant {
  const { defaults } = spec;
  const sliderKeys = spec.sliders.map((slider) => (typeof slider === 'string' ? slider : slider.key));
  for (const key of Object.keys(spec.bold)) {
    if (!sliderKeys.some((sliderKey) => sliderKey === key)) {
      throw new Error(`${spec.id}: the Bold preset sets ${key}, which has no slider`);
    }
  }
  const params: ParamSpec[] = spec.sliders.map((slider) => {
    const key = typeof slider === 'string' ? slider : slider.key;
    const range = SLIDERS[key];
    return {
      ...range,
      ...(typeof slider === 'string' ? null : { label: slider.label }),
      default: defaultFor(key, defaults),
    };
  });
  const variant: BoardMotionVariant = {
    id: spec.id,
    letter: spec.letter,
    name: spec.name,
    summary: spec.summary,
    params,
    boldParams: { ...Object.fromEntries(params.map((param) => [param.key, param.default])), ...spec.bold },
    createTransition: (values) => lookTransition(values, defaults),
    requiresNativeApi: WALL_SWAP_SHARED_NATIVE_API,
    requiresNativeLab: SWAP_LOOK_LAB_MODE,
  };
  DEFAULTS.set(variant, defaults);
  return variant;
}
