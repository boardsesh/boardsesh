import { describe, it, expect, afterEach } from 'vitest';
import { clearBoardArtGeometryCache, loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import {
  clearSprayWallRegistry,
  findRegisteredSprayWallByUuid,
  getSprayWall,
  LIVE_SPRAY_WALL_ARCHIVE_STATE,
  markSprayWallArchived,
  sprayWallArchiveState,
  sprayWallIsArchived,
  listRegisteredSprayWalls,
  registerSprayWall,
  resetSprayWallViewerAccess,
  setSprayWallLook,
  sprayBoardRenderDefault,
  sprayCacheToken,
  sprayGeometryKey,
  sprayWallViewerCanEdit,
  sprayWallViewerCanEditClimbs,
  sprayWallViewerGeneration,
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
    versionId: version,
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
    expect(sprayCacheToken('spray', LAYOUT_ID)).toMatch(/^-svid4-pr\d+-\d+$/);
  });

  it('moves when a discarded number is reused for another immutable row', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(3), versionId: 30 });
    const discardedToken = sprayCacheToken('spray', LAYOUT_ID);
    registerSprayWall(LAYOUT_ID, { ...wall(3), versionId: 31 });
    expect(sprayCacheToken('spray', LAYOUT_ID)).not.toBe(discardedToken);
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
    const unknownToken = sprayCacheToken('spray', 12345);
    expect(unknownToken).toMatch(/^-svid0-pr\d+-\d+$/);
    registerSprayWall(12345, wall(1));
    expect(sprayCacheToken('spray', 12345)).not.toBe(unknownToken);
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

  it('survives a re-registration that does not say, because the render payload never carries it', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(1), renderSettings: OUTLINE_LOOK });
    const first = sprayBoardRenderDefault('spray', LAYOUT_ID);
    registerSprayWall(LAYOUT_ID, wall(2));
    expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).toBe(first);
  });

  it('does not carry over to a different wall under the same layout', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(1), renderSettings: OUTLINE_LOOK });
    registerSprayWall(LAYOUT_ID, { ...wall(1), wallUuid: 'another-wall' });
    expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).toBeNull();
  });

  it('is set on its own for the wall it belongs to, and wakes subscribers only on a change', () => {
    registerSprayWall(LAYOUT_ID, wall(1));
    let wakes = 0;
    const unsubscribe = subscribeToSprayWalls(() => {
      wakes += 1;
    });
    try {
      setSprayWallLook(LAYOUT_ID, 'wall-uuid', OUTLINE_LOOK);
      expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).toEqual(OUTLINE_LOOK);
      expect(wakes).toBe(1);

      setSprayWallLook(LAYOUT_ID, 'wall-uuid', { ...OUTLINE_LOOK, boardsesh: { ...OUTLINE_LOOK.boardsesh } });
      expect(wakes).toBe(1);

      // An answer for a wall that has since been replaced, or never registered.
      setSprayWallLook(LAYOUT_ID, 'another-wall', null);
      setSprayWallLook(999, 'wall-uuid', OUTLINE_LOOK);
      expect(sprayBoardRenderDefault('spray', LAYOUT_ID)).toEqual(OUTLINE_LOOK);
      expect(sprayBoardRenderDefault('spray', 999)).toBeNull();
      expect(wakes).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});

