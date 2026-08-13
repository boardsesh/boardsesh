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
  downloadCalls: [] as Array<{ url: string; idempotent?: boolean; hasOnProgress: boolean; hasSignal: boolean }>,
  // The DownloadTask arm (issue #4394): which sessionType each call asked for,
  // how many native handles were released, and whether the task resolves the
  // `null` expo returns for a PAUSED transfer (which we never request).
  taskCalls: [] as Array<{
    url: string;
    sessionType?: 'background' | 'foreground';
    hasOnProgress: boolean;
    hasSignal: boolean;
  }>,
  taskReleases: 0,
  taskResolvesNull: false,
  /** Overrides the finished file's on-disk size, for the exact decoded-size gate. */
  downloadedFileSize: null as number | null,
  // Byte frames the fake downloader replays into the injected onProgress, in
  // whatever scale a real platform would report (Android: decoded bytes,
  // totalBytes -1).
  downloadProgressFrames: [] as Array<{ bytesWritten: number; totalBytes: number }>,
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
  // A real in-memory filesystem, not a stub: artifact RETENTION (issue #4310)
  // turns on file existence, sidecar contents, sizes, and mtimes, so a fake
  // where `exists` is always true would prove nothing.
  files: new Map<string, { text: string | null; bytes: Uint8Array; size: number; lastModified: number }>(),
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
    list(): FakeFile[] {
      const prefix = `file://${this.path}/`;
      return [...state.files.keys()].filter((uri) => uri.startsWith(prefix)).map((uri) => new FakeFile(uri));
    }
  }

  class FakeFile {
    uri: string;

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

    get exists() {
      return state.files.has(this.uri);
    }

    get size() {
      return state.files.get(this.uri)?.size ?? 0;
    }

    get lastModified() {
      return state.files.get(this.uri)?.lastModified ?? null;
    }

    get bytes() {
      return state.files.get(this.uri)?.bytes ?? new Uint8Array();
    }

    static downloadFileAsync = vi.fn(
      async (
        url: string,
        destination: FakeFile,
        options?: {
          idempotent?: boolean;
          onProgress?: (data: { bytesWritten: number; totalBytes: number }) => void;
          signal?: AbortSignal;
        },
      ) => {
        state.downloadCalls.push({
          url,
          idempotent: options?.idempotent,
          hasOnProgress: options?.onProgress !== undefined,
          hasSignal: options?.signal !== undefined,
        });
        return runFakeTransfer(destination, options);
      },
    );

    // The DownloadTask arm (issue #4394). Same byte-writing behaviour as
    // downloadFileAsync so every existing assertion holds under either
    // strategy; what differs is what the transport records.
    static createDownloadTask = vi.fn(
      (
        url: string,
        destination: FakeFile,
        options?: {
          sessionType?: 'background' | 'foreground';
          onProgress?: (data: { bytesWritten: number; totalBytes: number }) => void;
          signal?: AbortSignal;
        },
      ) => {
        state.taskCalls.push({
          url,
          sessionType: options?.sessionType,
          hasOnProgress: options?.onProgress !== undefined,
          hasSignal: options?.signal !== undefined,
        });
        return {
          downloadAsync: async () => {
            const file = await runFakeTransfer(destination, options);
            return state.taskResolvesNull ? null : file;
          },
          release: () => {
            state.taskReleases += 1;
          },
        };
      },
    );

    create(_options?: { intermediates?: boolean; overwrite?: boolean }) {
      writeFakeFile(this.uri, { bytes: new Uint8Array(), text: '' });
    }

    write(content: string) {
      writeFakeFile(this.uri, { bytes: new Uint8Array(), text: content });
    }

    textSync(): string {
      const entry = state.files.get(this.uri);
      if (entry?.text == null) throw new Error(`no text at ${this.uri}`);
      return entry.text;
    }

    delete() {
      if (!state.files.has(this.uri)) throw new Error(`no such file: ${this.uri}`);
      state.deletedUris.push(this.uri);
      state.files.delete(this.uri);
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

  function writeFakeFile(uri: string, content: { bytes: Uint8Array; text: string | null }): void {
    state.files.set(uri, {
      bytes: content.bytes,
      text: content.text,
      size: content.text !== null ? content.text.length : content.bytes.length,
      lastModified: state.files.size + 1,
    });
  }

  /** The shared body of both transport fakes: frames, abort, error, then bytes. */
  async function runFakeTransfer(
    destination: FakeFile,
    options?: {
      onProgress?: (data: { bytesWritten: number; totalBytes: number }) => void;
      signal?: AbortSignal;
    },
  ): Promise<FakeFile> {
    for (const frame of state.downloadProgressFrames) options?.onProgress?.(frame);
    if (options?.signal?.aborted) throw new Error('AbortError: download cancelled');
    if (state.downloadError) throw state.downloadError;
    writeFakeFile(destination.uri, { bytes: state.downloadBytes, text: null });
    // The decoded on-disk size the exact-size gate reads. Decoupled from the
    // sniffed bytes so a test can simulate a 269 MB artifact without allocating
    // one — or a short body, which is the gate's whole point.
    if (state.downloadedFileSize !== null) {
      const entry = state.files.get(destination.uri);
      if (entry) state.files.set(destination.uri, { ...entry, size: state.downloadedFileSize });
    }
    return destination;
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

// The strategy resolver reads Platform.OS. RN's real entry is Flow source that
// Rolldown's scan cannot parse, so it is stubbed here the way
// offline-sync-adapter.test.ts does.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const reportHandledError = vi.fn();
vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => reportHandledError(...args),
}));

