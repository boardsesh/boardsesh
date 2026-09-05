// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

/**
 * Keying a hold set off a flat white ground, and the placement merge that goes
 * with it.
 *
 * Every other board in the catalogue ships its art as a stack of mostly
 * transparent layers, so "hold substance" IS the alpha channel and there is
 * nothing to segment. Woods is a photograph: the hold set is composited on a
 * flat, fully opaque `#FFFFFF` ground, the alpha channel is 100% filled, and a
 * tracer reading it back gets the whole board. Recovering the alpha the
 * photographer never wrote is what this module does.
 *
 * The two primitives are lifted verbatim out of
 * `scripts/generate-woods-dark-art.ts`, which needed exactly the same alpha for
 * the opposite reason — it dims what survives and ships it as the dark-mode art.
 * They live here so both callers key the same pixels; that script now imports
 * them, and `vp run generate:woods-dark-art -- --check` is the byte-identity
 * proof that the move changed nothing.
 *
 * Pure and platform-free on purpose: no `sharp`, no `node:fs`, integers only. A
 * caller decodes; this decides.
 */

/**
 * A pixel counts as board ground when every channel is at least this bright.
 *
 * Verified insensitive rather than tuned: sweeping it across 225-245 moves the
 * filled fraction by at most 2.1 points on either Woods size, i.e. there is no
 * hold body sitting near the cutoff. The connectivity below is what does the
 * real work.
 */
export const GROUND_FLOOR = 235;

/** RGBA pixels the keying functions write alpha into, with their dimensions. */
export type MutableRaster = {
  /** Tightly packed RGBA, `width * height * 4` bytes. */
  data: Uint8Array;
  width: number;
  height: number;
};

/**
 * Zero the alpha of the connected white ground, seeded from the four corners.
 *
 * CONNECTED-ONLY IS THE WHOLE POINT. Pale holds carry near-white specular
 * highlights, and a global "near-white => transparent" rule punches holes
 * straight through them. Nothing reachable from a corner is a hold.
 *
 * An explicit stack rather than recursion: the ground is ~2/3 of a 1225x1400
 * image, which would blow the call stack several times over.
 */
export function keyOutGround({ data, width, height }: MutableRaster, groundFloor: number = GROUND_FLOOR): void {
  const isGround = (pixel: number) => {
    const offset = pixel * 4;
    return data[offset] >= groundFloor && data[offset + 1] >= groundFloor && data[offset + 2] >= groundFloor;
  };

  const stack = [0, width - 1, (height - 1) * width, height * width - 1];
  while (stack.length > 0) {
    const pixel = stack.pop() as number;
    const offset = pixel * 4;
    if (data[offset + 3] === 0) continue;
    if (!isGround(pixel)) continue;

    data[offset + 3] = 0;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x > 0) stack.push(pixel - 1);
    if (x < width - 1) stack.push(pixel + 1);
    if (y > 0) stack.push(pixel - width);
    if (y < height - 1) stack.push(pixel + width);
  }
}

/**
 * Drop every opaque pixel that touches a keyed one, so the antialiased white-ish
 * rim goes with the ground. Reads from a snapshot of the alpha rather than in
 * place, otherwise the first cleared pixel would seed its neighbour and the erode
 * would eat whole holds.
 */
export function erodeEdge({ data, width, height }: MutableRaster): void {
  const wasKeyed = new Uint8Array(width * height);
  for (let pixel = 0; pixel < wasKeyed.length; pixel++) {
    wasKeyed[pixel] = data[pixel * 4 + 3] === 0 ? 1 : 0;
  }

  const touchesKeyed = (x: number, y: number) => {
    const maxY = Math.min(height - 1, y + 1);
    const maxX = Math.min(width - 1, x + 1);
    for (let neighbourY = Math.max(0, y - 1); neighbourY <= maxY; neighbourY++) {
      for (let neighbourX = Math.max(0, x - 1); neighbourX <= maxX; neighbourX++) {
        if (wasKeyed[neighbourY * width + neighbourX] === 1) return true;
      }
    }
    return false;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (wasKeyed[pixel] === 1) continue;
      if (touchesKeyed(x, y)) data[pixel * 4 + 3] = 0;
    }
  }
}

/**
 * How to key one photographic board.
 *
 * `groundFloor` is a BRIGHTNESS floor, which is a statement about this board's
 * ground and not about photographic art in general. A board shot on a grey or
 * coloured sweep would need `{ colour, tolerance }` instead — the flood fill and
 * the erode above would carry over unchanged, only `isGround` would move. That
 * generalisation is deliberately not written until a second board needs it,
 * because a two-shaped parameter with one shape in use is a guess.
 */
export type WhiteKeyOptions = {
  /** Every channel at least this bright counts as ground. */
  groundFloor?: number;
  /** Pixels of antialiased rim to drop after the flood. 0 skips the erode. */
  erodePx?: number;
};

export type WhiteKeyMask = {
  /** 1 = hold substance, 0 = ground. `width * height` entries, row-major. */
  mask: Uint8Array;
  /** Share of the image the corner flood reached, 0..1 — before the erode. */
  groundShare: number;
  /** Share of the image that survived as hold substance, 0..1 — after the erode. */
  maskShare: number;
};

