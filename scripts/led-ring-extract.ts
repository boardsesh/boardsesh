/**
 * The generator's glue for the Kilter LED base-plate extractor.
 *
 * All the image reasoning lives in
 * `packages/shared/board-art-geometry/src/segmentation/led-ring.ts`, which is
 * pure and unit-tested against synthetic art. This module is the part that
 * cannot be: it crops the composited board, drives the extractor once per hold,
 * and applies the two acceptance layers the pure code has no way to ask about —
 * whether the ring a hold produced is a STORABLE ring drawn around that
 * placement, and whether enough of a config's holds produced one for the whole
 * table to be worth shipping.
 *
 * SEPARATE FROM THE TRACER on purpose, for the same reason
 * `outline-overrides-merge.ts` is: the tracer is two thousand lines of image
 * processing, and a reviewer should be able to read this file and know exactly
 * what can and cannot end up in a shard's `ledInner` table.
 *
 * WHERE IT SITS IN THE MERGE. The extractor runs on the silhouettes that SHIP —
 * after the hand-drawn `outlines` corrections have been merged in — and its
 * output is written into `ledInner` BEFORE the committed `led_inner`
 * annotations, so an annotation always replaces an extraction for the same
 * placement. That ordering is the whole point: Marco's annotations are the
 * ground truth this extractor is calibrated against, and a calibration target
 * that the thing being calibrated could overwrite is not one.
 */

import { rasteriseRing } from '../packages/shared/board-art-geometry/src/raster';
import {
  extractLedInner,
  type LedInnerRejection,
} from '../packages/shared/board-art-geometry/src/segmentation/led-ring';
import {
  CENTRE_TOLERANCE_RADII,
  distanceToRing,
  isValidOutlineRing,
  pointInRing,
  roundRing,
} from '../packages/shared/board-art-geometry/src/ring';

/**
 * Neck-trim radius for a placement, in board pixels.
 *
 * THE TRACER'S OWN RULE, restated here rather than imported for the reason
 * every constant in the gates is restated: a hold's neck is a fraction of the
 * hold, so the radius is a fraction of the placement radius, and the floor of 2
 * is where a disc stops being one. The inner boundary has to be trimmed at the
 * radius the silhouette around it was trimmed at, or the two are cleaned to
 * different standards and the ring between them inherits the difference.
 */
export const TRIM_RADIUS_PER_PLACEMENT_RADIUS = 0.078;

export function neckTrimRadiusFor(placementRadius: number): number {
  return Math.max(2, Math.round(TRIM_RADIUS_PER_PLACEMENT_RADIUS * placementRadius));
}

/**
 * Share of a config's traced holds that must yield an acceptable ring before the
 * config emits a `ledInner` table at all.
 *
 * The extractor is calibrated on one board's art style, and the honest answer
 * for a board drawn some other way is to emit nothing rather than a table of
 * near-misses: an absent `ledInner` means "light the whole silhouette", which is
 * exactly what every renderer did before this field existed. A board whose art
 * genuinely carries the two-tone plate clears this comfortably (Kilter Homewall
 * is well above it); a greyscale board cannot produce warm pixels at all and
 * lands near zero. There is no board in the catalogue sitting near 0.6, so this
 * is a cliff-edge separator rather than a threshold anything balances on — the
 * per-config rates are in `docs/board-art-geometry.md`.
 */
export const MIN_CONFIG_ACCEPTANCE = 0.6;

/** Why a hold that the pure extractor accepted still ships no ring. */
type StorageRejection = 'not-a-storable-ring' | 'ring-off-its-placement';

export type LedRingReason = LedInnerRejection | StorageRejection;