// Mocked wholesale: the real module reaches offline-sync-adapter for the cached
// NetInfo verdict, which drags NetInfo and the whole scheduler into this graph.
const reportArtifactTransfer = vi.fn();
vi.mock('../artifact-transfer-telemetry', () => ({
  reportArtifactTransfer: (...args: unknown[]) => reportArtifactTransfer(...args),
}));

// The FAKE File class the vi.mock above installs — imported so the strategy
// tests can read the exact options object each transport was handed.
import { File } from 'expo-file-system';
import {
  mobileSnapshotSource,
  setSnapshotDownloadStrategyFromFlags,
  __resetSnapshotDownloadStrategyForTests,
} from '../snapshot-source';
import {
  SnapshotArtifactTruncatedError,
  SnapshotPermanentMissError,
  type SnapshotManifestEntry,
} from '@boardsesh/offline-sync';

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
  state.downloadProgressFrames = [];
  state.createDirectoryError = null;
  state.downloadCalls = [];
  state.downloadError = null;
  state.downloadBytes = PLAIN_SQLITE_BYTES;
  state.streamChunks = null;
  state.readError = null;
  state.deletedUris = [];
  state.files.clear();
  state.taskCalls = [];
  state.taskReleases = 0;
  state.taskResolvesNull = false;
  state.downloadedFileSize = null;
  __resetSnapshotDownloadStrategyForTests();
});

const ARTIFACT_URI = 'file://cache-root/board-snapshots/kilter-8-2026-06-01T00-00-00-000Z.db';
const SIDECAR_URI = `${ARTIFACT_URI}.complete`;

