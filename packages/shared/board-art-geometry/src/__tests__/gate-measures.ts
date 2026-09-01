/// <reference types="node" />

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { BoardName } from '@boardsesh/shared-schema';
import { getBackgroundRelPaths, getBoardDetailsForBoard } from '@boardsesh/board-render';
import { getSetsForLayoutAndSize } from '@boardsesh/board-constants/product-sizes';
import {
  MOONBOARD_CELL_SETS,
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  WOODS_LAYOUTS,
  WOODS_SETS,
} from '@boardsesh/board-config';
import { buildWhiteKeyMask, mergeCoincidentPlacements } from '@boardsesh/board-art-geometry/segmentation';

/**
 * The measurements the seven capture gates are built out of (issue #2202).
 *
 * A separate module from the gates themselves so the assertions read as
 * assertions, and so the pin tables in `geometry-gates.test.ts` can be
 * re-derived with the same code that checks them.
 *
 * EVERY CONSTANT HERE IS DELIBERATELY RESTATED, not imported from
 * `scripts/generate-board-art-geometry.ts` — and so is the placement->image
 * routing the per-image gates need. A gate that shares its inputs with the code
 * it audits stops being a check on anything the moment one of them moves, and
 * the generator is a Node script that pulls in the whole catalogue, which a
 * package test should not.
 *
 * ONE INPUT IS SHARED, deliberately: `buildWhiteKeyMask` and
 * `mergeCoincidentPlacements` are IMPORTED for the photographic boards rather
 * than restated. A mask is not a threshold to re-derive, it is the substance
 * itself — measure a silhouette's boundary against a mask cut half a pixel
 * differently to the one the tracer cut it from and the gate reports the
 * difference between two flood fills, not a defect in the geometry. Restating it
 * would turn gates 6 and 7 into noise on exactly the board they are newest on.
 *
 * The independent anchor for that half lives elsewhere: `white-key.test.ts` pins
 * the mask's ground and hold shares on the real art as golden four-decimal
 * numbers, and pins the merged-group counts against `COINCIDENT_PAIR_BUDGET` in
 * `@boardsesh/board-config`, which is derived from the hold table rather than
 * from this package. A change to the key that moves a single pixel fails there
 * before it can quietly move a gate here.
 */

/** Mirrors the generator's search box, in placement radii. */
export const SEARCH_RADII = 2.6;
/** And the wider box a photographic board is traced in. */
export const PHOTO_SEARCH_RADII = 3.5;
/**
 * Opaque share of the composited art above which the alpha channel carries no
 * silhouette and the generator keys the ground out instead.
 */
export const OPAQUE_ART_CEILING = 0.95;
/**
 * The boards whose art is a photograph rather than a stack of transparent
 * layers, and are therefore traced off a white key.
 *
 * A NAME LIST HERE, and only because the alternative is worse: the routing is a
 * fact about decoded art, and gates 1-5 are synchronous geometry that never
 * decodes anything. It is not trusted, though — `assertPhotographicRouting`
 * measures the real composite and fails if this set and the art disagree in
 * either direction, so a board that ships photographic art without being listed
 * (or a listed board whose art gains an alpha channel) breaks the gate rather
 * than quietly measuring the wrong thing.
 */
const PHOTOGRAPHIC_BOARDS = new Set(['woods']);
/** Two placements this close in ROUNDED board px are one hold — see `mergeCoincidentPlacements`. */
const COINCIDENT_EPSILON_PX = 2;
/** Fraction of perimeter allowed on the search-box boundary before the trace is junk. */
export const MAX_BOX_EDGE_SHARE = 0.1;
/** A pixel counts as hold art if its alpha is at least this. */
export const ALPHA_FLOOR = 96;

/**
 * The per-shard substance floor — restated from the generator's crisp tracer
 * profiles, like every other constant here. Crisp-profile boards trace the 50%
 * isoline; measuring their silhouettes against the historical 37.6% mask counts
 * the anti-aliased ramp the profile deliberately excludes, which reads as area
 * "lost" on every hold and craters gate 7's recovery on the smallest chips.
 * The COMPOSITE mask (photographic routing, colour readings) stays at 96
 * everywhere — that question is about the stack, not the profile.
 */
const CRISP_SHARD_PREFIXES = [
  'kilter/1-',
  'kilter/8-',
  'tension/9-',
  'tension/10-',
  'tension/11-',
  'decoy/2-',
  'grasshopper/1-',
  'soill/1-',
  'touchstone/1-',
  'moonboard/1-',
  'moonboard/2-',
  'moonboard/3-',
  'moonboard/4-',
  'moonboard/5-',
  'moonboard/6-',
  'moonboard/7-',
];

export function alphaFloorFor(key: string): number {
  return CRISP_SHARD_PREFIXES.some((prefix) => key.startsWith(prefix)) ? 128 : ALPHA_FLOOR;
}
/** Neck-trim radius as a fraction of the placement radius — the radius gate 5 opens at. */
export const TRIM_RADIUS_PER_PLACEMENT_RADIUS = 0.078;
/** Board px² a 3-px open may cost an outline before the trimmed part counts as a spur. */
export const MAX_SPUR_AREA = 20;
/** Within this of an image axis, a segment is straight enough to be a crop-box side. */
const AXIS_TOLERANCE = Math.tan((2 * Math.PI) / 180);
/** A crop rectangle is four axis-aligned runs and almost nothing else. */
export const CROP_BOX_MIN_RUNS = 4;
export const CROP_BOX_PERIMETER_SHARE = 0.8;
/** Douglas-Peucker tolerance the generator simplifies at, in board pixels. */
export const SIMPLIFY_EPSILON = 1.6;
/** Board pixels a segment may be off the search-box boundary and still count as on it. */
const BOX_EDGE_TOLERANCE_PX = 1;
/**
 * Board pixels to step along the outward normal when asking what is on the other
 * side of the boundary, as an offset from the shard's own cut clearance.
 *
 * MUST scale with that clearance, and this is the bug it fixes. The probe was a
 * flat 2.5 board px, chosen when every board's clearance was 3: the tracer had
 * deleted everything within 3 px of a neighbour's art, so a compliant boundary
 * could not have art 2.5 px beyond it and the measure meant something. Once the
 * clearance became a fraction of the placement radius, a shard clearing 2 px was
 * being probed 0.5 px BEYOND its own guarantee, and read as defective by
 * construction. Sweeping touchstone/1-1 shows the whole effect is the probe:
 * 6 outlines over 5% at a probe of 2.0, 32 at 2.5, 69 at 3.0, on identical
 * geometry.
 *
 * Half a pixel inside the clearance is the honest question — "is there a
 * neighbour's art immediately short of where the pullback was allowed to stop" —
 * and it reproduces the original 2.5 exactly on the boards the original was
 * calibrated against.
 */