export type LedRingConfigResult = {
  /**
   * `placementId` -> inner ring in RADIUS UNITS, rounded to the shard's four
   * decimals — the value that ships, converted here rather than by the caller so
   * the storage checks below run on exactly what a renderer would read.
   */
  rings: Map<number, number[]>;
  /**
   * The same rings in BOARD PIXELS offset from the rounded placement centre,
   * for the report overlay. Not part of the shard.
   */
  boardPixelRings: Map<number, number[]>;
  /** Holds the extractor was run on: every placement with a shipping outline. */
  attempted: number;
  /** Holds that produced a storable ring. */
  accepted: number;
  /** Why the rest did not, by reason, for the run log and the report. */
  rejections: Map<LedRingReason, number>;
};

/**
 * The composited board, RGBA. `Uint8Array` rather than the generator's own
 * `Buffer` because a `Buffer` IS one and nothing here needs the extra methods —
 * which keeps this module off `@types/node` entirely, like the pure extractor
 * it drives.
 */
export type LedRingArt = { pixels: Uint8Array; width: number; height: number };

export type LedRingPlacement = { id: number; cx: number; cy: number; r: number };

/**
 * Run the extractor over one config's shipping silhouettes.
 *
 * `outlines` is the tracer's frame: flat board pixels offset from the ROUNDED
 * placement centre, which is what `rasteriseRing` and the art crop below both
 * assume. Nothing is filtered by board name — whether a config qualifies is
 * decided by {@link qualifies} on the measured acceptance rate, not by a list of
 * boards someone maintained by hand.
 */
export function extractConfigLedRings(
  art: LedRingArt,
  placements: ReadonlyArray<LedRingPlacement>,
  outlines: ReadonlyMap<number, number[]>,
  coordinateDecimals: number,
): LedRingConfigResult {
  const rings = new Map<number, number[]>();
  const boardPixelRings = new Map<number, number[]>();
  const rejections = new Map<LedRingReason, number>();
  let attempted = 0;
  let accepted = 0;

  const reject = (reason: LedRingReason): void => {
    rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
  };

  const seen = new Set<number>();
  for (const placement of placements) {
    if (seen.has(placement.id)) continue;
    seen.add(placement.id);
    const outline = outlines.get(placement.id);
    if (outline === undefined || outline.length < 6) continue;
    attempted += 1;

    const raster = rasteriseRing(outline);
    const centreX = Math.round(placement.cx);
    const centreY = Math.round(placement.cy);

    // The art under the silhouette, in the raster's own frame. Off the board
    // reads as transparent black, which is neutral chroma and therefore never
    // warm — a hold whose art is cut off by the board edge simply has less plate
    // to find rather than a phantom band along the crop.
    const pixels = new Uint8Array(raster.width * raster.height * 4);
    for (let y = 0; y < raster.height; y += 1) {
      const boardY = centreY + raster.originY + y;
      if (boardY < 0 || boardY >= art.height) continue;
      for (let x = 0; x < raster.width; x += 1) {
        const boardX = centreX + raster.originX + x;
        if (boardX < 0 || boardX >= art.width) continue;
        const from = (boardY * art.width + boardX) * 4;
        const to = (y * raster.width + x) * 4;
        pixels[to] = art.pixels[from];
        pixels[to + 1] = art.pixels[from + 1];
        pixels[to + 2] = art.pixels[from + 2];
        pixels[to + 3] = art.pixels[from + 3];
      }
    }

    const extraction = extractLedInner(
      pixels,
      raster.mask,
      raster.width,
      raster.height,
      [-raster.originX, -raster.originY],
      { neckTrimRadius: neckTrimRadiusFor(placement.r) },
    );
    if (!extraction.accepted) {
      reject(extraction.reason);
      continue;
    }

    const boardPixels: number[] = [];
    for (const [x, y] of extraction.contour) {
      boardPixels.push(raster.originX + x, raster.originY + y);
    }

    // Into radius units by EXACTLY the arithmetic the silhouette emission uses:
    // the tracer works in integer board pixels offset from the ROUNDED centre,
    // so the rounding is undone before dividing. Anything else would put an
    // inner ring and the silhouette around it in subtly different frames.
    //
    // The decimal rounding goes through `roundRing`, the package's own, rather
    // than a fourth private copy of `Math.round(v * 10 ** d) / 10 ** d`: the
    // editor, the backend and this all have to agree on what a stored
    // coordinate looks like, `-0` collapsing to `0` included.
    const roundingX = centreX - placement.cx;
    const roundingY = centreY - placement.cy;
    const radiusUnits = roundRing(
      boardPixels.map((value, index) => (value + (index % 2 === 0 ? roundingX : roundingY)) / placement.r),
      coordinateDecimals,
    );

    // The two storage questions the pure extractor cannot ask, because both are
    // about the RADIUS-UNIT ring a shard stores rather than about the pixels.
    // Checked here, on the value that would ship, against the same predicates
    // the backend enforces on a hand-drawn annotation — an extracted ring and an
    // annotated one are the same field and must clear the same bar.
    if (!isValidOutlineRing(radiusUnits)) {
      reject('not-a-storable-ring');
      continue;
    }
    if (!pointInRing(radiusUnits, 0, 0) && distanceToRing(radiusUnits, 0, 0) > CENTRE_TOLERANCE_RADII) {
      reject('ring-off-its-placement');
      continue;
    }

    rings.set(placement.id, radiusUnits);
    boardPixelRings.set(placement.id, boardPixels);
    accepted += 1;
  }

  return { rings, boardPixelRings, attempted, accepted, rejections };
}

