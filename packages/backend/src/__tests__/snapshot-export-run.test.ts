// runExport-level behaviour of the nightly board-snapshot export: manifest
// MERGE semantics (a filtered run must not clobber other boards' entries),
// per-layout failure resilience (one bad layout still publishes everyone
// else's entries, then fails the run), and stale-artifact pruning (unfiltered
// successful runs only, 14-day grace, never fatal).
//
// S3 is mocked at the storage/s3 function boundary (the beta-link-thumbnails
// precedent); Postgres is the real worker test DB.

import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';

vi.mock('../storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  getPublicUrl: vi.fn((key: string) => `https://cdn.example/${key}`),
  uploadToS3: vi.fn(async (_buffer: Buffer, key: string) => ({ url: `https://cdn.example/${key}`, key })),
  // The script reads the previous manifest through the STRICT variant (null =
  // genuinely missing; read errors throw).
  getFromS3Strict: vi.fn(async () => null),
  deleteFromS3: vi.fn(async () => {}),
  listS3Objects: vi.fn(async () => []),
}));

import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { SnapshotManifest, SnapshotManifestEntry } from '@boardsesh/offline-sync';
import { db } from '../db/client';
import { uploadToS3, getFromS3Strict, deleteFromS3, listS3Objects } from '../storage/s3';
import { runExport, mergeManifestEntries } from '../scripts/export-board-snapshots';

const MANIFEST_KEY = 'board-snapshots/v1/manifest.json';

function manifestEntryFixture(boardType: string, layoutId: number, key: string): SnapshotManifestEntry {
  return {
    boardType,
    layoutId,
    key,
    url: `https://cdn.example/${key}`,
    bytes: 1234,
    contentEncoding: 'gzip',
    builtAt: '2026-06-01T00:00:00.000Z',
    schemaVersion: 3,
    tables: {
      board_climbs: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 5 },
      board_climb_stats: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '7', rowCount: 3 },
    },
  };
}