const CUT_PROBE_INSET_FROM_CLEARANCE = 0.5;

/** The probe distance for one placement, in board pixels. */
export function cutProbeDistance(placementRadius: number): number {
  return radiusForPlacement(placementRadius) - CUT_PROBE_INSET_FROM_CLEARANCE;
}

// ---------------------------------------------------------------------------
// Hand-corrected outlines
// ---------------------------------------------------------------------------

/** Where `vp run db:export-outline-overrides` writes the committed corrections. */
export const OVERRIDES_DIR = fileURLToPath(new URL('../../overrides/', import.meta.url));

/** The committed corrections for one shard, as the exporter writes them. */
export type OverrideFile = {
  outlines?: Record<string, number[]>;
  ledInner?: Record<string, number[]>;
};

/**
 * Read one config's committed overrides, or `null` where it has none.
 *
 * PARSED HERE rather than imported from the generator's merge module, like every
 * other input in this file. Reading the JSON is not restating a measurement —
 * it is data, and the whole point of these gates is that they reach the same
 * files the generator did by their own route.
 */
export function overridesForKey(key: string): OverrideFile | null {
  const filePath = path.join(OVERRIDES_DIR, `${key}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8')) as OverrideFile;
}

/** Every shard key with a committed override file. */
export function overriddenShardKeys(): string[] {
  if (!existsSync(OVERRIDES_DIR)) return [];
  const keys: string[] = [];
  for (const boardEntry of readdirSync(OVERRIDES_DIR, { withFileTypes: true })) {
    if (!boardEntry.isDirectory()) continue;
    for (const fileEntry of readdirSync(path.join(OVERRIDES_DIR, boardEntry.name), { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.json')) continue;
      keys.push(`${boardEntry.name}/${fileEntry.name.slice(0, -'.json'.length)}`);
    }
  }
  return keys.sort();
}

/**
 * The placements of one shard whose SILHOUETTE a human drew.
 *
 * Gates 2, 3 and 7 still bind on these, and they are the invariants that matter
 * for a drawing: it swallows no second placement, it is not the crop rectangle,
 * it keeps its own hold.
 *
 * Gate 1, gate 5 and gate 6 do NOT. Gates 5 and 6 measure TRACER PATHOLOGIES — a
 * limb joined through a thin neck, a boundary that is a partition cut rather
 * than an art edge — and a human correcting exactly those defects trips them by
 * construction. The commonest correction is a contact cut, where the fix is to
 * draw the hold's real edge, and the hold's real edge is ON the neighbour's art:
 * gate 6 would read that as the defect it was drawn to repair.
 *
 * Gate 1 is exempt for a different and sharper reason — a TOLERANCE MISMATCH.
 * Its threshold is the 1.6 board px simplification tolerance, which on
 * kilter/1-28 is 0.052 radii, while the rule a correction is actually held to —
 * by the backend on write and by the merge on read — is `CENTRE_TOLERANCE_RADII`
 * at 0.25 radii. Five times looser. A legal correction whose bolt sits 0.1 radii
 * outside the drawn edge therefore passes the editor, the export and the merge
 * and then reds this gate with no remedy available: the hold can neither be
 * corrected nor left alone. The 0.25 rule binds instead on the committed ring,
 * in `overrides.test.ts`, which is where it can actually be satisfied.
 *
 * `ledInner` rings are exempt from all seven — a base-plate boundary is not a
 * silhouette and none of these measures mean anything about one — and get their
 * own structural checks in `overrides.test.ts`.
 *
 * ON ACTIVATED LAYOUTS a correction travels: the generator adopts a sibling
 * config's silhouette wherever both configs draw the placement from the SAME
 * art image (`adoptSameImageOverrides`), so the exemption has to travel with
 * the ring — a shard shipping a hand-drawn silhouette adopted from its sibling
 * would otherwise be measured as if the tracer had drawn it.
 */
export function overriddenPlacementIds(key: string): Set<number> {
  const file = overridesForKey(key);
  const ids = new Set(Object.keys(file?.outlines ?? {}).map(Number));

  const [boardName, layoutAndSize] = key.split('/');
  const layoutId = Number(layoutAndSize.split('-')[0]);
  if (!SAME_IMAGE_OVERRIDE_LAYOUTS.has(`${boardName}/${layoutId}`)) return ids;
  const siblingKeys = overriddenShardKeys().filter(
    (candidate) => candidate !== key && candidate.startsWith(`${boardName}/${layoutId}-`),
  );
  if (siblingKeys.length === 0) return ids;

  const imageFor = (board: ShardBoard, placementId: number): string | undefined => {
    const layer = board.layerOfPlacement.get(placementId) ?? -1;
    return layer >= 0 ? board.backgroundRelPaths[layer] : undefined;
  };
  const own = shardBoardForKey(key);
  for (const siblingKey of siblingKeys) {
    const rows = Object.keys(overridesForKey(siblingKey)?.outlines ?? {}).map(Number);
    if (rows.length === 0) continue;
    const sibling = shardBoardForKey(siblingKey);
    for (const placementId of rows) {
      const ownImage = imageFor(own, placementId);
      if (ownImage !== undefined && ownImage === imageFor(sibling, placementId)) ids.add(placementId);
    }
  }
  return ids;
}

/**
 * Layouts whose silhouette corrections are adopted across configs sharing the
 * same art image — restated from the generator's `CANONICAL_LAYOUTS`, like
 * every other constant in this file, so the gates cannot inherit a routing bug
 * from the code they audit.
 */
export const SAME_IMAGE_OVERRIDE_LAYOUTS = new Set(CRISP_SHARD_PREFIXES.map((prefix) => prefix.slice(0, -1)));

export type Placement = { id: number; cx: number; cy: number; r: number };

export type ShardBoard = {
  key: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  boardWidth: number;
  boardHeight: number;
  placements: Placement[];
  placementById: Map<number, Placement>;
  backgroundRelPaths: string[];
  /**
   * Which art layer draws each placement, as an index into
   * `backgroundRelPaths`; `-1` for a placement no layer draws.
   *
   * Restated from the board data rather than taken from the generator, like
   * everything else here. Aurora states it outright — `images_to_holds` IS image
   * -> hold tuples — and MoonBoard routes through `MOONBOARD_CELL_SETS`, grid
   * cell -> hold set -> that set's image, because its own map carries keys with
   * empty values.
   */
  layerOfPlacement: Map<number, number>;
  /**
   * The placements each layer draws, in placement order — and on a photographic
   * board, the CANONICAL placement of each coincident group, because that is what
   * the tracer's partition was seeded with.
   */
  placementsByLayer: Placement[][];
  /** Half-width of the search box this shard was traced in, in placement radii. */
  searchRadii: number;
  /** Whether the shard was traced off a white key rather than off an alpha channel. */
  photographic: boolean;
  /**
   * Placement -> the placement whose trace it shipped.
   *
   * Identity everywhere but a photographic board, where placements 0-2 rounded
   * board px apart are one hold with one silhouette emitted under every member
   * id. The art gates have to ask about the hold, not the member: measured
   * against a member's own centre, the canonical would win most of the cell and
   * the same polygon would read as covering twice its own body.
   */
  canonicalPlacement: Map<number, Placement>;
};

/**
 * The board behind a shard key, with EVERY set of that layout and size mounted —
 * which is what the shard was traced against.
 *
 * The set enumeration is restated rather than taken from the generator's
 * `listCatalogueEntries`, for the same reason the constants above are: a gate
 * that shares its inputs with the code it audits is only checking that the code
 * agrees with itself. (It also is not exported from `@boardsesh/board-render`'s
 * barrel — it imports `node:crypto` and is deliberately kept out of client
 * bundles.)
 */
export function shardBoardForKey(key: string): ShardBoard {
  const [boardName, layoutAndSize] = key.split('/');
  const [layoutId, sizeId] = layoutAndSize.split('-').map(Number);

  let setIds: number[];
  if (boardName === 'moonboard') {
    const layoutKey = Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.id === layoutId)?.[0];
    setIds = (MOONBOARD_SETS[layoutKey as keyof typeof MOONBOARD_SETS] ?? [])
      .map((set) => set.id)
      .sort((left, right) => left - right);
  } else if (boardName === 'woods') {
    setIds = WOODS_SETS.map((set) => set.id).sort((left, right) => left - right);
    if (layoutId !== WOODS_LAYOUTS.woods.id) throw new Error(`${key}: unexpected Woods layout`);
  } else {
    setIds = getSetsForLayoutAndSize(boardName as BoardName, layoutId, sizeId)
      .map((set) => set.id)
      .sort((left, right) => left - right);
  }

  const details = getBoardDetailsForBoard({
    board_name: boardName,
    layout_id: layoutId,
    size_id: sizeId,
    set_ids: setIds,
  });

  // A board can list the same placement under more than one set; the tracer
  // emits one outline per id, so the gates count placements the same way.
  const placements: Placement[] = [];
  const placementById = new Map<number, Placement>();
  for (const hold of details.holdsData) {
    if (placementById.has(hold.id)) continue;
    const placement: Placement = { id: hold.id, cx: hold.cx, cy: hold.cy, r: hold.r };
    placements.push(placement);
    placementById.set(hold.id, placement);
  }

  // `getBackgroundRelPaths` walks the `images_to_holds` keys in order, so key
  // `i` is layer `i`.
  const imageKeys = Object.keys(details.images_to_holds);
  const layerOfPlacement = new Map<number, number>();
  if (boardName === 'moonboard') {
    const layoutKey = Object.entries(MOONBOARD_LAYOUTS).find(([, layout]) => layout.id === layoutId)?.[0];
    const layerOfSet = new Map<number, number>();
    for (const set of MOONBOARD_SETS[layoutKey as keyof typeof MOONBOARD_SETS] ?? []) {
      const index = imageKeys.indexOf(`${details.layoutFolder}/${set.imageFile}`);
      if (index >= 0) layerOfSet.set(set.id, index);
    }
    const cells = MOONBOARD_CELL_SETS[layoutId] ?? {};
    for (const placement of placements) {
      const setId = cells[placement.id];
      layerOfPlacement.set(placement.id, (setId === undefined ? undefined : layerOfSet.get(setId)) ?? -1);
    }
  } else {
    for (const [index, imageKey] of imageKeys.entries()) {
      for (const [holdId] of details.images_to_holds[imageKey]) layerOfPlacement.set(holdId, index);
    }
    // A board that states no routing but ships ONE image has an unambiguous one:
    // that image draws every placement. Woods is the case — its
    // `images_to_holds` carries a key with an empty value, because its geometry
    // is a detected hold table rather than Aurora's per-image tuples.
    //
    // Restated from the generator's `placementFieldIndex`, including its
    // fallback: no routing and more than one image leaves every placement
    // unrouted, which downstream is a ring rather than an error. A gate that
    // threw there would fail on a board the generator ships perfectly happily.
    if (layerOfPlacement.size === 0 && imageKeys.length === 1) {
      for (const placement of placements) layerOfPlacement.set(placement.id, 0);
    } else {
      for (const placement of placements) {
        if (!layerOfPlacement.has(placement.id)) layerOfPlacement.set(placement.id, -1);
      }
    }
  }
  const photographic = PHOTOGRAPHIC_BOARDS.has(boardName);
  // One hold, one trace: the shard emits one silhouette per coincident group
  // under every member's id, so the partition the art gates rebuild has to be
  // seeded with the same canonicals the tracer seeded with.
  const groups = mergeCoincidentPlacements(placements, COINCIDENT_EPSILON_PX);
  const canonicalPlacement = new Map<number, Placement>();
  for (const placement of placements) {
    const canonicalId = photographic ? (groups.canonicalOf.get(placement.id) ?? placement.id) : placement.id;
    canonicalPlacement.set(placement.id, placementById.get(canonicalId) as Placement);
  }

  const placementsByLayer: Placement[][] = imageKeys.map(() => []);
  for (const placement of placements) {
    const index = layerOfPlacement.get(placement.id) ?? -1;
    if (index < 0) continue;
    if (photographic && canonicalPlacement.get(placement.id) !== placement) continue;
    placementsByLayer[index].push(placement);
  }

  return {
    key,
    boardName: boardName as BoardName,
    layoutId,
    sizeId,
    boardWidth: details.boardWidth,
    boardHeight: details.boardHeight,
    placements,
    placementById,
    backgroundRelPaths: getBackgroundRelPaths(details, false),
    layerOfPlacement,
    placementsByLayer,
    searchRadii: photographic ? PHOTO_SEARCH_RADII : SEARCH_RADII,
    photographic,
    canonicalPlacement,
  };
}

/**
 * The generator's per-placement radius rule, restated. A hold's neck is a
 * fraction of the hold, so the trim radius is a fraction of the placement
 * radius; gate 5 has to open at the radius the tracer trimmed at or it measures
 * a different hold to the one that shipped.
 *
 * The rule this replaces scaled with the board's PIXEL width, which is not the
 * same thing: TB2's 12x12 Wide is 1461 px across carrying the same 31.8 px
 * placement radius as the 1080 px 12x12, and the extra pixel of trim it bought
 * is what left the one outline that had to be pinned as a known gate-5 failure.
 */
export function radiusForPlacement(placementRadius: number): number {
  return Math.max(2, Math.round(TRIM_RADIUS_PER_PLACEMENT_RADIUS * placementRadius));
}

/**
 * A shard polygon back in the whole board pixels the tracer worked in.
 *
 * The tracer walks the art in integer board pixels offset from the ROUNDED
 * placement centre, and emits `(absoluteBoardPixel - exactCentre) / r` so a
 * renderer drawing at `cx + value * r` lands back on the pixel the art was
 * traced from. Undoing that division here recovers the tracer's own integers to
 * within 0.005 board px (the 4-decimal rounding at the catalogue's smallest
 * radius), so every gate below measures exactly the polygon that was traced —
 * scanline rasters and box-edge distances are both half-pixel-sensitive, and
 * measuring them a half pixel off the tracer's frame reports defects that are
 * only the rounding.
 *
 * Coordinates come back relative to `Math.round(cx)`, `Math.round(cy)`, which is
 * where the search box and the neighbouring placements sit for gates 2, 3 and 6.
 */
export function toTracerPixels(flat: number[], placement: Placement): number[] {
  const roundingX = placement.cx - Math.round(placement.cx);
  const roundingY = placement.cy - Math.round(placement.cy);
  return flat.map((value, index) => Math.round(value * placement.r + (index % 2 === 0 ? roundingX : roundingY)));
}

/**
 * The same frame conversion without the final integer rounding.
 *
 * `toTracerPixels` reconstructs the classic tracer's INTEGER pixel vertices,
 * and the gates' pins were baselined through it — it stays as it is. But a
 * crisp-profile shard ships sub-pixel vertices, and rounding both a silhouette
 * and the inner ring inside it injects up to ~1 px of pure quantisation into a
 * containment measure whose tolerance IS one pixel. Containment runs exact.
 */
export function toTracerPixelsExact(flat: number[], placement: Placement): number[] {
  const roundingX = placement.cx - Math.round(placement.cx);
  const roundingY = placement.cy - Math.round(placement.cy);
  return flat.map((value, index) => value * placement.r + (index % 2 === 0 ? roundingX : roundingY));
}

/** Crossing-count containment for a flat [x0, y0, x1, y1, ...] polygon. Scale-free. */
export function containsPoint(flat: number[], pointX: number, pointY: number): boolean {
  let inside = false;
  const count = flat.length / 2;
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    const currentX = flat[index * 2];
    const currentY = flat[index * 2 + 1];
    const previousX = flat[previous * 2];
    const previousY = flat[previous * 2 + 1];
    if (currentY > pointY === previousY > pointY) continue;
    const crossingX = ((previousX - currentX) * (pointY - currentY)) / (previousY - currentY) + currentX;
    if (pointX < crossingX) inside = !inside;
  }
  return inside;
}

/**
 * Share of perimeter lying on the search-box boundary, in board pixels. A trace
 * that ran into the box and followed it always has one; a real silhouette never
 * does. This is the generator's own backstop restated, so the gate catches a box
 * edge that slipped past a loosened threshold rather than only one the generator
 * already rejects.
 */
export function boxEdgeShare(flatBoardPx: number[], box: number): number {
  let onEdge = 0;
  let perimeter = 0;
  const count = flatBoardPx.length / 2;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const length = Math.hypot(
      flatBoardPx[next * 2] - flatBoardPx[index * 2],
      flatBoardPx[next * 2 + 1] - flatBoardPx[index * 2 + 1],
    );
    perimeter += length;
    const onVertical =
      Math.abs(Math.abs(flatBoardPx[index * 2]) - box) <= BOX_EDGE_TOLERANCE_PX &&
      Math.abs(Math.abs(flatBoardPx[next * 2]) - box) <= BOX_EDGE_TOLERANCE_PX;
    const onHorizontal =
      Math.abs(Math.abs(flatBoardPx[index * 2 + 1]) - box) <= BOX_EDGE_TOLERANCE_PX &&
      Math.abs(Math.abs(flatBoardPx[next * 2 + 1]) - box) <= BOX_EDGE_TOLERANCE_PX;
    if (onVertical || onHorizontal) onEdge += length;
  }
  return perimeter === 0 ? 1 : onEdge / perimeter;
}

/**
 * How far outside the polygon a point sits, in the polygon's own units. `0` when
 * it is inside or exactly on the boundary.
 *
 * Gate 1 asks a containment question about a point the boundary can genuinely
 * run through — a screw-on hold is often drawn BESIDE its bolt rather than over
 * it — so it needs the distance, not the predicate. Anything under the
 * simplification tolerance is the simplification, not a misplaced silhouette;
 * anything far outside is a trace that landed on the wrong hold.
 */
export function distanceOutsidePolygon(flat: number[], pointX: number, pointY: number): number {
  if (containsPoint(flat, pointX, pointY)) return 0;
  let best = Infinity;
  const count = flat.length / 2;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const fromX = flat[index * 2];
    const fromY = flat[index * 2 + 1];
    const deltaX = flat[next * 2] - fromX;
    const deltaY = flat[next * 2 + 1] - fromY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const along =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((pointX - fromX) * deltaX + (pointY - fromY) * deltaY) / lengthSquared));
    best = Math.min(best, Math.hypot(pointX - (fromX + along * deltaX), pointY - (fromY + along * deltaY)));
  }
  return best;
}

/**
 * Whether the polygon reaches the search box at all, on either axis.
 *
 * The crop-box signature below is a SHAPE test, and on its own it is not
 * sufficient: Douglas-Peucker at 1.6 board px leaves a small blocky hold with
 * eight or ten points, and 12 real holds across the catalogue come out 80-96%
 * axis-aligned in four runs — grasshopper/1-3's hold 97 is 28 x 88 board pixels
 * inside a 256-pixel search box. A trace that followed the box is the box, so
 * requiring it to actually touch the box is what separates the two. The
 * `boxEdgeShare` measure above is the independent second reading, and it is 0 on
 * all 15,499 shipped outlines.
 */
export function reachesSearchBox(flatBoardPx: number[], box: number): boolean {
  let maxX = 0;
  let maxY = 0;
  for (let index = 0; index < flatBoardPx.length; index += 2) {
    maxX = Math.max(maxX, Math.abs(flatBoardPx[index]));
    maxY = Math.max(maxY, Math.abs(flatBoardPx[index + 1]));
  }
  return maxX >= box - BOX_EDGE_TOLERANCE_PX || maxY >= box - BOX_EDGE_TOLERANCE_PX;
}

/**
 * Maximal runs of consecutive segments pointing the same way along an image axis,
 * and what share of the perimeter they carry. The direction's sign counts: a
 * rectangle is four runs (right, down, left, up) covering all of it, which is the
 * signature; a hold that happens to have two parallel flats is two.
 */
export function axisAlignedRuns(flat: number[]): { runs: number; share: number } {
  const count = flat.length / 2;
  const directions = new Int8Array(count).fill(-1);
  const lengths = new Float64Array(count);
  let perimeter = 0;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const deltaX = flat[next * 2] - flat[index * 2];
    const deltaY = flat[next * 2 + 1] - flat[index * 2 + 1];
    const length = Math.hypot(deltaX, deltaY);
    lengths[index] = length;
    perimeter += length;
    if (length === 0) continue;
    if (Math.abs(deltaY) <= AXIS_TOLERANCE * Math.abs(deltaX)) directions[index] = deltaX > 0 ? 0 : 1;
    else if (Math.abs(deltaX) <= AXIS_TOLERANCE * Math.abs(deltaY)) directions[index] = deltaY > 0 ? 2 : 3;
  }

  let runs = 0;
  let axisLength = 0;
  for (let index = 0; index < count; index += 1) {
    if (directions[index] === -1) continue;
    axisLength += lengths[index];
    if (directions[(index - 1 + count) % count] !== directions[index]) runs += 1;
  }
  return { runs, share: perimeter === 0 ? 0 : axisLength / perimeter };
}

type Raster = { filled: Uint8Array; width: number; height: number; area: number };

/** The polygon's interior plus its border, as a local bitmap in board pixels. */
export function rasterise(flatBoardPx: number[]): Raster {
  const count = flatBoardPx.length / 2;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < count; index += 1) {
    minX = Math.min(minX, flatBoardPx[index * 2]);
    maxX = Math.max(maxX, flatBoardPx[index * 2]);
    minY = Math.min(minY, flatBoardPx[index * 2 + 1]);
    maxY = Math.max(maxY, flatBoardPx[index * 2 + 1]);
  }
  const left = Math.floor(minX) - 1;
  const top = Math.floor(minY) - 1;
  const width = Math.ceil(maxX) - left + 2;
  const height = Math.ceil(maxY) - top + 2;
  const filled = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const scanY = top + y;
    const crossings: number[] = [];
    for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
      const currentY = flatBoardPx[index * 2 + 1];
      const previousY = flatBoardPx[previous * 2 + 1];
      if (currentY > scanY === previousY > scanY) continue;
      const currentX = flatBoardPx[index * 2];
      const previousX = flatBoardPx[previous * 2];
      crossings.push(((previousX - currentX) * (scanY - currentY)) / (previousY - currentY) + currentX);
    }
    crossings.sort((first, second) => first - second);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.max(0, Math.ceil(crossings[pair] - left));
      const to = Math.min(width - 1, Math.floor(crossings[pair + 1] - left));
      for (let x = from; x <= to; x += 1) filled[y * width + x] = 1;
    }
  }

  // The vertices are border pixels of the original mask, so the border itself is
  // part of the hold. Scanline alone drops it wherever a side runs shallower than
  // a pixel per row, which on a 3-px-wide limb is most of it.
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const fromX = flatBoardPx[index * 2] - left;
    const fromY = flatBoardPx[index * 2 + 1] - top;
    const toX = flatBoardPx[next * 2] - left;
    const toY = flatBoardPx[next * 2 + 1] - top;
    const steps = Math.max(1, Math.abs(toX - fromX), Math.abs(toY - fromY));
    for (let step = 0; step <= steps; step += 1) {
      const x = Math.round(fromX + ((toX - fromX) * step) / steps);
      const y = Math.round(fromY + ((toY - fromY) * step) / steps);
      if (x >= 0 && y >= 0 && x < width && y < height) filled[y * width + x] = 1;
    }
  }

  let area = 0;
  for (let index = 0; index < filled.length; index += 1) area += filled[index];
  return { filled, width, height, area };
}

function discOffsets(radius: number): { erosion: Array<[number, number]>; dilation: Array<[number, number]> } {
  const erosion: Array<[number, number]> = [];
  const dilation: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const squared = dx * dx + dy * dy;
      if (squared < radius * radius) erosion.push([dx, dy]);
      if (squared <= radius * radius) dilation.push([dx, dy]);
    }
  }
  return { erosion, dilation };
}

/**
 * Board px² of the polygon that survive a plain morphological open.
 *
 * Deliberately NOT how the generator trims — the tracer grows the seed's core
 * alone, which is the stricter of the two — so this measures the shipped polygons
 * instead of replaying the code that made them. A gate that reproduces the
 * generator's own order passes whatever that order emits.
 */
export function openedArea(flatBoardPx: number[], radius: number): number {
  const { filled, width, height } = rasterise(flatBoardPx);
  const { erosion, dilation } = discOffsets(radius);

  const core = new Uint8Array(filled.length);
  for (let index = 0; index < filled.length; index += 1) {
    if (filled[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    let clear = true;
    for (const [stepX, stepY] of erosion) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height || filled[nextY * width + nextX] !== 1) {
        clear = false;
        break;
      }
    }
    if (clear) core[index] = 1;
  }

  const opened = new Uint8Array(filled.length);
  for (let index = 0; index < core.length; index += 1) {
    if (core[index] !== 1) continue;
    const x = index % width;
    const y = (index - x) / width;
    for (const [stepX, stepY] of dilation) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      if (filled[nextY * width + nextX] === 1) opened[nextY * width + nextX] = 1;
    }
  }
  let survived = 0;
  for (let index = 0; index < opened.length; index += 1) survived += opened[index];
  return survived;
}

/**
 * Board px² a plain open cuts away — the spur measure, and not a perimeter one: a
 * 37-board-px tail that paints across the neighbouring hold barely moves the
 * perimeter share, because the tail has perimeter of its own.
 *
 * A mask with no core comes back untouched, which is the generator's own "keep
 * the raw mask if nothing survives the erosion". Split out from the measure
 * rather than folded into it so a fixture can show the unexempted open deleting
 * the shape, which a `spurArea === 0` alone cannot: an untouched hold and an
 * exempted one both read 0.
 */
export function spurArea(flatBoardPx: number[], radius: number): number {
  const survived = openedArea(flatBoardPx, radius);
  if (survived === 0) return 0;
  return rasterise(flatBoardPx).area - survived;
}

// ---------------------------------------------------------------------------
// Gate 6: the art itself
// ---------------------------------------------------------------------------

/**
 * Every other gate here is geometry against geometry, and none of them can see
 * the defect gate 6 is for — a silhouette boundary that is not an edge of
 * anything, because the nearest-placement partition cut a touching pair apart
 * through solid art. Telling that from a real art edge takes the art.
 */
export const PUBLIC_DIR = fileURLToPath(new URL('../../../../web/public/', import.meta.url));

export type BoardArt = { opaque: Uint8Array; width: number; height: number };

export async function loadBoardArt(width: number, height: number, relativePaths: string[]): Promise<BoardArt> {
  const rawLayer = { width, height, channels: 4 as const };
  let composite: Buffer | null = null;
  for (const relativePath of relativePaths) {
    const layer = await sharp(path.join(PUBLIC_DIR, relativePath))
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    composite =
      composite === null
        ? layer
        : await sharp(composite, { raw: rawLayer })
            .composite([{ input: layer, raw: rawLayer, blend: 'over' }])
            .raw()
            .toBuffer();
  }
  if (composite === null) throw new Error('no layers');
  const opaque = new Uint8Array(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    opaque[pixel] = composite[pixel * 4 + 3] >= ALPHA_FLOOR ? 1 : 0;
  }
  return { opaque, width, height };
}

/**
 * Each art layer's own hold substance, one mask per `backgroundRelPaths` entry.
 *
 * The composite above is still what the colour tables measure; this is what a
 * SILHOUETTE is measured against, because a hold's shape is a fact about the one
 * image that draws it. Two holds from different sets are bolted into different
 * holes and their art barely overlaps, but flatten the layers into one bitmap
 * and they touch — and a boundary that only exists because two images were
 * stacked is not a boundary of anything.
 */
export async function loadBoardArtLayers(board: ShardBoard): Promise<BoardArt[]> {
  const { boardWidth: width, boardHeight: height } = board;
  await assertPhotographicRouting(board);

  const layers: BoardArt[] = [];
  for (const relativePath of board.backgroundRelPaths) {
    if (board.photographic) {
      layers.push(await keyedLayer(relativePath, width, height));
      continue;
    }
    const pixels = await sharp(path.join(PUBLIC_DIR, relativePath))
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const substanceFloor = alphaFloorFor(board.key);
    const opaque = new Uint8Array(width * height);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      opaque[pixel] = pixels[pixel * 4 + 3] >= substanceFloor ? 1 : 0;
    }
    layers.push({ opaque, width, height });
  }
  return layers;
}

/**
 * A photographic layer's hold substance, keyed off its white ground.
 *
 * The generator reads the LOSSLESS `.png` sibling, so this does too — measuring
 * the boundary of a silhouette against different pixels to the ones it was cut
 * from turns a gate into noise. No resample: the art is authored at board size,
 * and the mismatch is asserted rather than interpolated away.
 */
async function keyedLayer(relativePath: string, width: number, height: number): Promise<BoardArt> {
  const losslessPath = relativePath.replace(/\.(webp|jpg|jpeg)$/i, '.png');
  const { data, info } = await sharp(path.join(PUBLIC_DIR, losslessPath)).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) {
    throw new Error(`${losslessPath} is ${info.width}x${info.height}, not the board's ${width}x${height}`);
  }
  const keyed = buildWhiteKeyMask(data, info.width, info.height, info.channels);
  return { opaque: keyed.mask, width, height };
}

