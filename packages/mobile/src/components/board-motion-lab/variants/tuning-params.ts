/**
 * The wall swap's numbers (`WallSwapTuning`) as lab sliders and back. Shared by
 * the variants built on the wall-swap driver.
 */
import { WALL_SWAP, type BezierControls, type WallSwapTuning } from '../../play-drawer/wall-swap';
import type { ParamSpec, ParamValues } from '../types';

/** A slider value, or the tuning's own when the slider is missing or not a number. */
export function paramOr(params: ParamValues, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function curveFrom(params: ParamValues, prefix: string, fallback: BezierControls): BezierControls {
  return [
    paramOr(params, `${prefix}X1`, fallback[0]),
    paramOr(params, `${prefix}Y1`, fallback[1]),
    paramOr(params, `${prefix}X2`, fallback[2]),
    paramOr(params, `${prefix}Y2`, fallback[3]),
  ];
}

/** `base` with every number a slider sets replaced; unset sliders keep `base`'s. */
export function tuningFromParams(params: ParamValues, base: WallSwapTuning = WALL_SWAP): WallSwapTuning {
  return {
    dimFloor: paramOr(params, 'dimFloor', base.dimFloor),
    durationMs: paramOr(params, 'durationMs', base.durationMs),
    outgoingEndMs: paramOr(params, 'outgoingEndMs', base.outgoingEndMs),
    incomingStartMs: paramOr(params, 'incomingStartMs', base.incomingStartMs),
    reduceMotionDurationMs: paramOr(params, 'reduceMotionDurationMs', base.reduceMotionDurationMs),
    settleMs: paramOr(params, 'settleMs', base.settleMs),
    leadInMs: paramOr(params, 'leadInMs', base.leadInMs),
    pullBackPoints: paramOr(params, 'pullBackPoints', base.pullBackPoints),
    pairLean: paramOr(params, 'pairLean', base.pairLean),
    easeIn: curveFrom(params, 'easeIn', base.easeIn),
    easeOut: curveFrom(params, 'easeOut', base.easeOut),
  };
}

function curveSliders(prefix: string, name: string, curve: BezierControls): ParamSpec[] {
  const points = ['X1', 'Y1', 'X2', 'Y2'] as const;
  return points.map((point, index) => ({
    key: `${prefix}${point}`,
    label: `${name} ${point.toLowerCase()}`,
    min: 0,
    max: 1,
    step: 0.01,
    default: curve[index],
  }));
}

/** One slider per number of the wall swap, each starting at `WALL_SWAP`'s value. */
export const WALL_SWAP_PARAMS: readonly ParamSpec[] = [
  { key: 'dimFloor', label: 'Dim floor', min: 0, max: 1, step: 0.05, default: WALL_SWAP.dimFloor },
  { key: 'durationMs', label: 'Swap length', min: 40, max: 1000, step: 10, default: WALL_SWAP.durationMs, unit: 'ms' },
  {
    key: 'outgoingEndMs',
    label: 'Outgoing gone by',
    min: 10,
    max: 1000,
    step: 10,
    default: WALL_SWAP.outgoingEndMs,
    unit: 'ms',
  },
  {
    key: 'incomingStartMs',
    label: 'Incoming starts at',
    min: 0,
    max: 1000,
    step: 10,
    default: WALL_SWAP.incomingStartMs,
    unit: 'ms',
  },
  {
    key: 'reduceMotionDurationMs',
    label: 'Reduce Motion dissolve',
    min: 20,
    max: 600,
    step: 10,
    default: WALL_SWAP.reduceMotionDurationMs,
    unit: 'ms',
  },
  { key: 'settleMs', label: 'Settle', min: 20, max: 600, step: 10, default: WALL_SWAP.settleMs, unit: 'ms' },
  { key: 'leadInMs', label: 'Lead-in', min: 20, max: 600, step: 10, default: WALL_SWAP.leadInMs, unit: 'ms' },
  {
    key: 'pullBackPoints',
    label: 'Pull-back distance',
    min: 0,
    max: 40,
    step: 1,
    default: WALL_SWAP.pullBackPoints,
    unit: 'pt',
  },
  // Below 0.5, or the page position would name the arriving climb as the one being left.
  { key: 'pairLean', label: 'Pair lean', min: 0.05, max: 0.45, step: 0.05, default: WALL_SWAP.pairLean },
  ...curveSliders('easeIn', 'Outgoing curve', WALL_SWAP.easeIn),
  ...curveSliders('easeOut', 'Incoming curve', WALL_SWAP.easeOut),
];
