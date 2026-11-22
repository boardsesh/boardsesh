import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeMetadata = { exists: boolean; size?: number | null };

const filesystem = vi.hoisted(() => ({
  metadata: new Map<string, FakeMetadata>(),
  failures: new Set<string>(),
  inspected: [] as string[],
}));

vi.mock('expo-file-system', () => {
  class Entry {
    readonly uri: string;

    constructor(...segments: (string | Entry)[]) {
      this.uri = segments.map((segment) => (typeof segment === 'string' ? segment : segment.uri)).join('/');
    }

    info(): FakeMetadata {
      filesystem.inspected.push(this.uri);
      if (filesystem.failures.has(this.uri)) throw new Error('EACCES');
      return filesystem.metadata.get(this.uri) ?? { exists: false };
    }

    get size(): never {
      throw new Error('Use info(): native File.size can mask a read failure as zero');
    }
  }

  return { Directory: Entry, File: Entry, Paths: { document: 'document', cache: 'cache' } };
});

// Importing this sampler must not initialize SQLite or the spray photo lifecycle.
vi.mock('../../db/connection', () => {
  throw new Error('Storage measurement must not initialize the database');
});
vi.mock('../../lib/spray/spray-photo-store', () => {
  throw new Error('Storage measurement must not initialize the spray photo store');
});

import { measureOfflineDownloadStorage } from '../download-storage-measurement';

const DATABASE_PATH = 'document/SQLite/boardsesh.db';
const WAL_PATH = `${DATABASE_PATH}-wal`;
const SHM_PATH = `${DATABASE_PATH}-shm`;
const ARTIFACT_PATH = 'cache/board-snapshots';
const PHOTO_PATH = 'document/spray-wall-photos';
const MEASURED_PATHS = [DATABASE_PATH, WAL_PATH, SHM_PATH, ARTIFACT_PATH, PHOTO_PATH];

beforeEach(() => {
  filesystem.metadata.clear();
  filesystem.failures.clear();
  filesystem.inspected.length = 0;
});

describe('measureOfflineDownloadStorage', () => {
  it('counts the database, WAL, SHM, retained artifacts and durable wall photos', () => {
    filesystem.metadata.set(DATABASE_PATH, { exists: true, size: 100_000_000 });
    filesystem.metadata.set(WAL_PATH, { exists: true, size: 30_000_000 });
    filesystem.metadata.set(SHM_PATH, { exists: true, size: 32_768 });
    filesystem.metadata.set(ARTIFACT_PATH, { exists: true, size: 270_000_000 });
    filesystem.metadata.set(PHOTO_PATH, { exists: true, size: 8_000_000 });

    expect(measureOfflineDownloadStorage()).toEqual({
      databaseBytes: 130_032_768,
      artifactBytes: 270_000_000,
      photoBytes: 8_000_000,
      totalBytes: 408_032_768,
    });
    expect(filesystem.inspected).toEqual(MEASURED_PATHS);
  });

  it('treats nonexistent files and directories as zero without opening the database', () => {
    expect(measureOfflineDownloadStorage()).toEqual({
      databaseBytes: 0,
      artifactBytes: 0,
      photoBytes: 0,
      totalBytes: 0,
    });
    expect(filesystem.inspected).toEqual(MEASURED_PATHS);
  });

  it('allows absent sidecars and known empty directories', () => {
    filesystem.metadata.set(DATABASE_PATH, { exists: true, size: 4096 });
    filesystem.metadata.set(ARTIFACT_PATH, { exists: true, size: 0 });

    expect(measureOfflineDownloadStorage()).toEqual({
      databaseBytes: 4096,
      artifactBytes: 0,
      photoBytes: 0,
      totalBytes: 4096,
    });
  });

  it.each(MEASURED_PATHS)('returns an unknown sample if %s exists but has no size', (path) => {
    filesystem.metadata.set(path, { exists: true });
    expect(measureOfflineDownloadStorage()).toBeNull();
  });

  it.each(MEASURED_PATHS)('returns an unknown sample if %s has a null size', (path) => {
    filesystem.metadata.set(path, { exists: true, size: null });
    expect(measureOfflineDownloadStorage()).toBeNull();
  });

  it.each(MEASURED_PATHS)('returns an unknown sample if reading %s throws', (path) => {
    filesystem.failures.add(path);
    expect(measureOfflineDownloadStorage()).toBeNull();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid byte measurement: %s',
    (bytes) => {
      filesystem.metadata.set(DATABASE_PATH, { exists: true, size: bytes });
      expect(measureOfflineDownloadStorage()).toBeNull();
    },
  );

  it('rejects an aggregate that cannot be represented as an exact integer', () => {
    filesystem.metadata.set(DATABASE_PATH, { exists: true, size: Number.MAX_SAFE_INTEGER });
    filesystem.metadata.set(ARTIFACT_PATH, { exists: true, size: 1 });

    expect(measureOfflineDownloadStorage()).toBeNull();
  });

  it('takes a fresh sample each time instead of retaining a stale total', () => {
    filesystem.metadata.set(DATABASE_PATH, { exists: true, size: 4096 });
    expect(measureOfflineDownloadStorage()?.totalBytes).toBe(4096);

    filesystem.metadata.set(WAL_PATH, { exists: true, size: 8192 });

    expect(measureOfflineDownloadStorage()?.totalBytes).toBe(12_288);
  });
});
