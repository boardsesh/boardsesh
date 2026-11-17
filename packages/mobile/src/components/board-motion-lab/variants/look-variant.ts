/**
 * The swap-look variants (D onward): each is the wall swap's state machine with
 * its own timing, plus a native swap look (`play-drawer/swap-look.ts`) and the
 * look driver (`look-driver.ts`). One factory, so every variant gets the same
 * slider names, ranges and plumbing; a variant lists which sliders it shows and
 * its defaults.
 */
import type { BoardTransition } from '../../play-drawer/board-transition';
import type { SwapLook } from '../../play-drawer/swap-look';
import { WALL_SWAP_SHARED_NATIVE_API, type BezierControls, type WallSwapTuning } from '../../play-drawer/wall-swap';
import type { BoardMotionVariant, ParamSpec, ParamValues } from '../types';
import { swapLookDriver } from './look-driver';
import { paramOr, tuningFromParams } from './tuning-params';

/** The native lab mode these variants need (`variantAvailability`). */
export const SWAP_LOOK_LAB_MODE = 'swap-look';

/** CSS `linear`, for a side weight the look's fronts ease per hold instead. */
export const LINEAR: BezierControls = [0, 0, 1, 1];

/** Everything a look variant starts from. The look's floor is always the tuning's `dimFloor`. */
export type LookVariantDefaults = {
  tuning: WallSwapTuning;
  look: Omit<SwapLook, 'floor'>;
  sharedFloor: number;
  runWindowMs: number;
  runSwapMs: number;
  /** E: the arriving climb rises with the drag's dim, up to the floor (ghosts). */
  ghostDrag: boolean;
};

type SliderRange = Omit<ParamSpec, 'default'>;

/** Every slider a look variant can show, with its range. Keys match `WallSwapTuning`, `SwapLook` and the driver. */
const SLIDERS = {
  dimFloor: { key: 'dimFloor', label: 'Drag floor', min: 0.1, max: 0.9, step: 0.05 },
  durationMs: { key: 'durationMs', label: 'Swap length', min: 80, max: 600, step: 10, unit: 'ms' },
  outgoingEndMs: { key: 'outgoingEndMs', label: 'Outgoing gone by', min: 20, max: 400, step: 10, unit: 'ms' },
  incomingStartMs: { key: 'incomingStartMs', label: 'Incoming starts at', min: 0, max: 300, step: 10, unit: 'ms' },
  holdWindow: { key: 'holdWindow', label: 'Hold window (1 = all together)', min: 0.05, max: 1, step: 0.05 },
  lowWindow: { key: 'lowWindow', label: 'Below-floor window', min: 0.05, max: 1, step: 0.05 },
  climbUp: { key: 'climbUp', label: 'Climb-up order (0 sideways)', min: 0, max: 1, step: 1 },
  jitter: { key: 'jitter', label: 'Jitter', min: 0, max: 0.5, step: 0.05 },
  ghost: { key: 'ghost', label: 'Ghost glow (0 off)', min: 0, max: 1, step: 0.05 },
  markLag: { key: 'markLag', label: 'Mark trails glow', min: 0, max: 1, step: 0.05 },
  swell: { key: 'swell', label: 'Arrival swell', min: 0, max: 0.35, step: 0.01 },
  swellTail: { key: 'swellTail', label: 'Swell settle', min: 0, max: 0.6, step: 0.05 },
  focus: { key: 'focus', label: 'Arrival focus', min: 0, max: 0.35, step: 0.01 },
  tighten: { key: 'tighten', label: 'Leaving tighten', min: 0, max: 0.6, step: 0.05 },
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
      return defaults[key];
    default:
      return defaults.look[key];
  }
}

/** The look from slider values; anything without a slider keeps the variant's default. */
export function lookFromParams(params: ParamValues, defaults: LookVariantDefaults, floor: number): SwapLook {
  const base = defaults.look;
  const value = (key: Exclude<keyof SwapLook, 'floor' | 'climbUp'>) => paramOr(params, key, base[key]);
  return {
    holdWindow: value('holdWindow'),
    lowWindow: value('lowWindow'),
    floor,
    climbUp: paramOr(params, 'climbUp', base.climbUp ? 1 : 0) >= 0.5,
    jitter: value('jitter'),
    ghost: value('ghost'),
    markLag: value('markLag'),
    swell: value('swell'),
    swellTail: value('swellTail'),
    focus: value('focus'),
    tighten: value('tighten'),
    topBoost: value('topBoost'),
  };
}

/** The transition a look variant runs with these slider values. */
export function lookTransition(params: ParamValues, defaults: LookVariantDefaults): BoardTransition {
  const tuning = lookVariantTuning(params, defaults);
  return {
    revealMode: 'swap',
    driver: swapLookDriver({
      tuning,
      sharedFloor: paramOr(params, 'sharedFloor', defaults.sharedFloor),
      ghostDrag: defaults.ghostDrag,
      runWindowMs: paramOr(params, 'runWindowMs', defaults.runWindowMs),
      runSwapMs: paramOr(params, 'runSwapMs', defaults.runSwapMs),
    }),
    look: lookFromParams(params, defaults, tuning.dimFloor),
  };
}

/** Each look variant's defaults, for tests and the preview renderer. */
const DEFAULTS = new WeakMap<BoardMotionVariant, LookVariantDefaults>();

/** What `variant` was built from, or undefined when it is not a look variant. */
export function lookVariantDefaults(variant: BoardMotionVariant): LookVariantDefaults | undefined {
  return DEFAULTS.get(variant);
}

/** The full tuning a look variant runs with these slider values (curves included). */
export function lookVariantTuning(params: ParamValues, defaults: LookVariantDefaults): WallSwapTuning {
  return tuningFromParams(params, defaults.tuning);
}

export function lookVariant(spec: {
  id: string;
  letter: string;
  name: string;
  summary: string;
  defaults: LookVariantDefaults;
  sliders: readonly LookSlider[];
}): BoardMotionVariant {
  const { defaults } = spec;
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
    createTransition: (values) => lookTransition(values, defaults),
    requiresNativeApi: WALL_SWAP_SHARED_NATIVE_API,
    requiresNativeLab: SWAP_LOOK_LAB_MODE,
  };
  DEFAULTS.set(variant, defaults);
  return variant;
}