/**
 * Check the `PHOTOGRAPHIC_BOARDS` name list against the art it claims to
 * describe, in both directions.
 *
 * The list exists because gates 1-5 are synchronous and never decode anything.
 * This is what stops it being a guess: a board that ships photographic art
 * without being listed fails here rather than having its silhouettes measured
 * against a 100%-opaque mask that clears every probe by construction, and a
 * listed board whose art gains a real alpha channel fails here rather than being
 * keyed for no reason.
 */
async function assertPhotographicRouting(board: ShardBoard): Promise<void> {
  const composite = await loadBoardArt(board.boardWidth, board.boardHeight, board.backgroundRelPaths);
  let opaqueCount = 0;
  for (let index = 0; index < composite.opaque.length; index += 1) opaqueCount += composite.opaque[index];
  const opaqueShare = opaqueCount / composite.opaque.length;
  if (board.photographic !== opaqueShare >= OPAQUE_ART_CEILING) {
    throw new Error(
      `${board.key}: art is ${(opaqueShare * 100).toFixed(1)}% opaque but the gates treat it as ` +
        `${board.photographic ? 'photographic' : 'transparent-layer'} art`,
    );
  }
}

/**
 * The placements that could out-compete this one for a pixel in its search box.
 *
 * A pixel in the box is at most `box * sqrt(2)` from the placement, so nothing
 * further than twice the box can win one; the cut-off keeps the exact
 * nearest-placement scan off the board's other five hundred bolts.
 */
