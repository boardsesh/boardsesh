/**
 * How the moving frost changes climbs: the board's swap look at pill scale
 * ("option I"). The native views (`BokehMotion.swift`, `BokehMotion.kt` in
 * `packages/mobile/modules/frosted-bokeh-gpu`) run these rules every frame;
 * this file is their reference, so the numbers and the tests live in one place.
 * Change a rule here, then in both native files.
 *
 * - While the climber drags the board, the frost follows the board's own swap
 *   frames. Each light changes over its own window of its side's progress, keyed
 *   by its x in the pill: the leaving climb dims to the look's floor from the
 *   edge the next climb comes in from, and pulls its radius in (`tighten`);
 *   the arriving climb shows behind that front as glow-only ghosts.
 * - On release the board's frames carry the swap's own weights and timing
 *   (220 ms, old lights gone by 150 ms; a flick run's 140 ms), so the frost
 *   mirrors commits, cancels and reversals without timing of its own.
 * - A light lit in both climbs (same hold id, or within
 *   `BOKEH_SAME_HOLD_POINTS` with the same colour) stays whole.
 * - With no frames (the Next button, a queue tap, a crewmate's change, a
 *   binary or board without the swap) the frost runs the release on its own:
 *   old lights out by `BOKEH_SWAP_OUT_MS` (smoothstep), new ones filling from
 *   the right edge over `BOKEH_SWAP_MS`, shared lights held.
 * - A frame naming a page the app has not sent yet (a flick run outpacing the
 *   JS thread) keeps the last frame the view could draw until the page arrives.
 * - Reduce Motion: the wall button draws a still frost, so none of this runs;
 *   the native view's `reduceMotion` only stops the breathing.
 *
 * The native view draws at most `MAX_GPU_BOKEH_LIGHTS`, keeping the strongest.
 *
 * Nothing in the app calls these functions: the native views run the rules.
 * They are the reference the native tests are held to: the golden vectors in
 * `__tests__/swap.test.ts` are the same numbers `BokehMotionTest.kt` pins.
 */

/** A standalone release: new lights fill along the sweep over this long. */
export const BOKEH_SWAP_MS = 220;
/** A standalone release: old lights are gone by here. */
export const BOKEH_SWAP_OUT_MS = 150;
/** Without hold ids, two lights this close (pill points) with the same colour are one hold. */
export const BOKEH_SAME_HOLD_POINTS = 6;
/** What the native view draws at most: `MAX_BOKEH_BLOBS` for each of two climbs. */
export const MAX_GPU_BOKEH_LIGHTS = 30;
/** A side whose weight jumps by this much in one update arrived without a swap: run the release. */
export const BOKEH_ABRUPT_STEP = 0.5;

const TAU = Math.PI * 2;

