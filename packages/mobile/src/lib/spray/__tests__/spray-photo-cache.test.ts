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
    delete() {
      for (const uri of fsState.files.keys()) if (uri.startsWith(`file://${this.uri}/`)) fsState.files.delete(uri);
    }
    list() {
      return [...fsState.files.keys()]
        .filter((uri) => uri.startsWith(`file://${this.uri}/`))
        .map((uri) => ({
          name: uri.slice(`file://${this.uri}/`.length),
          delete: () => fsState.files.delete(uri),
        }));
    }
  }
  class MockFileImpl {
    uri: string;
    name: string;
    constructor(parent: { uri: string } | string, name?: string) {
      const base = typeof parent === 'string' ? parent : parent.uri;
      this.name = name ?? base;
      this.uri = name === undefined ? base : `file://${base}/${this.name}`;
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
const {
  ensureSprayPhotoCached,
  resetSprayPhotoCacheForTests,
  tryGetSprayPhotoPathSync,
  deleteCachedSprayPhotos,
  liveSprayPhotoFileNames,
} = await import('../spray-photo-cache');
const { sprayPartialPhotoFileName, sprayPhotoFileName } = await import('../spray-photo-keys');

const LAYOUT_ID = 4200;
const IDENTITY = { layoutId: LAYOUT_ID, versionId: 1 };
const FINAL_URI = `file:///cache/spray-walls/${sprayPhotoFileName(IDENTITY)}`;
const PART_URI = `file:///cache/spray-walls/${sprayPartialPhotoFileName(IDENTITY)}`;

const FUTURE = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

function registerWall(expiresAt: string, layoutId = LAYOUT_ID) {
  registerSprayWall(layoutId, {
    wallUuid: 'wall-uuid',
    angle: 40,
    version: 1,
    versionId: 1,
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

describe('deleteCachedSprayPhotos', () => {
  it('removes every version and memo for only the withdrawn wall', async () => {
    registerWall(FUTURE);
    await ensureSprayPhotoCached(IDENTITY);
    // A name from before photos were keyed on the version's row id.
    const legacyVersion = 'file:///cache/spray-walls/4200-9.jpg';
    const newerVersion = `file:///cache/spray-walls/${sprayPhotoFileName({ layoutId: LAYOUT_ID, versionId: 2 })}`;
    const otherWall = `file:///cache/spray-walls/${sprayPhotoFileName({ layoutId: 42001, versionId: 1 })}`;
    for (const uri of [legacyVersion, newerVersion, otherWall]) fsState.files.set(uri, { exists: true });

    registry.unregisterSprayWall(LAYOUT_ID);
    deleteCachedSprayPhotos(LAYOUT_ID);

    expect(tryGetSprayPhotoPathSync(IDENTITY)).toBeNull();
    expect([...fsState.files.keys()]).toEqual([otherWall]);
  });
});

describe('ensureSprayPhotoCached', () => {
  it('ignores a legacy photo cached under the reused version number', async () => {
    registerWall(FUTURE);
    fsState.files.set('file:///cache/spray-walls/4200-1.jpg', { exists: true });
    expect(tryGetSprayPhotoPathSync(IDENTITY)).toBeNull();
    expect(await ensureSprayPhotoCached(IDENTITY)).toBe(FINAL_URI.replace('file://', ''));
    expect(fsState.downloads).toHaveLength(1);
  });

  it('selects real generation-scoped partials and legacy names while preserving another wall and unknown prefixes', async () => {
    const otherIdentity = { layoutId: 4201, versionId: 1 };
    registerWall(FUTURE);
    registerWall(FUTURE, otherIdentity.layoutId);
    fsState.downloadResult = 'hang';
    const targetDownload = ensureSprayPhotoCached(IDENTITY);
    const otherDownload = ensureSprayPhotoCached(otherIdentity);
    const targetPartial = fsState.downloads[0].destination;
    const otherPartial = fsState.downloads[1].destination;
    const unknownPrefix = `file:///cache/spray-walls/unrelated-${sprayPartialPhotoFileName(IDENTITY)}`;
    for (const uri of [targetPartial, otherPartial, FINAL_URI, PART_URI, unknownPrefix])
      fsState.files.set(uri, { exists: true });
    registry.unregisterSprayWall(LAYOUT_ID);
    deleteCachedSprayPhotos(LAYOUT_ID);
    const survivingNames = [...fsState.files.keys()];
    fsState.downloadResult = 'resolve';
    for (const resolveTransfer of fsState.pendingResolvers.splice(0)) resolveTransfer();
    await Promise.all([targetDownload, otherDownload]);
    expect(survivingNames.sort()).toEqual([otherPartial, unknownPrefix].sort());
    expect(fsState.files.has(FINAL_URI)).toBe(false);
    expect(fsState.files.has(`file:///cache/spray-walls/${sprayPhotoFileName(otherIdentity)}`)).toBe(true);
  });
  it.each(['resolve', 'reject'] as const)(
    'discards a late withdrawn download without deleting the new session’s photo (%s)',
    async (completion) => {
      registerWall(FUTURE);
      fsState.downloadResult = 'hang';
      const oldDownload = ensureSprayPhotoCached(IDENTITY);
      registry.withdrawAllSprayWalls();
      deleteCachedSprayPhotos();
      registerWall(FUTURE);
      fsState.downloadResult = 'resolve';
      expect(await ensureSprayPhotoCached(IDENTITY)).not.toBeNull();
      fsState.downloadResult = completion;
      fsState.pendingResolvers.shift()!();
      expect(await oldDownload).toBeNull();
      expect(fsState.files.has(FINAL_URI)).toBe(true);
      expect(fsState.files.size).toBe(1);
      expect(fsState.downloads[0].destination).not.toBe(fsState.downloads[1].destination);
    },
  );

  it('stages under .part and moves the finished file into place', async () => {
    registerWall(FUTURE);

    const path = await ensureSprayPhotoCached(IDENTITY);

    expect(fsState.downloads[0]).toMatchObject({ url: 'https://private.example/photo?sig=1' });
    expect(fsState.downloads[0].destination.endsWith(`-${sprayPartialPhotoFileName(IDENTITY)}`)).toBe(true);
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
    await expect(ensureSprayPhotoCached({ layoutId: LAYOUT_ID, versionId: 2 })).resolves.toBeNull();
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

describe('durable offline photos', () => {
  it('uses the owner-gated stored file without downloading and withdraws on account change', async () => {
    const versionId = 'local-00000000-0000-4000-8000-000000000001-2' as const;
    fsState.files.set('file:///photos/wall.jpg', { exists: true });
    registerSprayWall(LAYOUT_ID, {
      wallUuid: 'wall',
      angle: null,
      version: 2,
      versionId,
      photoWidth: 1200,
      photoHeight: 900,
      photoUrl: 'file:///photos/wall.jpg',
      localPhotoPath: '/photos/wall.jpg',
      photoThumbUrl: null,
      photoExpiresAt: PAST,
      holds: [],
    });
    const identity = { layoutId: LAYOUT_ID, versionId };
    expect(tryGetSprayPhotoPathSync(identity)).toBe('/photos/wall.jpg');
    expect(await ensureSprayPhotoCached(identity)).toBe('/photos/wall.jpg');
    expect(fsState.downloads).toHaveLength(0);
    const { resetSprayWallViewerAccess } = await import('../spray-wall-registry');
    resetSprayWallViewerAccess();
    expect(tryGetSprayPhotoPathSync(identity)).toBeNull();
  });
});

describe('liveSprayPhotoFileNames', () => {
  it('protects the art a local mirror kept, under the server version it was made for', () => {
    const local = 'local-0a1b2c3d-0000-4000-8000-000000000000-3' as const;
    registerSprayWall(LAYOUT_ID, {
      wallUuid: 'wall-uuid',
      angle: 40,
      version: 3,
      versionId: local,
      localPhotoPath: '/photos/wall.jpg',
      photoWidth: 1200,
      photoHeight: 1600,
      photoUrl: 'file:///photos/wall.jpg',
      photoThumbUrl: null,
      photoExpiresAt: PAST,
      holds: [],
      background: 'wall-crop',
      art: {
        variant: 'crop',
        versionId: 21,
        version: 3,
        width: 800,
        height: 1200,
        scale: 0.8,
        url: 'https://private.example/crop',
        expiresAt: PAST,
        holds: [],
      },
    });
    const names = liveSprayPhotoFileNames();
    // An offline sweep must not delete the file the board is drawn from.
    expect(names.has(`${LAYOUT_ID}-v21-crop.jpg`)).toBe(true);
    expect(names.has(`${LAYOUT_ID}-v${local}.jpg`)).toBe(true);
  });
});
