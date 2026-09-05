// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

/// <reference types="node" />

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
// Through the package's own `./segmentation` subpath rather than by relative
// path, so the export map the generator and the dark-art script reach this
// module by is exercised by something. A broken entry there is invisible to a
// relative import.
import { GROUND_FLOOR, buildWhiteKeyMask, mergeCoincidentPlacements } from '@boardsesh/board-art-geometry/segmentation';
import { PUBLIC_DIR, shardBoardForKey } from './gate-measures';

/**
 * The white key, and the two things it has to get right (issue #2202).
 *
 * `buildWhiteKeyMask` is what stands in for an alpha channel on a photographed
 * board, so a change to it silently re-cuts every Woods silhouette. Two halves
 * are pinned here: the CONNECTIVITY rule against a synthetic fixture that a
 * global brightness threshold provably fails, and the real shares off the shipped
 * lossless art, which is the number a whole shard's geometry hangs off.
 */

/**
 * A grey hold on a white ground with a blown-out specular highlight inside it.
 *
 * The highlight is pure white and it is a HOLD, which is the entire reason the
 * key floods from the corners instead of thresholding: a pale hold photographed
 * under a flash carries near-white pixels well inside its own body.
 */
const FIXTURE_WIDTH = 20;
const FIXTURE_HEIGHT = 20;
const HOLD_FROM = 6;
const HOLD_TO = 13;
const HIGHLIGHT_FROM = 9;
const HIGHLIGHT_TO = 10;

function fixturePixels(): Uint8Array {
  const pixels = new Uint8Array(FIXTURE_WIDTH * FIXTURE_HEIGHT * 3).fill(255);
  for (let y = HOLD_FROM; y <= HOLD_TO; y += 1) {
    for (let x = HOLD_FROM; x <= HOLD_TO; x += 1) {
      const inHighlight = x >= HIGHLIGHT_FROM && x <= HIGHLIGHT_TO && y >= HIGHLIGHT_FROM && y <= HIGHLIGHT_TO;
      const value = inHighlight ? 255 : 120;
      const offset = (y * FIXTURE_WIDTH + x) * 3;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
    }
  }
  return pixels;
}

/** What a global "near-white is ground" rule would key, for the counterexample. */
function globalThresholdMask(pixels: Uint8Array, channels: number): Uint8Array {
  const mask = new Uint8Array(FIXTURE_WIDTH * FIXTURE_HEIGHT);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * channels;
    const ground =
      pixels[offset] >= GROUND_FLOOR && pixels[offset + 1] >= GROUND_FLOOR && pixels[offset + 2] >= GROUND_FLOOR;
    mask[pixel] = ground ? 0 : 1;
  }
  return mask;
}

const at = (mask: Uint8Array, x: number, y: number): number => mask[y * FIXTURE_WIDTH + x];

