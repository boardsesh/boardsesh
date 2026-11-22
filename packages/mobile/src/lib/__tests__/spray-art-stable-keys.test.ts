import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardName } from '@boardsesh/shared-schema';

// The web draft store reads its preferences through AsyncStorage; only its key
// builder is under test, so the store itself is never touched.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    getAllKeys: async () => [],
    removeMany: async () => {},
  },
}));

const registry = await import('../spray/spray-wall-registry');
const { createClimbScreenKey } = await import('../create-climb-screen-key');
const { createClimbDraftKey } = await import('../create-climb-draft-store.web');

const LAYOUT_ID = 5100;
const board = { boardName: 'spray' as BoardName, layoutId: LAYOUT_ID, sizeId: LAYOUT_ID, setIds: String(LAYOUT_ID) };

function registerWall(versionId: number, withArt: boolean, wallUuid = 'wall', layoutId = LAYOUT_ID) {
  registry.registerSprayWall(layoutId, {
    wallUuid,
    angle: 30,
    version: versionId,
    versionId,
    photoWidth: 2000,
    photoHeight: 3000,
    photoUrl: 'https://private.example/photo',
    photoThumbUrl: null,
    photoExpiresAt: 'later',
    holds: [{ id: 1, cx: 10, cy: 10, r: 5 }],
    background: 'wall-crop',
    art: withArt
      ? {
          variant: 'crop',
          versionId,
          version: versionId,
          width: 800,
          height: 1200,
          scale: 0.8,
          url: 'https://private.example/crop',
          expiresAt: 'later',
          holds: [{ id: 1, cx: 8, cy: 8, r: 4 }],
        }
      : null,
  });
}

const keys = (config = board) => ({
  screen: createClimbScreenKey('new', config),
  draft: createClimbDraftKey({ ...config, angle: 30 }),
});

beforeEach(() => registry.clearSprayWallRegistry());

describe('keys for what a climber is editing ignore the drawn picture', () => {
  it('keep the create screen and the web draft slot when a generated look lands', () => {
    registerWall(21, false);
    const before = keys();
    const drawnBefore = registry.sprayCacheToken('spray', LAYOUT_ID);

    registerWall(21, true);

    // The picture did change (the drawing caches move)...
    expect(registry.sprayCacheToken('spray', LAYOUT_ID)).not.toBe(drawnBefore);
    // ...and the editor's identity did not: no remount, no orphaned draft.
    expect(keys()).toEqual(before);
  });

  it('keep the authoring session when more holds are published', () => {
    registerWall(21, false);
    const before = keys();
    const drawnBefore = registry.sprayCacheToken('spray', LAYOUT_ID);
    registerWall(22, false);
    expect(keys()).toEqual(before);
    expect(registry.sprayCacheToken('spray', LAYOUT_ID)).not.toBe(drawnBefore);
  });

  it('move to a separate session when reset creates a replacement wall', () => {
    registerWall(21, false);
    const before = keys();
    const replacementLayout = LAYOUT_ID + 1;
    registerWall(22, false, 'replacement-wall', replacementLayout);
    const replacement = keys({
      ...board,
      layoutId: replacementLayout,
      sizeId: replacementLayout,
      setIds: String(replacementLayout),
    });
    expect(replacement.screen).not.toBe(before.screen);
    expect(replacement.draft).not.toBe(before.draft);
  });
});