function manifestFixture(entries: SnapshotManifestEntry[]): SnapshotManifest {
  return { formatVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', entries };
}

/** Serves `manifest` as the previous manifest through the getFromS3Strict mock. */
function serveExistingManifest(manifest: SnapshotManifest): void {
  serveManifestBody(JSON.stringify(manifest));
}

/** Serves an arbitrary (possibly invalid) previous-manifest body. */
function serveManifestBody(body: string): void {
  vi.mocked(getFromS3Strict).mockResolvedValue({
    stream: Readable.from([Buffer.from(body)]),
    contentType: 'application/json',
    contentLength: undefined,
  });
}

/** Parses the manifest JSON out of the uploadToS3 mock's manifest-key call. */
function uploadedManifest(): SnapshotManifest {
  const manifestCalls = vi.mocked(uploadToS3).mock.calls.filter(([, key]) => key === MANIFEST_KEY);
  expect(manifestCalls.length).toBeGreaterThan(0);
  const [buffer] = manifestCalls[manifestCalls.length - 1];
  return JSON.parse(buffer.toString('utf8')) as SnapshotManifest;
}

async function seedClimb(boardType: string, layoutId: number, uuid: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, updated_at)
    VALUES (${uuid}, ${boardType}, ${layoutId}, ${'Climb ' + uuid}, true, false, '{5}'::int[], '2026-05-01T00:00:00Z')
  `);
}

beforeEach(async () => {
  // clearAllMocks resets call records but NOT implementations, so re-pin every
  // implementation a test may have overridden (the throwing uploadToS3, the
  // rejecting listS3Objects) back to the happy path.
  vi.clearAllMocks();
  vi.mocked(uploadToS3).mockImplementation(async (_buffer: Buffer, key: string) => ({
    url: `https://cdn.example/${key}`,
    key,
  }));
  vi.mocked(getFromS3Strict).mockResolvedValue(null);
  vi.mocked(listS3Objects).mockResolvedValue([]);
  vi.mocked(deleteFromS3).mockResolvedValue(undefined);
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats RESTART IDENTITY CASCADE`);
});

describe('mergeManifestEntries', () => {
  const kilterOld = manifestEntryFixture('kilter', 1, 'board-snapshots/v1/kilter/1/old.db');
  const kilterNew = manifestEntryFixture('kilter', 1, 'board-snapshots/v1/kilter/1/new.db');
  const tensionOld = manifestEntryFixture('tension', 9, 'board-snapshots/v1/tension/9/old.db');

  it('filtered semantics (livePairs null): upserts new entries, preserves every other previous entry', () => {
    const merged = mergeManifestEntries({
      previousEntries: [kilterOld, tensionOld],
      newEntries: [kilterNew],
      livePairs: null,
    });
    expect(merged).toEqual([kilterNew, tensionOld]);
  });

  it('unfiltered semantics: drops previous entries whose pair is no longer live', () => {
    const merged = mergeManifestEntries({
      previousEntries: [kilterOld, tensionOld],
      newEntries: [kilterNew],
      livePairs: [{ boardType: 'kilter', layoutId: 1 }],
    });
    expect(merged).toEqual([kilterNew]);
  });

  it('unfiltered semantics: a live pair with no new entry (failed layout) keeps its previous entry', () => {
    const merged = mergeManifestEntries({
      previousEntries: [kilterOld, tensionOld],
      newEntries: [],
      livePairs: [
        { boardType: 'kilter', layoutId: 1 },
        { boardType: 'tension', layoutId: 9 },
      ],
    });
    expect(merged).toEqual([kilterOld, tensionOld]);
  });
});

describe('runExport — manifest merge on filtered runs', () => {
  it('fails fast when --board is missing its value', async () => {
    await expect(runExport(['--board'])).rejects.toThrow('--board expects a board type');
    await expect(runExport(['--board', '--layout', '1'])).rejects.toThrow('--board expects a board type');
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('a --board run preserves other boards’ manifest entries instead of clobbering them', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    const foreignEntry = manifestEntryFixture('tension', 9, 'board-snapshots/v1/tension/9/old.db');
    const staleKilterEntry = manifestEntryFixture('kilter', 1, 'board-snapshots/v1/kilter/1/old.db');
    serveExistingManifest(manifestFixture([foreignEntry, staleKilterEntry]));

    await runExport(['--board', 'kilter']);

    const manifest = uploadedManifest();
    const entryKeys = manifest.entries.map((entry) => `${entry.boardType}:${entry.layoutId}`);
    expect(entryKeys).toEqual(['kilter:1', 'tension:9']);
    // The foreign entry rides through verbatim; the kilter entry is the fresh one.
    expect(manifest.entries.find((entry) => entry.boardType === 'tension')).toEqual(foreignEntry);
    const refreshedKilter = manifest.entries.find((entry) => entry.boardType === 'kilter')!;
    expect(refreshedKilter.key).not.toBe(staleKilterEntry.key);
    expect(refreshedKilter.tables.board_climbs.rowCount).toBe(1);
  });

  it('an unfiltered run drops entries for layouts that no longer exist in the DB', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    const vanishedEntry = manifestEntryFixture('tension', 9, 'board-snapshots/v1/tension/9/old.db');
    serveExistingManifest(manifestFixture([vanishedEntry]));

    await runExport([]);

    const manifest = uploadedManifest();
    expect(manifest.entries.map((entry) => `${entry.boardType}:${entry.layoutId}`)).toEqual(['kilter:1']);
  });
});

describe('runExport — previous-manifest failure matrix', () => {
  it('S3 read error on a filtered run aborts BEFORE anything is uploaded', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    vi.mocked(getFromS3Strict).mockRejectedValue(new Error('S3 connection reset'));

    await expect(runExport(['--board', 'kilter'])).rejects.toThrow(/S3 connection reset/);

    // Nothing was uploaded: no artifacts, no manifest.
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('S3 read error on an unfiltered run also aborts before anything is uploaded (failed layouts need previous entries too)', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    vi.mocked(getFromS3Strict).mockRejectedValue(new Error('S3 connection reset'));

    await expect(runExport([])).rejects.toThrow(/S3 connection reset/);
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('manifest genuinely missing (strict null) on a filtered run proceeds against an empty previous manifest', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    // beforeEach default: getFromS3Strict resolves null (NoSuchKey — first run).

    await runExport(['--board', 'kilter']);

    const manifest = uploadedManifest();
    expect(manifest.entries.map((entry) => `${entry.boardType}:${entry.layoutId}`)).toEqual(['kilter:1']);
  });

  it('unparseable previous manifest is FATAL on a filtered run (it cannot reconstruct what it would drop)', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    serveManifestBody('{{{ not json');

    await expect(runExport(['--board', 'kilter'])).rejects.toThrow(/filtered run cannot merge safely/);
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('schema-invalid previous manifest is FATAL on a filtered run too', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    serveManifestBody(JSON.stringify({ formatVersion: 999, generatedAt: 'x', entries: [] }));

    await expect(runExport(['--board', 'kilter'])).rejects.toThrow(/filtered run cannot merge safely/);
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('unparseable previous manifest on an UNFILTERED run warns and continues (it rebuilds everything anyway)', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    serveManifestBody('{{{ not json');

    await expect(runExport([])).resolves.toBeUndefined();

    const manifest = uploadedManifest();
    expect(manifest.entries.map((entry) => `${entry.boardType}:${entry.layoutId}`)).toEqual(['kilter:1']);
  });
});

describe('runExport — per-layout failure resilience', () => {
  it('one failing layout still publishes the successful entries, preserves the failed layout’s previous entry, and exits non-zero', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedClimb('kilter', 2, 'k2-a');
    const previousLayout2Entry = manifestEntryFixture('kilter', 2, 'board-snapshots/v1/kilter/2/old.db');
    serveExistingManifest(manifestFixture([previousLayout2Entry]));

    // Fail exactly layout 2's artifact upload; every other upload succeeds.
    vi.mocked(uploadToS3).mockImplementation(async (_buffer: Buffer, key: string) => {
      if (key.includes('/kilter/2/')) throw new Error('simulated S3 outage for layout 2');
      return { url: `https://cdn.example/${key}`, key };
    });

    await expect(runExport([])).rejects.toThrow(/Export failed for 1 layout\(s\): kilter:2/);

    // The manifest still went out, carrying the fresh layout-1 entry and the
    // PREVIOUS layout-2 entry (old artifacts are immutable, so it stays valid).
    const manifest = uploadedManifest();
    const byPair = new Map(manifest.entries.map((entry) => [`${entry.boardType}:${entry.layoutId}`, entry]));
    expect([...byPair.keys()].sort()).toEqual(['kilter:1', 'kilter:2']);
    expect(byPair.get('kilter:2')).toEqual(previousLayout2Entry);
    expect(byPair.get('kilter:1')!.key).toContain('board-snapshots/v1/kilter/1/');

    // Pruning is skipped on a failure night.
    expect(listS3Objects).not.toHaveBeenCalled();
    expect(deleteFromS3).not.toHaveBeenCalled();
  });
});

