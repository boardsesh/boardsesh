import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `expo-file-system` has no Vitest build, so the whole filesystem seam is a mock.
// What that leaves testable is exactly the part worth testing: the download is
// staged under `.part` and moved into place, concurrent asks share one transfer,
// the handle is retained across the transfer (issue #5297), an expired signature
// wakes the query instead of fetching, and nothing half-written is ever handed to
// the decoder.

const fsState = vi.hoisted(() => ({
  files: new Map<string, { exists: boolean }>(),
  directoryCreated: 0,
  downloads: [] as { url: string; destination: string }[],
  downloadResult: 'resolve' as 'resolve' | 'reject' | 'null-file' | 'hang',
  pendingResolvers: [] as (() => void)[],
}));

const retained = vi.hoisted(() => ({ retain: 0, release: 0 }));
vi.mock('../../../offline/download-task-retention', () => ({
  retainDownloadTask: () => {
    retained.retain += 1;
  },
  releaseDownloadTaskAfterNativeCompletion: () => {
    retained.release += 1;
  },
}));

vi.mock('expo-file-system', () => {
  class MockDirectory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
    get exists() {
      return true;
    }
    create() {
      fsState.directoryCreated += 1;
    }
  }
  class MockFileImpl {
    uri: string;
    name: string;
    constructor(parent: { uri: string } | string, name?: string) {
      const base = typeof parent === 'string' ? parent : parent.uri;
      this.name = name ?? base;
      this.uri = `file://${base}/${this.name}`;
    }
    get exists() {
      return fsState.files.get(this.uri)?.exists ?? false;
    }
    delete() {
      fsState.files.delete(this.uri);
    }
    moveSync(destination: MockFileImpl) {
      if (!this.exists) throw new Error('ENOENT');
      fsState.files.delete(this.uri);
      fsState.files.set(destination.uri, { exists: true });
    }
    static createDownloadTask(url: string, destination: MockFileImpl) {
      fsState.downloads.push({ url, destination: destination.uri });
      return {
        downloadAsync: () =>
          new Promise<MockFileImpl | null>((resolve, reject) => {
            const settle = () => {
              if (fsState.downloadResult === 'reject') return reject(new Error('403'));
              if (fsState.downloadResult === 'null-file') return resolve(null);
              fsState.files.set(destination.uri, { exists: true });
              resolve(destination);
            };
            if (fsState.downloadResult === 'hang') fsState.pendingResolvers.push(settle);
            else settle();
          }),
      };
    }
  }
  return { Directory: MockDirectory, File: MockFileImpl, Paths: { cache: { uri: '/cache' } } };
});

const { clearSprayWallRegistry, registerSprayWall } = await import('../spray-wall-registry');
const registry = await import('../spray-wall-registry');
const { ensureSprayPhotoCached, resetSprayPhotoCacheForTests, tryGetSprayPhotoPathSync } =
  await import('../spray-photo-cache');
const { sprayPartialPhotoFileName, sprayPhotoFileName } = await import('../spray-photo-keys');

const LAYOUT_ID = 4200;
const IDENTITY = { layoutId: LAYOUT_ID, version: 1 };
const FINAL_URI = `file:///cache/spray-walls/${sprayPhotoFileName(IDENTITY)}`;
const PART_URI = `file:///cache/spray-walls/${sprayPartialPhotoFileName(IDENTITY)}`;

const FUTURE = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

function registerWall(expiresAt: string) {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-uuid',
    version: 1,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'https://private.example/photo?sig=1',
    photoThumbUrl: null,
    photoExpiresAt: expiresAt,
    holds: [{ id: 7, cx: 1, cy: 2, r: 3 }],
  });
}

beforeEach(() => {
  clearSprayWallRegistry();
  resetSprayPhotoCacheForTests();
  fsState.files.clear();
  fsState.directoryCreated = 0;
  fsState.downloads = [];
  fsState.downloadResult = 'resolve';
  fsState.pendingResolvers = [];
  retained.retain = 0;
  retained.release = 0;
});

