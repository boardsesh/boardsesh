/**
 * Reset matching: which of yesterday's holds are still on the wall.
 *
 * The input is two sets of circles in the wall's CANONICAL frame — last
 * published version's alive holds, and what the detector (or the climber's own
 * taps) found in the new photo. Both photos have already been mapped through
 * their own homography, which is the only reason two pictures taken from
 * different spots can be compared at all.
 *
 * ## Why a moved hold is removed + added
 *
 * Climbs reference POSITIONS. A hold unbolted and re-bolted 40 cm to the left is
 * not the hold that climb used any more — every climb through it now asks the
 * climber to reach somewhere the wall no longer has anything. Calling it "the
 * same hold, moved" would silently rewrite every one of those climbs into a
 * different problem and leave their grades and ticks attached. So the matcher
 * reports it as one removal and one addition, the climbs that used it get a
 * missing-hold count and a badge, and {@link suggestMoves} offers the pairing to
 * the review UI so a remix can start from the successor.
 */
import { INFEASIBLE, solveAssignment } from './hungarian';

/** A circle on the wall, in canonical coordinates. */
export interface WallCircle {
  cx: number;
  cy: number;
  r: number;
  /**
   * Optional colour descriptor — `@boardsesh/hold-detection`'s `describeColour`
   * produces one. Any equal-length numeric vector works; the term is dropped and
   * the weights renormalised when either side is missing it.
   */
  colour?: readonly number[];
}

export interface AliveHold extends WallCircle {
  holdId: string;
}

export interface MatchWeights {
  centroid: number;
  iou: number;
  colour: number;
}

export interface MatchOptions {
  /**
   * How far apart two centres may be, as a fraction of the pair's mean radius.
   * 0.6 of a radius is well inside the hold: two neighbouring bolts on a spray
   * wall are rarely closer than two radii apart, so this refuses to call a hold
   * its own neighbour even on the densest wall.
   */
  distanceGate?: number;
  /** Minimum circle IoU for a pair to be considered at all. */
  iouGate?: number;
  weights?: Partial<MatchWeights>;
  /**
   * A second candidate inside BOTH gates makes the match low confidence, and
   * this is how much worse that runner-up may be before it stops counting. 1.5
   * means "the next best option costs less than half again as much".
   */
  ambiguityRatio?: number;
}

export interface KeptHold {
  holdId: string;
  detectionIndex: number;
  /** `1 - cost`, clamped to 0..1. 1 is a perfect overlap of identical colours. */
  confidence: number;
}

export interface MatchResult {
  kept: KeptHold[];
  /** Hold ids with no detection inside the gates. */
  removed: string[];
  /** Detection indices that matched nothing that was already on the wall. */
  added: number[];
  /**
   * Kept holds a human should look at: a second detection sat inside the gates
   * and nearly as close, so the assignment could plausibly have gone the other
   * way.
   */
  lowConfidence: string[];
}

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = { centroid: 0.5, iou: 0.3, colour: 0.2 };
export const DEFAULT_DISTANCE_GATE = 0.6;
export const DEFAULT_IOU_GATE = 0.3;
const DEFAULT_AMBIGUITY_RATIO = 1.5;

/** How far a removed hold's successor may sit, in radii, for a move suggestion. */
export const DEFAULT_MOVE_RADII = 3;

/**
 * Area of overlap of two circles over the area of their union.
 *
 * Analytic rather than sampled: the circular-segment formula is exact, cheap and
 * has no resolution to tune, and the whole matcher is circles.
 */
export function circleIou(a: WallCircle, b: WallCircle): number {
  const distance = Math.hypot(a.cx - b.cx, a.cy - b.cy);
  const radiusA = Math.max(0, a.r);
  const radiusB = Math.max(0, b.r);
  if (radiusA === 0 || radiusB === 0) return 0;
  if (distance >= radiusA + radiusB) return 0;

  const areaA = Math.PI * radiusA * radiusA;
  const areaB = Math.PI * radiusB * radiusB;
  if (distance <= Math.abs(radiusA - radiusB)) {
    // One circle inside the other: the overlap is the smaller one entirely.
    return Math.min(areaA, areaB) / Math.max(areaA, areaB);
  }

  const angleA =
    2 * Math.acos((distance * distance + radiusA * radiusA - radiusB * radiusB) / (2 * distance * radiusA));
  const angleB =
    2 * Math.acos((distance * distance + radiusB * radiusB - radiusA * radiusA) / (2 * distance * radiusB));
  const intersection =
    0.5 * radiusA * radiusA * (angleA - Math.sin(angleA)) + 0.5 * radiusB * radiusB * (angleB - Math.sin(angleB));
  return intersection / (areaA + areaB - intersection);
}