/**
 * The hold-substance mask for a photographic board, and the two shares that say
 * whether the key found a ground at all.
 *
 * Accepts 3- or 4-channel pixels and NEVER writes to them: the flood and the
 * erode run over a private RGBA scratch buffer, so a caller can hand the same
 * decoded art to this and to a colour measurement in either order.
 *
 * `maskShare` is the answer a caller routes on. A board whose corners are not
 * ground keys almost nothing, so its mask share stays near 1 and it is honestly
 * not segmentable by this rule.
 */
export function buildWhiteKeyMask(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  { groundFloor = GROUND_FLOOR, erodePx = 1 }: WhiteKeyOptions = {},
): WhiteKeyMask {
  if (channels !== 3 && channels !== 4) {
    throw new Error(`buildWhiteKeyMask expects 3 or 4 channels, got ${channels}`);
  }
  const pixelCount = width * height;
  if (pixels.length < pixelCount * channels) {
    throw new Error(`buildWhiteKeyMask got ${pixels.length} bytes for ${width}x${height}x${channels}`);
  }
  if (erodePx !== 0 && erodePx !== 1) {
    // One pass is what the antialiased rim needs and what the shipped dark art
    // uses. A wider erode would want a disc rather than repeated 8-neighbour
    // passes, so refuse rather than approximate one.
    throw new Error(`buildWhiteKeyMask supports erodePx 0 or 1, got ${erodePx}`);
  }

  const scratch = new Uint8Array(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const from = pixel * channels;
    const to = pixel * 4;
    scratch[to] = pixels[from];
    scratch[to + 1] = pixels[from + 1];
    scratch[to + 2] = pixels[from + 2];
    // A source that already carries alpha keeps it: a pixel the artwork made
    // transparent is not ground the flood has to discover, and leaving it opaque
    // here would let the flood stop at it.
    scratch[to + 3] = channels === 4 ? pixels[from + 3] : 255;
  }

  const raster: MutableRaster = { data: scratch, width, height };
  keyOutGround(raster, groundFloor);

  let ground = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (scratch[pixel * 4 + 3] === 0) ground += 1;
  }

  if (erodePx === 1) erodeEdge(raster);

  const mask = new Uint8Array(pixelCount);
  let kept = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (scratch[pixel * 4 + 3] === 0) continue;
    mask[pixel] = 1;
    kept += 1;
  }

  return { mask, groundShare: ground / pixelCount, maskShare: kept / pixelCount };
}

/** A placement the coincidence merge can group: an id and a centre in board pixels. */
export type PlacementCentre = { id: number; cx: number; cy: number };

export type CoincidentGroups = {
  /** Every placement id -> its group's canonical id. A lone placement maps to itself. */
  canonicalOf: Map<number, number>;
  /** Canonical id -> every member id including the canonical, ascending. */
  membersOf: Map<number, number[]>;
};

/**
 * Group placements whose centres land on the same board pixel, or all but.
 *
 * WHY A PHOTOGRAPHIC BOARD NEEDS THIS AND A TRANSPARENT ONE DOES NOT. The tracer
 * partitions art by nearest placement, and Woods' hold table carries pairs of
 * placements 0-2 board pixels apart (the same physical hold offered at two bolt
 * orientations). Two bolts inside one hold split that hold down the midline
 * between them and each half traces as a silhouette; where the two centres round
 * to the SAME pixel the partition cannot even seed both, and one of the pair
 * silently loses its label. Merging them first makes the group one seed, one
 * trace, and one outline emitted under every member id — which is what a climber
 * sees, since there is one hold on the wall.
 *
 * Integer distance on ROUNDED centres, because the partition is built on rounded
 * centres too: two placements the partition cannot separate are exactly the ones
 * that have to merge. Lowest id is canonical so the grouping does not depend on
 * the order the board data happens to list placements in.
 */
export function mergeCoincidentPlacements(placements: ReadonlyArray<PlacementCentre>, epsilonPx = 2): CoincidentGroups {
  const parent = placements.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  const rounded = placements.map((placement) => [Math.round(placement.cx), Math.round(placement.cy)] as const);
  const limit = epsilonPx * epsilonPx;
  for (let index = 0; index < placements.length; index += 1) {
    for (let other = index + 1; other < placements.length; other += 1) {
      const deltaX = rounded[index][0] - rounded[other][0];
      const deltaY = rounded[index][1] - rounded[other][1];
      if (deltaX * deltaX + deltaY * deltaY <= limit) union(index, other);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let index = 0; index < placements.length; index += 1) {
    const root = find(index);
    const bucket = byRoot.get(root);
    if (bucket === undefined) byRoot.set(root, [placements[index].id]);
    else bucket.push(placements[index].id);
  }

  const canonicalOf = new Map<number, number>();
  const membersOf = new Map<number, number[]>();
  for (const bucket of byRoot.values()) {
    const members = [...bucket].sort((left, right) => left - right);
    const canonical = members[0];
    membersOf.set(canonical, members);
    for (const id of members) canonicalOf.set(id, canonical);
  }
  return { canonicalOf, membersOf };
}
