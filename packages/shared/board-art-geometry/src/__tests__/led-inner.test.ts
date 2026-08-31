/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { listBoardArtGeometryKeys, loadBoardArtGeometry } from '../loader';
import { CENTRE_TOLERANCE_RADII, MAX_RING_NUMBERS, distanceToRing, isValidOutlineRing, pointInRing } from '../ring';
import { isSimpleRing } from '../raster';
import { distanceOutsidePolygon, overridesForKey, shardBoardForKey, toTracerPixels } from './gate-measures';

/** {@link isSimpleRing} against a flat `[x0, y0, x1, y1, ...]` shard ring. */
function isSimpleFlatRing(flat: number[]): boolean {
  const points: Array<[number, number]> = [];
  for (let index = 0; index < flat.length; index += 2) points.push([flat[index], flat[index + 1]]);
  return isSimpleRing(points);
}

function describeEntry(entry: { key: string; placementId: number }): string {
  return `${entry.key} ${entry.placementId}`;
}

/**
 * The extracted LED base-plate inner rings, checked against the shards they
 * ship in (PR 6).
 *
 * `scripts/led-ring-extract.ts` fills `ledInner` automatically on the configs
 * whose art carries a two-tone plate, so the field is no longer "empty unless
 * somebody drew one" and the checks that watched for a leftover entry cannot be
 * the whole story any more. These are the ones that replace them.
 *
 * The load-bearing one is the LAST structural check: every vertex of an inner
 * ring has to lie inside the silhouette it is subtracted from. `ledInner` is
 * defined as "the lit region is the silhouette MINUS this polygon", so a vertex
 * outside the silhouette does not describe a thinner lit band — it describes a
 * lit region with a piece missing that was never there, and no gate on the
 * silhouettes themselves would see it.
 *
 * WHY THE COUNTS ARE PINNED rather than bounded. The extractor's constants are
 * calibration anchors tuned by eye against one board's art, and the thing that
 * makes a retune reviewable is that the shard diff says exactly how many holds
 * moved. A floor would let a threshold nudge quietly drop forty rings.
 */

const SHARD_KEYS = listBoardArtGeometryKeys();

/**
 * Extracted rings per config, from the run that wrote the committed shards.
 *
 * Every one is a Kilter Homewall config (layout 8), and that is the extractor
 * separating the catalogue rather than a board list someone typed: acceptance
 * on these ten runs 73.2% to 92.1%, and the highest anywhere else is
 * tension/9-3 at 22.3%. The 60% cut-off sits in a 50-point gap with nothing in
 * it, so no config in the catalogue is anywhere near flipping.
 *
 * A config absent from this table must ship no `ledInner` table at all.
 */
const PINNED_LED_INNER_COUNTS: Record<string, number> = {
  'kilter/8-17': 277,
  'kilter/8-18': 148,
  'kilter/8-19': 129,
  'kilter/8-21': 346,
  'kilter/8-22': 172,
  'kilter/8-23': 340,
  'kilter/8-24': 184,
  'kilter/8-25': 383,
  'kilter/8-26': 191,
  'kilter/8-29': 174,
};

/**
 * Board pixels a ring vertex may sit outside its silhouette and still count as
 * inside it.
 *
 * Not zero, and the reason is discretisation rather than tolerance for error.
 * Both polygons are traced from pixel masks and then simplified, so a vertex on
 * the inner contour can land a fraction of a pixel outside a chord the outer
 * contour's simplification cut across. One pixel is under the 1.6-pixel
 * simplification tolerance that produced both, and two orders of magnitude
 * tighter than the failure this catches — a ring that escapes its silhouette
 * escapes it by radii, not by a pixel.
 */
const MAX_VERTEX_OUTSIDE_PX = 1;

