// Reset matching, on synthetic walls where the answer is known by construction.
//
// A wrong matcher is the most expensive bug in the epic: it does not fail, it
// quietly tells a climber that half their climbs lost holds, or worse, that none
// of them did when the wall was stripped. So every case here builds a wall,
// applies a KNOWN change, and asserts the exact sets back.
import { describe, expect, it } from 'vite-plus/test';
import { INFEASIBLE, solveAssignment } from '../hungarian';
import {
  DEFAULT_DISTANCE_GATE,
  DEFAULT_IOU_GATE,
  DEFAULT_MATCH_WEIGHTS,
  type AliveHold,
  type WallCircle,
  circleIou,
  colourDistance,
  matchHolds,
  pairCost,
  suggestMoves,
} from '../match';

/** A grid of identical holds, 60 px apart, radius 20 — a plausible spray wall. */
function wall(rows: number, columns: number): AliveHold[] {
  const holds: AliveHold[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      holds.push({ holdId: `h${row}-${column}`, cx: 60 + column * 60, cy: 60 + row * 60, r: 20 });
    }
  }
  return holds;
}

/** The same wall as the detector would report it: circles, no ids. */
function asDetections(holds: readonly AliveHold[]): WallCircle[] {
  return holds.map(({ cx, cy, r, colour }) => ({ cx, cy, r, colour }));
}

/** Detection noise: a hand-tapped or detected centre is never exactly the old one. */
function jitter(detections: WallCircle[], amount: number): WallCircle[] {
  return detections.map((detection, index) => ({
    ...detection,
    cx: detection.cx + (index % 2 === 0 ? amount : -amount),
    cy: detection.cy + (index % 3 === 0 ? amount : -amount),
  }));
}

describe('circleIou', () => {
  it('is 1 for a circle against itself and 0 for disjoint circles', () => {
    expect(circleIou({ cx: 0, cy: 0, r: 10 }, { cx: 0, cy: 0, r: 10 })).toBeCloseTo(1, 12);
    expect(circleIou({ cx: 0, cy: 0, r: 10 }, { cx: 30, cy: 0, r: 10 })).toBe(0);
  });

  it('is the area ratio when one circle contains the other', () => {
    expect(circleIou({ cx: 0, cy: 0, r: 10 }, { cx: 0, cy: 0, r: 5 })).toBeCloseTo(0.25, 12);
  });

  it('matches the lens-area formula for a half overlap', () => {
    // Two unit circles one radius apart: the classic lens, 2*pi/3 - sqrt(3)/2
    // per circle, over the union.
    const intersection = (2 * Math.PI) / 3 - Math.sqrt(3) / 2;
    const expectedIou = intersection / (2 * Math.PI - intersection);
    expect(circleIou({ cx: 0, cy: 0, r: 1 }, { cx: 1, cy: 0, r: 1 })).toBeCloseTo(expectedIou, 12);
  });

  it('is 0 for a zero-radius circle rather than NaN', () => {
    expect(circleIou({ cx: 0, cy: 0, r: 0 }, { cx: 0, cy: 0, r: 10 })).toBe(0);
  });
});

describe('colourDistance', () => {
  it('is 0 for identical descriptors and near 1 for opposite ones', () => {
    expect(colourDistance([50, 0, 0, 1, 0, 0, 0], [50, 0, 0, 1, 0, 0, 0])).toBe(0);
    expect(colourDistance([0, 0, 0, 1, 0], [100, 0, 0, 0, 1])).toBeGreaterThan(0.9);
  });

  it('never exceeds 1, so it cannot swamp the geometry terms', () => {
    expect(colourDistance([-200, -200, -200], [200, 200, 200])).toBe(1);
  });

  it('refuses descriptors of different lengths rather than scoring the shared axes', () => {
    expect(() => colourDistance([50, 0, 0], [50, 0, 0, 1, 0, 0, 0])).toThrow(/equal length/);
  });
});

