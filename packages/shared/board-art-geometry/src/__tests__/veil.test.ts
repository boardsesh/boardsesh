// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

import { describe, expect, it } from 'vitest';
import type { BoardName } from '@boardsesh/shared-schema';
import { getWallLightness } from '../loader';
import { VEIL_TUNING, oklabLightness, veilOpacityFor } from '../veil';

/**
 * The veil's published figures, pinned against the committed wall-lightness
 * table (issue #2202).
 *
 * These are the numbers the spike's write-up quotes, so they have to be
 * reproducible from what ships: the gap per board on the shipped field, and the
 * bucket it lands in. A change to the tracer that moves a wall reading enough to
 * cross a threshold is a visible change to what the app draws, and it should
 * show up here rather than in a screenshot three weeks later.
 */

/** The play field the shipped board view paints. */
const PLAY_FIELD = '#181225';
/** The plywood chip from the spike's chip row — brighter than several boards' walls. */
const PLYWOOD_CHIP = '#6B4F33';

function gapOn(field: string, boardName: BoardName, layoutId: number, sizeId: number): number {
  const wall = getWallLightness({ boardName, layoutId, sizeId });
  if (wall === null) throw new Error(`${boardName}/${layoutId}-${sizeId}: no wall lightness`);
  return Math.round((wall.mean - oklabLightness(field)) * 1000) / 1000;
}

function veilOn(field: string, boardName: BoardName, layoutId: number, sizeId: number): number {
  const wall = getWallLightness({ boardName, layoutId, sizeId });
  if (wall === null) throw new Error(`${boardName}/${layoutId}-${sizeId}: no wall lightness`);
  return veilOpacityFor({ wallLightness: wall.mean, coverage: wall.coverage, fieldColor: field });
}

describe('oklabLightness', () => {
  it('reads the shipped play field at the lightness the tuning was set against', () => {
    expect(Math.round(oklabLightness(PLAY_FIELD) * 1000) / 1000).toBe(0.2);
    expect(oklabLightness('#000000')).toBe(0);
    expect(Math.round(oklabLightness('#FFFFFF') * 1000) / 1000).toBe(1);
  });

  it('reports mid-grey rather than NaN for a colour it cannot read', () => {
    // NaN compares false against both thresholds, so it would silently turn the
    // veil off — the weakest outcome, reached by a typo rather than a measurement.
    expect(oklabLightness('#zzzzzz')).toBe(0.5);
    expect(oklabLightness('#fff')).toBe(0.5);
    expect(oklabLightness('rebeccapurple')).toBe(0.5);
  });

  it('accepts the hex with or without its hash', () => {
    expect(oklabLightness('181225')).toBe(oklabLightness(PLAY_FIELD));
  });
});

