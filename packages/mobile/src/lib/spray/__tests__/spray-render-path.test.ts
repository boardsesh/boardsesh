import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as preferenceStore from '../../preference-store';
import { clearBoardArtGeometryCache } from '@boardsesh/board-art-geometry';
import { clearBoardRenderDataCache, getBoardAspectRatio, getBoardRenderData } from '../../board-details';
import { clearCreateBoardHoldsCache, getCreateBoardHolds } from '../../create-board-holds';
import { createClimbDraftKey } from '../../create-climb-draft-store';
import { createClimbScreenKey } from '../../create-climb-screen-key';
import { planSprayPhotoSweep, SPRAY_PHOTO_MAX_AGE_MS } from '../../cache-sweep-plan';
import { parseSprayBackgroundKey, sprayBackgroundKey, sprayPhotoFileName } from '../spray-photo-keys';
import { clearSprayWallRegistry, registerSprayWall } from '../spray-wall-registry';
import {
  _clearRenderBoardTargetCacheForTests,
  getPlaylistRenderBoardTarget,
} from '../../playlists/playlist-climb-render-board';
import { overlayRetainIdentity } from '../../overlay-retain-identity';
import { clearSupersededSprayDrafts } from '../../create-climb-draft-store';
import type { SprayPhotoHold } from '../spray-hold-geometry';

const LAYOUT_ID = 4200;
const SIZE_ID = LAYOUT_ID;

const HOLDS: SprayPhotoHold[] = [
  { id: 7, cx: 100, cy: 200, r: 18, outline: [1, 0, 0, 1, -1, 0] },
  { id: 8, cx: 400, cy: 900, r: 22 },
];

function registerWall(version: number, holds: SprayPhotoHold[] = HOLDS) {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-uuid',
    version,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: `https://private.example/photo?sig=${version}`,
    photoThumbUrl: null,
    photoExpiresAt: '2026-09-15T12:15:00.000Z',
    holds,
  });
}

const SPRAY_CONFIG = { boardName: 'spray' as const, layoutId: LAYOUT_ID, sizeId: SIZE_ID, setIds: [1] };

beforeEach(() => {
  clearSprayWallRegistry();
  clearBoardRenderDataCache();
  clearCreateBoardHoldsCache();
  clearBoardArtGeometryCache();
  _clearRenderBoardTargetCacheForTests();
});

afterEach(() => {
  clearSprayWallRegistry();
  clearBoardRenderDataCache();
  clearCreateBoardHoldsCache();
  clearBoardArtGeometryCache();
  _clearRenderBoardTargetCacheForTests();
});

describe('getBoardRenderData — spray branch', () => {
  it('reports no board until the wall is registered', () => {
    expect(getBoardRenderData(SPRAY_CONFIG)).toBeNull();
  });

  it('draws the photo at its own pixel size, edges spanning all of it', () => {
    registerWall(1);
    expect(getBoardRenderData(SPRAY_CONFIG)).toMatchObject({
      boardWidth: 1200,
      boardHeight: 1600,
      edgeLeft: 0,
      edgeRight: 1200,
      edgeBottom: 0,
      edgeTop: 1600,
      backgroundImageKeys: [sprayBackgroundKey(LAYOUT_ID, 1)],
    });
  });

  it('carries the wall holds through unmirrored', () => {
    registerWall(1);
    expect(getBoardRenderData(SPRAY_CONFIG)?.holdsData).toEqual([
      { id: 7, mirroredHoldId: null, cx: 100, cy: 200, r: 18 },
      { id: 8, mirroredHoldId: null, cx: 400, cy: 900, r: 22 },
    ]);
  });

  it('refuses a size id that is not the layout id', () => {
    registerWall(1);
    expect(getBoardRenderData({ ...SPRAY_CONFIG, sizeId: SIZE_ID + 1 })).toBeNull();
  });

  it('refuses a photo with no usable dimensions', () => {
    registerSprayWall(LAYOUT_ID, {
      wallUuid: 'wall-uuid',
      version: 1,
      photoWidth: 0,
      photoHeight: 0,
      photoUrl: 'https://private.example/photo',
      photoThumbUrl: null,
      photoExpiresAt: '2026-09-15T12:15:00.000Z',
      holds: HOLDS,
    });
    expect(getBoardRenderData(SPRAY_CONFIG)).toBeNull();
  });

  it('takes its aspect ratio off the photo', () => {
    registerWall(1);
    expect(getBoardAspectRatio(SPRAY_CONFIG)).toBeCloseTo(1200 / 1600, 10);
  });
});