/**
 * Distance between two colour descriptors of the SAME length, normalised to
 * roughly 0..1.
 *
 * The Lab triple is divided by 100 — Lab's lightness axis runs 0..100 and the
 * chroma axes rarely leave ±100 — so a black hold against a white one scores
 * about 1 and the term cannot swamp the geometry it is meant to break ties in.
 *
 * Two descriptors of different lengths are not comparable — a Lab-only vector
 * against a Lab-plus-hue-histogram one would be scored on the three axes they
 * share and silently read as a close match. `pairCost` refuses such a pair's
 * colour term rather than asking for a number here.
 */
export function colourDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`colourDistance needs descriptors of equal length, got ${a.length} and ${b.length}`);
  }
  const length = a.length;
  if (length === 0) return 0;
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    const difference = index < 3 ? (a[index] - b[index]) / 100 : a[index] - b[index];
    total += difference * difference;
  }
  return Math.min(1, Math.sqrt(total));
}

/** The two hard gates a pair has to clear before it is a candidate at all. */
export interface MatchGates {
  distanceGate: number;
  iouGate: number;
}

/**
 * What it costs to call `detection` the same hold as `hold`, in 0..1, or
 * {@link INFEASIBLE} when either gate refuses the pair.
 */
export function pairCost(hold: WallCircle, detection: WallCircle, weights: MatchWeights, gates: MatchGates): number {
  const meanRadius = (Math.max(0, hold.r) + Math.max(0, detection.r)) / 2;
  if (meanRadius <= 0) return INFEASIBLE;

  const distance = Math.hypot(hold.cx - detection.cx, hold.cy - detection.cy);
  const overlap = circleIou(hold, detection);
  if (distance >= gates.distanceGate * meanRadius || overlap <= gates.iouGate) return INFEASIBLE;

  const holdColour = hold.colour;
  const detectionColour = detection.colour;
  // Equal lengths too: a wall whose old holds carry a Lab-plus-hue descriptor and
  // whose new detections carry Lab alone has no colour comparison to make, and
  // scoring the axes they happen to share would invent agreement.
  const hasColour =
    holdColour !== undefined && detectionColour !== undefined && holdColour.length === detectionColour.length;
  // With no colour to compare, the two geometric terms are renormalised to carry
  // the whole cost, so the result stays on the same 0..1 scale as a matched pair
  // that did have colour — the gates and the ambiguity ratio are both expressed
  // on that scale. A pair WITH matching colours still scores lower than the same
  // geometry without any: an agreeing colour is evidence, and it should count.
  const total = hasColour ? weights.centroid + weights.iou + weights.colour : weights.centroid + weights.iou;
  if (total <= 0) return INFEASIBLE;

  let cost = weights.centroid * (distance / meanRadius) + weights.iou * (1 - overlap);
  if (hasColour) cost += weights.colour * colourDistance(holdColour, detectionColour);
  return cost / total;
}

/**
 * Match the holds that survived a reset.
 *
 * Both gates have to pass before a pair is even a candidate, and the assignment
 * then minimises the total cost over the pairs that remain. Anything left over
 * is a removal or an addition.
 */