/**
 * Bounds on the inner ring's share of its silhouette, as SHIPPED.
 *
 * Wider than the extractor's own 0.25..0.95, and deliberately measured a
 * different way: the extractor gated on PIXEL COUNTS of two masks, and this is
 * the shoelace area of the two POLYGONS that came out of them. Three things
 * separate those numbers, and they do not all push the same way:
 *
 *   - a pixel-counted area carries about half a perimeter more than the polygon
 *     enclosing it, which inflates both areas — the smaller one proportionally
 *     more, so the pixel share reads HIGH;
 *   - `fillHoles` runs on the interior mask and not on the silhouette mask, so a
 *     hold with a punched-out bolt hole has that hole counted in the numerator
 *     and not in the denominator;
 *   - Douglas-Peucker then decimates the two rings independently, at the same
 *     tolerance but against different curvature, so it cuts corners off the two
 *     areas by different amounts.
 *
 * The measured spread is small and two-sided: re-measured this way, six shipped
 * rings fall below the extractor's 0.25 (min 0.2365) and nine rise above its
 * 0.95 (max 0.9547).
 * Loosening by 0.05 either side absorbs all three effects rather than a defect —
 * a ring that traced the silhouette reads 1.0 here and a collapsed one reads
 * near 0, both an order of magnitude past these bounds.
 */
const MIN_SHIPPED_AREA_SHARE = 0.2;
const MAX_SHIPPED_AREA_SHARE = 0.97;

type ShippedRing = { key: string; placementId: number; ring: number[] };

function shippedRings(): ShippedRing[] {
  const rings: ShippedRing[] = [];
  for (const key of SHARD_KEYS) {
    const geometry = loadBoardArtGeometry(shardBoardForKey(key));
    if (geometry === null) throw new Error(`${key}: shard did not load`);
    for (const [placementText, ring] of Object.entries(geometry.ledInner ?? {})) {
      rings.push({ key, placementId: Number(placementText), ring });
    }
  }
  return rings;
}

const SHIPPED = shippedRings();