describe('getCreateBoardHolds — spray family', () => {
  it('reports the spray family and every alive hold as a target', () => {
    registerWall(1);
    const holds = getCreateBoardHolds(SPRAY_CONFIG);
    expect(holds?.family).toBe('spray');
    expect(holds?.holdTargets).toEqual([
      { id: 7, cx: 100, cy: 200, r: 18 },
      { id: 8, cx: 400, cy: 900, r: 22 },
    ]);
    expect(holds).toMatchObject({ boardWidth: 1200, boardHeight: 1600, edgeLeft: 0, edgeRight: 1200 });
  });

  it('never offers a hold that came off in a reset', () => {
    registerWall(1, HOLDS);
    expect(getCreateBoardHolds(SPRAY_CONFIG)?.holdTargets.map((hold) => hold.id)).toEqual([7, 8]);

    // Version 2 took hold 7 off the wall. `sprayWallRenderData` returns the
    // generation alive AT the version, so the registry never sees it again.
    registerWall(2, [HOLDS[1]]);
    expect(getCreateBoardHolds(SPRAY_CONFIG)?.holdTargets.map((hold) => hold.id)).toEqual([8]);
  });
});

/**
 * The load-bearing acceptance item: the wall version is in EVERY spray cache key.
 *
 * Each case registers version 1, takes the key, registers version 2 WITHOUT
 * clearing the memo, and asserts the key moved. Remove the version from the key
 * under test and its case fails — that is the mutation test.
 */