/** Seeds a retained artifact + its completeness sidecar, as a previous cycle would leave them. */
function seedRetainedArtifact(uri: string, builtAt: string, sizeBytes = 1_000): void {
  state.files.set(uri, { bytes: PLAIN_SQLITE_BYTES, text: null, size: sizeBytes, lastModified: 1 });
  state.files.set(`${uri}.complete`, { bytes: new Uint8Array(), text: builtAt, size: builtAt.length, lastModified: 1 });
}

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
    // An identity entry's `bytes` IS the decoded size, so it also gates on it.
    state.downloadedFileSize = ENTRY.bytes;
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
    expect(state.downloadCalls).toEqual([{ url: ENTRY.url, idempotent: true, hasOnProgress: false, hasSignal: false }]);
    expect(result).not.toBeNull();
    expect(result?.filePath.startsWith('file://')).toBe(false);
    expect(result?.filePath).toContain('kilter-8-2026-06-01T00-00-00-000Z.db');
  });

  it('omits the onProgress option entirely when the caller does not ask for it (kill-switch path)', async () => {
    // Passing onProgress makes expo take a DIFFERENT native download
    // implementation, so the flag-off path has to reproduce the original call
    // exactly — not merely discard the callback's output.
    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.downloadCalls).toEqual([{ url: ENTRY.url, idempotent: true, hasOnProgress: false, hasSignal: false }]);
  });

  it('forwards platform byte frames and maps a non-positive totalBytes to null', async () => {
    // Android gunzips transparently, so contentLength() is -1 while the write
    // loop counts decoded bytes. The engine needs null, not -1.
    state.downloadProgressFrames = [
      { bytesWritten: 1_000, totalBytes: -1 },
      { bytesWritten: 2_000, totalBytes: 0 },
      { bytesWritten: 3_000, totalBytes: 4_000 },
    ];
    const frames: Array<{ bytesWritten: number; totalBytes: number | null }> = [];

    await mobileSnapshotSource.downloadArtifact(ENTRY, { onProgress: (frame) => frames.push(frame) });

    expect(state.downloadCalls).toEqual([{ url: ENTRY.url, idempotent: true, hasOnProgress: true, hasSignal: false }]);
    expect(frames).toEqual([
      { bytesWritten: 1_000, totalBytes: null },
      { bytesWritten: 2_000, totalBytes: null },
      { bytesWritten: 3_000, totalBytes: 4_000 },
    ]);
  });

  it('requires exactly (decoded + wire + slack) free bytes when the manifest carries uncompressedBytes', async () => {
    // The old 6x guess demanded ~6 MB to download this 1 MB artifact. The exact
    // figure is 3 MB decoded + 1 MB wire + 32 MB slack.
    const withDecodedSize: SnapshotManifestEntry = { ...ENTRY, uncompressedBytes: 3_000_000 };
    const exactRequirement = 3_000_000 + ENTRY.bytes + 32 * 1024 * 1024;
    state.downloadedFileSize = 3_000_000;

    state.availableDiskSpace = exactRequirement - 1;
    await expect(mobileSnapshotSource.downloadArtifact(withDecodedSize)).rejects.toThrow(/insufficient disk space/);
    expect(state.downloadCalls).toHaveLength(0);

    state.availableDiskSpace = exactRequirement;
    await expect(mobileSnapshotSource.downloadArtifact(withDecodedSize)).resolves.not.toBeNull();
  });

  it('falls back to the coarse multiplier for an entry built before uncompressedBytes existed', async () => {
    expect(ENTRY.uncompressedBytes).toBeUndefined();
    state.availableDiskSpace = ENTRY.bytes * 5; // under the 6x gzip multiplier

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow(/insufficient disk space/);
  });

  it('throws a descriptive error wrapping the underlying cause when the download itself fails (issue #4106: this used to swallow to null)', async () => {
    state.downloadError = new Error('boom');

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow(/transfer failed.*boom/);
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
    state.downloadedFileSize = ENTRY.bytes;
    const identityEntry: SnapshotManifestEntry = { ...ENTRY, contentEncoding: 'identity' };

    const result = await mobileSnapshotSource.downloadArtifact(identityEntry);

    expect(result).not.toBeNull();
    expect(state.deletedUris).toHaveLength(0);
  });
});

