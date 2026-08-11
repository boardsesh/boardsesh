// expo-file-system is native and globally stubbed for every mobile suite
// (packages/mobile/vite.config.ts's `expo-file-system` alias); this suite
// needs a richer, controllable fake to actually exercise downloadArtifact's
// disk-space check, download, gzip-magic detection, and cleanup — so it
// registers its own vi.mock, which takes precedence over that alias.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  availableDiskSpace: 10_000_000_000, // 10 GB — plenty of headroom by default
  createdDirectories: [] as Array<{
    path: string;
    options?: { intermediates?: boolean; idempotent?: boolean; overwrite?: boolean };
  }>,
  createDirectoryError: null as Error | null,
  downloadCalls: [] as Array<{ url: string; idempotent?: boolean }>,
  downloadError: null as Error | null,
  downloadBytes: new Uint8Array([9, 9, 9, 9]), // non-gzip payload by default
  // When set, readableStream() yields these chunks one read() at a time
  // instead of the whole file in one chunk — for the empty-first-chunk and
  // split-header edge cases the ReadableStream spec allows.
  streamChunks: null as Uint8Array[] | null,
  // When set, the reader rejects instead of yielding bytes — the "can't verify
  // the body at all" path.
  readError: null as Error | null,
  deletedUris: [] as string[],
}));

vi.mock('expo-file-system', () => {
  class FakeDirectory {
    path: string;
    constructor(...parts: unknown[]) {
      this.path = parts.map((part) => (part instanceof FakeDirectory ? part.path : String(part))).join('/');
    }
    create(options?: { intermediates?: boolean; idempotent?: boolean; overwrite?: boolean }) {
      if (state.createDirectoryError) throw state.createDirectoryError;
      state.createdDirectories.push({ path: this.path, options });
    }
  }

  class FakeFile {
    uri: string;
    exists = true;
    bytes: Uint8Array = new Uint8Array();

    constructor(...parts: unknown[]) {
      const joined = parts
        .map((part) => {
          if (part instanceof FakeDirectory) return part.path;
          if (part instanceof FakeFile) return part.uri.replace('file://', '');
          return String(part);
        })
        .join('/');
      this.uri = joined.startsWith('file://') ? joined : `file://${joined}`;
    }

    static downloadFileAsync = vi.fn(async (url: string, destination: FakeFile, options?: { idempotent?: boolean }) => {
      state.downloadCalls.push({ url, idempotent: options?.idempotent });
      if (state.downloadError) throw state.downloadError;
      destination.bytes = state.downloadBytes;
      return destination;
    });

    delete() {
      state.deletedUris.push(this.uri);
    }

    readableStream() {
      const chunks = state.streamChunks ?? [this.bytes];
      let index = 0;
      return {
        getReader: () => ({
          read: async () => {
            if (state.readError) throw state.readError;
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          cancel: async () => {},
        }),
      };
    }
  }

  return {
    Directory: FakeDirectory,
    File: FakeFile,
    Paths: {
      get cache() {
        return new FakeDirectory('cache-root');
      },
      get availableDiskSpace() {
        return state.availableDiskSpace;
      },
    },
  };
});

vi.mock('../../lib/env', () => ({
  SNAPSHOT_BASE_URL: 'https://example.test/board-snapshots/v1',
}));

const reportHandledError = vi.fn();
vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => reportHandledError(...args),
}));

import { mobileSnapshotSource } from '../snapshot-source';
import { SnapshotPermanentMissError, type SnapshotManifestEntry } from '@boardsesh/offline-sync';

const ENTRY: SnapshotManifestEntry = {
  boardType: 'kilter',
  layoutId: 8,
  key: 'board-snapshots/v1/kilter/8/2026-06-01.db',
  url: 'https://example.test/artifacts/kilter-8.db',
  bytes: 1_000_000,
  contentEncoding: 'gzip',
  builtAt: '2026-06-01T00:00:00.000Z',
  schemaVersion: 1,
  tables: {
    board_climbs: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 100 },
    board_climb_stats: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 100 },
  },
};

const GZIP_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
const PLAIN_SQLITE_BYTES = new Uint8Array([0x53, 0x51, 0x4c, 0x69]); // "SQLi" — not gzip magic

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function brokenJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('bad json');
    },
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.availableDiskSpace = 10_000_000_000;
  state.createdDirectories = [];
  state.createDirectoryError = null;
  state.downloadCalls = [];
  state.downloadError = null;
  state.downloadBytes = PLAIN_SQLITE_BYTES;
  state.streamChunks = null;
  state.readError = null;
  state.deletedUris = [];
});

describe('fetchManifest', () => {
  it('fetches the manifest URL with cache: no-store and returns the parsed JSON on 200', async () => {
    const manifestBody = { formatVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', entries: [] };
    const fetchMock = vi.fn(async () => jsonResponse(manifestBody));
    vi.stubGlobal('fetch', fetchMock);

    const result = await mobileSnapshotSource.fetchManifest();

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/board-snapshots/v1/manifest.json', {
      cache: 'no-store',
    });
    expect(result).toEqual(manifestBody);
    vi.unstubAllGlobals();
  });

  it('returns null on a 404 response (treated as "not published yet")', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404)),
    );

    await expect(mobileSnapshotSource.fetchManifest()).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('throws on non-404 HTTP failures so the engine retries the manifest path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 500)),
    );

    await expect(mobileSnapshotSource.fetchManifest()).rejects.toThrow('HTTP 500');
    vi.unstubAllGlobals();
  });

  it('returns null for unparseable JSON so the engine falls back to paged sync', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => brokenJsonResponse()),
    );

    await expect(mobileSnapshotSource.fetchManifest()).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('lets a network/transport error throw (the engine counts it as a bootstrap attempt)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network request failed');
      }),
    );

    await expect(mobileSnapshotSource.fetchManifest()).rejects.toThrow('network request failed');
    vi.unstubAllGlobals();
  });
});

