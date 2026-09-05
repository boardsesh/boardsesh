// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { listBoardArtGeometryKeys, loadBoardArtGeometry } from '../loader';
import { CENTRE_TOLERANCE_RADII, distanceToRing, isValidOutlineRing, pointInRing } from '../ring';
import {
  SAME_IMAGE_OVERRIDE_LAYOUTS,
  SIMPLIFY_EPSILON,
  overriddenPlacementIds,
  overriddenShardKeys,
  overridesForKey,
  shardBoardForKey,
  type ShardBoard,
} from './gate-measures';

/**
 * The hand-corrected outlines, checked against the shards they were merged into.
 *
 * `packages/db/scripts/export-outline-overrides.ts` writes
 * `overrides/<board>/<layout>-<size>.json` out of the `hold_outline_overrides`
 * table; `scripts/generate-board-art-geometry.ts` merges them at its emission
 * boundary. Everything between those two is a file on disk, and a file on disk
 * can be hand-edited, can outlive the board data it was drawn against, and can
 * be committed without the shards being regenerated. These are the checks that
 * turn each of those into a red test.
 *
 * The load-bearing one is the LAST: an overridden placement's shard value has to
 * equal the committed ring BYTE FOR BYTE. That is what proves the merge actually
 * ran. Without it an override that silently failed to apply would look exactly
 * like an override that applied — the shard is a valid shard either way, and
 * every capture gate passes on the tracer's version.
 *
 * With no overrides committed (the state this pipeline ships in) most of these
 * iterate over nothing, and that is the correct amount of work for them to do.
 * The must-trip fixtures for the hard-fail paths live in
 * `scripts/outline-overrides-merge.test.ts`, next to the loader that throws:
 * this package's tsconfig sets `rootDir: ./src` and cannot import from
 * `scripts/`.
 */

const OVERRIDE_KEYS = overriddenShardKeys();
const SHARD_KEYS = new Set(listBoardArtGeometryKeys());

/** Every ring in every committed file, tagged with where it came from. */
type CommittedRing = {
  key: string;
  table: 'outlines' | 'ledInner';
  placementId: number;
  ring: number[];
};

function committedRings(): CommittedRing[] {
  const rings: CommittedRing[] = [];
  for (const key of OVERRIDE_KEYS) {
    const file = overridesForKey(key);
    if (file === null) throw new Error(`${key}: listed as an override file but did not read back`);
    for (const table of ['outlines', 'ledInner'] as const) {
      for (const [placementText, ring] of Object.entries(file[table] ?? {})) {
        rings.push({ key, table, placementId: Number(placementText), ring });
      }
    }
  }
  return rings;
}

const COMMITTED = committedRings();