/**
 * One config's `ledInner` table: extractions first, hand-drawn annotations over
 * the top.
 *
 * A ONE-LINE RULE IN ITS OWN FUNCTION, and that is the point. Written inline in
 * the generator it was two loops in the right order and nothing could tell them
 * from the wrong order: no `led_inner` annotation exists in the repo yet, so
 * every test that reads committed data iterates over nothing, and swapping the
 * loops passed the entire suite. Here the rule is checkable without a fixture
 * file — and without committing an override the exporter would delete on its
 * next real run, since it removes files whose config has no rows behind it.
 *
 * Annotations win because they are the ground truth the extractor is calibrated
 * against. A calibration target the thing being calibrated can overwrite is not
 * one.
 */
export function assembleLedInner(
  extracted: ReadonlyMap<number, number[]>,
  annotations: ReadonlyMap<number, number[]>,
): Map<number, number[]> {
  const assembled = new Map<number, number[]>(extracted);
  for (const [placementId, ring] of annotations) assembled.set(placementId, ring);
  return assembled;
}

/**
 * The result of not looking: zero attempts, zero rings, no rejections.
 *
 * A layout with no LED base plate (`hasLedBasePlate`) never runs the extractor,
 * and the caller still needs a result to report and to hand `assembleLedInner`.
 * `attempted: 0` also makes `qualifies` answer false on it, so the two gates
 * agree even if a caller ever asks both.
 */
export function emptyLedRingResult(): LedRingConfigResult {
  return { rings: new Map(), boardPixelRings: new Map(), attempted: 0, accepted: 0, rejections: new Map() };
}

/**
 * Does this config's acceptance rate clear {@link MIN_CONFIG_ACCEPTANCE}?
 *
 * A config with no traced outlines at all does not qualify — the rate would be
 * 0/0, and "no holds failed" is not evidence that the art carries a base plate.
 */
export function qualifies(result: LedRingConfigResult): boolean {
  if (result.attempted === 0) return false;
  return result.accepted / result.attempted >= MIN_CONFIG_ACCEPTANCE;
}

/** The run-log line for one config's extraction. */
export function describeLedRings(result: LedRingConfigResult): string {
  const rate = result.attempted === 0 ? 0 : result.accepted / result.attempted;
  const reasons = [...result.rejections.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
  return (
    `${result.accepted}/${result.attempted} LED rings (${(rate * 100).toFixed(1)}%)` +
    (reasons === '' ? '' : ` — ${reasons}`)
  );
}
