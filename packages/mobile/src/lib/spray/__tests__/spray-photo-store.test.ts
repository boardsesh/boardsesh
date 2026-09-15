import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The durable half of a spray wall (issue #5448): the photograph.
 *
 * Two behaviours here can lose data or leak it, and neither is visible from any
 * other test:
 *
 *  - **The prune.** A reset mints a NEW `photo_key`, and nothing sweeps
 *    `Paths.document` — that is the point of storing there. Without a prune,
 *    every reset of every wall leaves its predecessor's JPEG on the phone
 *    forever. The prune has to key on what the DATABASE holds, not on what a
 *    sync page carried, because a page names one wall and the device may hold
 *    ten.
 *  - **The empty-set guard.** An empty live set is far more likely to mean "the
 *    caller could not read the rows" than "this device has no walls", so it must
 *    delete nothing. Sign-out's deliberate wipe is a different function.
 *
 * The filesystem is a Map. Everything below is about which names survive.
 */

type FakeFile = { contents: string };

const { files, downloadedUrls } = vi.hoisted(() => ({
  files: new Map<string, FakeFile>(),
  downloadedUrls: [] as string[],
}));

// Both classes address by their full joined uri, so a file's identity is its
// path — the same thing the real module relies on.
vi.mock('expo-file-system', () => {
  class Directory {
    readonly uri: string;
    constructor(base: string | { uri: string }, name?: string) {
      const baseUri = typeof base === 'string' ? base : base.uri;
      this.uri = name ? `${baseUri}/${name}` : baseUri;
    }
    get exists(): boolean {
      return [...files.keys()].some((path) => path.startsWith(`${this.uri}/`));
    }
    create(): void {
      // Directories are implied by their files in this fake.
    }
    delete(): void {
      for (const path of [...files.keys()]) {
        if (path.startsWith(`${this.uri}/`)) files.delete(path);
      }
    }
    list(): { name: string; delete: () => void }[] {
      return [...files.keys()]
        .filter((path) => path.startsWith(`${this.uri}/`))
        .map((path) => ({
          name: path.slice(this.uri.length + 1),
          delete: () => {
            files.delete(path);
          },
        }));
    }
  }

  class File {
    readonly uri: string;
    constructor(base: string | { uri: string }, name?: string) {
      const baseUri = typeof base === 'string' ? base : base.uri;
      this.uri = name ? `${baseUri}/${name}` : baseUri;
    }
    get exists(): boolean {
      return files.has(this.uri);
    }
    delete(): void {
      files.delete(this.uri);
    }
    moveSync(destination: { uri: string }): void {
      const contents = files.get(this.uri);
      if (!contents) throw new Error(`no such file: ${this.uri}`);
      files.delete(this.uri);
      files.set(destination.uri, contents);
    }
    static downloadFileAsync(
      url: string,
      destination: { uri: string },
    ): Promise<{ moveSync: (to: { uri: string }) => void; uri: string }> {
      downloadedUrls.push(url);
      files.set(destination.uri, { contents: url });
      return Promise.resolve(
        new File(destination.uri) as unknown as { moveSync: (to: { uri: string }) => void; uri: string },
      );
    }
  }

  return { Directory, File, Paths: { document: 'file:///documents', cache: 'file:///cache' } };
});

const {
  SPRAY_PHOTO_STORE_DIR_NAME,
  clearStoredSprayPhotos,
  deleteStoredSprayPhoto,
  pruneStoredSprayPhotos,
  sprayPhotoStoreFileName,
  storeSprayPhoto,
  tryGetStoredSprayPhotoPathSync,
} = await import('../spray-photo-store');

const DIR = `file:///documents/${SPRAY_PHOTO_STORE_DIR_NAME}`;

const pathFor = (photoKey: string) => `${DIR}/${sprayPhotoStoreFileName(photoKey)}`;
const names = () =>
  [...files.keys()].filter((path) => path.startsWith(`${DIR}/`)).map((path) => path.slice(DIR.length + 1));

const KEY_V1 = 'spray-walls/wall-a/photo-1.jpg';
const KEY_V2 = 'spray-walls/wall-a/photo-2.jpg';
const KEY_OTHER = 'spray-walls/wall-b/photo-1.jpg';

beforeEach(() => {
  files.clear();
  downloadedUrls.length = 0;
});

describe('storeSprayPhoto', () => {
  it('downloads to .part and only moves a completed file into place', async () => {
    const path = await storeSprayPhoto(KEY_V1, 'https://private.example/photo?sig=1');

    expect(path).toBe(pathFor(KEY_V1).replace('file://', ''));
    expect(names()).toEqual([sprayPhotoStoreFileName(KEY_V1)]);
    // Nothing is left under the staging name: a truncated JPEG under the real
    // name would be handed to the decoder forever.
    expect(names().some((name) => name.endsWith('.part'))).toBe(false);
  });

  it('is a no-op when the key is already on disk', async () => {
    await storeSprayPhoto(KEY_V1, 'https://private.example/photo?sig=1');
    await storeSprayPhoto(KEY_V1, 'https://private.example/photo?sig=2');

    // The signature changes on every read; the bytes do not. A second fetch per
    // sync cycle would be a download per cycle, forever.
    expect(downloadedUrls).toHaveLength(1);
  });

  it('resolves a stored photo synchronously, and answers null for one it has not got', async () => {
    expect(tryGetStoredSprayPhotoPathSync(KEY_V1)).toBeNull();
    await storeSprayPhoto(KEY_V1, 'https://private.example/photo?sig=1');
    expect(tryGetStoredSprayPhotoPathSync(KEY_V1)).toBe(pathFor(KEY_V1).replace('file://', ''));
    expect(tryGetStoredSprayPhotoPathSync(null)).toBeNull();
  });
});

describe('pruneStoredSprayPhotos', () => {
  it('deletes the generation a reset replaced, keeping the live one', async () => {
    await storeSprayPhoto(KEY_V1, 'https://private.example/a?sig=1');
    await storeSprayPhoto(KEY_V2, 'https://private.example/a?sig=2');
    expect(names()).toHaveLength(2);

    const deleted = pruneStoredSprayPhotos([KEY_V2]);

    expect(deleted).toBe(1);
    expect(names()).toEqual([sprayPhotoStoreFileName(KEY_V2)]);
  });

  it('keeps every wall the device still holds, not just the one that was pulled', async () => {
    await storeSprayPhoto(KEY_V2, 'https://private.example/a?sig=2');
    await storeSprayPhoto(KEY_OTHER, 'https://private.example/b?sig=1');

    pruneStoredSprayPhotos([KEY_V2, KEY_OTHER]);

    expect(names().sort()).toEqual([sprayPhotoStoreFileName(KEY_OTHER), sprayPhotoStoreFileName(KEY_V2)].sort());
  });

  it('reaps an orphaned .part but never one belonging to a live key', async () => {
    await storeSprayPhoto(KEY_V2, 'https://private.example/a?sig=2');
    // A download killed mid-flight, for a key no wall claims any more.
    files.set(`${DIR}/${sprayPhotoStoreFileName(KEY_V1)}.part`, { contents: 'half' });
    // And one for the wall that IS live — it may be in flight right now.
    files.set(`${DIR}/${sprayPhotoStoreFileName(KEY_V2)}.part`, { contents: 'half' });

    pruneStoredSprayPhotos([KEY_V2]);

    expect(names().sort()).toEqual([sprayPhotoStoreFileName(KEY_V2), `${sprayPhotoStoreFileName(KEY_V2)}.part`].sort());
  });

  it('deletes NOTHING for an empty live set', async () => {
    // An empty set means the caller could not read the rows far more often than
    // it means the device holds no walls, and guessing wrong wipes every photo.
    await storeSprayPhoto(KEY_V2, 'https://private.example/a?sig=2');

    expect(pruneStoredSprayPhotos([])).toBe(0);
    expect(names()).toHaveLength(1);
  });
});

describe('deleteStoredSprayPhoto', () => {
  it('removes one wall’s photo and its staging file, leaving the others', async () => {
    await storeSprayPhoto(KEY_V2, 'https://private.example/a?sig=2');
    await storeSprayPhoto(KEY_OTHER, 'https://private.example/b?sig=1');
    files.set(`${DIR}/${sprayPhotoStoreFileName(KEY_V2)}.part`, { contents: 'half' });

    deleteStoredSprayPhoto(KEY_V2);

    expect(names()).toEqual([sprayPhotoStoreFileName(KEY_OTHER)]);
  });

  it('is a no-op for a wall that never had a photo', async () => {
    await storeSprayPhoto(KEY_OTHER, 'https://private.example/b?sig=1');

    deleteStoredSprayPhoto(null);
    deleteStoredSprayPhoto(undefined);

    expect(names()).toHaveLength(1);
  });
});

describe('clearStoredSprayPhotos', () => {
  it('takes every photograph, whoever it belonged to', async () => {
    await storeSprayPhoto(KEY_V2, 'https://private.example/a?sig=2');
    await storeSprayPhoto(KEY_OTHER, 'https://private.example/b?sig=1');

    clearStoredSprayPhotos();

    expect(names()).toEqual([]);
  });
});
