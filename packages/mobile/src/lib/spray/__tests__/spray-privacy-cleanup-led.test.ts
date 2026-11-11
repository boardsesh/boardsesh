import { beforeEach, describe, expect, it, vi } from 'vitest';

const led = vi.hoisted(() => ({ recheck: vi.fn(), eraseAll: vi.fn(async () => undefined) }));
vi.mock('expo-file-system', () => {
  class Directory {
    exists = false;
    list() {
      return [];
    }
    delete() {}
  }
  return { Directory, File: class {}, Paths: { cache: { uri: 'file:///cache' } } };
});
vi.mock('../../../offline/download-task-retention', () => ({
  retainDownloadTask: vi.fn(),
  releaseDownloadTaskAfterNativeCompletion: vi.fn(),
}));
vi.mock('../spray-wall-led-sync', () => ({ recheckSprayWallLedAccess: led.recheck }));
vi.mock('../spray-wall-led-cache', () => ({ eraseAllSprayWallLedCaches: led.eraseAll }));

// Its own file: the other cleanup tests reset the registry, which drops the
// subscription this module makes when it loads.
const { clearSprayWallPrivateCaches } = await import('../spray-privacy-cleanup');
const { registerSprayWall } = await import('../spray-wall-registry');

function seedWall(layoutId: number) {
  registerSprayWall(layoutId, {
    wallUuid: `wall-${layoutId}`,
    angle: 40,
    version: 1,
    versionId: 1,
    photoWidth: 10,
    photoHeight: 10,
    photoUrl: 'https://private.example/photo',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01',
    holds: [],
  });
}

beforeEach(() => {
  led.recheck.mockClear();
  led.eraseAll.mockClear();
});

describe('a withdrawn wall’s LED setup', () => {
  it('asks the server about one wall instead of erasing its setup', () => {
    seedWall(42);
    clearSprayWallPrivateCaches(42);
    expect(led.recheck).toHaveBeenCalledWith('wall-42');
    expect(led.eraseAll).not.toHaveBeenCalled();
  });

  it('erases every setup when all walls are withdrawn', () => {
    seedWall(43);
    clearSprayWallPrivateCaches();
    expect(led.eraseAll).toHaveBeenCalledOnce();
    expect(led.recheck).not.toHaveBeenCalled();
  });
});