export function nearbyCandidates(
  candidates: Placement[],
  placement: Placement,
  searchRadii: number = SEARCH_RADII,
): Placement[] {
  const reach = placement.r * searchRadii * 2;
  return candidates.filter(
    (entry) => Math.abs(entry.cx - placement.cx) <= reach && Math.abs(entry.cy - placement.cy) <= reach,
  );
}

/**
 * How much of its own art body the shipped silhouette actually kept.
 *
 * The denominator is the CONNECTED art body the silhouette sits on: art pixels
 * in the search box that the exact nearest-placement partition gives to this
 * placement on its own layer, restricted to the 4-connected components the
 * shipped polygon actually covers. The numerator is that polygon's area. Their
 * ratio is the one measure that catches a hold that simply lost half of itself:
 * gate 3 clears a chopped silhouette, gate 5's open clears it, and gate 6
 * positively likes it, because a boundary well inside the hold's own art is
 * exactly what a pullback is supposed to produce.
 *
 * THE CONNECTIVITY IS LOAD-BEARING. A partition cell is a region of the board,
 * not a hold: a neighbouring macro's rim can lie closer to this bolt than to its
 * own and fall inside this cell without ever touching this hold. Counting the
 * whole cell read as a chop on 145 of 181 holds catalogue-wide that the tracer
 * had removed nothing from — grasshopper/1-4's 293 came out at 0.250 recovery
 * with a `droppedArea` of zero.
 *
 * Restated rather than imported, and deliberately anchored differently to the
 * generator: the tracer floods from ITS seed rule, and this floods from the
 * polygon that shipped. They agree on every well-formed hold and disagree on a
 * trace anchored to the wrong body, which is a defect worth seeing.
 *
 * It can exceed 1, and that is not a defect. The tracer fills holes before it
 * takes the outer border, so a hold with a punched-out bolt hole ships a polygon
 * covering art the partition never counted.
 */
