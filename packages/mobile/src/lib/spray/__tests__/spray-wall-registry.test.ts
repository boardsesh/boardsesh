import { describe, it, expect, afterEach } from 'vitest';
import { clearBoardArtGeometryCache, loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import {
  clearSprayWallRegistry,
  getSprayWall,
  listRegisteredSprayWalls,
  registerSprayWall,
  sprayBoardRenderDefault,
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
    angle: 40,
    version,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: `https://private.example/photo?sig=${version}`,
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
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

describe("a wall's stored look", () => {
  const OUTLINE_LOOK = {
    mode: 'aura' as const,
    boardsesh: {
      glowFalloff: 'soft' as const,
      glowReach: 0.5,
      plateauShare: 0.4,
      veil: 'auto' as const,
      veilOpacity: 0.3,
      markStyle: 'outline' as const,
      fillOpacity: 0.9,
      softDisc: false,
      smallHoldBoost: true,
      ledDots: true,
      roleGlyphs: false,
      thumbnailStyle: 'fill' as const,
      holdShape: 'silhouette' as const,
    },
  };

  it('is null for a wall registered without one, and for every catalogue board', () => {
    registerSprayWall(LAYOUT_ID, wall(1));
    expect(getSprayWall(LAYOUT_ID)?.renderSettings).toBeNull();
    expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).toBeNull();
    expect(sprayBoardRenderDefault('kilter', LAYOUT_ID)).toBeNull();
    expect(sprayBoardRenderDefault('spray', 999)).toBeNull();
  });

  it('is handed back for the wall that stored it, and only under the spray board name', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(1), renderSettings: OUTLINE_LOOK });
    expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).toEqual(OUTLINE_LOOK);
    expect(sprayBoardRenderDefault('tension', LAYOUT_ID)).toBeNull();
  });

  it('keeps its identity across a re-registration that did not change it', () => {
    // Every board surface on the wall subscribes to this; a ten-minute
    // revalidation handing back the same look must not wake them all.
    registerSprayWall(LAYOUT_ID, { ...wall(1), renderSettings: OUTLINE_LOOK });
    const first = sprayBoardRenderDefault('spray', LAYOUT_ID);
    registerSprayWall(LAYOUT_ID, {
      ...wall(1),
      renderSettings: { ...OUTLINE_LOOK, boardsesh: { ...OUTLINE_LOOK.boardsesh } },
    });
    expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).toBe(first);
  });

  it('moves when the look changes, and goes when it is cleared or the wall is dropped', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(1), renderSettings: OUTLINE_LOOK });
    const first = sprayBoardRenderDefault('spray', LAYOUT_ID);
    const classic = { ...OUTLINE_LOOK, mode: 'classic' as const };
    registerSprayWall(LAYOUT_ID, { ...wall(1), renderSettings: classic });
    expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).not.toBe(first);
    expect(sprayBoardRenderDefault('spray', LAYOUT_ID)?.mode).toBe('classic');

    registerSprayWall(LAYOUT_ID, { ...wall(1), renderSettings: null });
    expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).toBeNull();

    registerSprayWall(LAYOUT_ID, { ...wall(1), renderSettings: OUTLINE_LOOK });
    unregisterSprayWall(LAYOUT_ID);
    expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).toBeNull();
  });
});
