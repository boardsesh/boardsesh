/**
 * Raster primitives for hold outlines — masks, morphology, connected
 * components, border following, and the rasteriser that turns a ring back into
 * a bitmap.
 *
 * Imports NOTHING but `./ring`, and for the reason `ring.ts` gives about
 * itself: this half of the package RUNS ON DEVICE. The outline editor's brush
 * (`./brush`) drives these per stroke to add to or erase from a hold's ring,
 * and Metro does not tree-shake by default, so anything reachable from here
 * lands in the mobile bundle whether it is called or not.
 *
 * THAT IS WHY THEY ARE NOT UNDER `segmentation/` ANY MORE. That directory's
 * rule is that nothing in it runs at runtime, because the whole point of the
 * package is that the tracing already happened offline — and these primitives
 * stopped fitting the rule the moment a brush started calling them. Left in
 * `segmentation/led-ring.ts` they would also drag the LED colour classifier,
 * which the app never calls, into the bundle behind them.
 *
 * ONE IMPLEMENTATION, SHARED WITH THE TRACER, which is the stronger reason.
 * `traceMaskBorder` is the generator's own Moore-neighbour follower, the way
 * `simplifyRing` in `ring.ts` is its Douglas-Peucker: a ring the editor redraws
 * has to be walked and decimated by exactly what walked and decimated the shard
 * it sits beside, or the two polygons are produced by different conventions and
 * a renderer subtracting one from the other inherits the difference. A
 * mobile-local copy would break that on the first divergent edit; sharing the
 * module states the invariant structurally instead of in a comment.
 *
 * OFF THE EDGE IS BACKGROUND throughout. The frames these operate on are crops
 * with a margin of empty pixels on every side, so nothing real ever sits on the
 * boundary — but the convention is stated so that eroding a mask which fills
 * its frame shrinks from the edge, which is the conservative direction.
 */

import type { RingPoint } from './ring';

/** 4-connected steps. Connectivity is 4 throughout, like the tracer's flood fill. */
export const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// ---------------------------------------------------------------------------
// Morphology
// ---------------------------------------------------------------------------

/** A closed disc of a radius, as offsets. Cached: building one is O(radius²). */
const discCache = new Map<number, Array<readonly [number, number]>>();
function disc(radius: number): Array<readonly [number, number]> {
  const cached = discCache.get(radius);
  if (cached !== undefined) return cached;
  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push([dx, dy]);
    }
  }
  discCache.set(radius, offsets);
  return offsets;
}

/**
 * Morphological dilation by a closed disc.
 *
 * OFF THE EDGE IS BACKGROUND, for both operators. The caller's frame is a crop
 * around one hold with a margin of empty pixels on every side, so nothing real
 * ever sits on the boundary and the two conventions cannot disagree in practice
 * — but stating it makes `erode` on a mask that fills its frame shrink from the
 * edge, which is the conservative direction for a ring that must stay inside a
 * silhouette.
 */
export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const offsets = disc(radius);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    for (const [stepX, stepY] of offsets) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      out[nextY * width + nextX] = 1;
    }
  }
  return out;
}

/** Morphological erosion by a closed disc. Off the edge is background. */
export function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const offsets = disc(radius);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    let clear = true;
    for (const [stepX, stepY] of offsets) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height || mask[nextY * width + nextX] !== 1) {
        clear = false;
        break;
      }
    }
    if (clear) out[index] = 1;
  }
  return out;
}

/** The 4-connected component of `mask` containing `start`, marking `visited`. */
export function component(
  mask: Uint8Array,
  width: number,
  height: number,
  start: number,
  visited: Uint8Array,
): number[] {
  const members: number[] = [start];
  const stack: number[] = [start];
  visited[start] = 1;
  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = (index - x) / width;
    for (const [stepX, stepY] of ORTHOGONAL) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      const neighbour = nextY * width + nextX;
      if (visited[neighbour] === 1 || mask[neighbour] !== 1) continue;
      visited[neighbour] = 1;
      members.push(neighbour);
      stack.push(neighbour);
    }
  }
  return members;
}

