// The one filesystem seam of the cache sweep.
//
// Two things matter here and neither is obvious from the API: a missing
// directory must not throw (`Directory.list()` does), and the walk must hand the
// JS thread back periodically — `Directory.size` looks like the cheap way to do
// this but is a synchronous full recursive walk on both platforms, so it can
// never yield.

import { describe, it, expect, afterEach, vi } from 'vitest';
// Imported by path, not by package name: the `expo-file-system` alias in
// vite.config.ts points at this same file, so this is the same module instance
// cache-dir-io sees — but `tsc` resolves the package name to the real types,
// which know nothing about the seeding helpers.
import { Directory, File, __resetFileSystem, __seedFileSystem } from '../../../test/expo-file-system-stub';
import { deleteCacheDirEntries, resolveImageCacheDirName, walkCacheDir } from '../cache-dir-io';

afterEach(() => {
  __resetFileSystem();
  vi.restoreAllMocks();
});

describe('walkCacheDir', () => {
  it('reports a missing directory as null rather than zero bytes', async () => {
    expect(await walkCacheDir('board-thumbnails')).toBeNull();
  });

  it('returns per-entry size and mtime alongside the total in one pass', async () => {
    __seedFileSystem({
      'cache/board-thumbnails': {
        'a.png': { size: 100, lastModified: 1_000 },
        'b.png': { size: 250, lastModified: 2_000 },
      },
    });
    const walk = await walkCacheDir('board-thumbnails');
    expect(walk?.totalBytes).toBe(350);
    expect(walk?.entries).toEqual([
      { name: 'a.png', sizeBytes: 100, modifiedAtMs: 1_000 },
      { name: 'b.png', sizeBytes: 250, modifiedAtMs: 2_000 },
    ]);
  });

  // `list()` returns `(Directory | File)[]`, and reading `.size` off a Directory
  // is the recursive walk we are avoiding.
  it('skips subdirectories by default and never reads their size', async () => {
    __seedFileSystem({
      'cache/board-thumbnails': { 'a.png': { size: 100, lastModified: 1_000 } },
      'cache/board-thumbnails/nested': { 'b.png': { size: 999, lastModified: 1_000 } },
    });
    const directorySize = vi.spyOn(Directory.prototype, 'list');
    const walk = await walkCacheDir('board-thumbnails');
    expect(walk?.totalBytes).toBe(100);
    expect(walk?.entries.map((entry) => entry.name)).toEqual(['a.png']);
    // One list call: the nested directory was skipped, not descended into.
    expect(directorySize).toHaveBeenCalledTimes(1);
  });

  it('descends when asked — SDWebImage keeps its files one level down', async () => {
    __seedFileSystem({
      'cache/com.hackemist.SDImageCache': {},
      'cache/com.hackemist.SDImageCache/default': {
        'photo-a': { size: 1_000, lastModified: 1 },
        'photo-b': { size: 2_500, lastModified: 1 },
      },
    });
    const walk = await walkCacheDir('com.hackemist.SDImageCache', { recursive: true });
    expect(walk?.totalBytes).toBe(3_500);
  });

  it('yields the JS thread once per chunk instead of blocking on the whole directory', async () => {
    const files: Record<string, { size: number; lastModified: number }> = {};
    for (let index = 0; index < 6; index += 1) files[`entry-${index}.png`] = { size: 1, lastModified: index };
    __seedFileSystem({ 'cache/board-thumbnails': files });

    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    await walkCacheDir('board-thumbnails', { chunkSize: 2 });
    expect(scheduled).toHaveBeenCalledTimes(3);
  });
});

describe('deleteCacheDirEntries', () => {
  it('deletes what it can and keeps going past a name that is already gone', () => {
    __seedFileSystem({
      'cache/board-thumbnails': { 'a.png': { size: 1 }, 'c.png': { size: 1 } },
    });
    expect(deleteCacheDirEntries('board-thumbnails', ['a.png', 'b-vanished.png', 'c.png'])).toEqual(['a.png', 'c.png']);
    expect(new Directory('cache/board-thumbnails').list()).toHaveLength(0);
  });

  // The names rather than a count, because the callers turn this into freed
  // BYTES: a file that survived the pass is still occupying its space.
  it('leaves a file it could not delete out of the result', () => {
    __seedFileSystem({
      'cache/board-thumbnails': { 'a.png': { size: 1 }, 'locked.png': { size: 1 }, 'c.png': { size: 1 } },
    });
    vi.spyOn(File.prototype, 'delete').mockImplementation(function refuseOne(this: File) {
      if (this.name === 'locked.png') throw new Error('EPERM: operation not permitted');
    });
    expect(deleteCacheDirEntries('board-thumbnails', ['a.png', 'locked.png', 'c.png'])).toEqual(['a.png', 'c.png']);
  });
});

describe('resolveImageCacheDirName', () => {
  it('is null when neither known cache directory is on this device', () => {
    expect(resolveImageCacheDirName()).toBeNull();
  });

  it('finds SDWebImage on iOS', () => {
    __seedFileSystem({ 'cache/com.hackemist.SDImageCache': {} });
    expect(resolveImageCacheDirName()).toBe('com.hackemist.SDImageCache');
  });

  it('finds Glide on Android', () => {
    __seedFileSystem({ 'cache/image_manager_disk_cache': {} });
    expect(resolveImageCacheDirName()).toBe('image_manager_disk_cache');
  });
});