describe('veilOpacityFor', () => {
  it('reproduces the spike gaps and buckets on the shipped field', () => {
    // TB2 Mirror 12x12 — the loudest wall in the catalogue's spike sample.
    expect(gapOn(PLAY_FIELD, 'tension', 10, 6)).toBe(0.541);
    expect(veilOn(PLAY_FIELD, 'tension', 10, 6)).toBe(VEIL_TUNING.veilStrongOpacity);
    // Tension Original Full Wall.
    expect(gapOn(PLAY_FIELD, 'tension', 9, 1)).toBe(0.461);
    expect(veilOn(PLAY_FIELD, 'tension', 9, 1)).toBe(VEIL_TUNING.veilStrongOpacity);
    // Kilter Original 12x12 — over the soft threshold, under the strong one.
    expect(gapOn(PLAY_FIELD, 'kilter', 1, 10)).toBe(0.325);
    expect(veilOn(PLAY_FIELD, 'kilter', 1, 10)).toBe(VEIL_TUNING.veilSoftOpacity);
    // Grasshopper Master 8x12 — the board the issue was filed against.
    expect(gapOn(PLAY_FIELD, 'grasshopper', 1, 5)).toBe(0.216);
    expect(veilOn(PLAY_FIELD, 'grasshopper', 1, 5)).toBe(VEIL_TUNING.veilSoftOpacity);
    // Kilter Homewall 10x12.
    expect(gapOn(PLAY_FIELD, 'kilter', 8, 25)).toBe(0.426);
    expect(veilOn(PLAY_FIELD, 'kilter', 8, 25)).toBe(VEIL_TUNING.veilStrongOpacity);
    // MoonBoard Masters 2019: the spike published 0.441 off a three-set trace;
    // every shard mounts all eight sets, which brightens the annulus to 0.469.
    // Same bucket, so nothing downstream moved — pinned so the next move shows.
    expect(gapOn(PLAY_FIELD, 'moonboard', 5, 1)).toBe(0.469);
    expect(veilOn(PLAY_FIELD, 'moonboard', 5, 1)).toBe(VEIL_TUNING.veilStrongOpacity);
  });

  it('pins the two MoonBoards that sit on a coverage edge', () => {
    // 6-1 has readings on 59.8% of its placements — 0.002 under the soft cap —
    // so a strong-bucket gap still ships soft. A re-trace that nudges it over
    // flips the veil from 0.30 to 0.60; this is where that shows up.
    const edge = getWallLightness({ boardName: 'moonboard', layoutId: 6, sizeId: 1 });
    expect(edge?.coverage).toBe(0.598);
    expect(veilOn(PLAY_FIELD, 'moonboard', 6, 1)).toBe(VEIL_TUNING.veilSoftOpacity);
    // 1-1 averages four placements of 198: not a wall reading, so no veil.
    const sparse = getWallLightness({ boardName: 'moonboard', layoutId: 1, sizeId: 1 });
    expect(sparse?.coverage).toBe(0.02);
    expect(veilOn(PLAY_FIELD, 'moonboard', 1, 1)).toBe(0);
  });

  it('caps a board that is mostly bare grid at the soft bucket', () => {
    // MoonBoard 2016: the gap clears the strong threshold, but only 52% of its
    // placements carry any art at all. What the veil dims there is the field's
    // own furniture — the A-K / 1-18 labels painted into the board art.
    const wall = getWallLightness({ boardName: 'moonboard', layoutId: 2, sizeId: 1 });
    expect(wall).not.toBeNull();
    if (wall === null) return;
    expect(wall.coverage).toBeLessThan(VEIL_TUNING.veilMinCoverage);
    expect(gapOn(PLAY_FIELD, 'moonboard', 2, 1)).toBe(0.373);
    expect(veilOn(PLAY_FIELD, 'moonboard', 2, 1)).toBe(VEIL_TUNING.veilSoftOpacity);
  });

  it('turns off on a field brighter than the wall', () => {
    // Every board on white, and Grasshopper on the plywood chip: a wash there
    // makes the wall brighter than the hold it is meant to be quieting behind.
    for (const [boardName, layoutId, sizeId] of [
      ['tension', 10, 6],
      ['kilter', 1, 10],
      ['grasshopper', 1, 5],
    ] as const) {
      expect([boardName, veilOn('#FFFFFF', boardName, layoutId, sizeId)]).toEqual([boardName, 0]);
    }
    expect(oklabLightness(PLYWOOD_CHIP)).toBeGreaterThan(0.4);
    expect(veilOn(PLYWOOD_CHIP, 'grasshopper', 1, 5)).toBe(0);
  });

  it('refuses to guess when there is no reading to bucket on', () => {
    expect(veilOpacityFor({ wallLightness: 0.9, coverage: 0, fieldColor: PLAY_FIELD })).toBe(0);
    expect(veilOpacityFor({ wallLightness: Number.NaN, coverage: 1, fieldColor: PLAY_FIELD })).toBe(0);
  });

  it('buckets exactly on the thresholds, not near them', () => {
    const field = '#000000';
    const at = (wallLightness: number): number => veilOpacityFor({ wallLightness, coverage: 1, fieldColor: field });
    expect(at(VEIL_TUNING.veilStrongGap)).toBe(VEIL_TUNING.veilStrongOpacity);
    expect(at(VEIL_TUNING.veilStrongGap - 1e-6)).toBe(VEIL_TUNING.veilSoftOpacity);
    expect(at(VEIL_TUNING.veilSoftGap)).toBe(VEIL_TUNING.veilSoftOpacity);
    expect(at(VEIL_TUNING.veilSoftGap - 1e-6)).toBe(0);
  });
});
