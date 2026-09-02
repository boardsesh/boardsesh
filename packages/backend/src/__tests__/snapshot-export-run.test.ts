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
  getPublicUrl: vi.fn((_bucket: string, key: string) => `https://cdn.example/${key}`),
  uploadToS3: vi.fn(async (_bucket: string, _buffer: Buffer, key: string) => ({ key })),
  // The script reads the previous manifest through the STRICT variant (null =
  // genuinely missing; read errors throw).
  getFromS3Strict: vi.fn(async () => null),
  deleteFromS3: vi.fn(async () => {}),
  listS3Objects: vi.fn(async () => []),
}));

import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { LATEST_SCHEMA_VERSION, type SnapshotManifest, type SnapshotManifestEntry } from '@boardsesh/offline-sync';
import { createPool } from '@boardsesh/db/client';
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
    schemaVersion: LATEST_SCHEMA_VERSION,
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
function uploadedManifest(manifestKey = MANIFEST_KEY): SnapshotManifest {
  const manifestCalls = vi.mocked(uploadToS3).mock.calls.filter(([, , key]) => key === manifestKey);
  expect(manifestCalls.length).toBeGreaterThan(0);
  const [, buffer] = manifestCalls[manifestCalls.length - 1];
  return JSON.parse(buffer.toString('utf8')) as SnapshotManifest;
}

async function seedClimb(boardType: string, layoutId: number, uuid: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, updated_at)
    VALUES (${uuid}, ${boardType}, ${layoutId}, ${'Climb ' + uuid}, true, false, '{5}'::int[], '2026-05-01T00:00:00Z')
  `);
}

async function seedStatsDelta(boardType: string, climbUuid: string, count: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, updated_at)
    SELECT ${boardType}, ${climbUuid}, delta_number, 20, '2026-06-02T00:00:00Z'::timestamp
    FROM generate_series(1, ${count}) AS delta_number
  `);
}

async function seedClimbDelta(boardType: string, layoutId: number, count: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, updated_at)
    SELECT ${boardType + '-delta-'} || delta_number, ${boardType}, ${layoutId},
           'Delta climb ' || delta_number, true, false, '{5}'::int[], '2026-06-02T00:00:00Z'::timestamp
    FROM generate_series(1, ${count}) AS delta_number
  `);
}

async function seedGradesDelta(boardType: string, climbUuid: string, count: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, universal_grade, confidence,
       ascensionist_count, model_version, coeff_version, computed_at)
    SELECT ${boardType}, ${climbUuid}, delta_number, 20, 19, 'high',
           100, 'test-model', 'test-coeff', '2026-06-02T00:00:00Z'::timestamp
    FROM generate_series(1, ${count}) AS delta_number
  `);
}

function withGradesArtifact(
  entry: SnapshotManifestEntry,
  schemaVersion = LATEST_SCHEMA_VERSION,
): SnapshotManifestEntry {
  const gradesKey = entry.key.replace(/\.db$/, '-grades.db');
  return {
    ...entry,
    grades: {
      key: gradesKey,
      url: `https://cdn.example/${gradesKey}`,
      bytes: 42,
      contentEncoding: 'gzip',
      builtAt: entry.builtAt,
      schemaVersion,
      tables: {
        board_climb_grades: {
          watermarkUpdatedAt: '2026-05-01T00:00:00Z',
          watermarkSyncSeq: '10',
          rowCount: 1,
        },
      },
    },
  };
}

beforeEach(async () => {
  // clearAllMocks resets call records but NOT implementations, so re-pin every
  // implementation a test may have overridden (the throwing uploadToS3, the
  // rejecting listS3Objects) back to the happy path.
  vi.clearAllMocks();
  vi.mocked(uploadToS3).mockImplementation(async (_bucket, _buffer: Buffer, key: string) => ({
    url: `https://cdn.example/${key}`,
    key,
  }));
  vi.mocked(getFromS3Strict).mockResolvedValue(null);
  vi.mocked(listS3Objects).mockResolvedValue([]);
  vi.mocked(deleteFromS3).mockResolvedValue(undefined);
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades RESTART IDENTITY CASCADE`);
});

/** Seeds one Boardsesh grade row for a climb (the NOT NULL columns are required). */
async function seedGrade(boardType: string, climbUuid: string, angle: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, universal_grade, confidence,
       ascensionist_count, model_version, coeff_version, computed_at)
    VALUES (${boardType}, ${climbUuid}, ${angle}, 20, 19, 'high', 100, 'test-model', 'test-coeff',
            '2026-05-01T00:00:00Z'::timestamp)
  `);
}

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