describe('shipped ledInner rings', () => {
  it('appear in exactly the configs the extractor qualified', () => {
    const withTable = SHARD_KEYS.filter(
      (key) => loadBoardArtGeometry(shardBoardForKey(key))?.ledInner !== undefined,
    ).sort();
    expect(withTable).toEqual(Object.keys(PINNED_LED_INNER_COUNTS).sort());
  });

  it('match the committed per-config count', () => {
    const measured: Record<string, number> = {};
    for (const entry of SHIPPED) measured[entry.key] = (measured[entry.key] ?? 0) + 1;
    expect(measured).toEqual(PINNED_LED_INNER_COUNTS);
  });

  it('are rings a renderer could store', () => {
    const invalid = SHIPPED.filter((entry) => !isValidOutlineRing(entry.ring)).map(
      (entry) => `${entry.key} ${entry.placementId} (${entry.ring.length} numbers)`,
    );
    expect(invalid).toEqual([]);
  });

  it('are drawn around their own placement', () => {
    // The same rule the backend enforces on a hand-drawn annotation. An
    // extracted ring and an annotated one are the same field, so they clear the
    // same bar: inside the ring, or outside it by no more than 0.25 radii.
    const misplaced = SHIPPED.filter(
      (entry) => !pointInRing(entry.ring, 0, 0) && distanceToRing(entry.ring, 0, 0) > CENTRE_TOLERANCE_RADII,
    ).map((entry) => `${entry.key} ${entry.placementId}`);
    expect(misplaced).toEqual([]);
  });

  it('have a silhouette to sit inside', () => {
    // `ledInner` is the silhouette MINUS this polygon, so an entry with no
    // `outlines` entry beside it describes a lit region of nothing.
    const orphaned: string[] = [];
    for (const key of Object.keys(PINNED_LED_INNER_COUNTS)) {
      const geometry = loadBoardArtGeometry(shardBoardForKey(key));
      if (geometry === null) throw new Error(`${key}: shard did not load`);
      for (const entry of SHIPPED.filter((candidate) => candidate.key === key)) {
        if (geometry.outlines[entry.placementId] === undefined) {
          orphaned.push(`${key} ${entry.placementId}`);
        }
      }
    }
    expect(orphaned).toEqual([]);
  });

  it('sit inside the silhouette they are subtracted from', () => {
    // Both polygons are put back in the tracer's own board pixels first: they
    // ship divided by the placement radius, and a distance measured in radius
    // units cannot be compared against a pixel tolerance.
    const escaped: string[] = [];
    for (const key of Object.keys(PINNED_LED_INNER_COUNTS)) {
      const board = shardBoardForKey(key);
      const geometry = loadBoardArtGeometry(board);
      if (geometry === null) throw new Error(`${key}: shard did not load`);
      for (const entry of SHIPPED.filter((candidate) => candidate.key === key)) {
        const placement = board.placementById.get(entry.placementId);
        if (placement === undefined) {
          escaped.push(`${key} ${entry.placementId}: no such placement`);
          continue;
        }
        const silhouette = toTracerPixels(geometry.outlines[entry.placementId], placement);
        const inner = toTracerPixels(entry.ring, placement);
        let worst = 0;
        for (let index = 0; index < inner.length; index += 2) {
          worst = Math.max(worst, distanceOutsidePolygon(silhouette, inner[index], inner[index + 1]));
        }
        if (worst > MAX_VERTEX_OUTSIDE_PX) {
          escaped.push(`${key} ${entry.placementId}: ${worst.toFixed(2)} board px outside`);
        }
      }
    }
    expect(escaped).toEqual([]);
  });

  it('are simple polygons', () => {
    // A ring that crosses itself renders as a hole in the wrong place, and it
    // passes every area, containment and centre test there is — nothing else in
    // this file would notice one. 176 of the first 2,306 rings extracted did
    // cross themselves: a 1-pixel isthmus the blur left behind, walked out and
    // back by the border follower and then replaced with two crossing chords by
    // Douglas-Peucker. The interior's neck trim is the fix; this is the proof.
    expect(SHIPPED.filter((entry) => !isSimpleFlatRing(entry.ring)).map(describeEntry)).toEqual([]);
  });

  it('are no more self-intersecting than the silhouettes, which is not at all', () => {
    // The control, and it is what says the trim was the missing piece rather
    // than the ring being intrinsically harder: the silhouettes come off the
    // same border follower and the same simplification, and the only thing they
    // had that the interior lacked was a neck trim before tracing.
    const crossing: string[] = [];
    for (const key of SHARD_KEYS) {
      const geometry = loadBoardArtGeometry(shardBoardForKey(key));
      if (geometry === null) throw new Error(`${key}: shard did not load`);
      for (const [placementText, ring] of Object.entries(geometry.outlines)) {
        if (!isSimpleFlatRing(ring)) crossing.push(`${key} ${placementText}`);
      }
    }
    expect(crossing).toEqual([]);
  });

  it('describe a lit band rather than the whole hold or none of it', () => {
    // A ring that traced the silhouette itself would be a table full of no-ops,
    // and one collapsed to a speck would light everything. Neither is a defect
    // the structural checks above can see, because both are perfectly
    // well-formed rings inside their silhouette.
    const degenerate: string[] = [];
    for (const key of Object.keys(PINNED_LED_INNER_COUNTS)) {
      const geometry = loadBoardArtGeometry(shardBoardForKey(key));
      if (geometry === null) throw new Error(`${key}: shard did not load`);
      for (const entry of SHIPPED.filter((candidate) => candidate.key === key)) {
        const share = polygonArea(entry.ring) / polygonArea(geometry.outlines[entry.placementId]);
        if (share < MIN_SHIPPED_AREA_SHARE || share > MAX_SHIPPED_AREA_SHARE) {
          degenerate.push(`${key} ${entry.placementId}: ${share.toFixed(3)}`);
        }
      }
    }
    expect(degenerate).toEqual([]);
  });
});