afterEach(() => {
  clearSprayWallRegistry();
  resetSprayPhotoCacheForTests();
});

describe('ensureSprayPhotoCached', () => {
  it('stages under .part and moves the finished file into place', async () => {
    registerWall(FUTURE);

    const path = await ensureSprayPhotoCached(IDENTITY);

    expect(fsState.downloads).toEqual([{ url: 'https://private.example/photo?sig=1', destination: PART_URI }]);
    expect(path).toBe(FINAL_URI.replace('file://', ''));
    expect(fsState.files.has(FINAL_URI)).toBe(true);
    expect(fsState.files.has(PART_URI)).toBe(false);
  });

  it('creates the cache directory before writing', async () => {
    registerWall(FUTURE);
    await ensureSprayPhotoCached(IDENTITY);
    expect(fsState.directoryCreated).toBeGreaterThan(0);
  });

  it('retains the download handle across the transfer and releases it after', async () => {
    registerWall(FUTURE);
    await ensureSprayPhotoCached(IDENTITY);
    // Issue #5297: nothing may let iOS collect the task handle inside the
    // delegate window.
    expect(retained.retain).toBe(1);
    expect(retained.release).toBe(1);
  });

  it('shares one transfer between concurrent askers', async () => {
    registerWall(FUTURE);
    fsState.downloadResult = 'hang';

    const first = ensureSprayPhotoCached(IDENTITY);
    const second = ensureSprayPhotoCached(IDENTITY);
    const third = ensureSprayPhotoCached(IDENTITY);
    expect(fsState.downloads).toHaveLength(1);

    fsState.downloadResult = 'resolve';
    for (const settle of fsState.pendingResolvers) settle();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      FINAL_URI.replace('file://', ''),
      FINAL_URI.replace('file://', ''),
      FINAL_URI.replace('file://', ''),
    ]);
  });

  it('leaves nothing half-written behind when the transfer fails', async () => {
    registerWall(FUTURE);
    fsState.downloadResult = 'reject';

    await expect(ensureSprayPhotoCached(IDENTITY)).resolves.toBeNull();

    expect(fsState.files.has(PART_URI)).toBe(false);
    expect(fsState.files.has(FINAL_URI)).toBe(false);
  });

  it('treats a paused transfer as a failure rather than moving a file nobody wrote', async () => {
    registerWall(FUTURE);
    fsState.downloadResult = 'null-file';

    await expect(ensureSprayPhotoCached(IDENTITY)).resolves.toBeNull();
    expect(fsState.files.has(FINAL_URI)).toBe(false);
  });

  it('never fetches with an expired signature, and asks for a fresh payload', async () => {
    const refresh = vi.spyOn(registry, 'refreshSprayWall');
    registerWall(PAST);

    await expect(ensureSprayPhotoCached(IDENTITY)).resolves.toBeNull();

    expect(fsState.downloads).toHaveLength(0);
    expect(refresh).toHaveBeenCalledWith(LAYOUT_ID);
    refresh.mockRestore();
  });

  it('does not fetch for a wall the registry does not hold', async () => {
    await expect(ensureSprayPhotoCached(IDENTITY)).resolves.toBeNull();
    expect(fsState.downloads).toHaveLength(0);
  });

  it('does not fetch when the version asked for is not the one registered', async () => {
    registerWall(FUTURE);
    await expect(ensureSprayPhotoCached({ layoutId: LAYOUT_ID, version: 2 })).resolves.toBeNull();
    expect(fsState.downloads).toHaveLength(0);
  });

  it('answers straight from disk without a transfer once the photo is there', async () => {
    registerWall(FUTURE);
    fsState.files.set(FINAL_URI, { exists: true });

    expect(tryGetSprayPhotoPathSync(IDENTITY)).toBe(FINAL_URI.replace('file://', ''));
    await ensureSprayPhotoCached(IDENTITY);
    expect(fsState.downloads).toHaveLength(0);
  });
});
