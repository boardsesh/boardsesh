import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDENTITY_HOMOGRAPHY } from '@boardsesh/spray-wall-geometry';

const fixture = vi.hoisted(() => ({
  userId: 'viewer' as string | undefined,
  storedPath: '/photos/wall.jpg' as string | null,
  viewerGeneration: 1,
  removalGeneration: 1,
  read: vi.fn(),
  register: vi.fn(),
  getSize: vi.fn(),
  previous: null as unknown,
  artOnDisk: true,
}));
vi.mock('react-native', () => ({ Image: { getSize: fixture.getSize } }));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => ({}) }));
vi.mock('../../../db/queries/get-spray-wall-local', () => ({ getSprayWallLocal: fixture.read }));
vi.mock('../../local-user-id', () => ({ readLocalUserId: async () => fixture.userId }));
vi.mock('../spray-photo-store', () => ({ tryGetStoredSprayPhotoPathSync: () => fixture.storedPath }));
vi.mock('../spray-photo-cache', () => ({
  tryGetSprayPhotoPathSync: () => (fixture.artOnDisk ? '/cache/4-v21-crop.jpg' : null),
}));
vi.mock('../spray-wall-registry', () => ({
  getSprayWall: () => fixture.previous,
  registerSprayWall: fixture.register,
  sprayWallViewerGeneration: () => fixture.viewerGeneration,
  sprayWallRemovalGeneration: () => fixture.removalGeneration,
}));
import { loadLocalSprayWall } from '../spray-wall-local-loader';

const PHOTO_ID = '00000000-0000-4000-8000-000000000001';
const wall = {
  layoutId: 4,
  boardUuid: 'wall',
  name: 'Wall',
  referenceWidth: 800,
  referenceHeight: 600,
  version: 2,
  photoKey: `spray-walls/wall/${PHOTO_ID}.jpg`,
  homography: [...IDENTITY_HOMOGRAPHY],
  holds: [{ id: 1, cx: 100, cy: 150, r: 20, outline: null }],
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.userId = 'viewer';
  fixture.storedPath = '/photos/wall.jpg';
  fixture.viewerGeneration = 1;
  fixture.removalGeneration = 1;
  fixture.previous = null;
  fixture.artOnDisk = true;
  fixture.read.mockResolvedValue(wall);
  fixture.getSize.mockImplementation((_uri: string, success: (width: number, height: number) => void) =>
    success(1200, 900),
  );
});

describe('offline published wall hydration', () => {
  it('uses decoded photo pixels, immutable local identity and read-only permissions', async () => {
    expect(await loadLocalSprayWall(4, 1, 1)).toBe(true);
    expect(fixture.getSize).toHaveBeenCalledWith('file:///photos/wall.jpg', expect.any(Function), expect.any(Function));
    expect(fixture.register).toHaveBeenCalledWith(
      4,
      expect.objectContaining({
        versionId: `local-${PHOTO_ID}-2`,
        photoWidth: 1200,
        photoHeight: 900,
        localPhotoPath: '/photos/wall.jpg',
        viewerAccess: { canEdit: false, generation: 1 },
        holds: [expect.objectContaining({ cx: 100, cy: 150 })],
      }),
    );
  });

  it('projects holds through photo-to-canonical homography', async () => {
    fixture.read.mockResolvedValue({ ...wall, homography: [2, 0, 0, 0, 2, 0, 0, 0, 1] });
    expect(await loadLocalSprayWall(4, 1, 1)).toBe(true);
    expect(fixture.register).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ holds: [expect.objectContaining({ cx: 50, cy: 75, r: 10 })] }),
    );
  });

  it.each([{ version: null }, { homography: null }, { photoKey: null }])(
    'refuses incomplete unpublished/draft setup %s',
    async (missing) => {
      fixture.read.mockResolvedValue({ ...wall, ...missing });
      expect(await loadLocalSprayWall(4, 1, 1)).toBe(false);
      expect(fixture.register).not.toHaveBeenCalled();
    },
  );

  it('refuses a missing durable photo', async () => {
    fixture.storedPath = null;
    expect(await loadLocalSprayWall(4, 1, 1)).toBe(false);
    expect(fixture.getSize).not.toHaveBeenCalled();
  });

  it('refuses missing owner identity or an owner-gated missing row', async () => {
    fixture.userId = undefined;
    expect(await loadLocalSprayWall(4, 1, 1)).toBe(false);
    fixture.userId = 'viewer';
    fixture.read.mockResolvedValue(null);
    expect(await loadLocalSprayWall(4, 1, 1)).toBe(false);
    expect(fixture.register).not.toHaveBeenCalled();
  });

  it.each(['viewer', 'removal', 'owner'] as const)(
    'never resurrects private geometry after %s changes during image decoding',
    async (change) => {
      let finish: ((width: number, height: number) => void) | undefined;
      fixture.getSize.mockImplementation((_uri: string, success: (width: number, height: number) => void) => {
        finish = success;
      });
      const loading = loadLocalSprayWall(4, 1, 1);
      await vi.waitFor(() => expect(finish).toBeDefined());
      if (change === 'viewer') fixture.viewerGeneration++;
      if (change === 'removal') fixture.removalGeneration++;
      if (change === 'owner') fixture.userId = 'another';
      finish?.(1200, 900);
      expect(await loading).toBe(false);
      expect(fixture.register).not.toHaveBeenCalled();
    },
  );

  it('refuses a mirror replaced while decoding its old photo', async () => {
    fixture.read.mockResolvedValueOnce(wall).mockResolvedValueOnce({ ...wall, version: 3 });
    expect(await loadLocalSprayWall(4, 1, 1)).toBe(false);
    expect(fixture.register).not.toHaveBeenCalled();
  });
});

describe('a generated look survives going offline', () => {
  const art = {
    variant: 'crop',
    versionId: 21,
    version: 2,
    width: 800,
    height: 600,
    scale: 1,
    url: 'https://private.example/crop',
    expiresAt: 'later',
    holds: [],
  };

  it('keeps the art the online wall drew for the same published version', async () => {
    fixture.previous = { wallUuid: 'wall', version: 2, versionId: 21, art };
    expect(await loadLocalSprayWall(4, 1, 1)).toBe(true);
    expect(fixture.register).toHaveBeenCalledWith(4, expect.objectContaining({ art }));
  });

  it.each([
    ['another version', { wallUuid: 'wall', art: { ...art, version: 1 } }, true],
    ['another wall', { wallUuid: 'other', art }, true],
    ['a file no longer on disk', { wallUuid: 'wall', art }, false],
  ])('drops it for %s', async (_label, previous, onDisk) => {
    fixture.previous = previous;
    fixture.artOnDisk = onDisk;
    expect(await loadLocalSprayWall(4, 1, 1)).toBe(true);
    expect(fixture.register).toHaveBeenCalledWith(4, expect.objectContaining({ art: null }));
  });
});