describe('buildWhiteKeyMask', () => {
  it('keeps an enclosed specular highlight, which a global threshold punches out', () => {
    const pixels = fixturePixels();
    const { mask } = buildWhiteKeyMask(pixels, FIXTURE_WIDTH, FIXTURE_HEIGHT, 3, { erodePx: 0 });
    for (let y = HIGHLIGHT_FROM; y <= HIGHLIGHT_TO; y += 1) {
      for (let x = HIGHLIGHT_FROM; x <= HIGHLIGHT_TO; x += 1) {
        expect([x, y, at(mask, x, y)]).toEqual([x, y, 1]);
      }
    }
    // And the counterexample: the same pixels, keyed by brightness alone, lose the
    // highlight. Without this the test above would pass on a threshold too.
    const naive = globalThresholdMask(pixels, 3);
    expect(at(naive, HIGHLIGHT_FROM, HIGHLIGHT_FROM)).toBe(0);
    expect(at(mask, HIGHLIGHT_FROM, HIGHLIGHT_FROM)).toBe(1);
  });

  it('erodes exactly the outermost opaque ring, and only when asked', () => {
    const pixels = fixturePixels();
    const holdSide = HOLD_TO - HOLD_FROM + 1;
    const unEroded = buildWhiteKeyMask(pixels, FIXTURE_WIDTH, FIXTURE_HEIGHT, 3, { erodePx: 0 });
    expect(unEroded.maskShare).toBeCloseTo((holdSide * holdSide) / (FIXTURE_WIDTH * FIXTURE_HEIGHT), 10);
    expect(at(unEroded.mask, HOLD_FROM, HOLD_FROM)).toBe(1);

    const eroded = buildWhiteKeyMask(pixels, FIXTURE_WIDTH, FIXTURE_HEIGHT, 3);
    const inner = holdSide - 2;
    expect(eroded.maskShare).toBeCloseTo((inner * inner) / (FIXTURE_WIDTH * FIXTURE_HEIGHT), 10);
    // The rim goes; nothing a pixel further in does.
    expect(at(eroded.mask, HOLD_FROM, HOLD_FROM)).toBe(0);
    expect(at(eroded.mask, HOLD_FROM + 1, HOLD_FROM + 1)).toBe(1);
    // The erode is one pass over a SNAPSHOT: eating its own output would take the
    // second ring too, and on a 3-px-wide hold the whole hold.
    expect(at(eroded.mask, HOLD_FROM + 2, HOLD_FROM + 2)).toBe(1);

    // `groundShare` is measured before the erode, so the two do not double-count.
    expect(eroded.groundShare).toBeCloseTo(unEroded.groundShare, 10);
    expect(eroded.groundShare + unEroded.maskShare).toBeCloseTo(1, 10);
  });

  it('never writes to the pixels it was handed', () => {
    const pixels = fixturePixels();
    const before = Uint8Array.from(pixels);
    buildWhiteKeyMask(pixels, FIXTURE_WIDTH, FIXTURE_HEIGHT, 3);
    expect(Array.from(pixels)).toEqual(Array.from(before));
  });

  it('reads 4-channel pixels the same way, and keeps art the source made transparent', () => {
    const rgb = fixturePixels();
    const rgba = new Uint8Array(FIXTURE_WIDTH * FIXTURE_HEIGHT * 4);
    for (let pixel = 0; pixel < FIXTURE_WIDTH * FIXTURE_HEIGHT; pixel += 1) {
      rgba[pixel * 4] = rgb[pixel * 3];
      rgba[pixel * 4 + 1] = rgb[pixel * 3 + 1];
      rgba[pixel * 4 + 2] = rgb[pixel * 3 + 2];
      rgba[pixel * 4 + 3] = 255;
    }
    expect(Array.from(buildWhiteKeyMask(rgba, FIXTURE_WIDTH, FIXTURE_HEIGHT, 4).mask)).toEqual(
      Array.from(buildWhiteKeyMask(rgb, FIXTURE_WIDTH, FIXTURE_HEIGHT, 3).mask),
    );

    // A pixel the source already made transparent is not ground to be discovered,
    // and it must not stop the flood either: punch a transparent hole in the
    // ground and the corners still reach past it.
    rgba[(2 * FIXTURE_WIDTH + 2) * 4 + 3] = 0;
    const keyed = buildWhiteKeyMask(rgba, FIXTURE_WIDTH, FIXTURE_HEIGHT, 4, { erodePx: 0 });
    expect(at(keyed.mask, 2, 2)).toBe(0);
    expect(at(keyed.mask, 0, 19)).toBe(0);
  });

  it('refuses inputs it cannot honestly key', () => {
    const pixels = fixturePixels();
    expect(() => buildWhiteKeyMask(pixels, FIXTURE_WIDTH, FIXTURE_HEIGHT, 2)).toThrow(/3 or 4 channels/);
    expect(() => buildWhiteKeyMask(pixels, FIXTURE_WIDTH, FIXTURE_HEIGHT * 2, 3)).toThrow(/bytes for/);
    expect(() => buildWhiteKeyMask(pixels, FIXTURE_WIDTH, FIXTURE_HEIGHT, 3, { erodePx: 2 })).toThrow(/erodePx/);
  });
});

/**
 * The shares off the shipped lossless art.
 *
 * These are golden numbers, not bounds: the whole Woods geometry is cut out of
 * this mask, so a change of a tenth of a point means every silhouette moved. The
 * LOSSLESS `.png` is the source on purpose — keying the shipped `.webp` disagrees
 * on 0.30% of pixels, which is its compression ringing around every hold edge.
 */
const WOODS_KEY_GOLDENS: Record<string, { image: string; groundShare: number; maskShare: number }> = {
  'woods/1-1': { image: 'images/woods/woods-8x10-bg.png', groundShare: 0.6804, maskShare: 0.2632 },
  'woods/1-2': { image: 'images/woods/woods-12x12-bg.png', groundShare: 0.6624, maskShare: 0.2858 },
};