describe('runExport — threshold refresh', () => {
  const GZIP_PREFIX = 'board-snapshots/v1-gzip';
  const GZIP_MANIFEST_KEY = `${GZIP_PREFIX}/manifest.json`;
  const thresholdArgs = ['--gzip', '--key-prefix', GZIP_PREFIX, '--refresh-threshold', '500'];

  it('is a true no-op below 500 post-manifest rows, including no manifest rewrite or prune', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedStatsDelta('kilter', 'k1-a', 499);
    serveExistingManifest(manifestFixture([manifestEntryFixture('kilter', 1, `${GZIP_PREFIX}/kilter/1/old.db`)]));

    await runExport(thresholdArgs);

    expect(getFromS3Strict).toHaveBeenCalledWith('snapshots', GZIP_MANIFEST_KEY);
    expect(uploadToS3).not.toHaveBeenCalled();
    expect(listS3Objects).not.toHaveBeenCalled();
  });

  it('rebuilds only the layout at the exact 500-row threshold and preserves every other entry', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedClimb('kilter', 2, 'k2-a');
    await seedStatsDelta('kilter', 'k1-a', 500);
    await seedStatsDelta('kilter', 'k2-a', 499);
    const staleLayout = manifestEntryFixture('kilter', 1, `${GZIP_PREFIX}/kilter/1/old.db`);
    const currentLayout = manifestEntryFixture('kilter', 2, `${GZIP_PREFIX}/kilter/2/old.db`);
    serveExistingManifest(manifestFixture([staleLayout, currentLayout]));

    await runExport(thresholdArgs);

    const artifactKeys = vi
      .mocked(uploadToS3)
      .mock.calls.map(([, , key]) => key)
      .filter((key) => !key.endsWith('/manifest.json'));
    expect(artifactKeys).toHaveLength(1);
    expect(artifactKeys[0]).toContain(`${GZIP_PREFIX}/kilter/1/`);
    const manifest = uploadedManifest(GZIP_MANIFEST_KEY);
    expect(manifest.entries.find((entry) => entry.layoutId === 1)?.key).not.toBe(staleLayout.key);
    expect(manifest.entries.find((entry) => entry.layoutId === 2)).toEqual(currentLayout);
    // A partial live refresh never has enough information to prune safely.
    expect(listS3Objects).not.toHaveBeenCalled();
  });

  it('keeps the previous live entry and uploads no replacement when the replay-boundary probe falls back', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedStatsDelta('kilter', 'k1-a', 1);
    const previousEntry = manifestEntryFixture('kilter', 1, `${GZIP_PREFIX}/kilter/1/old.db`);
    serveExistingManifest(manifestFixture([previousEntry]));

    // Temporarily advertise one connection so the observer probe fails closed:
    // the export transaction can still run, but its LayoutSnapshotResult carries
    // observer-pool-capacity and no boundary. Restore the shared pool immediately.
    const poolOptions = createPool().options as { max: number };
    const originalPoolMax = poolOptions.max;
    poolOptions.max = 1;
    try {
      await expect(runExport(['--gzip', '--key-prefix', GZIP_PREFIX, '--refresh-threshold', '1'])).rejects.toThrow(
        /Export failed for 1 layout\(s\): kilter:1/,
      );
    } finally {
      poolOptions.max = originalPoolMax;
    }

    const artifactUploads = vi.mocked(uploadToS3).mock.calls.filter(([, , key]) => key !== GZIP_MANIFEST_KEY);
    expect(artifactUploads).toHaveLength(0);
    expect(uploadToS3).toHaveBeenCalledTimes(1);
    expect(uploadedManifest(GZIP_MANIFEST_KEY).entries).toEqual([previousEntry]);
    expect(listS3Objects).not.toHaveBeenCalled();
  });

  it('uses the climbs watermark too', async () => {
    await seedClimbDelta('kilter', 1, 1);
    const previousEntry = manifestEntryFixture('kilter', 1, `${GZIP_PREFIX}/kilter/1/old.db`);
    serveExistingManifest(manifestFixture([previousEntry]));

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX, '--refresh-threshold', '1']);

    expect(uploadedManifest(GZIP_MANIFEST_KEY).entries[0].key).not.toBe(previousEntry.key);
  });

  it('uses the grades computed_at/sync_seq watermark and rebuilds at 500 rows', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedGradesDelta('kilter', 'k1-a', 500);
    const previousEntry = withGradesArtifact(manifestEntryFixture('kilter', 1, `${GZIP_PREFIX}/kilter/1/old.db`));
    serveExistingManifest(manifestFixture([previousEntry]));

    await runExport(thresholdArgs);

    const refreshedEntry = uploadedManifest(GZIP_MANIFEST_KEY).entries[0];
    expect(refreshedEntry.key).not.toBe(previousEntry.key);
    expect(refreshedEntry.grades?.tables.board_climb_grades.rowCount).toBe(500);
    expect(vi.mocked(uploadToS3).mock.calls.some(([, , key]) => key.endsWith('-grades.db'))).toBe(true);
  });

  it('rebuilds when an existing grades artifact has an older client schema', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedGrade('kilter', 'k1-a', 40);
    const previousEntry = withGradesArtifact(
      manifestEntryFixture('kilter', 1, `${GZIP_PREFIX}/kilter/1/old.db`),
      LATEST_SCHEMA_VERSION - 1,
    );
    serveExistingManifest(manifestFixture([previousEntry]));

    await runExport(thresholdArgs);

    const refreshedEntry = uploadedManifest(GZIP_MANIFEST_KEY).entries[0];
    expect(refreshedEntry.key).not.toBe(previousEntry.key);
    expect(refreshedEntry.grades?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
  });

  it('rebuilds every discovered layout when the live manifest is missing', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedClimb('tension', 9, 't9-a');
    // getFromS3Strict defaults to null: a genuinely missing manifest.

    await runExport(thresholdArgs);

    expect(uploadedManifest(GZIP_MANIFEST_KEY).entries.map((entry) => `${entry.boardType}:${entry.layoutId}`)).toEqual([
      'kilter:1',
      'tension:9',
    ]);
  });

  it('treats an invalid manifest as fatal before uploading because a partial refresh cannot merge safely', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    serveManifestBody('{{{ not json');

    await expect(runExport(thresholdArgs)).rejects.toThrow(/filtered run cannot merge safely/);
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('rejects a missing, zero, or non-integer threshold before touching S3', async () => {
    await expect(runExport(['--refresh-threshold'])).rejects.toThrow(/expects a positive integer/);
    await expect(runExport(['--refresh-threshold=0'])).rejects.toThrow(/expects a positive integer/);
    await expect(runExport(['--refresh-threshold=1.5'])).rejects.toThrow(/expects a positive integer/);
    await expect(runExport(['--dry-run', '--refresh-threshold=500'])).rejects.toThrow(
      /cannot be combined with --refresh-threshold/,
    );
    expect(uploadToS3).not.toHaveBeenCalled();
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
    vi.mocked(uploadToS3).mockImplementation(async (_bucket, _buffer: Buffer, key: string) => {
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

    expect(listS3Objects).toHaveBeenCalledWith('snapshots', 'board-snapshots/v1/');
    expect(deleteFromS3).toHaveBeenCalledTimes(1);
    expect(deleteFromS3).toHaveBeenCalledWith('snapshots', 'board-snapshots/v1/kilter/1/ancient.db');
  });

  it('never prunes an artifact referenced by the manifest just written', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    vi.mocked(listS3Objects).mockImplementation(async () => {
      // Derive the just-uploaded artifact key from the recorded upload calls, so
      // the listing contains a REFERENCED old-looking object.
      const artifactCall = vi.mocked(uploadToS3).mock.calls.find(([, , key]) => key !== MANIFEST_KEY)!;
      return [{ key: artifactCall[2], size: 10, lastModified: thirtyDaysAgo }];
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

describe('runExport — SNAPSHOT_PUBLIC_BASE_URL', () => {
  // Tigris only serves public objects on the bucket's virtual-host domain; the
  // S3 endpoint's path-style URLs (what getPublicUrl builds) 403 unauthenticated
  // GETs even on a public bucket. The env var re-bases entry URLs onto the
  // public host so the app can actually download what the manifest points at.
  it('builds manifest entry URLs on the public base when set (trailing slash tolerated)', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    process.env.SNAPSHOT_PUBLIC_BASE_URL = 'https://boardsesh-board-snapshots.t3.tigrisfiles.io/';
    try {
      await runExport([]);
    } finally {
      delete process.env.SNAPSHOT_PUBLIC_BASE_URL;
    }

    const entry = uploadedManifest().entries[0];
    expect(entry.url).toBe(`https://boardsesh-board-snapshots.t3.tigrisfiles.io/${entry.key}`);
  });

  it('falls back to the store URL when unset', async () => {
    await seedClimb('kilter', 1, 'k1-a');

    await runExport([]);

    const entry = uploadedManifest().entries[0];
    expect(entry.url).toBe(`https://cdn.example/${entry.key}`);
  });
});

describe('runExport — gzip + key-prefix (dual-publish transition)', () => {
  const GZIP_PREFIX = 'board-snapshots/v1-gzip';
  const GZIP_MANIFEST_KEY = `${GZIP_PREFIX}/manifest.json`;

  /** uploadToS3 calls for artifacts (everything that isn't a manifest write). */
  function artifactUploadCalls(): unknown[][] {
    return vi.mocked(uploadToS3).mock.calls.filter(([, , key]) => !String(key).endsWith('/manifest.json'));
  }

  it('default run stays identity under board-snapshots/v1 (regression guard for the live fleet)', async () => {
    await seedClimb('kilter', 1, 'k1-a');

    await runExport([]);

    const entry = uploadedManifest().entries[0];
    expect(entry.contentEncoding).toBe('identity');
    expect(entry.key.startsWith('board-snapshots/v1/')).toBe(true);
    // No gzip option on the artifact upload → S3 stores it identity-encoded.
    const [, , , , options] = artifactUploadCalls()[0];
    expect(options).toBeUndefined();
  });

  it('--gzip --key-prefix publishes a gzip manifest under the new prefix, never touching v1', async () => {
    await seedClimb('kilter', 1, 'k1-a');

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX]);

    // Reads and writes its OWN manifest, isolated from the identity v1 one.
    expect(getFromS3Strict).toHaveBeenCalledWith('snapshots', GZIP_MANIFEST_KEY);
    const manifestCalls = vi.mocked(uploadToS3).mock.calls.filter(([, , key]) => key === GZIP_MANIFEST_KEY);
    expect(manifestCalls.length).toBe(1);
    const manifest = JSON.parse((manifestCalls[0][1] as Buffer).toString('utf8')) as SnapshotManifest;

    const entry = manifest.entries[0];
    expect(entry.contentEncoding).toBe('gzip');
    expect(entry.key.startsWith(`${GZIP_PREFIX}/kilter/1/`)).toBe(true);
    expect(entry.url).toContain(GZIP_PREFIX);
    // The identity (v1) manifest is not written by a gzip run.
    expect(vi.mocked(uploadToS3).mock.calls.some(([, , key]) => key === MANIFEST_KEY)).toBe(false);

    // The artifact object is uploaded gzip-compressed with Content-Encoding: gzip.
    const [, body, key, , options] = artifactUploadCalls()[0];
    expect(String(key)).toContain(`${GZIP_PREFIX}/kilter/1/`);
    expect(options).toEqual({ contentEncoding: 'gzip' });
    expect((body as Buffer)[0]).toBe(0x1f); // gzip magic
    expect((body as Buffer)[1]).toBe(0x8b);
  });

  it('--gzip publishes the pre-compression size in uncompressedBytes, distinct from the stored bytes', async () => {
    await seedClimb('kilter', 1, 'k1-a');

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX]);

    const manifestCalls = vi.mocked(uploadToS3).mock.calls.filter(([, , key]) => key === GZIP_MANIFEST_KEY);
    const manifest = JSON.parse((manifestCalls[0][1] as Buffer).toString('utf8')) as SnapshotManifest;
    const entry = manifest.entries[0];
    const [, gzippedBody] = artifactUploadCalls()[0];

    // `bytes` is what S3 stores (and what the client downloads); uncompressedBytes
    // is the SQLite file that lands on disk after gunzip — strictly larger here.
    expect(entry.bytes).toBe((gzippedBody as Buffer).length);
    expect(entry.uncompressedBytes).toBeGreaterThan(entry.bytes);
  });

  it('an identity run reports uncompressedBytes equal to bytes', async () => {
    await seedClimb('kilter', 1, 'k1-a');

    await runExport([]);

    const entry = uploadedManifest().entries[0];
    expect(entry.uncompressedBytes).toBe(entry.bytes);
  });

  it('a merged previous entry that predates uncompressedBytes rides through without it', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    // The fixture deliberately omits uncompressedBytes — every entry published
    // before this field existed looks like this, and the merge must not invent one.
    const legacyEntry = manifestEntryFixture('tension', 9, 'board-snapshots/v1/tension/9/old.db');
    expect(legacyEntry.uncompressedBytes).toBeUndefined();
    serveExistingManifest(manifestFixture([legacyEntry]));

    await runExport(['--board', 'kilter']);

    const merged = uploadedManifest().entries.find((entry) => entry.boardType === 'tension')!;
    expect(merged).toEqual(legacyEntry);
    expect(merged.uncompressedBytes).toBeUndefined();
  });

  it('rejects an unsafe --key-prefix before any upload', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await expect(runExport(['--key-prefix', '../evil'])).rejects.toThrow(/--key-prefix expects a safe key/);
    await expect(runExport(['--key-prefix'])).rejects.toThrow(/--key-prefix expects a safe key/);
    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('rejects an identity export aimed at the live gzip prefix before any upload', async () => {
    await seedClimb('kilter', 1, 'k1-a');

    await expect(runExport(['--key-prefix', GZIP_PREFIX])).rejects.toThrow(
      '--key-prefix board-snapshots/v1-gzip requires --gzip',
    );

    expect(uploadToS3).not.toHaveBeenCalled();
  });

  it('prunes only within the gzip prefix, never the identity prefix', async () => {
    await seedClimb('kilter', 1, 'k1-a');

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX]);

    expect(listS3Objects).toHaveBeenCalledWith('snapshots', `${GZIP_PREFIX}/`);
    expect(listS3Objects).not.toHaveBeenCalledWith('snapshots', 'board-snapshots/v1/');
  });

  it('honors --board/--layout under --gzip --key-prefix (filtered canary of one layout)', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedClimb('kilter', 2, 'k2-a');

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX, '--board', 'kilter', '--layout', '1']);

    const manifestCalls = vi.mocked(uploadToS3).mock.calls.filter(([, , key]) => key === GZIP_MANIFEST_KEY);
    const manifest = JSON.parse((manifestCalls[0][1] as Buffer).toString('utf8')) as SnapshotManifest;
    // Only the filtered layout was built, gzip-encoded, under the gzip prefix.
    expect(manifest.entries.map((entry) => `${entry.boardType}:${entry.layoutId}`)).toEqual(['kilter:1']);
    expect(manifest.entries[0].contentEncoding).toBe('gzip');
    expect(manifest.entries[0].key.startsWith(`${GZIP_PREFIX}/kilter/1/`)).toBe(true);
    // A filtered run never prunes.
    expect(listS3Objects).not.toHaveBeenCalled();
  });
});