// Which expo API moves the bytes (issue #4394). The default is deliberately
// today's shipped call on both platforms — the new transports roll out by
// setting a PostHog flag after on-device QA, never by merging an OTA.
describe('download transport strategies', () => {
  const DECODED = { ...ENTRY, uncompressedBytes: 3_000_000 };

  it('uses downloadFileAsync with EXACTLY the shipped options when the flags are unresolved', async () => {
    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.taskCalls).toEqual([]);
    const call = (File.downloadFileAsync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toEqual({ idempotent: true, signal: undefined });
  });

  it('passes the four-key options object when the caller asked for progress', async () => {
    await mobileSnapshotSource.downloadArtifact(ENTRY, { onProgress: () => {} });

    const call = (File.downloadFileAsync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(Object.keys(call[2] as object).sort()).toEqual(['idempotent', 'onProgress', 'signal']);
    expect((call[2] as { idempotent: boolean }).idempotent).toBe(true);
  });

  it('stays on downloadFileAsync when the task-api flag is explicitly off', async () => {
    setSnapshotDownloadStrategyFromFlags({ taskApiFlag: false, backgroundSessionFlag: true });

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.taskCalls).toEqual([]);
    expect(state.downloadCalls).toHaveLength(1);
  });

  it('drives a background URLSession task on iOS when the task-api flag is on', async () => {
    setSnapshotDownloadStrategyFromFlags({ taskApiFlag: true, backgroundSessionFlag: undefined });

    await mobileSnapshotSource.downloadArtifact(ENTRY, { onProgress: () => {} });

    expect(state.downloadCalls).toEqual([]);
    expect(state.taskCalls).toEqual([
      { url: ENTRY.url, sessionType: 'background', hasOnProgress: true, hasSignal: false },
    ]);
  });

  it('pins the task to a foreground session when the background-session flag is off', async () => {
    setSnapshotDownloadStrategyFromFlags({ taskApiFlag: true, backgroundSessionFlag: false });

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.taskCalls[0].sessionType).toBe('foreground');
  });

  it('releases the native task handle on the success AND the throw path', async () => {
    setSnapshotDownloadStrategyFromFlags({ taskApiFlag: true, backgroundSessionFlag: undefined });

    await mobileSnapshotSource.downloadArtifact(ENTRY);
    expect(state.taskReleases).toBe(1);

    // A different build, so the sidecar the first download wrote cannot short
    // -circuit this one into the reuse path.
    state.downloadError = new Error('boom');
    await expect(
      mobileSnapshotSource.downloadArtifact({ ...ENTRY, builtAt: '2026-06-02T00:00:00.000Z' }),
    ).rejects.toThrow(/transfer failed/);
    expect(state.taskReleases).toBe(2);
  });

  it('treats a task that resolves null as a failed transfer, not a silent success', async () => {
    // expo resolves null only for a PAUSED transfer, which we never request.
    setSnapshotDownloadStrategyFromFlags({ taskApiFlag: true, backgroundSessionFlag: undefined });
    state.taskResolvesNull = true;

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow(/ended without a file/);
  });

  it('reports the strategy it actually used on the transfer event', async () => {
    setSnapshotDownloadStrategyFromFlags({ taskApiFlag: true, backgroundSessionFlag: false });
    state.downloadedFileSize = DECODED.uncompressedBytes;

    await mobileSnapshotSource.downloadArtifact(DECODED);

    expect(reportArtifactTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'task-foreground', outcome: 'completed' }),
    );
  });
});