describe('ledInner overrides against the extractor', () => {
  it('put every committed annotation in the shard verbatim, extraction or not', () => {
    // The precedence rule, checked on the shards rather than asserted in a
    // comment: a hand-drawn `led_inner` annotation REPLACES whatever the
    // extractor produced for that placement. The annotations are the ground
    // truth the extractor is calibrated against, so an extractor that could
    // overwrite one would make its own calibration target unreadable.
    //
    // Iterates over nothing while no annotations are committed, which is the
    // correct amount of work for it to do until the editor ships one.
    const mismatched: string[] = [];
    for (const key of SHARD_KEYS) {
      const committed = overridesForKey(key)?.ledInner;
      if (committed === undefined) continue;
      const geometry = loadBoardArtGeometry(shardBoardForKey(key));
      if (geometry === null) throw new Error(`${key}: shard did not load`);
      for (const [placementText, ring] of Object.entries(committed)) {
        const shipped = geometry.ledInner?.[Number(placementText)];
        if (JSON.stringify(shipped) !== JSON.stringify(ring)) {
          mismatched.push(`${key} ${placementText}: shard has ${JSON.stringify(shipped)}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });
});

/** Shoelace area of an implicitly-closed flat ring, unsigned. */
function polygonArea(flat: number[]): number {
  const count = flat.length / 2;
  let twice = 0;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    twice += flat[index * 2] * flat[next * 2 + 1] - flat[next * 2] * flat[index * 2 + 1];
  }
  return Math.abs(twice) / 2;
}

describe('ledInner gate fixtures', () => {
  // A plausible hold silhouette, one radius across, and an inner ring inside it.
  const SILHOUETTE = [-1, -1, 1, -1, 1, 1, -1, 1];
  const INNER = [-0.6, -0.6, 0.6, -0.6, 0.6, 0.6, -0.6, 0.6];
  // The same inner ring slid off the hold: still a legal ring, still inside
  // nothing.
  const ESCAPED = [1.4, -0.6, 2.6, -0.6, 2.6, 0.6, 1.4, 0.6];

  it('catches an inner ring that escapes its silhouette', () => {
    let insideWorst = 0;
    let escapedWorst = 0;
    for (let index = 0; index < INNER.length; index += 2) {
      insideWorst = Math.max(insideWorst, distanceOutsidePolygon(SILHOUETTE, INNER[index], INNER[index + 1]));
      escapedWorst = Math.max(escapedWorst, distanceOutsidePolygon(SILHOUETTE, ESCAPED[index], ESCAPED[index + 1]));
    }
    expect(insideWorst).toBe(0);
    expect(escapedWorst).toBeGreaterThan(MAX_VERTEX_OUTSIDE_PX);
    // And it is a well-formed ring by every other measure, which is why this
    // check has to exist separately.
    expect(isValidOutlineRing(ESCAPED)).toBe(true);
  });

  it('catches an inner ring drawn around the neighbouring hold', () => {
    expect(pointInRing(ESCAPED, 0, 0)).toBe(false);
    expect(distanceToRing(ESCAPED, 0, 0)).toBeGreaterThan(CENTRE_TOLERANCE_RADII);
    expect(pointInRing(INNER, 0, 0)).toBe(true);
  });

  it('catches an inner ring that is really the silhouette again', () => {
    // 100% of the silhouette's area: subtracting it lights nothing at all.
    expect(polygonArea(SILHOUETTE) / polygonArea(SILHOUETTE)).toBe(1);
    expect(polygonArea(INNER) / polygonArea(SILHOUETTE)).toBeCloseTo(0.36, 6);
  });

  it('catches an un-simplified ring the storage bound would refuse', () => {
    const unsimplified = Array.from({ length: MAX_RING_NUMBERS + 2 }, (_, index) =>
      index % 2 === 0 ? Math.cos(index) * 0.5 : Math.sin(index) * 0.5,
    );
    expect(isValidOutlineRing(unsimplified)).toBe(false);
    expect(isValidOutlineRing(INNER)).toBe(true);
  });
});
