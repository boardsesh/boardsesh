// The rest-length domain as a rail, and the two rules that keep it honest. Pure
// — no React, no react-native — so the arithmetic is unit-testable without a
// native tree.
//
// Why a rail at all: `Off · 1:00 · 2:00 · 3:00 · 5:00 · Custom` plus a revealed
// stepper was TWO controls for one number, and they could disagree — Custom
// stepped onto 1:00 left the segment pinned to Custom, and the stepper's value
// was raw seconds ("60") while every segment beside it read `1:00`. On a rail
// every rest length the climber can pick is one tap and the VALUE IS THE LABEL,
// so there is nothing left for the two halves to lie to each other about.

import { formatRestTimerElapsed } from '../../lib/rest-timer';

/**
 * Every one-tap rest length, ascending. Fine-grained where climbers actually
 * live (15 s steps to 3:00 — the working range for limit bouldering), coarser as
 * the rest gets long enough that 15 s stops mattering: 30 s steps to 5:00, a
 * minute to 10:00, then the long recoveries a power-endurance or max-strength
 * block wants.
 */
export const REST_LENGTH_RAIL_SECONDS: readonly number[] = [
  15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 210, 240, 270, 300, 360, 420, 480, 540, 600, 720, 900, 1200,
  1800, 2700, 3600,
];

/** The head chip's id. 0 is not a legal rest length, so it can never collide
 *  with a real one — which lets the whole rail be keyed by seconds. */
export const REST_LENGTH_OFF = 0;

/**
 * The rail's chips for a given persisted rest length.
 *
 * A value that is not on the rail is SPLICED IN at its sorted position rather
 * than snapped to the nearest chip. Someone who set 100 s through the old
 * stepper (or who lands here from a future rail with a different domain) must
 * see their own rest length selected — silently rewriting a persisted setting
 * because the UI was redesigned underneath it is the one thing this control is
 * not allowed to do. Same rule, same shape, as the generator card's minAscents.
 */
export function restLengthRailSeconds(persistedSeconds: number | null): number[] {
  const base = [...REST_LENGTH_RAIL_SECONDS];
  if (persistedSeconds === null || !Number.isFinite(persistedSeconds) || persistedSeconds <= 0) return base;
  if (base.includes(persistedSeconds)) return base;
  return [...base, persistedSeconds].sort((first, second) => first - second);
}

/**
 * A chip's label.
 *
 * `formatRestTimerElapsed`, never `formatRestTimerTarget`: the compact target
 * format collapses whole minutes to `2m`, so a rail built from it would carry
 * TWO notations side by side (`1:15 · 2m · 2:15`) and no consistent column of
 * digits to scan. One notation, one width per digit count.
 */
export function formatRestLengthChipLabel(seconds: number): string {
  return formatRestTimerElapsed(seconds);
}

/** Whether a persisted setting counts as a real rest length. `Off` (null) has no
 *  deadline, and neither does a zero — both mean "count up instead". */
export function hasRestLength(targetSeconds: number | null): targetSeconds is number {
  return targetSeconds !== null && Number.isFinite(targetSeconds) && targetSeconds > 0;
}