function clampUnit(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

function smooth(value: number): number {
  const unit = clampUnit(value);
  return unit * unit * (3 - 2 * unit);
}

/** PCG hash of a hold id to 0..<1, as `ClimbOverlaySwapLook.entropy`. */
function idHash(id: number): number {
  let hash = (Math.imul(id >>> 0, 747_796_405) + 2_891_336_453) >>> 0;
  hash = Math.imul(((hash >>> ((hash >>> 28) + 4)) ^ hash) >>> 0, 277_803_737) >>> 0;
  hash = ((hash >>> 22) ^ hash) >>> 0;
  return (hash >>> 8) / (1 << 24);
}

/**
 * A light's breathing phase, 0..<2π: from its hold id, or from its position
 * when there is none. The shader used the light's slot, so a light jumped
 * whenever the lights before it changed; a seed follows the hold.
 */
export function bokehSeed(light: { x: number; y: number; id?: number }): number {
  if (light.id !== undefined && Number.isFinite(light.id)) return idHash(Math.trunc(light.id)) * TAU;
  const wave = Math.sin(light.x * 12.9898 + light.y * 78.233) * 43758.5453;
  return (wave - Math.floor(wave)) * TAU;
}

/** A hex colour's channels, 0 to 1 (`#RGB` or `#RRGGBB`), as the native views parse it. */
function channels(hex: string): [number, number, number] {
  let clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) clean = clean.replace(/./g, (digit) => digit + digit);
  const value = Number.parseInt(clean.slice(0, 6), 16);
  const packed = Number.isFinite(value) ? value : 0;
  return [((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255];
}

/**
 * Two lights are one hold: the same colour (each channel within 0.02) and the
 * same id, or, without ids, within 6 points.
 */
export function sameBokehHold(
  first: { x: number; y: number; color: string; id?: number },
  second: { x: number; y: number; color: string; id?: number },
): boolean {
  const firstChannels = channels(first.color);
  const secondChannels = channels(second.color);
  if (firstChannels.some((channel, index) => Math.abs(channel - (secondChannels[index] ?? 0)) >= 0.02)) return false;
  if (first.id !== undefined && second.id !== undefined) return first.id === second.id;
  return Math.hypot(first.x - second.x, first.y - second.y) < BOKEH_SAME_HOLD_POINTS;
}

/**
 * The numbers of the board's swap look the frost uses, from the same 15-number
 * `swapLook` the board takes (`encodeSwapLook`), clamped as the board clamps
 * them. The frost has no marks, so `markLag` is unused; it keys by x, so
 * `climbUp` and `jitter` are unused too.
 */
export type FrostSwapLook = {
  holdWindow: number;
  lowWindow: number;
  floor: number;
  arrivalFloor: number;
  ghost: number;
  swell: number;
  swellTail: number;
  focus: number;
  focusShape: number;
  tighten: number;
  topBoost: number;
};

const LOOK_FORMAT = 2;
const LOOK_FIELDS = 15;

/** The board's `ClimbOverlaySwapLook.Look(values)`, or null for a look it would reject. */
export function parseFrostSwapLook(values: readonly number[] | null | undefined): FrostSwapLook | null {
  if (!values || values.length !== LOOK_FIELDS || values[0] !== LOOK_FORMAT) return null;
  if (!values.every((value) => Number.isFinite(value))) return null;
  const number = (index: number, low: number, high: number) => Math.min(high, Math.max(low, values[index] ?? 0));
  const swell = number(9, 0, 0.35);
  const swellTail = Math.max(number(10, 0, 0.6), swell > 0 ? 0.05 : 0);
  const holdWindow = swell > 0 ? Math.min(number(1, 0.05, 1), 1 - swellTail) : number(1, 0.05, 1);
  return {
    holdWindow,
    lowWindow: number(2, 0.05, 1),
    floor: number(3, 0, 0.95),
    arrivalFloor: number(4, 0, 0.95),
    ghost: number(7, 0, 1),
    swell,
    swellTail,
    focus: number(11, 0, 0.35),
    focusShape: number(12, 0.25, 3),
    tighten: number(13, 0, 0.8),
    topBoost: number(14, 0, 1),
  };
}

/**
 * A light's order key, 0 changes first as its side's weight rises (and last as
 * it falls): 0 at the edge its climb enters from. `across` is its x over the
 * pill's width.
 */
export function frostSweepKey(across: number, fromRight: boolean): number {
  const unit = clampUnit(across);
  return fromRight ? 1 - unit : unit;
}

function frontWindow(progress: number, key: number, width: number, tail: number): number {
  const lead = Math.max(0, 1 - width - tail);
  return clampUnit((progress - key * lead) / width);
}

function frontEase(local: number, width: number): number {
  const smoothed = local * local * (3 - 2 * local);
  return local + (smoothed - local) * (1 - width);
}

/** One light's weight when its side is at `weight`: the board's `ClimbOverlaySwapLook.lit`. */
export function frostLightWeight(weight: number, key: number, arriving: boolean, look: FrostSwapLook): number {
  const side = clampUnit(weight);
  const floor = arriving ? look.arrivalFloor : look.floor;
  if (side >= floor) {
    const span = 1 - floor;
    const progress = span > 0 ? (side - floor) / span : 1;
    const local = frontWindow(progress, key, look.holdWindow, arriving ? look.swellTail : 0);
    return floor + span * frontEase(local, look.holdWindow);
  }
  const local = frontWindow(floor > 0 ? side / floor : 1, key, look.lowWindow, 0);
  return floor * frontEase(local, look.lowWindow);
}

function swellAt(weight: number, key: number, look: FrostSwapLook): number {
  const floor = look.arrivalFloor;
  if (!(look.swell > 0) || weight <= floor || weight >= 1) return 0;
  const progress = (weight - floor) / (1 - floor);
  const span = look.holdWindow + look.swellTail;
  const local = clampUnit((progress - key * Math.max(0, 1 - span)) / span);
  const peak = look.holdWindow / span;
  const shape = local < peak ? smooth(local / peak) : 1 - smooth((local - peak) / (1 - peak));
  return look.swell * (1 + (key - 1) * look.topBoost) * shape;
}

/** The frost's radius stays inside these shares of a light's own. */
export const FROST_MIN_REACH = 0.6;
export const FROST_MAX_REACH = 1.35;

/**
 * A light's peak and radius multipliers at per-light weight `weight`: the
 * board's glow and reach (`ClimbOverlaySwapLook.shaped`), without the mark.
 * An arriving climb below its floor is a ghost, up to `ghost`; a leaving one
 * pulls in by `tighten` as it fades.
 */
export function frostLightShape(
  weight: number,
  key: number,
  arriving: boolean,
  calm: boolean,
  look: FrostSwapLook,
): { glow: number; reach: number } {
  if (!(weight > 0)) return { glow: 0, reach: 1 };
  let glow = weight;
  if (arriving && look.ghost > 0 && look.arrivalFloor > 0) {
    glow =
      weight <= look.arrivalFloor
        ? (weight * look.ghost) / look.arrivalFloor
        : look.ghost + ((1 - look.ghost) * (weight - look.arrivalFloor)) / (1 - look.arrivalFloor);
  }
  const missing = 1 - weight;
  const base = arriving ? 1 + look.focus * missing ** look.focusShape : 1 - look.tighten * missing;
  const grown = arriving && !calm ? base * (1 + swellAt(weight, key, look)) : base;
  return { glow, reach: Math.min(FROST_MAX_REACH, Math.max(FROST_MIN_REACH, grown)) };
}

/**
 * A standalone release's ceiling on one arriving light, `elapsedMs` in: each
 * light fills over half the release, starting up to half a release late in
 * sweep order from the right edge.
 */
export function frostReleaseFill(across: number, elapsedMs: number): number {
  const half = BOKEH_SWAP_MS / 2;
  const key = frostSweepKey(across, true);
  return smooth((elapsedMs - key * half) / half);
}

/** A standalone release's share left of an old light, `elapsedMs` in. */
export function frostReleaseFade(elapsedMs: number): number {
  return 1 - smooth(elapsedMs / BOKEH_SWAP_OUT_MS);
}

/** At most `max` lights, the strongest by peak, in their drawing order. */
export function capBokehLights<Light extends { peak: number }>(
  lights: readonly Light[],
  max = MAX_GPU_BOKEH_LIGHTS,
): Light[] {
  if (lights.length <= max) return [...lights];
  const keep = new Set(
    lights
      .map((light, index) => ({ peak: light.peak, index }))
      .sort((first, second) => second.peak - first.peak || first.index - second.index)
      .slice(0, max)
      .map(({ index }) => index),
  );
  return lights.filter((_, index) => keep.has(index));
}
