import { describe, expect, it } from 'vitest';
import {
  BRUSH_SUPERSAMPLE,
  brushEditOutline,
  frameHalfSpan,
  keepAnchoredComponent,
  maskToRing,
  outlineToMask,
  stampBrushStroke,
} from '../brush';
import { MAX_RING_COORDINATE, MAX_RING_NUMBERS, pointInRing } from '../ring';
import { isSimpleRing } from '../raster';

/** A closed circle as a flat board-px ring, `steps` points around. */
function circle(cx: number, cy: number, radius: number, steps = 48): number[] {
  const ring: number[] = [];
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    ring.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  }
  return ring;
}

/** Flat `[x0, y0, …]` as `[x, y]` pairs. */
function ringPairs(ring: number[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let index = 0; index + 1 < ring.length; index += 2) pairs.push([ring[index], ring[index + 1]]);
  return pairs;
}

/** Area of a flat, implicitly-closed ring (shoelace, absolute). */
function ringArea(ring: number[]): number {
  let twiceArea = 0;
  const count = ring.length / 2;
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    twiceArea += ring[previous * 2] * ring[index * 2 + 1] - ring[index * 2] * ring[previous * 2 + 1];
  }
  return Math.abs(twiceArea) / 2;
}

// A Kilter Homewall placement is ~39 board px in radius and its silhouette runs
// to roughly 0.7 of that, so these numbers are the real thing's scale.
const HOLD_RADIUS = 28;
const CENTRE = 100;