// The separate per-layout grades artifact (issue #4310). It rides under the same
// key prefix as the whole-layout artifact but is referenced through the entry's
// optional `grades` block, never as its own `entries` element.
describe('runExport — board_climb_grades artifacts', () => {
  const GZIP_PREFIX = 'board-snapshots/v1-gzip';
  const GZIP_MANIFEST_KEY = `${GZIP_PREFIX}/manifest.json`;

  function gzipManifest(): SnapshotManifest {
    const manifestCalls = vi.mocked(uploadToS3).mock.calls.filter(([, , key]) => key === GZIP_MANIFEST_KEY);
    expect(manifestCalls.length).toBeGreaterThan(0);
    return JSON.parse((manifestCalls[manifestCalls.length - 1][1] as Buffer).toString('utf8')) as SnapshotManifest;
  }

  it('publishes a grades artifact and references it from the entry, not from `entries`', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedGrade('kilter', 'k1-a', 40);

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX]);

    const manifest = gzipManifest();
    // One entry per (board, layout) — the grades file must never become a
    // sibling entry, because findSnapshotEntry first-matches on that pair.
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0];
    expect(entry.grades).toBeDefined();
    expect(entry.grades?.key).toBe(`${entry.key.replace(/\.db$/, '')}-grades.db`);
    expect(entry.grades?.contentEncoding).toBe('gzip');
    expect(entry.grades?.tables.board_climb_grades.rowCount).toBe(1);
    // The whole-layout entry's own fields are untouched.
    expect(Object.keys(entry.tables).sort()).toEqual(['board_climb_stats', 'board_climbs']);
    expect(manifest.formatVersion).toBe(1);

    const gradesUpload = vi.mocked(uploadToS3).mock.calls.find(([, , key]) => String(key).endsWith('-grades.db'))!;
    expect(gradesUpload[4]).toEqual({ contentEncoding: 'gzip' });
    expect((gradesUpload[1] as Buffer)[0]).toBe(0x1f); // gzip magic
  });

  it('omits `grades` for a layout with no grade rows (every MoonBoard layout)', async () => {
    await seedClimb('kilter', 1, 'k1-a');

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX]);

    expect(gzipManifest().entries[0].grades).toBeUndefined();
    expect(vi.mocked(uploadToS3).mock.calls.some(([, , key]) => String(key).endsWith('-grades.db'))).toBe(false);
  });

  it('publishes NO grades artifact on the identity rollback pass — that prefix is the kill switch', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedGrade('kilter', 'k1-a', 40);

    await runExport([]);

    expect(uploadedManifest().entries[0].grades).toBeUndefined();
    expect(vi.mocked(uploadToS3).mock.calls.some(([, , key]) => String(key).endsWith('-grades.db'))).toBe(false);
  });

  it('never prunes a grades artifact the manifest just published', async () => {
    // Grades keys are not in `entries`, so a prune that only walks entry.key
    // would delete live grades files out from under every client holding the
    // current manifest.
    await seedClimb('kilter', 1, 'k1-a');
    await seedGrade('kilter', 'k1-a', 40);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    vi.mocked(listS3Objects).mockImplementation(async () =>
      vi
        .mocked(uploadToS3)
        .mock.calls.filter(([, , key]) => !String(key).endsWith('/manifest.json'))
        .map(([, , key]) => ({ key: String(key), size: 10, lastModified: thirtyDaysAgo })),
    );

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX]);

    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('prunes a SUPERSEDED grades artifact once it leaves the grace window', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    await seedGrade('kilter', 'k1-a', 40);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    vi.mocked(listS3Objects).mockResolvedValue([
      { key: `${GZIP_PREFIX}/kilter/1/ancient-grades.db`, size: 10, lastModified: thirtyDaysAgo },
    ]);

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX]);

    expect(deleteFromS3).toHaveBeenCalledWith('snapshots', `${GZIP_PREFIX}/kilter/1/ancient-grades.db`);
  });

  it('a filtered run preserves another board’s previously-published grades block', async () => {
    await seedClimb('kilter', 1, 'k1-a');
    const previousTension: SnapshotManifestEntry = {
      ...manifestEntryFixture('tension', 9, `${GZIP_PREFIX}/tension/9/old.db`),
      grades: {
        key: `${GZIP_PREFIX}/tension/9/old-grades.db`,
        url: `https://cdn.example/${GZIP_PREFIX}/tension/9/old-grades.db`,
        bytes: 42,
        contentEncoding: 'gzip',
        builtAt: '2026-06-01T00:00:00.000Z',
        schemaVersion: LATEST_SCHEMA_VERSION,
        tables: {
          board_climb_grades: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '9', rowCount: 4 },
        },
      },
    };
    serveExistingManifest(manifestFixture([previousTension]));

    await runExport(['--gzip', '--key-prefix', GZIP_PREFIX, '--board', 'kilter']);

    const tensionEntry = gzipManifest().entries.find((entry) => entry.boardType === 'tension')!;
    expect(tensionEntry.grades?.key).toBe(`${GZIP_PREFIX}/tension/9/old-grades.db`);
  });
});