// The exact decoded-size gate (issue #4394): the manifest's `uncompressedBytes`
// is the SQLite file's own byte length, so a short body is provable — and it
// must be provable BEFORE the completeness sidecar is written.
describe('the exact decoded-size gate', () => {
  const DECODED_BYTES = 3_000_000;
  const WITH_DECODED_SIZE: SnapshotManifestEntry = { ...ENTRY, uncompressedBytes: DECODED_BYTES };

  it('deletes a short body, writes no sidecar, and throws SnapshotArtifactTruncatedError', async () => {
    state.downloadedFileSize = DECODED_BYTES - 1;

    const rejection = await mobileSnapshotSource.downloadArtifact(WITH_DECODED_SIZE).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(SnapshotArtifactTruncatedError);
    expect((rejection as Error).message).toMatch(/expected 3000000 bytes, got 2999999/);
    expect(state.files.has(ARTIFACT_URI)).toBe(false);
    expect(state.files.has(SIDECAR_URI)).toBe(false);
    expect(reportHandledError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'snapshot artifact size mismatch' }),
      expect.objectContaining({
        extra: expect.objectContaining({ expectedDecodedBytes: DECODED_BYTES, bytesOnDisk: DECODED_BYTES - 1 }),
      }),
    );
  });

  it('writes the sidecar exactly as before when the size matches', async () => {
    state.downloadedFileSize = DECODED_BYTES;

    const result = await mobileSnapshotSource.downloadArtifact(WITH_DECODED_SIZE);

    expect(result).toEqual({ filePath: ARTIFACT_URI.replace('file://', '') });
    expect(state.files.get(SIDECAR_URI)?.text).toBe(ENTRY.builtAt);
  });

  it('skips the gate for an entry with no uncompressedBytes (grades artifact / pre-#4311 manifest)', async () => {
    expect(ENTRY.uncompressedBytes).toBeUndefined();

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).resolves.not.toBeNull();
  });

  it('gates an identity-encoded entry on entry.bytes — there, bytes IS the decoded size', async () => {
    const identityEntry: SnapshotManifestEntry = { ...ENTRY, contentEncoding: 'identity' };
    state.downloadedFileSize = ENTRY.bytes - 10;

    await expect(mobileSnapshotSource.downloadArtifact(identityEntry)).rejects.toBeInstanceOf(
      SnapshotArtifactTruncatedError,
    );
  });

  it('keeps the gzip sniff WINNING over the size gate for a still-compressed body', async () => {
    // A still-compressed body is a permanent miss, not a short one: the two
    // spend different budgets and mean different things.
    state.downloadBytes = GZIP_BYTES;
    state.downloadedFileSize = DECODED_BYTES - 1;

    await expect(mobileSnapshotSource.downloadArtifact(WITH_DECODED_SIZE)).rejects.toBeInstanceOf(
      SnapshotPermanentMissError,
    );
  });

  it('re-downloads a RETAINED artifact whose file has since been truncated', async () => {
    seedRetainedArtifact(ARTIFACT_URI, ENTRY.builtAt, DECODED_BYTES - 1);
    state.downloadedFileSize = DECODED_BYTES;

    const result = await mobileSnapshotSource.downloadArtifact(WITH_DECODED_SIZE);

    expect(result?.reused).toBeUndefined();
    expect(state.downloadCalls).toHaveLength(1);
  });

  it('still reuses a retained artifact whose size matches', async () => {
    seedRetainedArtifact(ARTIFACT_URI, ENTRY.builtAt, DECODED_BYTES);

    const result = await mobileSnapshotSource.downloadArtifact(WITH_DECODED_SIZE);

    expect(result).toEqual({ filePath: ARTIFACT_URI.replace('file://', ''), reused: true });
    expect(state.downloadCalls).toEqual([]);
  });
});

describe('superseded-partial sweep', () => {
  it('discards an older build BEFORE the free-space precheck that its bytes would fail', async () => {
    // Today a 271 MB stale partial sits in the cache until the NEXT download
    // succeeds — which it may not, because that partial counts against the
    // precheck. Sweeping first frees the space the new download needs.
    const stalePartial = 'file://cache-root/board-snapshots/kilter-8-2026-05-01T00-00-00-000Z.db';
    seedRetainedArtifact(stalePartial, '2026-05-01T00:00:00.000Z', 271_000_000);

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).resolves.not.toBeNull();

    expect(state.files.has(stalePartial)).toBe(false);
    expect(state.files.has(`${stalePartial}.complete`)).toBe(false);
  });

  it('leaves a DIFFERENT layout alone — the sweep is per (board, layout)', async () => {
    const otherLayout = 'file://cache-root/board-snapshots/kilter-9-2026-05-01T00-00-00-000Z.db';
    seedRetainedArtifact(otherLayout, '2026-05-01T00:00:00.000Z');

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.files.has(otherLayout)).toBe(true);
  });

  it('never runs for a grades artifact, whose filename carries no board-layout prefix', async () => {
    const layoutArtifact = 'file://cache-root/board-snapshots/kilter-8-2026-05-01T00-00-00-000Z.db';
    seedRetainedArtifact(layoutArtifact, '2026-05-01T00:00:00.000Z');

    await mobileSnapshotSource.downloadGradesArtifact?.({
      key: 'board-snapshots/v1-gzip/kilter/8/2026-06-01-grades.db',
      url: 'https://example.test/artifacts/kilter-8-grades.db',
      bytes: 2_000_000,
      contentEncoding: 'gzip',
      builtAt: '2026-06-01T00:00:00.000Z',
      schemaVersion: 1,
      tables: {
        board_climb_grades: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 900 },
      },
    });

    expect(state.files.has(layoutArtifact)).toBe(true);
  });
});

