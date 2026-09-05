// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

import { describe, expect, it } from 'vitest';
import type { BoardName } from '@boardsesh/shared-schema';
import {
  clearBoardArtGeometryCache,
  getOutlineCounts,
  getWallLightness,
  listBoardArtGeometryKeys,
  loadBoardArtGeometry,
} from '../loader';
import { boardArtGeometryKey } from '../types';

/**
 * The loader's contract, and the shard contract the Rust renderer reads through
 * (issue #2202).
 *
 * The shape assertions are not decoration: the shards are generated text, so a
 * generator that emitted a stray `-1` sentinel, an odd-length polygon or a `NaN`
 * coordinate would produce a file that parses perfectly and draws garbage.
 */

const KILTER_ORIGINAL_12X12 = { boardName: 'kilter', layoutId: 1, sizeId: 10 } as const;

describe('loadBoardArtGeometry', () => {
  it('returns null for a board config with no shard', () => {
    // `null` is a normal answer, not an error — the caller falls back to a ring at
    // the placement radius. Every config in the catalogue ships a shard now (Woods
    // was the last holdout, and it is keyed off its white ground), so the case is
    // a layout or size the catalogue does not carry.
    expect(loadBoardArtGeometry({ boardName: 'kilter', layoutId: 999, sizeId: 999 })).toBeNull();
    expect(loadBoardArtGeometry({ boardName: 'woods', layoutId: 1, sizeId: 99 })).toBeNull();
  });

  it('memoises, so a redraw does not re-evaluate the shard', () => {
    clearBoardArtGeometryCache();
    const first = loadBoardArtGeometry(KILTER_ORIGINAL_12X12);
    const second = loadBoardArtGeometry(KILTER_ORIGINAL_12X12);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    // A miss is memoised too, or every frame of an unshipped config pays a failed
    // module lookup.
    const missing = { boardName: 'woods', layoutId: 1, sizeId: 99 } as const;
    expect(loadBoardArtGeometry(missing)).toBe(loadBoardArtGeometry(missing));
  });

  it('ignores set ids: one shard covers every subset of its layout and size', () => {
    // The query type has no set field at all, and the key is built from three
    // parts. This pins the decision rather than the type.
    expect(boardArtGeometryKey(KILTER_ORIGINAL_12X12)).toBe('kilter/1-10');
  });

  it('loads a real shard with the three contract tables', () => {
    const geometry = loadBoardArtGeometry(KILTER_ORIGINAL_12X12);
    expect(geometry).not.toBeNull();
    if (geometry === null) return;
    expect(Object.keys(geometry.outlines).length).toBe(476);
    expect(Object.keys(geometry.silhouetteLightness).length).toBeGreaterThan(0);
    // Kilter draws a dark bolt hole rather than a bright LED, so this table is
    // legitimately empty there — that is the fact the renderer needs.
    expect(geometry.ledBright).toEqual({});
  });

  it('has a painted-LED table on the board whose art paints them', () => {
    const geometry = loadBoardArtGeometry({ boardName: 'grasshopper', layoutId: 1, sizeId: 5 });
    expect(geometry).not.toBeNull();
    if (geometry === null) return;
    expect(Object.keys(geometry.ledBright).length).toBe(234);
  });
});

describe('shard contract', () => {
  const keys = listBoardArtGeometryKeys();

  it('indexes at least one shard', () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it('every outline is an even-length ring of at least three finite points', () => {
    const offenders: string[] = [];
    for (const key of keys) {
      const [boardName, layoutAndSize] = key.split('/');
      const [layoutId, sizeId] = layoutAndSize.split('-').map(Number);
      const query = { boardName: boardName as BoardName, layoutId, sizeId };
      const geometry = loadBoardArtGeometry(query);
      if (geometry === null) {
        offenders.push(`${key}: indexed but did not load`);
        continue;
      }
      for (const [holdId, flat] of Object.entries(geometry.outlines)) {
        if (flat.length % 2 !== 0) offenders.push(`${key}#${holdId}: odd length ${flat.length}`);
        if (flat.length < 6) offenders.push(`${key}#${holdId}: only ${flat.length / 2} points`);
        if (flat.some((value) => !Number.isFinite(value))) offenders.push(`${key}#${holdId}: non-finite coordinate`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every lightness reading is a real OkLab lightness, with no sentinel', () => {
    const offenders: string[] = [];
    for (const key of keys) {
      const [boardName, layoutAndSize] = key.split('/');
      const [layoutId, sizeId] = layoutAndSize.split('-').map(Number);
      const query = { boardName: boardName as BoardName, layoutId, sizeId };
      const geometry = loadBoardArtGeometry(query);
      if (geometry === null) continue;
      for (const [holdId, value] of Object.entries(geometry.silhouetteLightness)) {
        if (!Number.isFinite(value) || value < 0 || value > 1) offenders.push(`${key}#${holdId}: ${value}`);
        // Every lightness reading belongs to a traced outline. The spike shipped
        // a `-1` "no art" sentinel here and a `?? target` read straight past it.
        if (geometry.outlines[Number(holdId)] === undefined) offenders.push(`${key}#${holdId}: no outline`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every painted-LED offset is a finite pair on a traced placement', () => {
    const offenders: string[] = [];
    for (const key of keys) {
      const [boardName, layoutAndSize] = key.split('/');
      const [layoutId, sizeId] = layoutAndSize.split('-').map(Number);
      const query = { boardName: boardName as BoardName, layoutId, sizeId };
      const geometry = loadBoardArtGeometry(query);
      if (geometry === null) continue;
      for (const [holdId, offset] of Object.entries(geometry.ledBright)) {
        // The tuple type is what the contract PROMISES; the shard is generated
        // text, so the count is read back as a plain array rather than trusted.
        const components = offset as number[];
        if (components.length !== 2) offenders.push(`${key}#${holdId}: ${components.length} components`);
        if (geometry.outlines[Number(holdId)] === undefined)
          offenders.push(`${key}#${holdId}: LED on an untraced placement`);
        if (components.some((value) => !Number.isFinite(value))) offenders.push(`${key}#${holdId}: non-finite offset`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('getWallLightness', () => {
  it('has a row for every shard and none for a board with no shard', () => {
    for (const key of listBoardArtGeometryKeys()) {
      const [boardName, layoutAndSize] = key.split('/');
      const [layoutId, sizeId] = layoutAndSize.split('-').map(Number);
      const query = { boardName: boardName as BoardName, layoutId, sizeId };
      const wall = getWallLightness(query);
      expect([key, wall !== null]).toEqual([key, true]);
      if (wall === null) continue;
      expect([key, wall.mean >= 0 && wall.mean <= 1]).toEqual([key, true]);
      expect([key, wall.coverage >= 0 && wall.coverage <= 1]).toEqual([key, true]);
    }
    expect(getWallLightness({ boardName: 'woods', layoutId: 1, sizeId: 99 })).toBeNull();
  });
});

describe('getOutlineCounts', () => {
  it('covers exactly the shipped shards', () => {
    expect(Object.keys(getOutlineCounts()).sort()).toEqual(listBoardArtGeometryKeys());
  });
});
