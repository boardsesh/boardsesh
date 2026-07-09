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
  downloadCalls: [] as Array<{ url: string; idempotent?: boolean }>,
  downloadError: null as Error | null,
  downloadBytes: new Uint8Array([9, 9, 9, 9]), // non-gzip payload by default
  deletedUris: [] as string[],
}));

vi.mock('expo-file-system', () => {
  class FakeDirectory {
    path: string;
    constructor(...parts: unknown[]) {
      this.path = parts.map((part) => (part instanceof FakeDirectory ? part.path : String(part))).join('/');
    }
    create(options?: { intermediates?: boolean; idempotent?: boolean; overwrite?: boolean }) {
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
      const bytes = this.bytes;
      let consumed = false;
      return {
        getReader: () => ({
          read: async () => {
            if (consumed) return { done: true, value: undefined };
            consumed = true;
            return { done: false, value: bytes };
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
  state.downloadCalls = [];
  state.downloadError = null;
  state.downloadBytes = PLAIN_SQLITE_BYTES;
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
  it('returns null without downloading when free disk space is below the gzip safety multiple of entry.bytes', async () => {
    state.availableDiskSpace = ENTRY.bytes * 2; // well under the 6x safety multiplier

    const result = await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(result).toBeNull();
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

  it('returns null when the download itself fails', async () => {
    state.downloadError = new Error('boom');

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).resolves.toBeNull();
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