describe('the shipped Woods art keys to the shares its shard was cut from', () => {
  for (const [key, golden] of Object.entries(WOODS_KEY_GOLDENS)) {
    it(key, async () => {
      const board = shardBoardForKey(key);
      const { data, info } = await sharp(path.join(PUBLIC_DIR, golden.image))
        .raw()
        .toBuffer({ resolveWithObject: true });
      // The generator asserts this rather than resampling, because a photographic
      // board's art IS the board — see `keyPhotographicLayers`.
      expect([info.width, info.height]).toEqual([board.boardWidth, board.boardHeight]);

      const keyed = buildWhiteKeyMask(data, info.width, info.height, info.channels);
      expect(Number(keyed.groundShare.toFixed(4))).toBe(golden.groundShare);
      expect(Number(keyed.maskShare.toFixed(4))).toBe(golden.maskShare);
    });
  }
});

describe('mergeCoincidentPlacements', () => {
  it('groups placements within the epsilon and leaves the rest alone', () => {
    const groups = mergeCoincidentPlacements([
      { id: 7, cx: 10, cy: 10 },
      { id: 3, cx: 11, cy: 10 },
      { id: 9, cx: 40, cy: 10 },
    ]);
    // Lowest id is canonical, so the grouping does not depend on the order the
    // board data happens to list placements in.
    expect(groups.membersOf.get(3)).toEqual([3, 7]);
    expect(groups.canonicalOf.get(7)).toBe(3);
    expect(groups.membersOf.get(9)).toEqual([9]);
    expect([...groups.membersOf.keys()].sort((left, right) => left - right)).toEqual([3, 9]);
  });

  it('is a union, so a chain merges even where the ends are further apart', () => {
    const groups = mergeCoincidentPlacements([
      { id: 1, cx: 10, cy: 10 },
      { id: 2, cx: 12, cy: 10 },
      { id: 3, cx: 14, cy: 10 },
    ]);
    expect(groups.membersOf.get(1)).toEqual([1, 2, 3]);
  });

  it('rounds centres first, because the partition it feeds seeds on rounded ones', () => {
    // 1.2 board px apart in exact coordinates, 2 apart once rounded — and it is
    // the rounded pair the nearest-placement transform actually contests.
    const groups = mergeCoincidentPlacements([
      { id: 1, cx: 10.4, cy: 10 },
      { id: 2, cx: 11.6, cy: 10 },
    ]);
    expect(groups.membersOf.get(1)).toEqual([1, 2]);
    // And it is a distance, not a bounding box: 2 across and 2 down is 2.83 apart.
    expect(
      mergeCoincidentPlacements([
        { id: 1, cx: 0, cy: 0 },
        { id: 2, cx: 2, cy: 2 },
      ]).membersOf.size,
    ).toBe(2);
  });
});

/**
 * The merged groups on the real boards, against the near-duplicate budget the
 * hold table already ships.
 *
 * `COINCIDENT_PAIR_BUDGET` in `@boardsesh/board-config`'s
 * `woods-hold-positions.test.ts` pins the same defect from the other end — 24
 * pairs on the 8x10 and 17 on the 12x12, measured as exact centres under 2 board
 * px apart — and it may only ever shrink. The merge here is a SUPERSET of it, and
 * deliberately: it rounds first, because two placements the nearest-placement
 * transform cannot separate are exactly the ones that have to merge, and rounding
 * pulls in 7 more pairs on the 8x10 and 1 more on the 12x12 whose exact
 * separation is a shade over 2 px. Every budget pair is inside a merged group,
 * which is what makes this a superset rather than a different answer.
 */
const WOODS_MERGED_GROUPS: Record<string, { placements: number; groups: number; merged: number }> = {
  'woods/1-1': { placements: 485, groups: 454, merged: 31 },
  'woods/1-2': { placements: 894, groups: 876, merged: 18 },
};

describe('the Woods hold tables merge to one seed per hold', () => {
  for (const [key, expected] of Object.entries(WOODS_MERGED_GROUPS)) {
    it(key, () => {
      const board = shardBoardForKey(key);
      const groups = mergeCoincidentPlacements(board.placements);
      const merged = [...groups.membersOf.values()].filter((members) => members.length > 1);
      expect({
        placements: board.placements.length,
        groups: groups.membersOf.size,
        merged: merged.length,
      }).toEqual(expected);

      // Every pair the shipped budget counts is inside one of these groups.
      const uncovered: string[] = [];
      for (let first = 0; first < board.placements.length; first += 1) {
        for (let second = first + 1; second < board.placements.length; second += 1) {
          const left = board.placements[first];
          const right = board.placements[second];
          if (Math.hypot(left.cx - right.cx, left.cy - right.cy) >= 2) continue;
          if (groups.canonicalOf.get(left.id) !== groups.canonicalOf.get(right.id)) {
            uncovered.push(`${left.id}/${right.id}`);
          }
        }
      }
      expect(uncovered).toEqual([]);
    });
  }
});