export function areaRecovery(
  layerArt: BoardArt,
  sameLayerCandidates: Placement[],
  placement: Placement,
  flatBoardPx: number[],
  searchRadii: number = SEARCH_RADII,
): number {
  const centreX = Math.round(placement.cx);
  const centreY = Math.round(placement.cy);
  const box = Math.round(placement.r * searchRadii);
  const left = Math.max(0, centreX - box);
  const top = Math.max(0, centreY - box);
  const right = Math.min(layerArt.width - 1, centreX + box);
  const bottom = Math.min(layerArt.height - 1, centreY + box);
  const localWidth = right - left + 1;
  const localHeight = bottom - top + 1;
  if (localWidth <= 0 || localHeight <= 0) return 0;

  const cell = new Uint8Array(localWidth * localHeight);
  for (let y = 0; y < localHeight; y += 1) {
    for (let x = 0; x < localWidth; x += 1) {
      if (layerArt.opaque[(top + y) * layerArt.width + (left + x)] !== 1) continue;
      const own = (placement.cx - (left + x)) ** 2 + (placement.cy - (top + y)) ** 2;
      let beaten = false;
      for (const candidate of sameLayerCandidates) {
        if (candidate.id === placement.id) continue;
        if ((candidate.cx - (left + x)) ** 2 + (candidate.cy - (top + y)) ** 2 < own) {
          beaten = true;
          break;
        }
      }
      if (!beaten) cell[y * localWidth + x] = 1;
    }
  }

  // Flood the cell from every pixel the shipped polygon covers, so the
  // denominator is the body (or bodies) that silhouette belongs to and nothing
  // else in the cell.
  const raster = rasterise(flatBoardPx);
  // `rasterise` anchors its bitmap one pixel outside the polygon's own bounds,
  // and the polygon is offset from the ROUNDED centre.
  let polygonMinX = Infinity;
  let polygonMinY = Infinity;
  for (let point = 0; point < flatBoardPx.length; point += 2) {
    polygonMinX = Math.min(polygonMinX, flatBoardPx[point]);
    polygonMinY = Math.min(polygonMinY, flatBoardPx[point + 1]);
  }
  const rasterOriginX = centreX + Math.floor(polygonMinX) - 1 - left;
  const rasterOriginY = centreY + Math.floor(polygonMinY) - 1 - top;

  const visited = new Uint8Array(cell.length);
  const stack: number[] = [];
  for (let index = 0; index < raster.filled.length; index += 1) {
    if (raster.filled[index] !== 1) continue;
    const rasterX = index % raster.width;
    const rasterY = (index - rasterX) / raster.width;
    const localX = rasterOriginX + rasterX;
    const localY = rasterOriginY + rasterY;
    if (localX < 0 || localY < 0 || localX >= localWidth || localY >= localHeight) continue;
    const cellIndex = localY * localWidth + localX;
    if (cell[cellIndex] !== 1 || visited[cellIndex] === 1) continue;
    visited[cellIndex] = 1;
    stack.push(cellIndex);
  }

  let bodyArea = 0;
  while (stack.length > 0) {
    const index = stack.pop() as number;
    bodyArea += 1;
    const x = index % localWidth;
    const y = (index - x) / localWidth;
    for (const [stepX, stepY] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      if (nextX < 0 || nextY < 0 || nextX >= localWidth || nextY >= localHeight) continue;
      const neighbour = nextY * localWidth + nextX;
      if (cell[neighbour] !== 1 || visited[neighbour] === 1) continue;
      visited[neighbour] = 1;
      stack.push(neighbour);
    }
  }

  return bodyArea === 0 ? 0 : raster.area / bodyArea;
}