/** Every 4-connected component of `mask`, in scan order of their first pixel. */
export function components(mask: Uint8Array, width: number, height: number): number[][] {
  const visited = new Uint8Array(mask.length);
  const found: number[][] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1 || visited[index] === 1) continue;
    found.push(component(mask, width, height, index, visited));
  }
  return found;
}

/** Drop every 4-connected component smaller than `minimumArea` board px². */
export function dropSmallComponents(mask: Uint8Array, width: number, height: number, minimumArea: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (const members of components(mask, width, height)) {
    if (members.length < minimumArea) continue;
    for (const index of members) out[index] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contours
// ---------------------------------------------------------------------------

/**
 * Moore-neighbour border following, clockwise, from a mask's topmost-leftmost
 * filled pixel.
 *
 * Copied from `scripts/generate-board-art-geometry.ts`, like `simplifyRing` in
 * `ring.ts` is: the inner boundary has to be walked by exactly the follower that
 * walked the silhouette around it, or the two polygons are produced by different
 * conventions and a renderer subtracting one from the other inherits the
 * difference. A change here has to be made there too.
 */
export function traceMaskBorder(mask: Uint8Array, width: number, height: number): RingPoint[] {
  let start: RingPoint | null = null;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) continue;
    const x = index % width;
    start = [x, (index - x) / width];
    break;
  }
  if (start === null) return [];

  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  const offsets: RingPoint[] = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];
  const border: RingPoint[] = [];
  let current = start;
  let backtrackIndex = 0;
  const maxSteps = width * height * 4;

  for (let step = 0; step < maxSteps; step += 1) {
    border.push(current);
    let moved = false;
    for (let turn = 1; turn <= 8; turn += 1) {
      const index = (backtrackIndex + turn) % 8;
      const candidate: RingPoint = [current[0] + offsets[index][0], current[1] + offsets[index][1]];
      if (!at(candidate[0], candidate[1])) continue;
      backtrackIndex = (index + 5) % 8;
      current = candidate;
      moved = true;
      break;
    }
    if (!moved) break;
    if (current[0] === start[0] && current[1] === start[1] && border.length > 2) break;
  }
  return border;
}

/**
 * Fill every enclosed hole in a mask, by flooding the background inward from
 * the frame and keeping whatever it could not reach.
 *
 * The extractor emits an OUTER border only, so a hole would be traced around
 * rather than into and the polygon would claim it anyway. Filling first makes
 * the area measurements agree with the polygon that ships.
 */
export function fillHoles(mask: Uint8Array, width: number, height: number): Uint8Array {
  const background = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) background[index] = mask[index] === 1 ? 0 : 1;
  const outside = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    const x = index % width;
    const y = (index - x) / width;
    if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
    if (background[index] !== 1 || outside[index] === 1) continue;
    component(background, width, height, index, outside);
  }
  const filled = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) filled[index] = outside[index] === 1 ? 0 : 1;
  return filled;
}

/**
 * A flat polygon's interior plus its border, as a local bitmap.
 *
 * Even-odd scanline fill, then a Bresenham walk of every edge. The walk is not
 * belt-and-braces: scanline alone drops a border wherever a side runs shallower
 * than a pixel per row, and the polygon's own vertices are border pixels of the
 * mask it was traced from, so they are part of the shape.
 *
 * Coordinates are in the caller's units (the tracer's board pixels offset from
 * a rounded placement centre); the returned `originX`/`originY` are the bitmap's
 * top-left corner in those same units, one pixel outside the polygon's bounds.
 */
