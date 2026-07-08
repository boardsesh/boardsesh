// Snapshot-bootstrap coverage (offline-sync Phase 3) against the REAL client DDL.
//
// Fixture artifacts are built with node:sqlite (the same engine expo-sqlite and
// the export job use) so ATTACH, quick_check, json_each size filtering, and the
// column-intersection copy all run for real — no mocking of the SQLite layer.
// Two surfaces are exercised: `bootstrapScopeFromSnapshot` directly (import
// filter, verification, drift, wipe rollback) and `pullSync` end-to-end (the
// eligibility/failure matrix, artifact reuse, delta continuity, deletions rewind).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueryInvalidator } from '../../database';
import { pullSync } from '../pull-client';
import { bootstrapScopeFromSnapshot, SnapshotSchemaStaleError, type SnapshotSource } from '../snapshot-bootstrap';
import { getCheckpoint, setCheckpoint, DELETIONS_CHECKPOINT_KEY } from '../checkpoints';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { setSigningOut, __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { SCHEMA_STATEMENTS } from '../../db/schema';
import type { OfflineBoardScope } from '../../offline-board-key';
import type { SnapshotManifest, SnapshotManifestEntry } from '../snapshot-manifest';

const SNAPSHOT_META_DDL = `
CREATE TABLE IF NOT EXISTS snapshot_meta (
  table_name TEXT PRIMARY KEY,
  watermark_updated_at TEXT,
  watermark_sync_seq TEXT,
  row_count INTEGER,
  built_at TEXT,
  schema_version INTEGER,
  format_version INTEGER
);`;

type Cursor = { updatedAt: string; syncSeq: string };

type ClimbInput = {
  uuid: string;
  boardType?: string;
  layoutId?: number;
  compatibleSizeIds: number[] | null;
  name?: string;
  updatedAt?: string;
  syncSeq?: number;
};

type StatInput = {
  climbUuid: string;
  boardType?: string;
  angle?: number;
  displayDifficulty?: number | null;
  updatedAt?: string;
  syncSeq?: number;
};

type ArtifactSpec = {
  filePath: string;
  climbs: ClimbInput[];
  stats: StatInput[];
  climbsWatermark: Cursor;
  statsWatermark: Cursor;
  formatVersion?: number;
  schemaVersion?: number;
  climbsRowCountOverride?: number;
  statsRowCountOverride?: number;
  climbsDdl?: string;
  statsDdl?: string;
};

/** Builds a gzip-free SQLite artifact carrying board_climbs + stats + meta. */
function buildArtifact(spec: ArtifactSpec): void {
  const db = new DatabaseSync(spec.filePath);
  try {
    if (spec.climbsDdl || spec.statsDdl) {
      // Custom DDL for the schema-drift fixtures.
      db.exec(spec.climbsDdl ?? '');
      db.exec(spec.statsDdl ?? '');
    } else {
      for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    }
    db.exec(SNAPSHOT_META_DDL);

    for (const climb of spec.climbs) {
      db.prepare(
        `INSERT OR REPLACE INTO board_climbs
          (uuid, board_type, layout_id, name, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
         VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
      ).run(
        climb.uuid,
        climb.boardType ?? 'kilter',
        climb.layoutId ?? 1,
        climb.name ?? `name-${climb.uuid}`,
        climb.compatibleSizeIds === null ? null : JSON.stringify(climb.compatibleSizeIds),
        climb.updatedAt ?? '2026-05-01T00:00:00Z',
        climb.syncSeq ?? 1,
      );
    }
    for (const stat of spec.stats) {
      db.prepare(
        `INSERT OR REPLACE INTO board_climb_stats
          (board_type, climb_uuid, angle, display_difficulty, updated_at, sync_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        stat.boardType ?? 'kilter',
        stat.climbUuid,
        stat.angle ?? 40,
        stat.displayDifficulty ?? 20.0,
        stat.updatedAt ?? '2026-05-01T00:00:00Z',
        stat.syncSeq ?? 1,
      );
    }

    const meta = db.prepare(
      `INSERT OR REPLACE INTO snapshot_meta
        (table_name, watermark_updated_at, watermark_sync_seq, row_count, built_at, schema_version, format_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const formatVersion = spec.formatVersion ?? 1;
    const schemaVersion = spec.schemaVersion ?? LATEST_SCHEMA_VERSION;
    meta.run(
      'board_climbs',
      spec.climbsWatermark.updatedAt,
      spec.climbsWatermark.syncSeq,
      spec.climbsRowCountOverride ?? spec.climbs.length,
      '2026-06-01T00:00:00.000Z',
      schemaVersion,
      formatVersion,
    );
    meta.run(
      'board_climb_stats',
      spec.statsWatermark.updatedAt,
      spec.statsWatermark.syncSeq,
      spec.statsRowCountOverride ?? spec.stats.length,
      '2026-06-01T00:00:00.000Z',
      schemaVersion,
      formatVersion,
    );
  } finally {
    db.close();
  }
}

function makeEntry(overrides: Partial<SnapshotManifestEntry> = {}): SnapshotManifestEntry {
  return {
    boardType: 'kilter',
    layoutId: 1,
    key: 'board-snapshots/v1/kilter/1/2026-06-01.db',
    url: 'https://example.test/kilter-1.db',
    bytes: 1024,
    contentEncoding: 'gzip',
    builtAt: '2026-06-01T00:00:00.000Z',
    schemaVersion: 1,
    tables: {
      board_climbs: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 1 },
      board_climb_stats: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 1 },
    },
    ...overrides,
  };
}

function makeManifest(entries: SnapshotManifestEntry[]): SnapshotManifest {
  return { formatVersion: 1, generatedAt: '2026-06-01T00:00:00.000Z', entries };
}

/** A recording fake of the injected snapshot I/O. */
function makeSnapshotSource(config: {
  manifest?: SnapshotManifest | null;
  manifestThrows?: boolean;
  fileForEntry?: (entry: SnapshotManifestEntry) => string | null;
  downloadThrows?: boolean;
}): SnapshotSource & {
  fetchManifest: ReturnType<typeof vi.fn>;
  downloadArtifact: ReturnType<typeof vi.fn>;
  deleteArtifact: ReturnType<typeof vi.fn>;
} {
  const fetchManifest = vi.fn(async () => {
    if (config.manifestThrows) throw new Error('network down');
    return config.manifest ?? null;
  });
  const downloadArtifact = vi.fn(async (entry: SnapshotManifestEntry) => {
    if (config.downloadThrows) throw new Error('download failed');
    const filePath = config.fileForEntry?.(entry) ?? null;
    return filePath ? { filePath } : null;
  });
  const deleteArtifact = vi.fn(async () => {});
  return { fetchManifest, downloadArtifact, deleteArtifact } as never;
}

function noopQueryClient(): QueryInvalidator {
  return { invalidateQueries: vi.fn() } as unknown as QueryInvalidator;
}

function compareCursor(a: Cursor, b: Cursor): number {
  const at = Date.parse(a.updatedAt);
  const bt = Date.parse(b.updatedAt);
  if (at !== bt) return at < bt ? -1 : 1;
  const as = BigInt(a.syncSeq);
  const bs = BigInt(b.syncSeq);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * A graphqlFetch that emulates the strict `>` cursor resolvers: for syncClimbs it
 * returns any `climbServerRows` strictly after the incoming cursor (else an empty
 * tail page). Every other query is an empty page. Captures the cursor each board
 * query received so delta continuity can be asserted.
 */
function makeGraphqlFetch(options?: { climbServerRows?: Array<{ doc: Record<string, unknown>; cursor: Cursor }> }) {
  const capturedClimbCursors: Array<Cursor | undefined> = [];
  const capturedStatsCursors: Array<Cursor | undefined> = [];
  const emptyCursor: Cursor = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };

  const fetch = vi.fn(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const cursor = variables?.cursor as Cursor | undefined;
    if (query.includes('syncDeletions')) {
      return { syncDeletions: { deletions: [], cursor: emptyCursor, hasMore: false } } as T;
    }
    if (query.includes('syncClimbStats')) {
      capturedStatsCursors.push(cursor);
      return { syncClimbStats: { documents: [], cursor: cursor ?? emptyCursor, hasMore: false } } as T;
    }
    if (query.includes('syncClimbs')) {
      capturedClimbCursors.push(cursor);
      const rows = (options?.climbServerRows ?? []).filter((row) => !cursor || compareCursor(row.cursor, cursor) > 0);
      if (rows.length === 0) {
        return { syncClimbs: { documents: [], cursor: cursor ?? emptyCursor, hasMore: false } } as T;
      }
      const last = rows[rows.length - 1];
      return {
        syncClimbs: { documents: rows.map((row) => row.doc), cursor: last.cursor, hasMore: false },
      } as T;
    }
    const match = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/);
    const field = match ? match[1] : 'unknown';
    return { [field]: { documents: [], cursor: emptyCursor, hasMore: false } } as T;
  });

  // Keep the generic call signature pullSync expects AND the mock's `.mock`.
  const typedFetch = fetch as unknown as GraphqlFetchMock;
  return { fetch: typedFetch, capturedClimbCursors, capturedStatsCursors };
}

type GraphqlFetchMock = ReturnType<typeof vi.fn> &
  (<T>(query: string, variables?: Record<string, unknown>) => Promise<T>);

const SCOPE_KILTER_5: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 5 };
const CLIMBS_WATERMARK: Cursor = { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' };
const STATS_WATERMARK: Cursor = { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' };

let workDir: string;
let db: TestSqliteDb;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'snapshot-bootstrap-'));
  db = createTestDatabase();
  await runMigrations(db);
  await ensureMutationQueueTable(db);
  __resetDrainerStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetDrainerStateForTests();
  rmSync(workDir, { recursive: true, force: true });
});

async function countRows(table: string): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// bootstrapScopeFromSnapshot — direct
// ---------------------------------------------------------------------------

describe('bootstrapScopeFromSnapshot', () => {
  it('imports the size-matched climbs + their stats and stamps both checkpoints at the watermarks', async () => {
    const filePath = join(workDir, 'artifact.db');
    buildArtifact({
      filePath,
      climbs: [
        { uuid: 'in-5', compatibleSizeIds: [5, 6] },
        { uuid: 'in-5-only', compatibleSizeIds: [5] },
        { uuid: 'out-7', compatibleSizeIds: [7] },
        { uuid: 'null-size', compatibleSizeIds: null },
      ],
      stats: [
        { climbUuid: 'in-5', angle: 40 },
        { climbUuid: 'out-7', angle: 40 },
        { climbUuid: 'null-size', angle: 40 },
      ],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });

    const result = await bootstrapScopeFromSnapshot({
      db,
      scope: SCOPE_KILTER_5,
      scopeKey: 'kilter:1:5',
      filePath,
    });

    // Only the size-5-compatible climbs land; the NULL-size row is excluded
    // exactly as Postgres `NULL @> ARRAY[5]` (queries.ts:173-175) excludes it.
    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
    expect(climbs.map((row) => row.uuid)).toEqual(['in-5', 'in-5-only']);
    // Stats follow their climb through the semi-join: out-7 and null-size excluded.
    const stats = await db.getAllAsync<{ climb_uuid: string }>(
      'SELECT climb_uuid FROM board_climb_stats ORDER BY climb_uuid',
    );
    expect(stats.map((row) => row.climb_uuid)).toEqual(['in-5']);

    expect(result.climbsWatermark).toEqual(CLIMBS_WATERMARK);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toEqual(CLIMBS_WATERMARK);
    expect(await getCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5')).toEqual(STATS_WATERMARK);
  });

  it('imports ALL climbs for a non-size-scoped board (moonboard), ignoring compatible_size_ids', async () => {
    const filePath = join(workDir, 'moon.db');
    buildArtifact({
      filePath,
      climbs: [
        { uuid: 'm1', boardType: 'moonboard', layoutId: 15, compatibleSizeIds: null },
        { uuid: 'm2', boardType: 'moonboard', layoutId: 15, compatibleSizeIds: [17] },
      ],
      stats: [{ climbUuid: 'm1', boardType: 'moonboard', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });

    await bootstrapScopeFromSnapshot({
      db,
      scope: { boardType: 'moonboard', layoutId: 15, sizeId: 1 },
      scopeKey: 'moonboard:15:1',
      filePath,
    });

    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
    expect(climbs.map((row) => row.uuid)).toEqual(['m1', 'm2']); // NULL-size row included
    expect(await countRows('board_climb_stats')).toBe(1);
  });

  it('tolerates schema drift in both directions and reports it to telemetry', async () => {
    const filePath = join(workDir, 'drift.db');
    // Seed has an extra column (extra_seed, ignored) and is missing one the live
    // table has (setter_username → NULL-filled). Stats table is the standard one.
    buildArtifact({
      filePath,
      climbs: [],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
      climbsDdl: `CREATE TABLE board_climbs (
        uuid TEXT PRIMARY KEY, board_type TEXT, layout_id INTEGER, name TEXT, is_draft INTEGER,
        is_listed INTEGER, compatible_size_ids TEXT, updated_at TEXT, sync_seq INTEGER, extra_seed TEXT
      )`,
      statsDdl: `CREATE TABLE board_climb_stats (
        board_type TEXT NOT NULL, climb_uuid TEXT NOT NULL, angle INTEGER NOT NULL,
        display_difficulty REAL, updated_at TEXT, sync_seq INTEGER,
        PRIMARY KEY (board_type, climb_uuid, angle)
      )`,
    });
    // Insert a drifted climb directly so the copy exercises the intersection.
    const seed = new DatabaseSync(filePath);
    seed
      .prepare(
        'INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, extra_seed) VALUES (?,?,?,?,?)',
      )
      .run('d1', 'kilter', 1, JSON.stringify([5]), 'ignored');
    // Fix the meta row_count now that a climb exists.
    seed.prepare('UPDATE snapshot_meta SET row_count = 1 WHERE table_name = ?').run('board_climbs');
    seed.close();

    const onSchemaDrift = vi.fn();
    await expect(
      bootstrapScopeFromSnapshot({ db, scope: SCOPE_KILTER_5, scopeKey: 'kilter:1:5', filePath, onSchemaDrift }),
    ).resolves.toBeDefined();

    const row = await db.getFirstAsync<{ uuid: string; setter_username: string | null }>(
      'SELECT uuid, setter_username FROM board_climbs WHERE uuid = ?',
      ['d1'],
    );
    expect(row?.uuid).toBe('d1');
    expect(row?.setter_username).toBeNull(); // main-only column, NULL-filled
    const driftColumns = onSchemaDrift.mock.calls.map(([drift]) => (drift as { column: string }).column);
    expect(driftColumns).toContain('extra_seed'); // seed-only → dropped
    expect(driftColumns).toContain('setter_username'); // main-only → NULL-filled
  });

  it('throws (no rows, no checkpoints) on a corrupt/garbage artifact', async () => {
    const filePath = join(workDir, 'garbage.db');
    writeFileSync(filePath, 'this is definitely not a sqlite database');

    await expect(
      bootstrapScopeFromSnapshot({ db, scope: SCOPE_KILTER_5, scopeKey: 'kilter:1:5', filePath }),
    ).rejects.toThrow();

    expect(await countRows('board_climbs')).toBe(0);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toBeNull();
  });

  it('throws when snapshot_meta row_count disagrees with the artifact (truncated download)', async () => {
    const filePath = join(workDir, 'shortcount.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
      climbsRowCountOverride: 999, // claims 999 rows, artifact holds 1
    });

    await expect(
      bootstrapScopeFromSnapshot({ db, scope: SCOPE_KILTER_5, scopeKey: 'kilter:1:5', filePath }),
    ).rejects.toThrow(/row_count/);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toBeNull();
  });

  it('throws on a format_version the client does not understand', async () => {
    const filePath = join(workDir, 'badformat.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
      formatVersion: 999,
    });

    await expect(
      bootstrapScopeFromSnapshot({ db, scope: SCOPE_KILTER_5, scopeKey: 'kilter:1:5', filePath }),
    ).rejects.toThrow(/format_version/);
  });

  it('rolls back with no checkpoints when a wipe lands mid-import', async () => {
    const filePath = join(workDir, 'wipe.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });

    // Flip the real wipe epoch the moment the stats INSERT runs (after the climbs
    // INSERT already executed inside the transaction), simulating a full sign-out
    // wipe cycle in flight. The final in-txn epoch check must then roll everything
    // back — no imported rows, no checkpoints.
    const realRunAsync = db.runAsync.bind(db);
    let wiped = false;
    vi.spyOn(db, 'runAsync').mockImplementation((async (source: string, ...rest: unknown[]) => {
      if (!wiped && source.includes('INSERT OR REPLACE INTO main.board_climb_stats')) {
        wiped = true;
        setSigningOut(true);
        setSigningOut(false); // epoch stays bumped; isSigningOut back to false
      }
      return realRunAsync(source, ...(rest as never[]));
    }) as typeof db.runAsync);

    await expect(
      bootstrapScopeFromSnapshot({ db, scope: SCOPE_KILTER_5, scopeKey: 'kilter:1:5', filePath }),
    ).rejects.toThrow();

    expect(await countRows('board_climbs')).toBe(0);
    expect(await countRows('board_climb_stats')).toBe(0);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toBeNull();
    expect(await getCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5')).toBeNull();
  });

  it('aborts when a full wipe cycle completes during the pre-transaction integrity checks', async () => {
    const filePath = join(workDir, 'wipe-preflight.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });

    // Flip the wipe epoch during the quick_check read — BEFORE the import
    // transaction opens. The epoch captured before the first await must catch a
    // wipe cycle that starts AND finishes inside the integrity checks; nothing
    // may be imported into the freshly wiped DB.
    const realGetAllAsync = db.getAllAsync.bind(db);
    let wiped = false;
    vi.spyOn(db, 'getAllAsync').mockImplementation((async (source: string, ...rest: unknown[]) => {
      if (!wiped && source.includes('quick_check')) {
        wiped = true;
        setSigningOut(true);
        setSigningOut(false); // epoch stays bumped; isSigningOut back to false
      }
      return realGetAllAsync(source, ...(rest as never[]));
    }) as typeof db.getAllAsync);

    await expect(
      bootstrapScopeFromSnapshot({ db, scope: SCOPE_KILTER_5, scopeKey: 'kilter:1:5', filePath }),
    ).rejects.toThrow();

    expect(await countRows('board_climbs')).toBe(0);
    expect(await countRows('board_climb_stats')).toBe(0);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toBeNull();
    expect(await getCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pullSync — bootstrap phase wiring
// ---------------------------------------------------------------------------

describe('pullSync snapshot bootstrap', () => {
  it('warms a fresh scope, then the paged pull resumes from the watermark and marks the scope complete', async () => {
    const filePath = join(workDir, 'happy.db');
    buildArtifact({
      filePath,
      climbs: [
        { uuid: 'c-in', compatibleSizeIds: [5] },
        { uuid: 'c-out', compatibleSizeIds: [9] },
      ],
      stats: [{ climbUuid: 'c-in', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
    });
    const { fetch, capturedClimbCursors, capturedStatsCursors } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    // Rows imported, size-filtered.
    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
    expect(climbs.map((row) => row.uuid)).toEqual(['c-in']);

    // The delta paged pull continued from the watermark checkpoints.
    expect(capturedClimbCursors[0]).toEqual(CLIMBS_WATERMARK);
    expect(capturedStatsCursors[0]).toEqual(STATS_WATERMARK);

    // Both tables reached their (empty) tail → scope marked available offline.
    const marker = await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5']);
    expect(marker).not.toBeNull();
    // Permanent done marker written.
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5']),
    ).not.toBeNull();
    // Artifact cleaned up.
    expect(source.deleteArtifact).toHaveBeenCalledWith(filePath);
  });

  it('catches a delta row exactly after the watermark while the at-watermark row stays the artifact copy', async () => {
    const filePath = join(workDir, 'continuity.db');
    buildArtifact({
      filePath,
      climbs: [
        {
          uuid: 'at-wm',
          compatibleSizeIds: [5],
          name: 'from-artifact',
          updatedAt: '2026-05-02T00:00:00Z',
          syncSeq: 20,
        },
      ],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK, // (2026-05-02T00:00:00Z, 20)
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });

    // Server holds the row AT the watermark (must NOT re-appear via strict >) and a
    // row just AFTER it (must be caught by the delta).
    const { fetch } = makeGraphqlFetch({
      climbServerRows: [
        {
          doc: { uuid: 'at-wm', name: 'server-should-not-send' },
          cursor: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' },
        },
        {
          doc: { uuid: 'after-wm', name: 'delta', compatible_size_ids: JSON.stringify([5]) },
          cursor: { updatedAt: '2026-05-03T00:00:00Z', syncSeq: '30' },
        },
      ],
    });

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    const atWm = await db.getFirstAsync<{ name: string }>('SELECT name FROM board_climbs WHERE uuid = ?', ['at-wm']);
    expect(atWm?.name).toBe('from-artifact'); // never overwritten by the delta
    const afterWm = await db.getFirstAsync<{ name: string }>('SELECT name FROM board_climbs WHERE uuid = ?', [
      'after-wm',
    ]);
    expect(afterWm?.name).toBe('delta'); // the strictly-after row landed
  });

  it('rejects a stale-schema artifact and falls straight through to the paged pull without burning an attempt', async () => {
    const filePath = join(workDir, 'stale-schema.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-artifact', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
      schemaVersion: LATEST_SCHEMA_VERSION - 1,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });

    // The server carries a row the paged crawl must deliver THIS cycle.
    const { fetch, capturedClimbCursors } = makeGraphqlFetch({
      climbServerRows: [
        {
          doc: { uuid: 'c-paged', name: 'paged', compatible_size_ids: JSON.stringify([5]) },
          cursor: { updatedAt: '2026-05-03T00:00:00Z', syncSeq: '30' },
        },
      ],
    });
    const errors: Array<{ stage: string; attempt: number }> = [];

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError: (report) => errors.push({ stage: report.stage, attempt: report.attempt }),
    });

    // Nothing imported from the artifact; the paged crawl ran from scratch and
    // delivered the server row in the SAME cycle.
    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
    expect(climbs.map((row) => row.uuid)).toEqual(['c-paged']);
    expect(capturedClimbCursors[0]).toBeUndefined(); // from-scratch, not from a watermark

    // No attempt burned: a stale artifact is tonight's-export's problem, not a
    // transient failure to retry.
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toBeNull();
    expect(errors).toEqual([{ stage: 'import', attempt: 0 }]);
  });

  it('rejects a stale-schema artifact directly with SnapshotSchemaStaleError', async () => {
    const filePath = join(workDir, 'stale-direct.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
      schemaVersion: LATEST_SCHEMA_VERSION - 1,
    });
    await expect(
      bootstrapScopeFromSnapshot({ db, scope: SCOPE_KILTER_5, scopeKey: 'kilter:1:5', filePath }),
    ).rejects.toThrow(SnapshotSchemaStaleError);
    expect(await db.getFirstAsync('SELECT 1 AS n FROM board_climbs LIMIT 1')).toBeNull();
  });

  it('invalidates board-table query caches after a bootstrap even when the delta pull is empty', async () => {
    const filePath = join(workDir, 'invalidate.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-in', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c-in', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch(); // delta returns zero documents everywhere
    const invalidated: unknown[] = [];
    const queryClient = {
      invalidateQueries: vi.fn((filter: { queryKey: unknown }) => {
        invalidated.push(filter.queryKey);
      }),
    } as unknown as QueryInvalidator;

    await pullSync(db, queryClient, fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    // syncTable's arrivals-only invalidation never fires (0 delta documents), so
    // the bootstrap itself must have busted the board-table caches.
    expect(invalidated.length).toBeGreaterThan(0);
    const flattened = JSON.stringify(invalidated);
    expect(flattened).toContain('climb');
  });

  it('downloads one artifact for two sizes of the same layout', async () => {
    const filePath = join(workDir, 'reuse.db');
    buildArtifact({
      filePath,
      climbs: [
        { uuid: 'c5', compatibleSizeIds: [5] },
        { uuid: 'c6', compatibleSizeIds: [6] },
      ],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5', 'kilter:1:6'],
      snapshotSource: source,
    });

    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toEqual(CLIMBS_WATERMARK);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:6')).toEqual(CLIMBS_WATERMARK);
    // Each size imported its own compatible climb.
    expect(await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', ['c5'])).not.toBeNull();
    expect(await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', ['c6'])).not.toBeNull();
  });

  it('skips bootstrap for a scope that already has a board checkpoint (mid-crawl user)', async () => {
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '5' });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    // Manifest never fetched, nothing downloaded — the paged pull just runs.
    expect(source.fetchManifest).not.toHaveBeenCalled();
    expect(source.downloadArtifact).not.toHaveBeenCalled();
    expect(await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5'])).toBeNull();
  });

  it('falls straight to the paged crawl (no attempt burned) when the manifest has no entry for the layout', async () => {
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry({ layoutId: 99 })]), // different layout
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const { fetch, capturedClimbCursors } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(source.downloadArtifact).not.toHaveBeenCalled();
    // Paged pull ran from scratch (no checkpoint → cursor undefined on first page).
    expect(capturedClimbCursors[0]).toBeUndefined();
    // No attempt recorded — the layout may be exported later.
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toBeNull();
  });

  it('falls straight to the paged crawl (no attempt burned) when the manifest is absent', async () => {
    const source = makeSnapshotSource({ manifest: null });
    const { fetch, capturedClimbCursors } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(source.downloadArtifact).not.toHaveBeenCalled();
    expect(capturedClimbCursors[0]).toBeUndefined();
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toBeNull();
  });

  it('counts an attempt AND skips the paged pull when the manifest fetch fails (network)', async () => {
    const source = makeSnapshotSource({ manifestThrows: true });
    const onSnapshotBootstrapError = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    // Paged pull SKIPPED this cycle (a first-page checkpoint would disqualify bootstrap).
    const climbsCalls = fetch.mock.calls.filter((args) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(0);
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toEqual({
      value: '1',
    });
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(expect.objectContaining({ stage: 'manifest', attempt: 1 }));
  });

  it('records two attempts on repeated corrupt artifacts, then the third run falls back to the paged crawl', async () => {
    const filePath = join(workDir, 'corrupt.db');
    writeFileSync(filePath, 'not a database');
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });

    // Run 1: import fails → attempt 1, paged pull skipped.
    const run1 = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), run1.fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });
    expect(run1.fetch.mock.calls.filter((a) => (a[0] as string).includes('syncClimbs'))).toHaveLength(0);
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toEqual({ value: '1' });

    // Run 2: import fails again → attempt 2, still skipped.
    const run2 = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), run2.fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });
    expect(run2.fetch.mock.calls.filter((a) => (a[0] as string).includes('syncClimbs'))).toHaveLength(0);
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toEqual({ value: '2' });

    // Run 3: attempts >= MAX → bootstrap not eligible → paged crawl runs from scratch.
    const run3 = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), run3.fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });
    const run3ClimbsCalls = run3.fetch.mock.calls.filter((a) => (a[0] as string).includes('syncClimbs'));
    expect(run3ClimbsCalls.length).toBeGreaterThan(0);
    expect(run3.capturedClimbCursors[0]).toBeUndefined();
    // downloadArtifact was NOT called on run 3 (bootstrap skipped entirely).
    expect(source.downloadArtifact).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// deletions rewind
// ---------------------------------------------------------------------------

describe('deletions checkpoint rewind on bootstrap', () => {
  it('rewinds the deletions checkpoint to min(watermarks) when it sits ahead of the snapshot', async () => {
    // Deletions already advanced well past the snapshot's watermark.
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, { updatedAt: '2026-09-01T00:00:00Z', syncSeq: '5000' });

    const filePath = join(workDir, 'rewind.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      // climbs watermark is OLDER than stats → min() picks climbs.
      climbsWatermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
      statsWatermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' },
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    // Rewound to the OLDER (climbs) watermark so no board deletion in the imported
    // window is skipped.
    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual({
      updatedAt: '2026-05-01T00:00:00Z',
      syncSeq: '10',
    });
  });

  it('leaves the deletions checkpoint untouched when it is already behind the watermark (BigInt seq compare)', async () => {
    // Same timestamp, seq '9' — behind the watermark's seq '10' (a raw string
    // compare would wrongly rank '9' > '10' and rewind).
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '9' });

    const filePath = join(workDir, 'behind.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
      statsWatermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    // Untouched — the deletions cursor was already behind, so nothing to rewind.
    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual({
      updatedAt: '2026-05-01T00:00:00Z',
      syncSeq: '9',
    });
  });
});