/** The nearest placement to a board point — the partition the generator cuts on. */
function nearestPlacementId(candidates: Placement[], pointX: number, pointY: number): number {
  let bestId = candidates[0].id;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = (candidate.cx - pointX) ** 2 + (candidate.cy - pointY) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = candidate.id;
    }
  }
  return bestId;
}

/**
 * Walk the polygon a board pixel at a time and probe outward at every step.
 *
 * `opaque` is the share of the boundary that is not an art edge at all. It reads
 * high by design once the tracer pulls back from a contact, because the pullback
 * puts the boundary inside the hold's OWN art, so it is a ceiling on how far that
 * pullback may run rather than a defect count. `neighbour` is the half that
 * matters: boundary whose outside is art the partition gives to a different
 * placement, which is exactly the wedge — a mark ending on someone else's hold
 * with the glow's brightest band laid along it.
 *
 * Sampled per pixel and not per vertex: Douglas-Peucker leaves a long straight
 * cut carrying two vertices and a curved art edge carrying twenty, so a
 * per-vertex share understates a cut by roughly the ratio of the two.
 *
 * `probeDistance` defaults to half a pixel inside the shard's own cut clearance,
 * which is the only distance at which the question is about the geometry rather
 * than about the probe — see `CUT_PROBE_INSET_FROM_CLEARANCE`. The fixtures pass
 * an explicit one.
 */