describe('who can edit the wall (#5955)', () => {
  /** "The viewer can edit", fetched under the account that is signed in now. */
  const canEditNow = () => ({ canEdit: true, generation: sprayWallViewerGeneration() });

  it('is false unless the registration says the viewer can edit', () => {
    registerSprayWall(LAYOUT_ID, wall(1));
    expect(getSprayWall(LAYOUT_ID)?.viewerCanEdit).toBe(false);
    expect(sprayWallViewerCanEdit('spray', LAYOUT_ID)).toBe(false);

    registerSprayWall(LAYOUT_ID, { ...wall(1), viewerAccess: canEditNow() });
    expect(sprayWallViewerCanEdit('spray', LAYOUT_ID)).toBe(true);
  });

  it('is never carried over from the previous registration', () => {
    // A revalidation that no longer says "can edit" is a role that was taken
    // away. Keeping the old answer would leave Edit on screen.
    registerSprayWall(LAYOUT_ID, { ...wall(1), viewerAccess: canEditNow() });
    registerSprayWall(LAYOUT_ID, wall(1));
    expect(sprayWallViewerCanEdit('spray', LAYOUT_ID)).toBe(false);
  });

  it('is false for a catalogue board and for a wall nobody registered', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(1), viewerAccess: canEditNow() });
    expect(sprayWallViewerCanEdit('kilter', LAYOUT_ID)).toBe(false);
    expect(sprayWallViewerCanEdit('spray', 999)).toBe(false);
  });

  it('supports separate climb edit permission (#6025)', () => {
    registerSprayWall(LAYOUT_ID, {
      ...wall(1),
      viewerAccess: { canEdit: false, canEditClimbs: true, generation: sprayWallViewerGeneration() },
    });
    expect(sprayWallViewerCanEdit('spray', LAYOUT_ID)).toBe(false);
    expect(sprayWallViewerCanEditClimbs('spray', LAYOUT_ID)).toBe(true);

    resetSprayWallViewerAccess();
    expect(sprayWallViewerCanEditClimbs('spray', LAYOUT_ID)).toBe(false);
  });

  it('drops every wall to "cannot edit" on an account change, and keeps the wall drawable', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(3), viewerAccess: canEditNow() });
    registerSprayWall(4201, { ...wall(1), wallUuid: 'other-wall', viewerAccess: canEditNow() });
    let wakes = 0;
    const unsubscribe = subscribeToSprayWalls(() => {
      wakes += 1;
    });
    try {
      expect(resetSprayWallViewerAccess().sort((left, right) => left - right)).toEqual([LAYOUT_ID, 4201]);
      expect(wakes).toBe(1);
    } finally {
      unsubscribe();
    }

    expect(sprayWallViewerCanEdit('spray', LAYOUT_ID)).toBe(false);
    expect(sprayWallViewerCanEdit('spray', 4201)).toBe(false);
    // Still registered at the same version: nothing on screen goes blank.
    expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 3, photoWidth: 1200 });
    expect(sprayCacheToken('spray', LAYOUT_ID)).toMatch(/^-svid3-pr\d+-\d+$/);
    // Marked stale, so the next ask goes back to the server for this account.
    expect(getSprayWall(LAYOUT_ID)?.registeredAtMs).toBe(0);
  });

  it('moves the viewer generation on every account change, even with nothing registered', () => {
    // A load can be in flight for a wall that has not registered yet, and it
    // has to be disowned too.
    const before = sprayWallViewerGeneration();
    let wakes = 0;
    const unsubscribe = subscribeToSprayWalls(() => {
      wakes += 1;
    });
    try {
      expect(resetSprayWallViewerAccess()).toEqual([]);
      expect(wakes).toBe(1);
    } finally {
      unsubscribe();
    }
    expect(sprayWallViewerGeneration()).toBe(before + 1);
  });

  it('does not believe "can edit" from a payload fetched under the previous account', () => {
    // The request left while account A was signed in...
    const fetchedUnder = sprayWallViewerGeneration();
    // ...A signed out, B signed in...
    resetSprayWallViewerAccess();
    resetSprayWallViewerAccess();
    // ...and only then did A's answer land.
    registerSprayWall(LAYOUT_ID, { ...wall(2), viewerAccess: { canEdit: true, generation: fetchedUnder } });

    // The wall draws: its photo and holds are the same for everyone.
    expect(getSprayWall(LAYOUT_ID)).toMatchObject({ version: 2, photoWidth: 1200 });
    // But A's Edit is not B's, and the registration is stale so B's is fetched.
    expect(sprayWallViewerCanEdit('spray', LAYOUT_ID)).toBe(false);
    expect(getSprayWall(LAYOUT_ID)?.registeredAtMs).toBe(0);
  });

  it('believes it again once fetched under the account that is here', () => {
    resetSprayWallViewerAccess();
    registerSprayWall(LAYOUT_ID, { ...wall(2), viewerAccess: canEditNow() });
    expect(sprayWallViewerCanEdit('spray', LAYOUT_ID)).toBe(true);
    expect(getSprayWall(LAYOUT_ID)?.registeredAtMs).toBeGreaterThan(0);
  });
});