describe('Offline Artifact Transfer telemetry', () => {
  it('reports a completed layout transfer with its dimensions and no fabricated numbers', async () => {
    state.downloadProgressFrames = [{ bytesWritten: 1_000, totalBytes: -1 }];
    state.downloadedFileSize = 3_000_000;

    await mobileSnapshotSource.downloadArtifact({ ...ENTRY, uncompressedBytes: 3_000_000 }, { onProgress: () => {} });

    expect(reportArtifactTransfer).toHaveBeenCalledTimes(1);
    const report = reportArtifactTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect(report).toMatchObject({
      strategy: 'download-file-async',
      artifact: 'layout',
      boardType: 'kilter',
      layoutId: 8,
      outcome: 'completed',
      wireBytes: ENTRY.bytes,
      expectedDecodedBytes: 3_000_000,
      bytesOnDisk: 3_000_000,
      backgroundedDuringTransfer: false,
      resumed: false,
      sizeMismatch: false,
    });
    expect(typeof report.wallMs).toBe('number');
    expect(typeof report.firstByteMs).toBe('number');
  });

  it('omits firstByteMs when no progress callback ever fired', async () => {
    await mobileSnapshotSource.downloadArtifact(ENTRY);

    const report = reportArtifactTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect('firstByteMs' in report).toBe(false);
  });

  it('reports a cancelled transfer as aborted, not failed', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY, { signal: controller.signal })).rejects.toThrow();

    expect(reportArtifactTransfer).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted' }));
  });

  it('reports a failed transfer as failed', async () => {
    state.downloadError = new Error('boom');

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow();

    expect(reportArtifactTransfer).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });

  it('reports sizeMismatch on a short body', async () => {
    state.downloadedFileSize = 10;

    await expect(mobileSnapshotSource.downloadArtifact({ ...ENTRY, uncompressedBytes: 3_000_000 })).rejects.toThrow();

    expect(reportArtifactTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', sizeMismatch: true, bytesOnDisk: 10 }),
    );
  });

  it('emits NOTHING for a reused artifact — the denominator stays real network work', async () => {
    seedRetainedArtifact(ARTIFACT_URI, ENTRY.builtAt);

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(reportArtifactTransfer).not.toHaveBeenCalled();
  });

  it('emits NOTHING when the disk-space precheck refuses before any bytes move', async () => {
    state.availableDiskSpace = 1;

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow(/insufficient disk space/);

    expect(reportArtifactTransfer).not.toHaveBeenCalled();
  });

  it('reports a grades transfer without board dimensions its manifest block does not carry', async () => {
    await mobileSnapshotSource.downloadGradesArtifact?.({
      key: 'board-snapshots/v1-gzip/kilter/8/2026-06-01-grades.db',
      url: 'https://example.test/artifacts/kilter-8-grades.db',
      bytes: 2_000_000,
      contentEncoding: 'gzip',
      builtAt: '2026-06-01T00:00:00.000Z',
      schemaVersion: 1,
      tables: {
        board_climb_grades: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 900 },
      },
    });

    const report = reportArtifactTransfer.mock.calls[0][0] as Record<string, unknown>;
    expect(report).toMatchObject({ artifact: 'grades', outcome: 'completed', wireBytes: 2_000_000 });
    expect('boardType' in report).toBe(false);
    expect('layoutId' in report).toBe(false);
    expect('expectedDecodedBytes' in report).toBe(false);
  });
});

describe('deleteArtifact', () => {
  it('deletes the file AND its completeness sidecar at the given plain path, best-effort', async () => {
    seedRetainedArtifact('file:///cache/board-snapshots/kilter-8.db', ENTRY.builtAt);

    await mobileSnapshotSource.deleteArtifact('/cache/board-snapshots/kilter-8.db');

    expect(new Set(state.deletedUris)).toEqual(
      new Set(['file:///cache/board-snapshots/kilter-8.db', 'file:///cache/board-snapshots/kilter-8.db.complete']),
    );
  });

  it('is a no-op when the file is already gone', async () => {
    await mobileSnapshotSource.deleteArtifact('/cache/board-snapshots/kilter-8.db');
    expect(state.deletedUris).toEqual([]);
  });
});