describe('committed outline overrides', () => {
  it('name a config that ships a shard', () => {
    // An override file for a board with no shard is a correction nothing will
    // ever merge — the generator skips the config, so the file is inert.
    expect(OVERRIDE_KEYS.filter((key) => !SHARD_KEYS.has(key))).toEqual([]);
  });

  it('hold only rings a renderer could store', () => {
    const invalid = COMMITTED.filter((entry) => !isValidOutlineRing(entry.ring)).map(
      (entry) => `${entry.key} ${entry.table} ${entry.placementId}`,
    );
    expect(invalid).toEqual([]);
  });

  it('hold only rings drawn around their own placement', () => {
    // The same rule the backend enforces on write and the merge re-checks on
    // read: inside the ring, or outside it by no more than 0.25 radii. Applied
    // to `ledInner` too — a base-plate boundary is a smaller ring around the
    // same bolt, so it fails this exactly when it has been drawn on the wrong
    // hold.
    const misplaced = COMMITTED.filter(
      (entry) => !pointInRing(entry.ring, 0, 0) && distanceToRing(entry.ring, 0, 0) > CENTRE_TOLERANCE_RADII,
    ).map((entry) => `${entry.key} ${entry.table} ${entry.placementId}`);
    expect(misplaced).toEqual([]);
  });

  it('name placements their config actually has', () => {
    const unknown: string[] = [];
    for (const key of OVERRIDE_KEYS) {
      const board = shardBoardForKey(key);
      for (const entry of COMMITTED.filter((candidate) => candidate.key === key)) {
        if (!board.placementById.has(entry.placementId)) {
          unknown.push(`${key} ${entry.table} ${entry.placementId}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe('the gate-1 exemption', () => {
  /**
   * The ring that proves the exemption is load-bearing rather than decorative.
   *
   * A correction is admitted by the editor, the exporter and the merge when its
   * placement centre is inside the ring or outside by at most
   * `CENTRE_TOLERANCE_RADII` (0.25 radii). Gate 1 asks the same question at
   * `SIMPLIFY_EPSILON` — 1.6 BOARD PIXELS, which is 0.052 radii on kilter/1-28.
   * Anything in the gap between those two numbers is a legal correction that
   * gate 1 reds, and the author has nowhere to go: redrawing it inside 0.052
   * radii means drawing a different hold.
   *
   * A square one radius on a side, pushed until its nearest edge is 0.1 radii
   * from the centre, sits squarely in that gap.
   */
  const OUTSIDE_BY_A_TENTH_RADIUS = [-1, 0.1, 1, 0.1, 1, 2.1, -1, 2.1];

  it('covers a ring the write path admits but gate 1 would reject', () => {
    expect(pointInRing(OUTSIDE_BY_A_TENTH_RADIUS, 0, 0)).toBe(false);
    const missBy = distanceToRing(OUTSIDE_BY_A_TENTH_RADIUS, 0, 0);
    // Admitted on write, on export and on merge...
    expect(missBy).toBeCloseTo(0.1, 6);
    expect(missBy).toBeLessThanOrEqual(CENTRE_TOLERANCE_RADII);
    expect(isValidOutlineRing(OUTSIDE_BY_A_TENTH_RADIUS)).toBe(true);

    // ...and rejected by gate 1, whose threshold is the simplification tolerance
    // converted into this placement's radius units. Every kilter/1-28 placement
    // is well over 1.6 board px in radius, so 0.1 radii is over the line on all
    // of them: the conflict is not an artefact of one hold's size.
    const board = shardBoardForKey('kilter/1-28');
    const gate1ThresholdRadii = board.placements.map((placement) => SIMPLIFY_EPSILON / placement.r);
    expect(Math.max(...gate1ThresholdRadii)).toBeLessThan(0.1);
    expect(Math.max(...gate1ThresholdRadii)).toBeLessThan(CENTRE_TOLERANCE_RADII);
  });

  it('exempts exactly the placements whose silhouette was drawn by hand', () => {
    // The wiring, in both directions. A shard with no committed corrections
    // exempts nothing — every traced outline still faces all seven gates, which
    // is why the committed shards are unchanged by this pipeline existing. And a
    // shard that has them exempts those placements and no others: an over-broad
    // exemption would quietly switch the gates off for a whole board.
    //
    // On an activated layout the exemption also travels with the ring: a
    // silhouette adopted from a same-image sibling exempts here too, and every
    // EXTRA exemption must be accounted for by a sibling's committed row.
    for (const key of listBoardArtGeometryKeys()) {
      const committed = Object.keys(overridesForKey(key)?.outlines ?? {})
        .map(Number)
        .sort((left, right) => left - right);
      const exempt = [...overriddenPlacementIds(key)].sort((left, right) => left - right);
      const [boardName, layoutAndSize] = key.split('/');
      const layoutPrefix = `${boardName}/${layoutAndSize.split('-')[0]}`;
      if (!SAME_IMAGE_OVERRIDE_LAYOUTS.has(layoutPrefix)) {
        expect([key, exempt]).toEqual([key, committed]);
        continue;
      }
      for (const placementId of committed) expect(exempt).toContain(placementId);
      const siblingRows = new Set(
        overriddenShardKeys()
          .filter((sibling) => sibling !== key && sibling.startsWith(`${layoutPrefix}-`))
          .flatMap((sibling) => Object.keys(overridesForKey(sibling)?.outlines ?? {}).map(Number)),
      );
      const unaccounted = exempt.filter(
        (placementId) => !committed.includes(placementId) && !siblingRows.has(placementId),
      );
      expect([key, unaccounted]).toEqual([key, []]);
    }
  });

  it('never exempts a placement for an LED annotation alone', () => {
    // `ledInner` rings are not silhouettes and never enter `outlines`, so they
    // must not buy the hold's traced silhouette an exemption it did not earn.
    for (const key of OVERRIDE_KEYS) {
      const file = overridesForKey(key);
      const ledOnly = Object.keys(file?.ledInner ?? {}).filter(
        (placementText) => (file?.outlines ?? {})[placementText] === undefined,
      );
      const exempt = overriddenPlacementIds(key);
      expect([key, ledOnly.filter((placementText) => exempt.has(Number(placementText)))]).toEqual([key, []]);
    }
  });
});

describe('overrides merged into the shards', () => {
  it('put every corrected silhouette in the shard verbatim', () => {
    const mismatched: string[] = [];
    for (const key of OVERRIDE_KEYS) {
      const geometry = loadBoardArtGeometry(shardBoardForKey(key));
      if (geometry === null) throw new Error(`${key}: shard did not load`);
      for (const entry of COMMITTED.filter((candidate) => candidate.key === key && candidate.table === 'outlines')) {
        const shipped = geometry.outlines[entry.placementId];
        // Byte-for-byte, not near-equal. The generator emits the stored value
        // straight through rather than round-tripping it through board pixels,
        // so anything but exact equality means the merge did not run.
        if (JSON.stringify(shipped) !== JSON.stringify(entry.ring)) {
          mismatched.push(`${key} outlines ${entry.placementId}: shard has ${JSON.stringify(shipped)}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('ship an adopted silhouette verbatim on every sibling config drawing the same art', () => {
    // On an activated layout the generator adopts a correction onto every
    // sibling config whose art image for that placement is the same file
    // (`adoptSameImageOverrides`) — identical art, identical frame, byte-equal
    // ring. Different art families never adopt: their renders jitter per hold,
    // and a projected human correction would inherit the misplacement it was
    // drawn to fix.
    const imageFor = (board: ShardBoard, placementId: number): string | undefined => {
      const layer = board.layerOfPlacement.get(placementId) ?? -1;
      return layer >= 0 ? board.backgroundRelPaths[layer] : undefined;
    };
    const mismatched: string[] = [];
    for (const entry of COMMITTED.filter((candidate) => candidate.table === 'outlines')) {
      const [boardName, layoutAndSize] = entry.key.split('/');
      const layoutPrefix = `${boardName}/${layoutAndSize.split('-')[0]}`;
      if (!SAME_IMAGE_OVERRIDE_LAYOUTS.has(layoutPrefix)) continue;
      const sourceImage = imageFor(shardBoardForKey(entry.key), entry.placementId);
      if (sourceImage === undefined) continue;
      for (const siblingKey of listBoardArtGeometryKeys()) {
        if (siblingKey === entry.key || !siblingKey.startsWith(`${layoutPrefix}-`)) continue;
        const sibling = shardBoardForKey(siblingKey);
        if (imageFor(sibling, entry.placementId) !== sourceImage) continue;
        const shipped = loadBoardArtGeometry(sibling)?.outlines[entry.placementId];
        if (JSON.stringify(shipped) !== JSON.stringify(entry.ring)) {
          mismatched.push(`${siblingKey} outlines ${entry.placementId}: shard has ${JSON.stringify(shipped)}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('put every LED-inner annotation in the shard verbatim', () => {
    const mismatched: string[] = [];
    for (const key of OVERRIDE_KEYS) {
      const geometry = loadBoardArtGeometry(shardBoardForKey(key));
      if (geometry === null) throw new Error(`${key}: shard did not load`);
      for (const entry of COMMITTED.filter((candidate) => candidate.key === key && candidate.table === 'ledInner')) {
        const shipped = geometry.ledInner?.[entry.placementId];
        if (JSON.stringify(shipped) !== JSON.stringify(entry.ring)) {
          mismatched.push(`${key} ledInner ${entry.placementId}: shard has ${JSON.stringify(shipped)}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('give every LED-inner annotation a silhouette to sit inside', () => {
    // `ledInner` is defined as the silhouette MINUS this polygon, so an entry
    // with no `outlines` entry beside it in the SAME shard describes a lit
    // region of nothing. It can happen honestly: someone annotates a base plate
    // on a placement the tracer never traced and does not also draw the
    // silhouette, and the shard then ships an annotation no renderer can use.
    const orphaned: string[] = [];
    for (const key of OVERRIDE_KEYS) {
      const geometry = loadBoardArtGeometry(shardBoardForKey(key));
      if (geometry === null) throw new Error(`${key}: shard did not load`);
      for (const entry of COMMITTED.filter((candidate) => candidate.key === key && candidate.table === 'ledInner')) {
        if (geometry.outlines[entry.placementId] === undefined) {
          orphaned.push(`${key} ledInner ${entry.placementId}: no silhouette in the shard`);
        }
      }
    }
    expect(orphaned).toEqual([]);
  });

  it('are not the only thing that can put a ledInner entry in a shard', () => {
    // This used to assert the other direction — that a `ledInner` entry with no
    // committed override behind it was a stale shard rather than a discovery —
    // and PR 6's automatic extractor is exactly that discovery, so the check
    // would now fail on 2,306 perfectly good rows.
    //
    // What is still worth stating is the SEPARATION, because it is what keeps
    // the two sources from being confused for one another: an override file is
    // not required for a shard to carry the table, and the shards that carry it
    // today have no override file at all. The extractor's own output is checked
    // in `led-inner.test.ts`; the annotations' precedence over it is checked
    // there too.
    const withTable = listBoardArtGeometryKeys().filter(
      (key) => loadBoardArtGeometry(shardBoardForKey(key))?.ledInner !== undefined,
    );
    const fromAnnotationsAlone = withTable.filter(
      (key) => Object.keys(overridesForKey(key)?.ledInner ?? {}).length > 0,
    );
    expect(withTable.length).toBeGreaterThan(0);
    expect(withTable).not.toEqual(fromAnnotationsAlone);
  });
});