describe('runExport — stale-artifact pruning', () => {
  it('an unfiltered successful run prunes unreferenced artifacts older than the grace window only', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    vi.mocked(listS3Objects).mockResolvedValue([
      // Unreferenced + old → pruned.
      { key: 'board-snapshots/v1/kilter/1/ancient.db', size: 10, lastModified: thirtyDaysAgo },
      // Unreferenced but inside the grace window → kept.
      { key: 'board-snapshots/v1/kilter/1/yesterday.db', size: 10, lastModified: oneDayAgo },
      // The manifest itself is always kept, whatever its age.
      { key: MANIFEST_KEY, size: 10, lastModified: thirtyDaysAgo },
    ]);

    await runExport([]);

    expect(listS3Objects).toHaveBeenCalledWith('board-snapshots/v1/');
    expect(deleteFromS3).toHaveBeenCalledTimes(1);
    expect(deleteFromS3).toHaveBeenCalledWith('board-snapshots/v1/kilter/1/ancient.db');
  });

  it('never prunes an artifact referenced by the manifest just written', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    vi.mocked(listS3Objects).mockImplementation(async () => {
      // Derive the just-uploaded artifact key from the recorded upload calls, so
      // the listing contains a REFERENCED old-looking object.
      const artifactCall = vi.mocked(uploadToS3).mock.calls.find(([, key]) => key !== MANIFEST_KEY)!;
      return [{ key: artifactCall[1], size: 10, lastModified: thirtyDaysAgo }];
    });

    await runExport([]);

    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('a filtered run never prunes', async () => {
    await seedClimb('kilter', 1, 'k1-a');

    await runExport(['--board', 'kilter']);

    expect(listS3Objects).not.toHaveBeenCalled();
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('a prune failure is swallowed — the run still succeeds', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    vi.mocked(listS3Objects).mockRejectedValue(new Error('ListObjectsV2 exploded'));

    await expect(runExport([])).resolves.toBeUndefined();
  });
});