// Artifact retention (issue #4310). Before this, `runBootstrapPhase` deleted
// every downloaded artifact in a `finally`, so locking the phone mid-cycle threw
// away a 103 MB Kilter download and started it again on the next wake.
describe('retention and reuse', () => {
  it('writes a completeness sidecar naming the artifact build only after the gzip sniff passes', async () => {
    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.files.get(SIDECAR_URI)?.text).toBe(ENTRY.builtAt);
  });

  it('does NOT write a sidecar when the body arrived still gzip-compressed', async () => {
    state.downloadBytes = GZIP_BYTES;

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY)).rejects.toThrow(SnapshotPermanentMissError);

    expect(state.files.has(SIDECAR_URI)).toBe(false);
  });

  it('reuses a retained artifact for the same build with no network call at all', async () => {
    seedRetainedArtifact(ARTIFACT_URI, ENTRY.builtAt);

    const result = await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.downloadCalls).toHaveLength(0);
    expect(result?.reused).toBe(true);
    expect(result?.filePath).toBe(ARTIFACT_URI.replace('file://', ''));
  });

  it('re-downloads a retained file that has NO sidecar — a half-written body is never reused', async () => {
    state.files.set(ARTIFACT_URI, { bytes: PLAIN_SQLITE_BYTES, text: null, size: 12, lastModified: 1 });

    const result = await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.downloadCalls).toHaveLength(1);
    expect(result?.reused).toBeUndefined();
  });

  it('re-downloads when the sidecar names a DIFFERENT build than the manifest asks for', async () => {
    seedRetainedArtifact(ARTIFACT_URI, '2026-05-01T00:00:00.000Z');

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.downloadCalls).toHaveLength(1);
  });

  it('sweeps a superseded build of the same board+layout once the new one lands', async () => {
    const supersededUri = 'file://cache-root/board-snapshots/kilter-8-2026-05-01T00-00-00-000Z.db';
    seedRetainedArtifact(supersededUri, '2026-05-01T00:00:00.000Z');

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.files.has(supersededUri)).toBe(false);
    expect(state.files.has(ARTIFACT_URI)).toBe(true);
  });

  it('keeps a DIFFERENT layout’s retained artifact — retention is per (board, layout)', async () => {
    const otherLayoutUri = 'file://cache-root/board-snapshots/tension-9-2026-05-01T00-00-00-000Z.db';
    seedRetainedArtifact(otherLayoutUri, '2026-05-01T00:00:00.000Z');

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.files.has(otherLayoutUri)).toBe(true);
  });

  it('evicts oldest-first once retained artifacts exceed the byte budget', async () => {
    const oldest = 'file://cache-root/board-snapshots/tension-9-2026-01-01T00-00-00-000Z.db';
    const newer = 'file://cache-root/board-snapshots/moonboard-2-2026-04-01T00-00-00-000Z.db';
    seedRetainedArtifact(oldest, '2026-01-01T00:00:00.000Z', 300 * 1024 * 1024);
    seedRetainedArtifact(newer, '2026-04-01T00:00:00.000Z', 300 * 1024 * 1024);
    state.files.get(oldest)!.lastModified = 1;
    state.files.get(newer)!.lastModified = 2;

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.files.has(oldest)).toBe(false);
    expect(state.files.has(newer)).toBe(true);
  });

  it('counts the artifact it just downloaded against the budget', async () => {
    // A survivor that exactly fills the 400 MB budget leaves no room for the
    // file this cycle downloaded — which is retained too whenever the cycle is
    // cut short before the import. Excluding it would let the directory settle
    // at budget-plus-one-artifact.
    const filling = 'file://cache-root/board-snapshots/tension-9-2026-01-01T00-00-00-000Z.db';
    seedRetainedArtifact(filling, '2026-01-01T00:00:00.000Z', 400 * 1024 * 1024);

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.files.has(filling)).toBe(false);
    expect(state.files.has(ARTIFACT_URI)).toBe(true);
  });

  it('retains nothing but the fresh artifact when free space is under the floor', async () => {
    const otherLayoutUri = 'file://cache-root/board-snapshots/tension-9-2026-05-01T00-00-00-000Z.db';
    seedRetainedArtifact(otherLayoutUri, '2026-05-01T00:00:00.000Z');
    // Above the 6x download requirement for a 1 MB entry, below the 1.5 GB
    // retention floor.
    state.availableDiskSpace = 900 * 1024 * 1024;

    await mobileSnapshotSource.downloadArtifact(ENTRY);

    expect(state.files.has(otherLayoutUri)).toBe(false);
    expect(state.files.has(ARTIFACT_URI)).toBe(true);
  });

  it('passes the caller’s AbortSignal through so a torn-down cycle cancels the transfer', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(mobileSnapshotSource.downloadArtifact(ENTRY, { signal: controller.signal })).rejects.toThrow(
      /transfer failed/,
    );
    expect(state.downloadCalls[0].hasSignal).toBe(true);
  });

  it('releaseArtifact deletes an IMPORTED artifact — its rows are in the database now', async () => {
    seedRetainedArtifact(ARTIFACT_URI, ENTRY.builtAt);

    await mobileSnapshotSource.releaseArtifact?.(ARTIFACT_URI.replace('file://', ''), { imported: true });

    expect(state.files.has(ARTIFACT_URI)).toBe(false);
    expect(state.files.has(SIDECAR_URI)).toBe(false);
  });

  it('releaseArtifact KEEPS an unimported artifact so the next cycle reuses it', async () => {
    seedRetainedArtifact(ARTIFACT_URI, ENTRY.builtAt);

    await mobileSnapshotSource.releaseArtifact?.(ARTIFACT_URI.replace('file://', ''), { imported: false });

    expect(state.files.has(ARTIFACT_URI)).toBe(true);
    expect(state.files.has(SIDECAR_URI)).toBe(true);
  });
});

