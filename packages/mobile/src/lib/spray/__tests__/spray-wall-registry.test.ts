import { describe, it, expect, afterEach } from 'vitest';
import { clearBoardArtGeometryCache, loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import {
  clearSprayWallRegistry,
  getSprayWall,
  listRegisteredSprayWalls,
  registerSprayWall,
  sprayCacheToken,
  sprayGeometryKey,
  subscribeToSprayWalls,
  unregisterSprayWall,
} from '../spray-wall-registry';
import type { SprayPhotoHold } from '../spray-hold-geometry';

const LAYOUT_ID = 4200;

const DEFAULT_HOLDS: SprayPhotoHold[] = [{ id: 7, cx: 100, cy: 200, r: 18, outline: [1, 0, 0, 1, -1, 0] }];

function wall(version: number, holds: SprayPhotoHold[] = DEFAULT_HOLDS) {
  return {
    wallUuid: 'wall-uuid',
    version,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: `https://private.example/photo?sig=${version}`,
    photoThumbUrl: null,
    photoExpiresAt: '2026-09-15T12:15:00.000Z',
    holds,
  };
}

afterEach(() => {
  clearSprayWallRegistry();
  clearBoardArtGeometryCache();
});

describe('spray wall registry', () => {
  it('hands a registered wall straight back', () => {
    registerSprayWall(LAYOUT_ID, wall(1));
    expect(getSprayWall(LAYOUT_ID)).toMatchObject({ layoutId: LAYOUT_ID, version: 1, photoWidth: 1200 });
  });

  it('answers null for a wall nobody registered', () => {
    expect(getSprayWall(999)).toBeNull();
  });

  it('publishes the wall geometry under the board-art key the renderer already asks for', () => {
    registerSprayWall(LAYOUT_ID, wall(1));
    expect(sprayGeometryKey(LAYOUT_ID)).toBe(`spray/${LAYOUT_ID}-${LAYOUT_ID}`);
    const geometry = loadBoardArtGeometry({ boardName: 'spray', layoutId: LAYOUT_ID, sizeId: LAYOUT_ID });
    expect(geometry?.outlines[7]).toEqual([1, 0, 0, 1, -1, 0]);
    // A wall has no LEDs and nothing measures its photo's brightness. Empty, not
    // fabricated: a consumer must read "no reading", never "black art".
    expect(geometry?.ledBright).toEqual({});
    expect(geometry?.silhouetteLightness).toEqual({});
  });

  it('omits a hold with no silhouette, so the renderer rings it', () => {
    registerSprayWall(
      LAYOUT_ID,
      wall(1, [
        { id: 7, cx: 1, cy: 2, r: 3, outline: [1, 0, 0, 1, -1, 0] },
        { id: 8, cx: 4, cy: 5, r: 6 },
      ]),
    );
    const geometry = loadBoardArtGeometry({ boardName: 'spray', layoutId: LAYOUT_ID, sizeId: LAYOUT_ID });
    expect(Object.keys(geometry?.outlines ?? {})).toEqual(['7']);
  });

  it('replaces the whole wall on a reset', () => {
    registerSprayWall(LAYOUT_ID, wall(1, [{ id: 7, cx: 1, cy: 2, r: 3, outline: [1, 0, 0, 1, -1, 0] }]));
    registerSprayWall(LAYOUT_ID, wall(2, [{ id: 9, cx: 4, cy: 5, r: 6, outline: [2, 0, 0, 2, -2, 0] }]));

    expect(getSprayWall(LAYOUT_ID)?.holds.map((hold) => hold.id)).toEqual([9]);
    const geometry = loadBoardArtGeometry({ boardName: 'spray', layoutId: LAYOUT_ID, sizeId: LAYOUT_ID });
    expect(Object.keys(geometry?.outlines ?? {})).toEqual(['9']);
  });

  it('withdraws the geometry with the wall', () => {
    registerSprayWall(LAYOUT_ID, wall(1));
    unregisterSprayWall(LAYOUT_ID);

    expect(getSprayWall(LAYOUT_ID)).toBeNull();
    expect(loadBoardArtGeometry({ boardName: 'spray', layoutId: LAYOUT_ID, sizeId: LAYOUT_ID })).toBeNull();
  });

  it('lists every wall for the sweeper to protect', () => {
    registerSprayWall(LAYOUT_ID, wall(3));
    registerSprayWall(LAYOUT_ID + 1, wall(1));
    expect(
      listRegisteredSprayWalls()
        .map((entry) => `${entry.layoutId}-${entry.version}`)
        .sort(),
    ).toEqual(['4200-3', '4201-1']);
  });

  it('wakes subscribers on register and unregister, and stops after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeToSprayWalls(() => {
      calls += 1;
    });
    registerSprayWall(LAYOUT_ID, wall(1));
    unregisterSprayWall(LAYOUT_ID);
    expect(calls).toBe(2);

    unsubscribe();
    registerSprayWall(LAYOUT_ID, wall(2));
    expect(calls).toBe(2);
  });
});

describe('sprayCacheToken', () => {
  it('is empty for every catalogue board, so no existing cache key moves', () => {
    registerSprayWall(LAYOUT_ID, wall(4));
    for (const boardName of [
      'kilter',
      'tension',
      'decoy',
      'touchstone',
      'grasshopper',
      'soill',
      'moonboard',
      'woods',
    ]) {
      expect(sprayCacheToken(boardName, LAYOUT_ID)).toBe('');
    }
  });

  it('carries the wall version', () => {
    registerSprayWall(LAYOUT_ID, wall(4));
    expect(sprayCacheToken('spray', LAYOUT_ID)).toBe('-sv4');
  });

  it('moves when the wall is reset', () => {
    registerSprayWall(LAYOUT_ID, wall(1));
    const beforeReset = sprayCacheToken('spray', LAYOUT_ID);
    registerSprayWall(LAYOUT_ID, wall(2));
    expect(sprayCacheToken('spray', LAYOUT_ID)).not.toBe(beforeReset);
  });

  it('differs from every real version while the wall is unknown', () => {
    // Nothing is drawn or cached under it — there is no render data — but it must
    // not collide with the first paint after the query lands.
    expect(sprayCacheToken('spray', 12345)).toBe('-sv0');
    registerSprayWall(12345, wall(1));
    expect(sprayCacheToken('spray', 12345)).not.toBe('-sv0');
  });

  it('keeps two walls apart', () => {
    registerSprayWall(LAYOUT_ID, wall(2));
    registerSprayWall(LAYOUT_ID + 1, wall(5));
    expect(sprayCacheToken('spray', LAYOUT_ID)).not.toBe(sprayCacheToken('spray', LAYOUT_ID + 1));
  });
});