describe('solveAssignment', () => {
  it('finds the minimum, not the greedy, assignment', () => {
    // Greedy takes the cheapest cell first — row 0 -> column 0, cost 1 — and is
    // then stuck with 100. The optimum pays 2 up front and 1 after: total 3.
    const assignment = solveAssignment([
      [1, 2],
      [1, 100],
    ]);
    expect(assignment.rowToColumn).toEqual([1, 0]);
    expect(assignment.cost).toBeCloseTo(3, 12);
  });

  it('leaves the extra side unassigned when the matrix is rectangular', () => {
    const wide = solveAssignment([[5, 1, 8]]);
    expect(wide.rowToColumn).toEqual([1]);
    expect(wide.columnToRow).toEqual([-1, 0, -1]);

    const tall = solveAssignment([[5], [1], [8]]);
    expect(tall.rowToColumn).toEqual([-1, 0, -1]);
    expect(tall.columnToRow).toEqual([1]);
  });

  it('never reports an infeasible pair as assigned', () => {
    const assignment = solveAssignment([
      [INFEASIBLE, 2],
      [INFEASIBLE, INFEASIBLE],
    ]);
    expect(assignment.rowToColumn).toEqual([1, -1]);
    expect(assignment.cost).toBeCloseTo(2, 12);
  });

  it('handles an empty problem', () => {
    expect(solveAssignment([]).rowToColumn).toEqual([]);
    expect(solveAssignment([[]]).rowToColumn).toEqual([-1]);
  });
});

describe('pairCost gates', () => {
  const gates = { distanceGate: DEFAULT_DISTANCE_GATE, iouGate: DEFAULT_IOU_GATE };
  const hold: WallCircle = { cx: 100, cy: 100, r: 20 };

  it('scores an exact repeat at 0', () => {
    expect(pairCost(hold, { ...hold }, DEFAULT_MATCH_WEIGHTS, gates)).toBeCloseTo(0, 12);
  });

  it('refuses a pair further than 0.6 radii apart', () => {
    expect(pairCost(hold, { cx: 111, cy: 100, r: 20 }, DEFAULT_MATCH_WEIGHTS, gates)).toBeLessThan(INFEASIBLE);
    expect(pairCost(hold, { cx: 113, cy: 100, r: 20 }, DEFAULT_MATCH_WEIGHTS, gates)).toBe(INFEASIBLE);
  });

  it('refuses a pair whose circles barely overlap, even when the centres agree', () => {
    // A detector that boxed a whole volume where a crimp used to be: same
    // centre, wildly different size. Distance alone would wave it through.
    const tiny: WallCircle = { cx: 100, cy: 100, r: 2 };
    expect(circleIou(hold, tiny)).toBeLessThan(DEFAULT_IOU_GATE);
    expect(pairCost(hold, tiny, DEFAULT_MATCH_WEIGHTS, gates)).toBe(INFEASIBLE);
  });

  it('renormalises the weights when a colour is missing on either side', () => {
    // Without the renormalisation the geometry terms would only ever reach 0.8,
    // so every gate and the ambiguity ratio would mean something different on a
    // wall captured without colour descriptors.
    const shifted: WallCircle = { cx: 105, cy: 100, r: 20 };
    const withoutColour = pairCost(hold, shifted, DEFAULT_MATCH_WEIGHTS, gates);
    const withIdenticalColour = pairCost(
      { ...hold, colour: [50, 0, 0] },
      { ...shifted, colour: [50, 0, 0] },
      DEFAULT_MATCH_WEIGHTS,
      gates,
    );
    const geometryWeight = DEFAULT_MATCH_WEIGHTS.centroid + DEFAULT_MATCH_WEIGHTS.iou;
    expect(withoutColour).toBeCloseTo(withIdenticalColour / geometryWeight, 12);
    expect(withoutColour).toBeGreaterThan(0);
    expect(withoutColour).toBeLessThanOrEqual(1);
    // Half the cost is missing from one side only if BOTH carry a descriptor.
    expect(pairCost({ ...hold, colour: [50, 0, 0] }, shifted, DEFAULT_MATCH_WEIGHTS, gates)).toBeCloseTo(
      withoutColour,
      12,
    );
  });

  it('drops the colour term when the two descriptors are different lengths', () => {
    // Lab-only against Lab-plus-hue: scoring the three axes they share would
    // invent agreement, so the pair is scored on geometry alone.
    const shifted: WallCircle = { cx: 105, cy: 100, r: 20 };
    const mismatched = pairCost(
      { ...hold, colour: [50, 0, 0] },
      { ...shifted, colour: [50, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] },
      DEFAULT_MATCH_WEIGHTS,
      gates,
    );
    expect(mismatched).toBeCloseTo(pairCost(hold, shifted, DEFAULT_MATCH_WEIGHTS, gates), 12);
  });

  it('charges for a colour that changed', () => {
    const shifted: WallCircle = { cx: 105, cy: 100, r: 20 };
    const same = pairCost({ ...hold, colour: [50, 0, 0] }, { ...shifted, colour: [50, 0, 0] }, DEFAULT_MATCH_WEIGHTS, {
      ...gates,
    });
    const different = pairCost(
      { ...hold, colour: [0, 0, 0] },
      { ...shifted, colour: [100, 0, 0] },
      DEFAULT_MATCH_WEIGHTS,
      gates,
    );
    expect(different).toBeGreaterThan(same);
  });
});