describe('the wall version is in every spray cache key', () => {
  it('render-data memo: a reset is not served the previous generation', () => {
    registerWall(1, [HOLDS[0]]);
    expect(getBoardRenderData(SPRAY_CONFIG)?.holdsData.map((hold) => hold.id)).toEqual([7]);

    // Deliberately NOT clearing `renderDataCache`: this is exactly the state a
    // running app is in when a refetch lands.
    registerWall(2, [HOLDS[1]]);
    expect(getBoardRenderData(SPRAY_CONFIG)?.holdsData.map((hold) => hold.id)).toEqual([8]);
  });

  it('render-data memo: the background key follows the version', () => {
    registerWall(1);
    expect(getBoardRenderData(SPRAY_CONFIG)?.backgroundImageKeys).toEqual([sprayBackgroundKey(LAYOUT_ID, 1)]);
    registerWall(2);
    expect(getBoardRenderData(SPRAY_CONFIG)?.backgroundImageKeys).toEqual([sprayBackgroundKey(LAYOUT_ID, 2)]);
  });

  it('hold-target memo: a reset is not served the previous generation', () => {
    registerWall(1, [HOLDS[0]]);
    expect(getCreateBoardHolds(SPRAY_CONFIG)?.holdTargets.map((hold) => hold.id)).toEqual([7]);
    registerWall(2, [HOLDS[1]]);
    expect(getCreateBoardHolds(SPRAY_CONFIG)?.holdTargets.map((hold) => hold.id)).toEqual([8]);
  });

  it('playlist render-board target: the compatibility check sees the live holds', () => {
    const renderBoard = {
      boardName: 'spray',
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: '1',
      angle: 40,
    };
    registerWall(1, [HOLDS[0]]);
    expect([...(getPlaylistRenderBoardTarget(renderBoard).holdsData ?? [])].map((hold) => hold.id)).toEqual([7]);

    // The target cache holds `holdsData`, which `canAddClimbToBoard` reads. Keyed
    // without the version it would keep matching climbs against hold 7 after the
    // reset that took it off the wall.
    registerWall(2, [HOLDS[1]]);
    expect([...(getPlaylistRenderBoardTarget(renderBoard).holdsData ?? [])].map((hold) => hold.id)).toEqual([8]);
  });

  it('playlist render-board target: a row resolved before the wall landed is not pinned empty', () => {
    const renderBoard = {
      boardName: 'spray',
      layoutId: LAYOUT_ID,
      sizeId: SIZE_ID,
      setIds: '1',
      angle: 40,
    };
    // Nothing registered: no render data, so no holds. A key without the version
    // would memoise this `undefined` for the rest of the session.
    expect(getPlaylistRenderBoardTarget(renderBoard).holdsData).toBeUndefined();

    registerWall(1);
    expect(getPlaylistRenderBoardTarget(renderBoard).holdsData).toHaveLength(2);
  });

  it('create-climb draft slot', () => {
    const draftConfig = { boardName: 'spray', layoutId: LAYOUT_ID, sizeId: SIZE_ID, setIds: '1', angle: 40 };
    registerWall(1);
    const atVersion1 = createClimbDraftKey(draftConfig);
    registerWall(2);
    expect(createClimbDraftKey(draftConfig)).not.toBe(atVersion1);
  });

  it('create-climb screen key', () => {
    const board = { boardName: 'spray' as const, layoutId: LAYOUT_ID, sizeId: SIZE_ID, setIds: '1' };
    registerWall(1);
    const atVersion1 = createClimbScreenKey('new', board);
    registerWall(2);
    expect(createClimbScreenKey('new', board)).not.toBe(atVersion1);
  });

  it('leaves a catalogue board\u2019s keys byte-identical', () => {
    const kilterDraft = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
    expect(createClimbDraftKey(kilterDraft)).toBe('kilter:1:10:1,2:40');
    expect(createClimbScreenKey('new', { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' })).toBe(
      'new:kilter:1:10:1,2',
    );
  });

  it('overlay retain identity: a reset does not bridge with the superseded overlay', () => {
    registerWall(1);
    const atVersion1 = overlayRetainIdentity('spray', LAYOUT_ID, SIZE_ID, '1');
    registerWall(2);
    expect(overlayRetainIdentity('spray', LAYOUT_ID, SIZE_ID, '1')).not.toBe(atVersion1);
    // Catalogue boards keep the identity they have always bridged on.
    expect(overlayRetainIdentity('kilter', 1, 10, '24,25')).toBe('kilter-1-10-24,25');
  });

  it('photo file name: two generations are two different files', () => {
    expect(sprayPhotoFileName({ layoutId: LAYOUT_ID, version: 1 })).not.toBe(
      sprayPhotoFileName({ layoutId: LAYOUT_ID, version: 2 }),
    );
  });
});

describe('spray background keys', () => {
  it('round-trips', () => {
    expect(parseSprayBackgroundKey(sprayBackgroundKey(4200, 3))).toEqual({ layoutId: 4200, version: 3 });
  });

  it('never claims a bundled board key', () => {
    expect(parseSprayBackgroundKey('kilter/product_sizes_layouts_sets/36-1.webp')).toBeNull();
    expect(parseSprayBackgroundKey('woods/woods12x12.webp')).toBeNull();
    expect(parseSprayBackgroundKey('spray/4200/3.webp')).toBeNull();
  });
});

describe('planSprayPhotoSweep', () => {
  const NOW = 1_800_000_000_000;

  it('reaps a photo nothing is using any more', () => {
    const plan = planSprayPhotoSweep({
      entries: [{ name: '4200-1.jpg', sizeBytes: 900, modifiedAtMs: NOW - SPRAY_PHOTO_MAX_AGE_MS - 1 }],
      nowMs: NOW,
      maxAgeMs: SPRAY_PHOTO_MAX_AGE_MS,
      protectedNames: new Set(),
    });
    expect(plan).toEqual({ deleteNames: ['4200-1.jpg'], freedBytes: 900 });
  });

  it('never deletes the photo of a wall on screen, however old the file is', () => {
    const plan = planSprayPhotoSweep({
      entries: [{ name: '4200-1.jpg', sizeBytes: 900, modifiedAtMs: 0 }],
      nowMs: NOW,
      maxAgeMs: 0,
      protectedNames: new Set(['4200-1.jpg']),
    });
    expect(plan.deleteNames).toEqual([]);
  });

  it('reaps the generation a reset superseded while keeping the live one', () => {
    const plan = planSprayPhotoSweep({
      entries: [
        { name: '4200-1.jpg', sizeBytes: 900, modifiedAtMs: 0 },
        { name: '4200-2.jpg', sizeBytes: 900, modifiedAtMs: 0 },
      ],
      nowMs: NOW,
      maxAgeMs: 0,
      protectedNames: new Set(['4200-2.jpg']),
    });
    expect(plan.deleteNames).toEqual(['4200-1.jpg']);
  });

  it('leaves an undateable entry alone', () => {
    const plan = planSprayPhotoSweep({
      entries: [{ name: '4200-1.jpg', sizeBytes: 900, modifiedAtMs: null }],
      nowMs: NOW,
      maxAgeMs: 0,
      protectedNames: new Set(),
    });
    expect(plan.deleteNames).toEqual([]);
  });

  it('keeps a fresh photo', () => {
    const plan = planSprayPhotoSweep({
      entries: [{ name: '4200-1.jpg', sizeBytes: 900, modifiedAtMs: NOW - 1000 }],
      nowMs: NOW,
      maxAgeMs: SPRAY_PHOTO_MAX_AGE_MS,
      protectedNames: new Set(),
    });
    expect(plan.deleteNames).toEqual([]);
  });
});

describe('clearSupersededSprayDrafts', () => {
  it('drops the wall\u2019s older slots and nothing else', async () => {
    const removed: string[] = [];
    const keys = [
      'boardsesh_create_climb_draft:spray:4200:4200-sv1:1:40',
      'boardsesh_create_climb_draft:spray:4200:4200-sv2:1:40',
      // Another wall, and a catalogue board. Neither is this wall's business.
      'boardsesh_create_climb_draft:spray:4201:4201-sv1:1:40',
      'boardsesh_create_climb_draft:kilter:1:10:24,25:40',
    ];
    vi.spyOn(preferenceStore, 'removePreferencesMatching').mockImplementation(async (matches) => {
      removed.push(...keys.filter(matches));
    });

    await clearSupersededSprayDrafts(LAYOUT_ID, '-sv2');

    expect(removed).toEqual(['boardsesh_create_climb_draft:spray:4200:4200-sv1:1:40']);
  });
});
