import { beforeEach, describe, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => ({ names: new Set<string>(), failDelete: new Set<string>() }));
vi.mock('expo-file-system', () => {
  class Directory {
    uri: string;
    constructor(base: { uri: string }, name: string) {
      this.uri = `${base.uri}/${name}`;
    }
    get exists() {
      return [...disk.names].some((name) => name.startsWith(`${this.uri}/`));
    }
    list() {
      return [...disk.names]
        .filter((name) => name.startsWith(`${this.uri}/`))
        .map((uri) => ({
          name: uri.slice(this.uri.length + 1),
          uri,
          delete() {
            if (disk.failDelete.has(uri)) throw new Error('synthetic filesystem error');
            disk.names.delete(uri);
          },
        }));
    }
    delete() {
      for (const entry of this.list()) entry.delete();
    }
  }
  return { Directory, File: class {}, Paths: { cache: { uri: 'file:///cache' } } };
});
vi.mock('../../../offline/download-task-retention', () => ({
  retainDownloadTask: vi.fn(),
  releaseDownloadTaskAfterNativeCompletion: vi.fn(),
}));

const { clearSprayWallPrivateCaches } = await import('../spray-privacy-cleanup');
const { cacheRenderedOverlay, getRenderedOverlay, clearOverlayIndex } = await import('../../overlay-index');
const {
  registerSprayWall,
  getSprayWall,
  ensureSprayWallLoaded,
  setSprayWallLoader,
  subscribeToSprayWalls,
  clearSprayWallRegistry,
} = await import('../spray-wall-registry');
const { sprayPrivacyGeneration } = await import('../spray-privacy-generation');

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
const overlay = (board: string, layout: number) => `v1_f_w400_${board}_${layout}_${layout}_1_hash`;
beforeEach(() => {
  disk.names.clear();
  disk.failDelete.clear();
  clearSprayWallRegistry();
  clearOverlayIndex();
});

describe('spray privacy cache withdrawal', () => {
  it('removes one wall’s versions and legacy overlays, preserving another wall and catalogue art', () => {
    seedWall(42);
    seedWall(43);
    // One legacy version-number name beside the version-id names in use now.
    for (const name of ['42-1.jpg', '42-v2.jpg', '43-v1.jpg']) disk.names.add(`file:///cache/spray-walls/${name}`);
    for (const key of [overlay('spray', 42), overlay('spray', 43), overlay('kilter', 42)]) {
      const uri = `file:///cache/board-thumbnails/${key}.png`;
      disk.names.add(uri);
      cacheRenderedOverlay(key, uri);
    }
    clearSprayWallPrivateCaches(42);
    expect(getSprayWall(42)).toBeNull();
    expect(getSprayWall(43)).not.toBeNull();
    expect(getRenderedOverlay(overlay('spray', 42))).toBeUndefined();
    expect(getRenderedOverlay(overlay('spray', 43))).toBeDefined();
    expect(getRenderedOverlay(overlay('kilter', 42))).toBeDefined();
    expect([...disk.names].sort()).toEqual(
      [
        `file:///cache/board-thumbnails/${overlay('kilter', 42)}.png`,
        `file:///cache/board-thumbnails/${overlay('spray', 43)}.png`,
        'file:///cache/spray-walls/43-v1.jpg',
      ].sort(),
    );
  });

  it('sign-out clears spray files and registrations without erasing catalogue art or loader/subscribers', async () => {
    seedWall(42);
    const loader = vi.fn(async () => {});
    setSprayWallLoader(loader);
    const subscriber = vi.fn();
    subscribeToSprayWalls(subscriber);
    disk.names.add('file:///cache/spray-walls/42-1.jpg');
    for (const board of ['spray', 'kilter']) {
      const key = overlay(board, 42);
      const uri = `file:///cache/board-thumbnails/${key}.png`;
      disk.names.add(uri);
      cacheRenderedOverlay(key, uri);
    }
    const oldGeneration = sprayPrivacyGeneration(42);
    clearSprayWallPrivateCaches();
    expect(sprayPrivacyGeneration(42)).not.toBe(oldGeneration);
    expect(getSprayWall(42)).toBeNull();
    expect(subscriber).toHaveBeenCalled();
    ensureSprayWallLoaded(43);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledWith(43);
    expect([...disk.names]).toEqual([`file:///cache/board-thumbnails/${overlay('kilter', 42)}.png`]);
    expect(getRenderedOverlay(overlay('kilter', 42))).toBeDefined();
  });

  it('continues invalidating memory and cleaning other overlays after one file cannot be removed', () => {
    for (const layout of [42, 43]) {
      const key = overlay('spray', layout);
      const uri = `file:///cache/board-thumbnails/${key}.png`;
      disk.names.add(uri);
      cacheRenderedOverlay(key, uri);
      if (layout === 42) disk.failDelete.add(uri);
    }
    expect(() => clearSprayWallPrivateCaches()).not.toThrow();
    expect(getRenderedOverlay(overlay('spray', 42))).toBeUndefined();
    expect(getRenderedOverlay(overlay('spray', 43))).toBeUndefined();
    expect(disk.names.size).toBe(1);
  });
});