export function matchHolds(
  previousAlive: readonly AliveHold[],
  detections: readonly WallCircle[],
  options: MatchOptions = {},
): MatchResult {
  const weights: MatchWeights = { ...DEFAULT_MATCH_WEIGHTS, ...options.weights };
  const gates: MatchGates = {
    distanceGate: options.distanceGate ?? DEFAULT_DISTANCE_GATE,
    iouGate: options.iouGate ?? DEFAULT_IOU_GATE,
  };
  const ambiguityRatio = options.ambiguityRatio ?? DEFAULT_AMBIGUITY_RATIO;

  const costs: number[][] = previousAlive.map((hold) =>
    detections.map((detection) => pairCost(hold, detection, weights, gates)),
  );

  const assignment = solveAssignment(costs);
  const kept: KeptHold[] = [];
  const removed: string[] = [];
  const lowConfidence: string[] = [];

  previousAlive.forEach((hold, row) => {
    const column = assignment.rowToColumn[row] ?? -1;
    if (column < 0) {
      removed.push(hold.holdId);
      return;
    }
    const cost = costs[row][column];
    kept.push({ holdId: hold.holdId, detectionIndex: column, confidence: Math.max(0, Math.min(1, 1 - cost)) });

    // A runner-up inside both gates and nearly as cheap means the assignment
    // could have gone the other way — exactly the case a reviewer should see.
    const runnerUp = costs[row].reduce(
      (best, value, index) => (index === column || value >= INFEASIBLE ? best : Math.min(best, value)),
      Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(runnerUp) && runnerUp <= Math.max(cost, Number.EPSILON) * ambiguityRatio) {
      lowConfidence.push(hold.holdId);
    }
  });

  // `?? -1` rather than a bare lookup: with no previous holds at all the solver
  // returns empty arrays, and `undefined < 0` is false — which would report a
  // brand-new wall as having added nothing.
  const added = detections.map((_, index) => index).filter((index) => (assignment.columnToRow[index] ?? -1) < 0);
  return { kept, removed, added, lowConfidence };
}

export interface MoveSuggestion {
  /** The hold the review UI would write as `movedFromHoldId`. */
  movedFromHoldId: string;
  /** Index into the same `detections` array `matchHolds` was given. */
  detectionIndex: number;
  /** Centre-to-centre distance, in canonical pixels. */
  distance: number;
}

export interface SuggestMovesOptions {
  /** How far a successor may sit, in mean radii. */
  withinRadii?: number;
}

/**
 * Pair each removed hold with the nearest added detection, for the review UI.
 *
 * Strictly a suggestion: the result changes nothing about what
 * {@link matchHolds} reported. A climber looking at "12 holds came off, 14 went
 * on" wants to be told that four of those are the same hold shuffled along the
 * wall, and a remix wants somewhere to start. Greedy nearest-first is the right
 * algorithm here, unlike in the matcher — a suggestion that is sometimes the
 * second-best pairing costs a tap, not a wrong database row.
 */
export function suggestMoves(
  previousAlive: readonly AliveHold[],
  detections: readonly WallCircle[],
  result: MatchResult,
  options: SuggestMovesOptions = {},
): MoveSuggestion[] {
  const withinRadii = options.withinRadii ?? DEFAULT_MOVE_RADII;
  const holdsById = new Map(previousAlive.map((hold) => [hold.holdId, hold]));

  const candidates: MoveSuggestion[] = [];
  for (const holdId of result.removed) {
    const hold = holdsById.get(holdId);
    if (!hold) continue;
    for (const detectionIndex of result.added) {
      const detection = detections[detectionIndex];
      if (!detection) continue;
      const meanRadius = (Math.max(0, hold.r) + Math.max(0, detection.r)) / 2;
      const distance = Math.hypot(hold.cx - detection.cx, hold.cy - detection.cy);
      if (meanRadius <= 0 || distance > withinRadii * meanRadius) continue;
      candidates.push({ movedFromHoldId: holdId, detectionIndex, distance });
    }
  }

  candidates.sort((left, right) => left.distance - right.distance);
  const usedHolds = new Set<string>();
  const usedDetections = new Set<number>();
  const suggestions: MoveSuggestion[] = [];
  for (const candidate of candidates) {
    if (usedHolds.has(candidate.movedFromHoldId) || usedDetections.has(candidate.detectionIndex)) continue;
    usedHolds.add(candidate.movedFromHoldId);
    usedDetections.add(candidate.detectionIndex);
    suggestions.push(candidate);
  }
  return suggestions;
}
