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

  // Distance first: it is one `hypot`, where `circleIou` is two `acos` calls. On a
  // 1,500-hold wall almost every pair fails here, so the order is worth stating.
  const distance = Math.hypot(hold.cx - detection.cx, hold.cy - detection.cy);
  if (distance >= gates.distanceGate * meanRadius) return INFEASIBLE;
  const overlap = circleIou(hold, detection);
  if (overlap <= gates.iouGate) return INFEASIBLE;

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

/** One feasible pair: a hold row, a detection column, and what it costs. */
interface FeasibleEdge {
  row: number;
  column: number;
  cost: number;
}

/**
 * Disjoint-set over rows and columns together — rows at `0..rows-1`, columns
 * offset by `rows` — so one feasible edge unions the two sides it joins.
 */
function connectedComponents(rows: number, columns: number, edges: readonly FeasibleEdge[]): Map<number, number[]> {
  const parent = Array.from({ length: rows + columns }, (_, index) => index);
  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) root = parent[root];
    // Path compression, so a long chain of edges does not make the next find walk it again.
    let walk = node;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  for (const edge of edges) {
    const rowRoot = find(edge.row);
    const columnRoot = find(rows + edge.column);
    if (rowRoot !== columnRoot) parent[rowRoot] = columnRoot;
  }

  const byRoot = new Map<number, number[]>();
  for (const edge of edges) {
    const root = find(edge.row);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(edge.row, rows + edge.column);
    else byRoot.set(root, [edge.row, rows + edge.column]);
  }
  return byRoot;
}

/**
 * Match the holds that survived a reset.
 *
 * Both gates have to pass before a pair is even a candidate, and the assignment
 * then minimises the total cost over the pairs that remain. Anything left over
 * is a removal or an addition.
 *
 * ## Why this prunes before it solves
 *
 * The gates are brutal by design — 0.6 of a radius — so the feasible graph on a
 * real wall is extremely sparse: a hold has one candidate, occasionally two,
 * essentially never twenty. Handing the whole gated matrix to `solveAssignment`
 * makes it walk a cubic loop over a matrix that is almost entirely
 * {@link INFEASIBLE} filler. A full reset is the worst case and the one that
 * matters: every pair fails, nothing is assignable, and a 1,500 x 1,500 constant
 * matrix took about 19 seconds on a desktop Node — on a phone, worse, and for an
 * answer ("all removed, all added") that needs no solver at all.
 *
 * So: collect the feasible edges, hand every row and column with no edge straight
 * to `removed` / `added`, split what remains into connected components of the
 * feasible graph, and solve each component on its own. That is exact, not an
 * approximation — no feasible edge crosses components, so no optimal assignment
 * can either. A pathological wall where every hold really can match every
 * detection still costs what it always did; a real one costs nothing.
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

  // Every pair is still costed — that is 2.25M cheap arithmetic calls at the
  // 1,500-hold cap, tens of milliseconds — but only the feasible ones are kept.
  const edges: FeasibleEdge[] = [];
  const edgesByRow = new Map<number, FeasibleEdge[]>();
  previousAlive.forEach((hold, row) => {
    detections.forEach((detection, column) => {
      const cost = pairCost(hold, detection, weights, gates);
      if (cost >= INFEASIBLE) return;
      const edge: FeasibleEdge = { row, column, cost };
      edges.push(edge);
      const bucket = edgesByRow.get(row);
      if (bucket) bucket.push(edge);
      else edgesByRow.set(row, [edge]);
    });
  });

  const assignedColumnForRow = new Map<number, number>();
  const costForRow = new Map<number, number>();
  for (const nodes of connectedComponents(previousAlive.length, detections.length, edges).values()) {
    const componentRows = [...new Set(nodes.filter((node) => node < previousAlive.length))].sort((a, b) => a - b);
    const componentColumns = [
      ...new Set(nodes.filter((node) => node >= previousAlive.length).map((node) => node - previousAlive.length)),
    ].sort((a, b) => a - b);

    // A component of one hold and one detection is the overwhelmingly common
    // case; the solver would give the same answer, just slower.
    if (componentRows.length === 1 && componentColumns.length === 1) {
      const [only] = edgesByRow.get(componentRows[0]) ?? [];
      if (only) {
        assignedColumnForRow.set(only.row, only.column);
        costForRow.set(only.row, only.cost);
      }
      continue;
    }

    const rowIndex = new Map(componentRows.map((row, index) => [row, index]));
    const columnIndex = new Map(componentColumns.map((column, index) => [column, index]));
    const subMatrix = componentRows.map(() => componentColumns.map(() => INFEASIBLE));
    for (const edge of edges) {
      const subRow = rowIndex.get(edge.row);
      const subColumn = columnIndex.get(edge.column);
      if (subRow !== undefined && subColumn !== undefined) subMatrix[subRow][subColumn] = edge.cost;
    }

    const assignment = solveAssignment(subMatrix);
    assignment.rowToColumn.forEach((subColumn, subRow) => {
      if (subColumn < 0) return;
      const row = componentRows[subRow];
      assignedColumnForRow.set(row, componentColumns[subColumn]);
      costForRow.set(row, subMatrix[subRow][subColumn]);
    });
  }

  const kept: KeptHold[] = [];
  const removed: string[] = [];
  const lowConfidence: string[] = [];
  const claimedColumns = new Set(assignedColumnForRow.values());

  previousAlive.forEach((hold, row) => {
    const column = assignedColumnForRow.get(row);
    if (column === undefined) {
      removed.push(hold.holdId);
      return;
    }
    const cost = costForRow.get(row) ?? 0;
    kept.push({ holdId: hold.holdId, detectionIndex: column, confidence: Math.max(0, Math.min(1, 1 - cost)) });

    // A runner-up inside both gates and nearly as cheap means the assignment
    // could have gone the other way — exactly the case a reviewer should see.
    const runnerUp = (edgesByRow.get(row) ?? []).reduce(
      (best, edge) => (edge.column === column ? best : Math.min(best, edge.cost)),
      Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(runnerUp) && runnerUp <= Math.max(cost, Number.EPSILON) * ambiguityRatio) {
      lowConfidence.push(hold.holdId);
    }
  });

  const added = detections.map((_, index) => index).filter((index) => !claimedColumns.has(index));
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