describe('outlineToMask', () => {
  it('rasterises a ring at the supersampled resolution, padded for the brush to grow into', () => {
    const mask = outlineToMask({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    // Ring is 56 board px across; +10 board px pad each side; +2 from rasteriseRing's
    // own one-cell bleed each side. All in cells, so times the supersample.
    expect(mask.supersample).toBe(BRUSH_SUPERSAMPLE);
    expect(mask.width).toBeGreaterThanOrEqual((HOLD_RADIUS * 2 + 20) * BRUSH_SUPERSAMPLE);
    expect(mask.originX).toBeLessThan(CENTRE - HOLD_RADIUS - 10);
    expect(mask.originY).toBeLessThan(CENTRE - HOLD_RADIUS - 10);

    // The centre is inside the shape and the padded frame corner is not.
    const centreCell =
      Math.round((CENTRE - mask.originY) * mask.supersample) * mask.width +
      Math.round((CENTRE - mask.originX) * mask.supersample);
    expect(mask.cells[centreCell]).toBe(1);
    expect(mask.cells[0]).toBe(0);
  });
});

describe('stampBrushStroke', () => {
  it('fills a continuous band even when samples are far apart', () => {
    // Two samples 40 board px apart: stamping only at the samples would leave a
    // gap in the middle, which is what the stepping exists to prevent.
    const mask = outlineToMask({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });
    const blank = new Uint8Array(mask.cells.length);
    const painted = { ...mask, cells: blank };
    stampBrushStroke(painted, [CENTRE - 20, CENTRE, CENTRE + 20, CENTRE], 3, 'add');

    for (let boardX = CENTRE - 20; boardX <= CENTRE + 20; boardX += 1) {
      const cell =
        Math.round((CENTRE - mask.originY) * mask.supersample) * mask.width +
        Math.round((boardX - mask.originX) * mask.supersample);
      expect(blank[cell]).toBe(1);
    }
  });

  it('reports zero changed cells for an erase that touches nothing', () => {
    const mask = outlineToMask({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });
    // Well outside the hold, inside the padded frame.
    const changed = stampBrushStroke(mask, [CENTRE + HOLD_RADIUS + 25, CENTRE], 2, 'erase');
    expect(changed).toBe(0);
  });
});

describe('brushEditOutline', () => {
  it('grows the outline where an add stroke paints outside it', () => {
    const before = circle(CENTRE, CENTRE, HOLD_RADIUS);
    const result = brushEditOutline({
      outlineBoardPx: before,
      // A stroke just outside the right edge, so the union bulges there.
      strokeBoardPx: [CENTRE + HOLD_RADIUS, CENTRE, CENTRE + HOLD_RADIUS + 8, CENTRE],
      brushRadiusBoardPx: 6,
      mode: 'add',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedPieces).toBe(0);
    expect(ringArea(result.outlineBoardPx)).toBeGreaterThan(ringArea(before));
    // The bulge reaches past the old edge.
    expect(pointInRing(result.outlineBoardPx, CENTRE + HOLD_RADIUS + 8, CENTRE)).toBe(true);
  });

  it('cuts the outline back where an erase stroke crosses it', () => {
    const before = circle(CENTRE, CENTRE, HOLD_RADIUS);
    const result = brushEditOutline({
      outlineBoardPx: before,
      strokeBoardPx: [CENTRE + HOLD_RADIUS - 6, CENTRE, CENTRE + HOLD_RADIUS + 6, CENTRE],
      brushRadiusBoardPx: 6,
      mode: 'erase',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ringArea(result.outlineBoardPx)).toBeLessThan(ringArea(before));
    // The bite is gone, the far side is untouched.
    expect(pointInRing(result.outlineBoardPx, CENTRE + HOLD_RADIUS - 2, CENTRE)).toBe(false);
    expect(pointInRing(result.outlineBoardPx, CENTRE - HOLD_RADIUS + 2, CENTRE)).toBe(true);
  });

  it('keeps the piece covering the placement centre when an erase splits the hold', () => {
    // A tall thin hold cut straight across below its centre: two blobs, and the
    // one with the placement in it is the hold.
    const tall = [
      CENTRE - 10,
      CENTRE - 40,
      CENTRE + 10,
      CENTRE - 40,
      CENTRE + 10,
      CENTRE + 40,
      CENTRE - 10,
      CENTRE + 40,
    ];
    const result = brushEditOutline({
      outlineBoardPx: tall,
      strokeBoardPx: [CENTRE - 20, CENTRE + 20, CENTRE + 20, CENTRE + 20],
      brushRadiusBoardPx: 5,
      mode: 'erase',
      anchorX: CENTRE,
      anchorY: CENTRE - 20,
      holdRadius: HOLD_RADIUS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedPieces).toBe(1);
    expect(pointInRing(result.outlineBoardPx, CENTRE, CENTRE - 20)).toBe(true);
    // The offcut below the cut is not in the kept ring.
    expect(pointInRing(result.outlineBoardPx, CENTRE, CENTRE + 35)).toBe(false);
  });

  it('drops an add stroke that never touches the hold, and says so', () => {
    const before = circle(CENTRE, CENTRE, HOLD_RADIUS);
    const result = brushEditOutline({
      outlineBoardPx: before,
      // Clear of the hold by more than the brush radius.
      strokeBoardPx: [CENTRE + HOLD_RADIUS + 30, CENTRE, CENTRE + HOLD_RADIUS + 40, CENTRE],
      brushRadiusBoardPx: 4,
      mode: 'add',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedPieces).toBe(1);
    expect(pointInRing(result.outlineBoardPx, CENTRE + HOLD_RADIUS + 35, CENTRE)).toBe(false);
  });

  it('refuses a stroke that changes nothing rather than rewriting the ring', () => {
    const result = brushEditOutline({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      strokeBoardPx: [CENTRE, CENTRE, CENTRE + 4, CENTRE],
      brushRadiusBoardPx: 3,
      // Painting "add" over the middle of a shape that is already filled.
      mode: 'add',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result).toEqual({ ok: false, reason: 'no-change' });
  });

  it('reports nothing-left when an erase takes the whole hold away', () => {
    const result = brushEditOutline({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      strokeBoardPx: [CENTRE, CENTRE],
      brushRadiusBoardPx: HOLD_RADIUS + 5,
      mode: 'erase',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result).toEqual({ ok: false, reason: 'nothing-left' });
  });

  it('ignores an eraser poked into the middle, because a stored ring has no holes', () => {
    // fillHoles runs before the border walk, so an interior bite is filled back
    // in rather than producing a ring that traces around a hole it still claims.
    const before = circle(CENTRE, CENTRE, HOLD_RADIUS);
    const result = brushEditOutline({
      outlineBoardPx: before,
      strokeBoardPx: [CENTRE, CENTRE],
      brushRadiusBoardPx: 5,
      mode: 'erase',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pointInRing(result.outlineBoardPx, CENTRE, CENTRE)).toBe(true);

    // Compared against the SAME ring taken through the pipeline with no stroke at
    // all, not against the 48-point input: the difference between those two is
    // decimation, which every path pays, and folding it in here would hide the
    // thing under test. Against the no-op baseline the interior bite has to leave
    // no trace whatsoever.
    const baselineMask = outlineToMask({
      outlineBoardPx: before,
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });
    const baseline = maskToRing(baselineMask.cells, baselineMask);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(Math.abs(ringArea(result.outlineBoardPx) - ringArea(baseline.outlineBoardPx))).toBeLessThan(1);
  });

  it('stays within the stored point cap on a deliberately fiddly boundary', () => {
    // A star with many spikes traces to a long border; the epsilon escalation has
    // to bring it under MAX_RING_NUMBERS rather than failing.
    const spiky: number[] = [];
    for (let step = 0; step < 240; step += 1) {
      const angle = (step / 240) * Math.PI * 2;
      const radius = HOLD_RADIUS + (step % 2 === 0 ? 6 : -6);
      spiky.push(CENTRE + Math.cos(angle) * radius, CENTRE + Math.sin(angle) * radius);
    }
    const result = brushEditOutline({
      outlineBoardPx: spiky,
      strokeBoardPx: [CENTRE + HOLD_RADIUS, CENTRE, CENTRE + HOLD_RADIUS + 4, CENTRE],
      brushRadiusBoardPx: 4,
      mode: 'add',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outlineBoardPx.length).toBeLessThanOrEqual(MAX_RING_NUMBERS);
  });

  it('holds its shape across repeated round trips through the mask', () => {
    // The drift guard, isolated: no stroke at all, just ring → mask → ring, ten
    // times over. This is exactly what an editor does to a hold if it does NOT
    // keep the mask between strokes, and it is why `use-brush-session` does.
    const original = circle(CENTRE, CENTRE, HOLD_RADIUS);
    let ring = original;
    for (let pass = 0; pass < 10; pass += 1) {
      const mask = outlineToMask({ outlineBoardPx: ring, anchorX: CENTRE, anchorY: CENTRE, holdRadius: HOLD_RADIUS });
      const traced = maskToRing(mask.cells, mask);
      if (!traced.ok) throw new Error(`pass ${pass}: ${traced.reason}`);
      ring = traced.outlineBoardPx;
    }

    const drift = Math.abs(ringArea(ring) - ringArea(original)) / ringArea(original);
    expect(drift).toBeLessThan(0.05);
  });

  it('does not compound: after the first decimation the shape stops moving', () => {
    // The number that matters. Pass 1 pays the decimation cost of turning a
    // smooth input into a ~13-point ring (measured -3.8% area on a circle); every
    // pass after that moves by around a tenth of a percent and wanders back up
    // rather than eating the hold. A shard outline is ALREADY a ~12-point ring,
    // so a real hold pays the small number from the first stroke onward.
    let ring = circle(CENTRE, CENTRE, HOLD_RADIUS);
    const roundTrip = (input: number[]): number[] => {
      const mask = outlineToMask({ outlineBoardPx: input, anchorX: CENTRE, anchorY: CENTRE, holdRadius: HOLD_RADIUS });
      const traced = maskToRing(mask.cells, mask);
      if (!traced.ok) throw new Error(traced.reason);
      return traced.outlineBoardPx;
    };

    ring = roundTrip(ring);
    const afterFirst = ringArea(ring);
    for (let pass = 0; pass < 10; pass += 1) ring = roundTrip(ring);

    expect(Math.abs(ringArea(ring) - afterFirst) / afterFirst).toBeLessThan(0.01);
  });

  it('treats a stroke already absorbed by the shape as no change, not as a rewrite', () => {
    // Brushing the same edge twice: the second stroke has nothing left to add, so
    // it is refused rather than quietly re-quantising the ring for no gain.
    const before = circle(CENTRE, CENTRE, HOLD_RADIUS);
    const stroke = [CENTRE + HOLD_RADIUS - 1, CENTRE, CENTRE + HOLD_RADIUS, CENTRE];
    const first = brushEditOutline({
      outlineBoardPx: before,
      strokeBoardPx: stroke,
      brushRadiusBoardPx: 2,
      mode: 'add',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = brushEditOutline({
      outlineBoardPx: first.outlineBoardPx,
      strokeBoardPx: stroke,
      brushRadiusBoardPx: 2,
      mode: 'add',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });
    expect(second).toEqual({ ok: false, reason: 'no-change' });
  });
});

describe('keepAnchoredComponent', () => {
  it('leaves a single blob untouched and reports no drops', () => {
    const mask = outlineToMask({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });
    const kept = keepAnchoredComponent(mask);

    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.droppedPieces).toBe(0);
    // Equal, not identical: hole filling always hands back a fresh array.
    expect(kept.cells).toStrictEqual(mask.cells);
  });

  it('refuses rather than picking a winner when the anchor itself was erased', () => {
    // Two survivors, neither on the bolt. "Largest wins" would hand back whichever
    // happened to be bigger, which is not the hold.
    const mask = outlineToMask({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });
    stampBrushStroke(mask, [CENTRE - 60, CENTRE, CENTRE + 60, CENTRE], HOLD_RADIUS, 'erase');
    stampBrushStroke(mask, [CENTRE - 40, CENTRE - 50], 8, 'add');
    stampBrushStroke(mask, [CENTRE + 40, CENTRE + 50], 4, 'add');

    expect(keepAnchoredComponent(mask)).toEqual({ ok: false, reason: 'anchor-erased' });
  });

  it('reconciles the 4-connected component split against the 8-connected follower', () => {
    // Two blocks meeting at one diagonal corner: `components` sees two blobs,
    // `traceMaskBorder` walks both as a single border and the ring it produces
    // crosses itself. Running the component step first is what stops that, so it
    // is not an optimisation to skip when the blob count looks like one.
    const mask = outlineToMask({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });
    mask.cells.fill(0);
    const put = (boardX: number, boardY: number): void => {
      const x = Math.round((boardX - mask.originX) * mask.supersample);
      const y = Math.round((boardY - mask.originY) * mask.supersample);
      mask.cells[y * mask.width + x] = 1;
    };
    for (let dx = -6; dx <= 0; dx += 0.5) {
      for (let dy = -6; dy <= 0; dy += 0.5) put(CENTRE + dx, CENTRE + dy);
    }
    for (let dx = 0.5; dx <= 6; dx += 0.5) {
      for (let dy = 0.5; dy <= 6; dy += 0.5) put(CENTRE + dx, CENTRE + dy);
    }

    const kept = keepAnchoredComponent(mask);
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.droppedPieces).toBe(1);

    const traced = maskToRing(kept.cells, mask);
    expect(traced.ok).toBe(true);
    if (!traced.ok) return;
    expect(isSimpleRing(ringPairs(traced.outlineBoardPx))).toBe(true);
    // The anchor sits in the upper-left block, so that is the one kept.
    expect(pointInRing(traced.outlineBoardPx, CENTRE - 3, CENTRE - 3)).toBe(true);
  });
});

describe('frameHalfSpan', () => {
  it('reaches past the outline far enough to grow the hold', () => {
    const outline = circle(CENTRE, CENTRE, HOLD_RADIUS);
    expect(frameHalfSpan(outline, CENTRE, CENTRE, HOLD_RADIUS)).toBeGreaterThan(HOLD_RADIUS);
  });

  it('caps at the four radii past which nothing is storable anyway', () => {
    // A pencil flick off the hold must not size the bitmap from wherever it went:
    // unbounded this is megabytes of Uint8Array plus a component index over every
    // cell. Anything out there fails `isValidOutlineRing`, so the cap costs nothing.
    const runaway = [CENTRE - 900, CENTRE - 900, CENTRE + 900, CENTRE - 900, CENTRE, CENTRE + 900];
    expect(frameHalfSpan(runaway, CENTRE, CENTRE, HOLD_RADIUS)).toBe(MAX_RING_COORDINATE * HOLD_RADIUS);
  });
});

describe('failure modes', () => {
  it('names erasing the centre for what it is, rather than blaming the ring', () => {
    // Falling back to "largest blob wins" here would hand back a ring nowhere near
    // the bolt and then reject it for not covering its centre — a message about a
    // ring the user never asked for.
    const before = circle(CENTRE, CENTRE, HOLD_RADIUS);
    const result = brushEditOutline({
      outlineBoardPx: before,
      // A wide swipe straight through the middle, cutting the disc in half.
      strokeBoardPx: [CENTRE - HOLD_RADIUS - 5, CENTRE, CENTRE + HOLD_RADIUS + 5, CENTRE],
      brushRadiusBoardPx: 5,
      mode: 'erase',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result).toEqual({ ok: false, reason: 'anchor-erased' });
  });

  it('never commits a ring that crosses itself', () => {
    // The neck trim is the prevention and this is the proof: every committed ring
    // out of the brush is simple, which is more than either the freehand path or
    // the resolver checks today.
    const before = circle(CENTRE, CENTRE, HOLD_RADIUS);
    let commits = 0;
    for (let angle = 0; angle < 24; angle += 1) {
      const theta = (angle / 24) * Math.PI * 2;
      const result = brushEditOutline({
        outlineBoardPx: before,
        strokeBoardPx: [
          CENTRE + Math.cos(theta) * (HOLD_RADIUS - 4),
          CENTRE + Math.sin(theta) * (HOLD_RADIUS - 4),
          CENTRE + Math.cos(theta) * (HOLD_RADIUS + 6),
          CENTRE + Math.sin(theta) * (HOLD_RADIUS + 6),
        ],
        brushRadiusBoardPx: 4,
        mode: 'erase',
        anchorX: CENTRE,
        anchorY: CENTRE,
        holdRadius: HOLD_RADIUS,
      });
      if (!result.ok) continue;
      commits += 1;
      expect(isSimpleRing(ringPairs(result.outlineBoardPx))).toBe(true);
    }
    expect(commits).toBeGreaterThan(0);
  });

  it('stores no repeated vertex, which closeRing would not catch mid-ring', () => {
    const result = brushEditOutline({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      strokeBoardPx: [CENTRE + HOLD_RADIUS - 3, CENTRE, CENTRE + HOLD_RADIUS + 5, CENTRE + 6],
      brushRadiusBoardPx: 4,
      mode: 'add',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seen = new Set<string>();
    for (const [x, y] of ringPairs(result.outlineBoardPx)) {
      const key = `${x},${y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('clips a stroke that runs far off the board instead of growing the bitmap', () => {
    const result = brushEditOutline({
      outlineBoardPx: circle(CENTRE, CENTRE, HOLD_RADIUS),
      // Starts on the hold's edge and flicks a long way past the storable limit.
      strokeBoardPx: [CENTRE + HOLD_RADIUS - 2, CENTRE, CENTRE + 5000, CENTRE],
      brushRadiusBoardPx: 5,
      mode: 'add',
      anchorX: CENTRE,
      anchorY: CENTRE,
      holdRadius: HOLD_RADIUS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (let index = 0; index + 1 < result.outlineBoardPx.length; index += 2) {
      expect(Math.abs(result.outlineBoardPx[index] - CENTRE)).toBeLessThanOrEqual(MAX_RING_COORDINATE * HOLD_RADIUS);
    }
  });
});