export function rasteriseRing(flat: number[]): {
  mask: Uint8Array;
  width: number;
  height: number;
  originX: number;
  originY: number;
} {
  const count = flat.length / 2;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < count; index += 1) {
    minX = Math.min(minX, flat[index * 2]);
    maxX = Math.max(maxX, flat[index * 2]);
    minY = Math.min(minY, flat[index * 2 + 1]);
    maxY = Math.max(maxY, flat[index * 2 + 1]);
  }
  const originX = Math.floor(minX) - 1;
  const originY = Math.floor(minY) - 1;
  const width = Math.ceil(maxX) - originX + 2;
  const height = Math.ceil(maxY) - originY + 2;
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const scanY = originY + y;
    const crossings: number[] = [];
    for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
      const currentY = flat[index * 2 + 1];
      const previousY = flat[previous * 2 + 1];
      if (currentY > scanY === previousY > scanY) continue;
      const currentX = flat[index * 2];
      const previousX = flat[previous * 2];
      crossings.push(((previousX - currentX) * (scanY - currentY)) / (previousY - currentY) + currentX);
    }
    crossings.sort((first, second) => first - second);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.max(0, Math.ceil(crossings[pair] - originX));
      const to = Math.min(width - 1, Math.floor(crossings[pair + 1] - originX));
      for (let x = from; x <= to; x += 1) mask[y * width + x] = 1;
    }
  }

  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const fromX = flat[index * 2] - originX;
    const fromY = flat[index * 2 + 1] - originY;
    const toX = flat[next * 2] - originX;
    const toY = flat[next * 2 + 1] - originY;
    const steps = Math.max(1, Math.abs(toX - fromX), Math.abs(toY - fromY));
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.round(fromX + ((toX - fromX) * step) / steps);
      const y = Math.round(fromY + ((toY - fromY) * step) / steps);
      if (x >= 0 && y >= 0 && x < width && y < height) mask[y * width + x] = 1;
    }
  }

  return { mask, width, height, originX, originY };
}

/**
 * Erosion by an OPEN disc — `dx² + dy² < radius²`, strictly.
 *
 * The neck trim's erosion and nothing else's, and the asymmetry against
 * {@link dilate}'s closed disc is the tracer's and is load-bearing. The closed
 * dilation strictly contains the open erosion, so every pixel a core pixel
 * needed filled in order to qualify comes back, and the round trip shaves no
 * straight edge: a 13x13 blob comes back 13x13, corners included. Erode and
 * dilate with the same disc instead and the trim rounds 19 pixels off every
 * square corner it meets — which a fixture here caught, on art where those
 * corners are the hold.
 *
 * The `<` also sets the neck cut-off. At radius 3 the open disc reaches 2 px
 * along the axes, so a straight limb keeps a core from 5 px wide up; the closed
 * disc would reach 3, demand 7, and cut real 5- and 6-px rails.
 */
function erodeOpenDisc(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy < radius * radius) offsets.push([dx, dy]);
    }
  }
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    let clear = true;
    for (const [stepX, stepY] of offsets) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height || mask[nextY * width + nextX] !== 1) {
        clear = false;
        break;
      }
    }
    if (clear) out[index] = 1;
  }
  return out;
}

/**
 * Drop whatever the anchor can reach only through a neck too thin to be part of
 * the hold, keeping the body the anchor sits on.
 *
 * THE TRACER'S OWN `trimThinNecks`, and it is here for a defect that was
 * measured rather than imagined. The tracer trims twice before it takes a
 * border, and the first version of this extractor trimmed not at all: the
 * blur's re-threshold leaves the interior joined across a 1-pixel isthmus here
 * and there, the border follower walks out along one side of it and back along
 * the other, and Douglas-Peucker then replaces that round trip with two chords
 * that cross. 176 of 2,306 shipped rings self-intersected that way, against 0 of
 * 15,499 silhouettes, which is exactly the difference the trim accounts for.
 *
 * Growing only the anchor's core is load-bearing, and is why this is not a plain
 * morphological open. Dilating every core and flooding afterwards is
 * `open(mask) ∩ anchorComponent`, which re-bridges a limb that carries a core of
 * its own: the two dilations meet inside the neck and the flood walks across.
 *
 * Two fallbacks, both the tracer's. A mask with no core at all — a hold thinner
 * than the radius everywhere — comes back untouched rather than deleted. So does
 * one whose body grows back without covering the anchor.
 */