describe('downloadArtifact', () => {
  it('throws a descriptive error without downloading when free disk space is below the gzip safety multiple of entry.bytes (issue #4106: this used to swallow to null)', async () => {
    state.availableDiskSpace = ENTRY.bytes * 2; // well under the 6x safety multiplier

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow(/insufficient disk space/);
    expect(state.downloadCalls).toHaveLength(0);
  });

  it('allows identity artifacts with the lower identity safety multiple', async () => {
    state.availableDiskSpace = ENTRY.bytes * 3;
    const identityEntry: SnapshotManifestEntry = { ...ENTRY, contentEncoding: 'identity' };

    const result = await mobileSnapshotSource.downloadArtifact(identityEntry);

    expect(result).not.toBeNull();
    expect(state.downloadCalls).toHaveLength(1);
  });

  it('downloads to the cache directory idempotently and returns a plain filesystem path (no file:// scheme)', async () => {
    const result = await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.createdDirectories).toEqual([
      { path: 'cache-root/board-snapshots', options: { intermediates: true, idempotent: true } },
    ]);
    expect(state.downloadCalls).toEqual([{ url: ENTRY.url, idempotent: true }]);
    expect(result).not.toBeNull();
    expect(result?.filePath.startsWith('file://')).toBe(false);
    expect(result?.filePath).toContain('kilter-8-2026-06-01T00-00-00-000Z.db');
  });

  it('throws a descriptive error wrapping the underlying cause when the download itself fails (issue #4106: this used to swallow to null)', async () => {
    state.downloadError = new Error('boom');

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow(/downloadFileAsync failed.*boom/);
  });

  it('keeps the original download exception as `cause` so the transport classifier can see it (issue #4238)', async () => {
    // expo-file-system throws UnableToDownloadException("The request timed out.")
    // for an offline user. Interpolating it into the message reads fine in
    // Sentry's title but is invisible to isNetworkError, which walks `.cause`.
    const downloadError = Object.assign(new Error('The request timed out.'), {
      name: 'UnableToDownloadException',
    });
    state.downloadError = downloadError;

    const rejection = await mobileSnapshotSource.downloadArtifact(ENTRY).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).cause).toBe(downloadError);
  });

  it('throws a descriptive error wrapping the underlying cause when the cache directory cannot be created', async () => {
    const createError = new Error('disk is read-only');
    state.createDirectoryError = createError;

    const rejection = await mobileSnapshotSource.downloadArtifact(ENTRY).catch((error: unknown) => error);

    expect((rejection as Error).message).toMatch(/cache directory.*disk is read-only/);
    expect((rejection as Error).cause).toBe(createError);
    expect(state.downloadCalls).toHaveLength(0);
  });

  it('throws (rather than returning null) and deletes the partial file when the gzip sniff cannot read the body', async () => {
    // The last path that still returned a bare null, which is exactly the one
    // Sentry reported as `cause: null` at stage "download" (issue #4238).
    const readError = new Error('stream closed');
    state.downloadBytes = GZIP_BYTES;
    state.readError = readError;

    const rejection = await mobileSnapshotSource.downloadArtifact(ENTRY).catch((error: unknown) => error);

    expect((rejection as Error).message).toMatch(/could not verify artifact encoding/);
    expect((rejection as Error).cause).toBe(readError);
    expect(state.deletedUris).toHaveLength(1);
  });

  it('accepts a gzip-encoded entry whose downloaded bytes are already decompressed', async () => {
    state.downloadBytes = PLAIN_SQLITE_BYTES;

    const result = await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(result).not.toBeNull();
    expect(state.deletedUris).toHaveLength(0);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('deletes the file, reports, and permanently misses when the body is STILL gzip-compressed', async () => {
    state.downloadBytes = GZIP_BYTES;

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow(SnapshotPermanentMissError);

    expect(state.deletedUris).toHaveLength(1);
    expect(reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('still gzip-compressed') }),
      expect.objectContaining({
        tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' },
        extra: expect.objectContaining({ boardType: 'kilter', layoutId: 8 }),
      }),
    );
  });

  it('still detects gzip when the stream yields an empty chunk, then a split header', async () => {
    // A ReadableStream may legally deliver empty or tiny chunks before real
    // data. An empty first read followed by the magic bytes split across two
    // chunks must still be recognised as an undecoded gzip body.
    state.streamChunks = [new Uint8Array([]), new Uint8Array([0x1f]), new Uint8Array([0x8b, 0x08])];

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow(SnapshotPermanentMissError);
    expect(state.deletedUris).toHaveLength(1);
  });

  it('treats a sub-2-byte stream as not gzip (EOF before the header completes)', async () => {
    state.streamChunks = [new Uint8Array([]), new Uint8Array([0x1f])];

    const result = await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(result).not.toBeNull();
    expect(state.deletedUris).toHaveLength(0);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('skips the gzip-magic check entirely for an identity-encoded entry', async () => {
    state.downloadBytes = GZIP_BYTES; // would fail the check if it ran
    const identityEntry: SnapshotManifestEntry = { ...ENTRY, contentEncoding: 'identity' };

    const result = await mobileSnapshotSource.downloadArtifact(identityEntry);

    expect(result).not.toBeNull();
    expect(state.deletedUris).toHaveLength(0);
  });
});

describe('deleteArtifact', () => {
  it('deletes the file at the given plain path, best-effort', async () => {
    await mobileSnapshotSource.deleteArtifact('/cache/board-snapshots/kilter-8.db');
    expect(state.deletedUris).toEqual(['file:///cache/board-snapshots/kilter-8.db']);
  });
});