// The layout's separate Boardsesh-grades artifact (issue #4310). Small next to
// the ~100 MB climbs file, but it removes hundreds of serial authenticated
// GraphQL pages from every Kilter and Tension download.
describe('downloadGradesArtifact', () => {
  const GRADES_ARTIFACT = {
    key: 'board-snapshots/v1-gzip/kilter/8/2026-06-01T00-00-00-000Z-grades.db',
    url: 'https://example.test/artifacts/kilter-8-grades.db',
    bytes: 2_000_000,
    contentEncoding: 'gzip' as const,
    builtAt: '2026-06-01T00:00:00.000Z',
    schemaVersion: 1,
    tables: {
      board_climb_grades: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 900 },
    },
  };

  it('downloads to a key-derived filename and returns a plain filesystem path', async () => {
    const result = await mobileSnapshotSource.downloadGradesArtifact?.(GRADES_ARTIFACT);

    expect(state.downloadCalls).toEqual([
      { url: GRADES_ARTIFACT.url, idempotent: true, hasOnProgress: false, hasSignal: false },
    ]);
    expect(result?.filePath.startsWith('file://')).toBe(false);
    // Key-derived: the manifest's grades block carries no board/layout pair,
    // and the key is already content-addressed by build stamp.
    expect(result?.filePath).toContain('board-snapshots-v1-gzip-kilter-8');
    // No completeness sidecar: a grades file is never retained across cycles
    // (the engine deletes it in its finally), so nothing may mark it reusable.
    expect([...state.files.keys()].some((uri) => uri.endsWith('.complete'))).toBe(false);
  });

  it('applies the same free-space guard as the whole-layout artifact', async () => {
    state.availableDiskSpace = GRADES_ARTIFACT.bytes * 2; // under the 6x gzip multiple

    await expect(mobileSnapshotSource.downloadGradesArtifact?.(GRADES_ARTIFACT)).rejects.toThrow(
      /insufficient disk space/,
    );
    expect(state.downloadCalls).toHaveLength(0);
  });

  it('permanently misses (and deletes) a body that arrived still gzip-compressed', async () => {
    state.downloadBytes = GZIP_BYTES;

    await expect(mobileSnapshotSource.downloadGradesArtifact?.(GRADES_ARTIFACT)).rejects.toThrow(
      SnapshotPermanentMissError,
    );
    expect(state.deletedUris).toHaveLength(1);
  });

  it('keeps the underlying download exception as `cause` for the transport classifier', async () => {
    const downloadError = Object.assign(new Error('The request timed out.'), {
      name: 'UnableToDownloadException',
    });
    state.downloadError = downloadError;

    const rejection = await mobileSnapshotSource.downloadGradesArtifact?.(GRADES_ARTIFACT).catch((error) => error);

    expect((rejection as Error).cause).toBe(downloadError);
  });
});
