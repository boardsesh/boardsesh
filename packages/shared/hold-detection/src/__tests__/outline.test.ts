import { describe, expect, it } from 'vitest';

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
    // thresholding is what turns it back into a line; tracing at upsample 1
    // keeps every step, so the finer trace must not have MORE vertices.
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
    const stepped = maskToOutline(diagonal, [0, 0, 1, 1], { upsample: 1, tolerance: 0 }) as number[];
    const smooth = maskToOutline(diagonal, [0, 0, 1, 1], { upsample: MASK_UPSAMPLE }) as number[];
    expect(points(smooth).length).toBeLessThanOrEqual(points(stepped).length);
  });

  it('simplifies away collinear points', () => {
    const detailed = maskToOutline(SQUARE, [0.25, 0.25, 0.75, 0.75], { tolerance: 0 }) as number[];
    const simplified = maskToOutline(SQUARE, [0.25, 0.25, 0.75, 0.75], { tolerance: 2 }) as number[];
    expect(points(simplified).length).toBeLessThan(points(detailed).length);
    expect(points(simplified).length).toBeGreaterThanOrEqual(3);
  });
});