describe('matchHolds', () => {
  it('keeps every hold when nothing changed', () => {
    const holds = wall(4, 5);
    const result = matchHolds(holds, asDetections(holds));
    expect(result.kept).toHaveLength(20);
    expect(result.removed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.kept.every((kept) => kept.confidence > 0.99)).toBe(true);
  });

  it('survives the jitter a detector actually produces', () => {
    const holds = wall(4, 5);
    const result = matchHolds(holds, jitter(asDetections(holds), 4));
    expect(result.removed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.kept).toHaveLength(20);
    // Each hold must find ITS OWN detection, not a neighbour's.
    expect(result.kept.every((kept, index) => kept.detectionIndex === index)).toBe(true);
  });

  it('reports exactly the holds that came off', () => {
    const holds = wall(3, 4);
    const surviving = holds.filter((hold) => hold.holdId !== 'h1-1' && hold.holdId !== 'h2-3');
    const result = matchHolds(holds, jitter(asDetections(surviving), 3));
    expect(result.removed.sort()).toEqual(['h1-1', 'h2-3']);
    expect(result.added).toEqual([]);
    expect(result.kept).toHaveLength(10);
  });

  it('reports exactly the holds that went on', () => {
    const holds = wall(3, 4);
    const detections = [...asDetections(holds), { cx: 400, cy: 400, r: 18 }, { cx: 30, cy: 250, r: 25 }];
    const result = matchHolds(holds, detections);
    expect(result.removed).toEqual([]);
    expect(result.added).toEqual([12, 13]);
  });

  it('calls a moved hold one removal and one addition', () => {
    // The decision the whole epic rests on: climbs reference positions, so a
    // hold that moved is not the hold those climbs used.
    const holds = wall(2, 2);
    const detections = asDetections(holds);
    detections[3] = { ...detections[3], cx: detections[3].cx + 200 };
    const result = matchHolds(holds, detections);
    expect(result.removed).toEqual(['h1-1']);
    expect(result.added).toEqual([3]);
    expect(result.kept.map((kept) => kept.holdId)).toEqual(['h0-0', 'h0-1', 'h1-0']);
  });

  it('strips the whole wall without matching anything to anything', () => {
    const holds = wall(3, 3);
    const result = matchHolds(holds, []);
    expect(result.kept).toEqual([]);
    expect(result.removed).toHaveLength(9);
    expect(result.added).toEqual([]);
  });

  it('treats a brand-new wall as all additions', () => {
    const result = matchHolds([], asDetections(wall(2, 2)));
    expect(result.added).toEqual([0, 1, 2, 3]);
    expect(result.kept).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('beats greedy nearest-neighbour on a shifted row', () => {
    // Three identical holds in a row; the FIRST one came off and the detector
    // sees the other two. Greedy would pair hold 0 with detection 0 (the old
    // hold 1) and cascade, reporting the LAST hold as removed. The global
    // assignment gets it right because the cascade costs more in total.
    const holds: AliveHold[] = [
      { holdId: 'a', cx: 0, cy: 0, r: 20 },
      { holdId: 'b', cx: 22, cy: 0, r: 20 },
      { holdId: 'c', cx: 44, cy: 0, r: 20 },
    ];
    const result = matchHolds(holds, [
      { cx: 22, cy: 0, r: 20 },
      { cx: 44, cy: 0, r: 20 },
    ]);
    expect(result.removed).toEqual(['a']);
    expect(result.kept.map((kept) => [kept.holdId, kept.detectionIndex])).toEqual([
      ['b', 0],
      ['c', 1],
    ]);
  });

  it('flags a hold with a second plausible candidate as low confidence', () => {
    // Two detections inside one hold's gates: the assignment picks one, and a
    // reviewer should be told it was close.
    const holds: AliveHold[] = [{ holdId: 'a', cx: 100, cy: 100, r: 20 }];
    const result = matchHolds(holds, [
      { cx: 102, cy: 100, r: 20 },
      { cx: 98, cy: 100, r: 20 },
    ]);
    expect(result.kept).toHaveLength(1);
    expect(result.lowConfidence).toEqual(['a']);
    expect(result.added).toHaveLength(1);
  });

  it('does not flag a hold whose only candidate is unambiguous', () => {
    const holds: AliveHold[] = [{ holdId: 'a', cx: 100, cy: 100, r: 20 }];
    expect(
      matchHolds(holds, [
        { cx: 100, cy: 100, r: 20 },
        { cx: 400, cy: 400, r: 20 },
      ]).lowConfidence,
    ).toEqual([]);
  });

  it('uses colour to break a tie two identical circles cannot', () => {
    // Same geometry both ways; only the colour says which detection is which.
    const holds: AliveHold[] = [
      { holdId: 'red', cx: 100, cy: 100, r: 20, colour: [50, 60, 40] },
      { holdId: 'blue', cx: 108, cy: 100, r: 20, colour: [50, -20, -60] },
    ];
    const result = matchHolds(holds, [
      { cx: 108, cy: 100, r: 20, colour: [50, -20, -60] },
      { cx: 100, cy: 100, r: 20, colour: [50, 60, 40] },
    ]);
    expect(result.kept.map((kept) => [kept.holdId, kept.detectionIndex])).toEqual([
      ['red', 1],
      ['blue', 0],
    ]);
  });

  it('scales to a full wall', () => {
    // The epic caps a wall at 1,500 holds; this is a realistic dense one.
    const holds = wall(20, 30);
    const detections = jitter(asDetections(holds.slice(0, 560)), 2);
    const result = matchHolds(holds, detections);
    expect(result.kept).toHaveLength(560);
    expect(result.removed).toHaveLength(40);
  });
});

describe('suggestMoves', () => {
  it('pairs a removed hold with the detection that replaced it nearby', () => {
    const holds = wall(2, 2);
    const detections = asDetections(holds);
    detections[3] = { ...detections[3], cx: detections[3].cx + 40 };
    const result = matchHolds(holds, detections);
    expect(suggestMoves(holds, detections, result)).toEqual([
      { movedFromHoldId: 'h1-1', detectionIndex: 3, distance: 40 },
    ]);
  });

  it('suggests nothing when the replacement is across the wall', () => {
    const holds = wall(2, 2);
    const detections = asDetections(holds);
    detections[3] = { ...detections[3], cx: detections[3].cx + 500 };
    const result = matchHolds(holds, detections);
    expect(suggestMoves(holds, detections, result)).toEqual([]);
  });

  it('uses each hold and each detection at most once, nearest first', () => {
    const holds: AliveHold[] = [
      { holdId: 'a', cx: 0, cy: 0, r: 20 },
      { holdId: 'b', cx: 200, cy: 0, r: 20 },
    ];
    // Both moved further than the match gate (0.6 r = 12 px) but inside the
    // suggestion radius (3 r = 60 px).
    const detections: WallCircle[] = [
      { cx: 230, cy: 0, r: 20 },
      { cx: 55, cy: 0, r: 20 },
    ];
    const result = matchHolds(holds, detections);
    expect(result.removed.sort()).toEqual(['a', 'b']);
    expect(suggestMoves(holds, detections, result)).toEqual([
      { movedFromHoldId: 'b', detectionIndex: 0, distance: 30 },
      { movedFromHoldId: 'a', detectionIndex: 1, distance: 55 },
    ]);
  });

  it('changes nothing about what the matcher reported', () => {
    // It is a review-UI hint, not a third outcome: the hold stays removed and
    // the detection stays added.
    const holds = wall(1, 2);
    const detections = asDetections(holds);
    detections[1] = { ...detections[1], cx: detections[1].cx + 40 };
    const result = matchHolds(holds, detections);
    const before = JSON.stringify(result);
    suggestMoves(holds, detections, result);
    expect(JSON.stringify(result)).toBe(before);
  });
});