export function trimNecks(mask: Uint8Array, width: number, height: number, anchor: number, radius: number): Uint8Array {
  const core = erodeOpenDisc(mask, width, height, radius);
  let hasCore = false;
  for (let index = 0; index < core.length; index += 1) {
    if (core[index] === 1) {
      hasCore = true;
      break;
    }
  }
  if (!hasCore) return mask;

  const coreVisited = new Uint8Array(core.length);
  let body: number[] = [];
  if (core[anchor] === 1) {
    body = component(core, width, height, anchor, coreVisited);
  } else {
    // The anchor sits on art thinner than the radius. The largest core stands in
    // — not a tie-break but the only anchor those holds have.
    for (let index = 0; index < core.length; index += 1) {
      if (core[index] !== 1 || coreVisited[index] === 1) continue;
      const candidate = component(core, width, height, index, coreVisited);
      if (candidate.length > body.length) body = candidate;
    }
  }

  const bodyMask = new Uint8Array(core.length);
  for (const index of body) bodyMask[index] = 1;
  const grown = dilate(bodyMask, width, height, radius);
  const kept = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    kept[index] = mask[index] === 1 && grown[index] === 1 ? 1 : 0;
  }
  if (kept[anchor] !== 1) return mask;
  const reachable = new Uint8Array(kept.length);
  const members = component(kept, width, height, anchor, reachable);
  const out = new Uint8Array(kept.length);
  for (const index of members) out[index] = 1;
  return out;
}

/**
 * Do two segments cross at a point interior to both?
 *
 * Strict: a shared endpoint is not a crossing, because consecutive edges of a
 * ring share one by construction and the caller excludes those pairs anyway.
 * Collinear overlap counts, since a ring that doubles back along itself is not
 * simple however the arithmetic works out.
 */
function segmentsCross(
  [fromAX, fromAY]: RingPoint,
  [toAX, toAY]: RingPoint,
  [fromBX, fromBY]: RingPoint,
  [toBX, toBY]: RingPoint,
): boolean {
  const orientation = (aX: number, aY: number, bX: number, bY: number, cX: number, cY: number): number => {
    const cross = (bX - aX) * (cY - aY) - (bY - aY) * (cX - aX);
    return cross > 0 ? 1 : cross < 0 ? -1 : 0;
  };
  const onSegment = (aX: number, aY: number, bX: number, bY: number, pX: number, pY: number): boolean =>
    Math.min(aX, bX) <= pX && pX <= Math.max(aX, bX) && Math.min(aY, bY) <= pY && pY <= Math.max(aY, bY);

  const first = orientation(fromAX, fromAY, toAX, toAY, fromBX, fromBY);
  const second = orientation(fromAX, fromAY, toAX, toAY, toBX, toBY);
  const third = orientation(fromBX, fromBY, toBX, toBY, fromAX, fromAY);
  const fourth = orientation(fromBX, fromBY, toBX, toBY, toAX, toAY);
  if (first !== second && third !== fourth) return true;
  if (first === 0 && onSegment(fromAX, fromAY, toAX, toAY, fromBX, fromBY)) return true;
  if (second === 0 && onSegment(fromAX, fromAY, toAX, toAY, toBX, toBY)) return true;
  if (third === 0 && onSegment(fromBX, fromBY, toBX, toBY, fromAX, fromAY)) return true;
  if (fourth === 0 && onSegment(fromBX, fromBY, toBX, toBY, toAX, toAY)) return true;
  return false;
}

/**
 * Is this implicitly-closed ring simple — no edge crossing any non-adjacent
 * edge?
 *
 * O(n²) on a ring the storage bound caps at 150 points, so about 11,000 integer
 * orientation tests at the very worst. Free, next to the image work that
 * produced the ring.
 */
export function isSimpleRing(points: ReadonlyArray<RingPoint>): boolean {
  const count = points.length;
  if (count < 3) return false;
  for (let first = 0; first < count; first += 1) {
    const firstEnd = (first + 1) % count;
    for (let second = first + 1; second < count; second += 1) {
      const secondEnd = (second + 1) % count;
      // Adjacent edges share an endpoint by construction, including the pair
      // either side of the implicit closing edge.
      if (secondEnd === first || firstEnd === second) continue;
      if (segmentsCross(points[first], points[firstEnd], points[second], points[secondEnd])) return false;
    }
  }
  return true;
}