export function cutShares(
  art: BoardArt,
  candidates: Placement[],
  placement: Placement,
  flatBoardPx: number[],
  probeDistance: number = cutProbeDistance(placement.r),
): { opaque: number; neighbour: number } {
  // `flatBoardPx` is offset from the rounded centre — the frame the tracer cut in.
  const centreX = Math.round(placement.cx);
  const centreY = Math.round(placement.cy);
  const count = flatBoardPx.length / 2;
  let samples = 0;
  let opaqueOutside = 0;
  let neighbourOutside = 0;

  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const fromX = flatBoardPx[index * 2];
    const fromY = flatBoardPx[index * 2 + 1];
    const toX = flatBoardPx[next * 2];
    const toY = flatBoardPx[next * 2 + 1];
    const edgeLength = Math.hypot(toX - fromX, toY - fromY);
    if (edgeLength === 0) continue;
    let normalX = -(toY - fromY) / edgeLength;
    let normalY = (toX - fromX) / edgeLength;
    // Either winding gives a consistent side; containment decides which is out.
    if (containsPoint(flatBoardPx, (fromX + toX) / 2 + normalX * 1.5, (fromY + toY) / 2 + normalY * 1.5)) {
      normalX = -normalX;
      normalY = -normalY;
    }
    const steps = Math.max(1, Math.round(edgeLength));
    for (let step = 0; step < steps; step += 1) {
      samples += 1;
      const alongX = fromX + ((toX - fromX) * step) / steps;
      const alongY = fromY + ((toY - fromY) * step) / steps;
      const probeX = Math.round(centreX + alongX + normalX * probeDistance);
      const probeY = Math.round(centreY + alongY + normalY * probeDistance);
      if (probeX < 0 || probeY < 0 || probeX >= art.width || probeY >= art.height) continue;
      if (art.opaque[probeY * art.width + probeX] !== 1) continue;
      opaqueOutside += 1;
      if (nearestPlacementId(candidates, probeX, probeY) !== placement.id) neighbourOutside += 1;
    }
  }
  if (samples === 0) return { opaque: 0, neighbour: 0 };
  return { opaque: opaqueOutside / samples, neighbour: neighbourOutside / samples };
}
