import { describe, expect, it } from 'vitest';

import { MAX_RING_NUMBERS, MIN_RING_NUMBERS, isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';

import { MASK_UPSAMPLE, type MaskGrid, maskToOutline } from '../outline';

/**
 * Build a mask grid of logits from a picture, where `#` is inside the hold.
 * Logits, not booleans: the tracer interpolates before thresholding, and a test
 * that handed it a 0/1 grid would not exercise that.
 */
function gridFrom(rows: string[]): MaskGrid {
  const height = rows.length;
  const width = rows[0].length;
  const logits = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      logits[y * width + x] = rows[y][x] === '#' ? 6 : -6;
    }
  }
  return { logits, width, height };
}

/** Ring points are `[x, y]` in units of r about the centre; this reads them back. */
function points(ring: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let index = 0; index < ring.length; index += 2) out.push([ring[index], ring[index + 1]]);
  return out;
}

function areaOf(ring: number[]): number {
  const pts = points(ring);
  let sum = 0;
  for (let index = 0; index < pts.length; index += 1) {
    const [x0, y0] = pts[index];
    const [x1, y1] = pts[(index + 1) % pts.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

const SQUARE = gridFrom([
  '........',
  '........',
  '..####..',
  '..####..',
  '..####..',
  '..####..',
  '........',
  '........',
]);

describe('maskToOutline', () => {
  it('traces a square blob into a closed ring', () => {
    const ring = maskToOutline(SQUARE, [0.25, 0.25, 0.75, 0.75]);
    expect(ring).toBeDefined();
    expect((ring as number[]).length % 2).toBe(0);
    expect(points(ring as number[]).length).toBeGreaterThanOrEqual(3);
  });

  it('returns the ring in units of r, so it is scale-free', () => {
    // r is the equivalent-circle radius of the box, so ANY shape that fills its
    // own box encloses exactly pi in r-units, whatever the grid it was drawn on.
    // The two grids below describe the same square at two resolutions and both
    // must land on pi.
    //
    // They land UNDER it, never over, because the boundary is traced through pixel
    // CENTRES: the ring runs through the outermost filled pixels rather than around
    // them, so it always encloses slightly less than the shape. The bias shrinks as
    // the grid gets finer — measured here, 2.41 over a 4-cell blob and 2.76 over an
    // 8-cell one, against pi.
    //
    // Left uncorrected on purpose: OpenCV's findContours uses the same pixel-centre
    // convention, so the Python harness this was measured against carries the same
    // bias, and "correcting" one side would put the two out of agreement. A hold at
    // the real working resolution is 8-15 mask cells, so the outline reads a few
    // percent small in area — invisible in a silhouette, and the renderer sizes the
    // hold from `r`, not from the ring.
    const finer = gridFrom([
      '................',
      '................',
      '................',
      '................',
      '....########....',
      '....########....',
      '....########....',
      '....########....',
      '....########....',
      '....########....',
      '....########....',
      '....########....',
      '................',
      '................',
      '................',
      '................',
    ]);
    const coarse = areaOf(maskToOutline(SQUARE, [0.25, 0.25, 0.75, 0.75]) as number[]);
    const fine = areaOf(maskToOutline(finer, [0.25, 0.25, 0.75, 0.75]) as number[]);

    // Never over pi: a centre-traced ring cannot enclose more than its shape.
    expect(coarse).toBeLessThanOrEqual(Math.PI);
    expect(fine).toBeLessThanOrEqual(Math.PI);
    // Still recognisably the shape, not a collapsed sliver.
    expect(coarse).toBeGreaterThan(Math.PI * 0.7);
    expect(fine).toBeGreaterThan(Math.PI * 0.8);
    // And the finer grid is the closer one, which is what makes the bias
    // discretisation rather than a constant error in the maths.
    expect(Math.abs(fine - Math.PI)).toBeLessThan(Math.abs(coarse - Math.PI));
  });

  it('is centred on the box, so the ring straddles the origin', () => {
    const ring = points(maskToOutline(SQUARE, [0.25, 0.25, 0.75, 0.75]) as number[]);
    const xs = ring.map(([x]) => x);
    const ys = ring.map(([, y]) => y);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeLessThan(0);
    expect(Math.max(...ys)).toBeGreaterThan(0);
  });

  it('takes the blob under the box, not the biggest one', () => {
    // A big neighbour on the left, the query's own small hold on the right. The
    // box points at the small one, and that is the one that must come back.
    const twoBlobs = gridFrom([
      '................',
      '.########.......',
      '.########.......',
      '.########.......',
      '.########.......',
      '.########..##...',
      '.########..##...',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
    ]);
    const ring = maskToOutline(twoBlobs, [11 / 16, 5 / 16, 13 / 16, 7 / 16]);
    expect(ring).toBeDefined();
    // The small blob is 2x2 of 16, the big one 8x6: an area ratio over 10x. In
    // units of its own r the small blob's ring is near 3.1 (a filled circle's
    // area); picking the big blob would blow that up.
    expect(areaOf(ring as number[])).toBeLessThan(8);
  });

  it('un-stretches a non-square tile, so a round hold stays round', () => {
    // The mask grid is square because the model input is square, but a tile is
    // not: a 1024x768 photo tiled 2x2 with 15% overlap gives 589x442 tiles that
    // the `stretch` letterbox squashes into 312x312 — x by 1.888, y by 1.417.
    //
    // So a hold that is ROUND ON THE WALL does not arrive as a circle in the
    // mask; it arrives squashed in x by 1.888/1.417 = 1.333. That is what this
    // builds, and the ring must come back round. Without the un-stretch it stays
    // squashed and every hold renders as an ellipse.
    const size = 24;
    const squash = 1.888 / 1.417;
    const rows: string[] = [];
    for (let y = 0; y < size; y += 1) {
      let row = '';
      for (let x = 0; x < size; x += 1) {
        const dx = (x - (size - 1) / 2) * squash;
        const dy = y - (size - 1) / 2;
        row += Math.hypot(dx, dy) <= 8 ? '#' : '.';
      }
      rows.push(row);
    }
    const circle = gridFrom(rows);
    const box: [number, number, number, number] = [4 / 24, 4 / 24, 20 / 24, 20 / 24];

    const extent = (ring: number[]) => {
      const pts = points(ring);
      const xs = pts.map(([x]) => x);
      const ys = pts.map(([, y]) => y);
      return (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys));
    };

    const corrected = maskToOutline(circle, box, { tileWidth: 589, tileHeight: 442 }) as number[];
    expect(extent(corrected)).toBeGreaterThan(0.93);
    expect(extent(corrected)).toBeLessThan(1.07);

    // Square tiles are the no-op case and must be unaffected by the correction.
    const square = maskToOutline(circle, box, { tileWidth: 589, tileHeight: 589 }) as number[];
    const untouched = maskToOutline(circle, box) as number[];
    expect(square).toEqual(untouched);
  });

  it('gives up on an empty mask rather than inventing a shape', () => {
    const empty = gridFrom(['....', '....', '....', '....']);
    expect(maskToOutline(empty, [0.25, 0.25, 0.75, 0.75])).toBeUndefined();
  });

  it('gives up on a degenerate box', () => {
    expect(maskToOutline(SQUARE, [0.5, 0.5, 0.5, 0.5])).toBeUndefined();
  });

  it('survives a mask that touches its own edge', () => {
    const edge = gridFrom(['####', '####', '####', '####']);
    const ring = maskToOutline(edge, [0, 0, 1, 1]);
    expect(ring).toBeDefined();
    expect(points(ring as number[]).length).toBeGreaterThanOrEqual(3);
  });

  it('smooths with upsampling rather than stepping the mask grid', () => {
    // A diagonal edge at mask resolution is a staircase. Upsampling before
    // thresholding turns it back into a line.
    //
    // The comparison has to be at the same PHYSICAL tolerance to mean anything:
    // `tolerance` is in UPSAMPLED pixels, so 0.5 at upsample 1 and 2.0 at
    // upsample 4 are both half a mask cell. Compared that way the smoothed trace
    // needs no more vertices to describe the same edge; compared at equal
    // NUMERIC tolerance the finer grid simply measures a finer shape and
    // legitimately keeps more.
    const diagonal = gridFrom([
      '########',
      '#######.',
      '######..',
      '#####...',
      '####....',
      '###.....',
      '##......',
      '#.......',
    ]);
    // Tolerance is held equal on both sides: this is a claim about UPSAMPLING,
    // and letting the default tolerance differ would measure simplification
    // instead.
    const stepped = maskToOutline(diagonal, [0, 0, 1, 1], { upsample: 1, tolerance: 0.5 }) as number[];
    const smooth = maskToOutline(diagonal, [0, 0, 1, 1], {
      upsample: MASK_UPSAMPLE,
      tolerance: 0.5 * MASK_UPSAMPLE,
    }) as number[];
    expect(points(smooth).length).toBeLessThanOrEqual(points(stepped).length);
  });

  it('simplifies away collinear points', () => {
    const detailed = maskToOutline(SQUARE, [0.25, 0.25, 0.75, 0.75], { tolerance: 0 }) as number[];
    const simplified = maskToOutline(SQUARE, [0.25, 0.25, 0.75, 0.75], { tolerance: 2 }) as number[];
    expect(points(simplified).length).toBeLessThan(points(detailed).length);
    expect(points(simplified).length).toBeGreaterThanOrEqual(3);
  });

  describe('the storage contract', () => {
    /**
     * `upsertSprayWallHolds` validates every ring with `isValidOutlineRing`. A
     * ring this tracer emits that the store then refuses would surface to a
     * climber as a failed save, not as a missing outline — so the guarantee is
     * that anything returned here is already storable.
     */
    it('emits only rings the real validator accepts', () => {
      const shapes: MaskGrid[] = [SQUARE, gridFrom(['####', '####', '####', '####'])];
      // A deliberately ragged blob: the case that generates the most vertices.
      const size = 40;
      const ragged: string[] = [];
      for (let y = 0; y < size; y += 1) {
        let row = '';
        for (let x = 0; x < size; x += 1) {
          const dx = x - size / 2;
          const dy = y - size / 2;
          const wobble = 12 + 4 * Math.sin(Math.atan2(dy, dx) * 9);
          row += Math.hypot(dx, dy) <= wobble ? '#' : '.';
        }
        ragged.push(row);
      }
      shapes.push(gridFrom(ragged));

      for (const shape of shapes) {
        for (const tolerance of [0, 0.25, 0.5, 1.5]) {
          const ring = maskToOutline(shape, [0.15, 0.15, 0.85, 0.85], { tolerance });
          if (ring === undefined) continue;
          expect(isValidOutlineRing(ring)).toBe(true);
          expect(ring.length).toBeGreaterThanOrEqual(MIN_RING_NUMBERS);
          expect(ring.length).toBeLessThanOrEqual(MAX_RING_NUMBERS);
        }
      }
    });

    it('raises the tolerance rather than emitting an over-long ring', () => {
      // Tolerance 0 keeps every traced vertex, which on a ragged blob is well
      // over the ceiling; the contract pass has to bring it back under.
      const size = 60;
      const rows: string[] = [];
      for (let y = 0; y < size; y += 1) {
        let row = '';
        for (let x = 0; x < size; x += 1) {
          const dx = x - size / 2;
          const dy = y - size / 2;
          const wobble = 20 + 6 * Math.sin(Math.atan2(dy, dx) * 15);
          row += Math.hypot(dx, dy) <= wobble ? '#' : '.';
        }
        rows.push(row);
      }
      const ring = maskToOutline(gridFrom(rows), [0.1, 0.1, 0.9, 0.9], { tolerance: 0 });
      expect(ring).toBeDefined();
      expect((ring as number[]).length).toBeLessThanOrEqual(MAX_RING_NUMBERS);
      expect(isValidOutlineRing(ring)).toBe(true);
    });
  });
});