describe('spray wall archive state', () => {
  const ARCHIVED = {
    archivedAt: '2026-10-01T09:00:00.000Z',
    resetOfWallUuid: 'older-wall',
    replacedByWallUuid: 'new-wall',
    holdsLocked: true,
  };

  it('carries the four fields a payload says, and reads a payload without them as a live wall', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(1), archive: ARCHIVED });
    expect(getSprayWall(LAYOUT_ID)?.archive).toEqual(ARCHIVED);
    expect(sprayWallArchiveState('spray', LAYOUT_ID)).toEqual(ARCHIVED);
    expect(sprayWallIsArchived('spray', LAYOUT_ID)).toBe(true);

    registerSprayWall(LAYOUT_ID + 1, wall(1));
    expect(sprayWallArchiveState('spray', LAYOUT_ID + 1)).toEqual(LIVE_SPRAY_WALL_ARCHIVE_STATE);
    expect(sprayWallIsArchived('spray', LAYOUT_ID + 1)).toBe(false);
  });

  it('answers null for a catalogue board and for a wall not registered yet', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(1), archive: ARCHIVED });
    expect(sprayWallArchiveState('kilter', LAYOUT_ID)).toBeNull();
    expect(sprayWallArchiveState('spray', 999)).toBeNull();
    expect(sprayWallIsArchived('spray', 999)).toBe(false);
  });

  // useSyncExternalStore compares snapshots by identity: a revalidation that
  // says the same thing must hand back the same object, and a real change a new one.
  it('keeps the snapshot identity across a revalidation that says the same thing', () => {
    registerSprayWall(LAYOUT_ID, { ...wall(1), archive: { ...LIVE_SPRAY_WALL_ARCHIVE_STATE, holdsLocked: true } });
    const first = sprayWallArchiveState('spray', LAYOUT_ID);
    registerSprayWall(LAYOUT_ID, { ...wall(1), archive: { ...LIVE_SPRAY_WALL_ARCHIVE_STATE, holdsLocked: true } });
    expect(sprayWallArchiveState('spray', LAYOUT_ID)).toBe(first);
    registerSprayWall(LAYOUT_ID, { ...wall(1), archive: ARCHIVED });
    expect(sprayWallArchiveState('spray', LAYOUT_ID)).not.toBe(first);
    expect(sprayWallArchiveState('spray', LAYOUT_ID)).toEqual(ARCHIVED);
  });

  it('marks a wall archived ahead of the server, waking readers once', () => {
    registerSprayWall(LAYOUT_ID, wall(1));
    let wakes = 0;
    subscribeToSprayWalls(() => {
      wakes += 1;
    });
    markSprayWallArchived(LAYOUT_ID, 'wall-uuid', {
      archivedAt: '2026-10-06T10:00:00.000Z',
      replacedByWallUuid: 'new-wall',
    });
    expect(sprayWallArchiveState('spray', LAYOUT_ID)).toEqual({
      archivedAt: '2026-10-06T10:00:00.000Z',
      resetOfWallUuid: null,
      replacedByWallUuid: 'new-wall',
      holdsLocked: true,
    });
    expect(wakes).toBe(1);
    // A second mark, or a mark for a wall that is not this one, changes nothing.
    markSprayWallArchived(LAYOUT_ID, 'wall-uuid', { archivedAt: '2027-01-01T00:00:00.000Z', replacedByWallUuid: null });
    markSprayWallArchived(LAYOUT_ID, 'another-wall', {
      archivedAt: '2027-01-01T00:00:00.000Z',
      replacedByWallUuid: null,
    });
    expect(sprayWallArchiveState('spray', LAYOUT_ID)?.archivedAt).toBe('2026-10-06T10:00:00.000Z');
    expect(wakes).toBe(1);
  });

  it('finds a registered wall by its uuid', () => {
    registerSprayWall(LAYOUT_ID, wall(1));
    expect(findRegisteredSprayWallByUuid('wall-uuid')?.layoutId).toBe(LAYOUT_ID);
    expect(findRegisteredSprayWallByUuid('nobody')).toBeNull();
  });
});
