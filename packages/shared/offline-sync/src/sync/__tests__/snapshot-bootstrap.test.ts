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
import { pullSync, type SyncProgress } from '../pull-client';
import type { SnapshotBootstrapProgress } from '../snapshot-progress';
import {
  bootstrapScopeFromSnapshot,
  getBootstrapAttempts,
  getBootstrapMetadataByScope,
  BOOTSTRAP_METADATA_QUERY,
  BOOTSTRAP_METADATA_PATTERNS,
  SnapshotPermanentMissError,
  SnapshotSchemaStaleError,
  type SnapshotSource,
} from '../snapshot-bootstrap';
import { getCheckpoint, setCheckpoint, DELETIONS_CHECKPOINT_KEY } from '../checkpoints';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { setSigningOut, setBackgrounded, __resetDrainerStateForTests } from '../../mutation-queue/drainer';
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
const SNAPSHOT_ALIAS = 'bs_snapshot';

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
        climb.updatedAt ?? spec.climbsWatermark.updatedAt,
        climb.syncSeq ?? Number(spec.climbsWatermark.syncSeq),
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
        stat.updatedAt ?? spec.statsWatermark.updatedAt,
        stat.syncSeq ?? Number(spec.statsWatermark.syncSeq),
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
    // Default to the client's current schema so the manifest-level staleness
    // pre-check in runBootstrapPhase doesn't skip fixture entries.
    schemaVersion: LATEST_SCHEMA_VERSION,
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
  /** Thrown instead of the default non-transport `Error('network down')`. */
  manifestError?: unknown;
  fileForEntry?: (entry: SnapshotManifestEntry) => string | null;
  downloadThrows?: boolean;
  /** Thrown instead of the default non-transport `Error('download failed')`. */
  downloadError?: unknown;
}): SnapshotSource & {
  fetchManifest: ReturnType<typeof vi.fn>;
  downloadArtifact: ReturnType<typeof vi.fn>;
  deleteArtifact: ReturnType<typeof vi.fn>;
} {
  const fetchManifest = vi.fn(async () => {
    if (config.manifestError !== undefined) throw config.manifestError;
    if (config.manifestThrows) throw new Error('network down');
    return config.manifest ?? null;
  });
  const downloadArtifact = vi.fn(async (entry: SnapshotManifestEntry) => {
    if (config.downloadError !== undefined) throw config.downloadError;
    if (config.downloadThrows) throw new Error('download failed');
    const filePath = config.fileForEntry?.(entry) ?? null;
    return filePath ? { filePath } : null;
  });
  const deleteArtifact = vi.fn(async () => {});
  return { fetchManifest, downloadArtifact, deleteArtifact } as never;
}

function deferred<Result>() {
  let resolvePromise!: (result: Result) => void;
  const promise = new Promise<Result>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
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
  // FILE-backed, deliberately: the adapter then mirrors expo-sqlite's
  // withExclusiveTransactionAsync running its task on a SEPARATE connection,
  // where a main-connection ATTACH does not exist. The in-memory double's
  // same-connection transactions hid exactly that and let the BOARDSESH-AA
  // "no such table: bs_snapshot.board_climb_stats" ship.
  db = createTestDatabase(join(workDir, 'client.db'));
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

describe('getBootstrapMetadataByScope', () => {
  it('reads requested attempt and completion markers in one batch with O(1) scope lookups', async () => {
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-attempts:kilter:1:5', '1']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-done:kilter:1:5', '1']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['checkpoint:board_climbs:kilter:1:5', '{}']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['scope-complete:kilter:1:5', '1']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-attempts:tension:2:10', '2']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-paged-fallback:tension:2:10',
      '1',
    ]);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-attempts:kilter:9:20', '1']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [
      'checkpoint:board_climb_stats:kilter:9:20',
      '{}',
    ]);
    // An unrequested scope must not become an accidental row in the returned map.
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-attempts:moonboard:3:7', '1']);

    const metadataByScope = await getBootstrapMetadataByScope(db, [
      'kilter:1:5',
      'tension:2:10',
      'kilter:9:20',
      'missing:4:20',
    ]);

    expect(metadataByScope.get('kilter:1:5')).toEqual({
      attempts: 1,
      isBootstrapDone: true,
      isPagedFallback: false,
      hasBoardCheckpoint: true,
      isScopeComplete: true,
    });
    expect(metadataByScope.get('tension:2:10')).toEqual({
      attempts: 2,
      isBootstrapDone: false,
      isPagedFallback: true,
      hasBoardCheckpoint: false,
      isScopeComplete: false,
    });
    expect(metadataByScope.get('kilter:9:20')).toEqual({
      attempts: 1,
      isBootstrapDone: false,
      isPagedFallback: false,
      hasBoardCheckpoint: true,
      isScopeComplete: false,
    });
    expect(metadataByScope.get('missing:4:20')).toBeUndefined();
    expect(metadataByScope.has('moonboard:3:7')).toBe(false);
  });

  it('uses the sync_meta primary-key index for every metadata prefix', async () => {
    const queryPlan = await db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${BOOTSTRAP_METADATA_QUERY}`, [
      ...BOOTSTRAP_METADATA_PATTERNS,
    ]);
    const details = queryPlan.map((row) => row.detail).join('\n');

    expect(details).not.toMatch(/\bSCAN sync_meta\b/);
    expect(details).toMatch(/SEARCH sync_meta USING (?:COVERING )?INDEX/);

    const completeScopesPlan = await db.getAllAsync<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT key FROM sync_meta WHERE key GLOB ?',
      ['scope-complete:*'],
    );
    const completeScopesDetails = completeScopesPlan.map((row) => row.detail).join('\n');
    expect(completeScopesDetails).not.toMatch(/\bSCAN sync_meta\b/);
    expect(completeScopesDetails).toMatch(/SEARCH sync_meta USING COVERING INDEX/);
  });
});

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

  it('stamps checkpoints from the exact scoped rows, not the wider layout artifact meta', async () => {
    const filePath = join(workDir, 'scoped-watermark.db');
    const scopedClimbWatermark = { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '5' };
    const scopedStatsWatermark = { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '6' };
    buildArtifact({
      filePath,
      climbs: [
        { uuid: 'size-5', compatibleSizeIds: [5], updatedAt: scopedClimbWatermark.updatedAt, syncSeq: 5 },
        { uuid: 'size-7-later', compatibleSizeIds: [7], updatedAt: '2026-05-03T00:00:00Z', syncSeq: 30 },
      ],
      stats: [
        { climbUuid: 'size-5', updatedAt: scopedStatsWatermark.updatedAt, syncSeq: 6 },
        { climbUuid: 'size-7-later', updatedAt: '2026-05-03T00:00:00Z', syncSeq: 31 },
      ],
      climbsWatermark: { updatedAt: '2026-05-03T00:00:00Z', syncSeq: '30' },
      statsWatermark: { updatedAt: '2026-05-03T00:00:00Z', syncSeq: '31' },
    });

    const result = await bootstrapScopeFromSnapshot({
      db,
      scope: SCOPE_KILTER_5,
      scopeKey: 'kilter:1:5',
      filePath,
    });

    expect(result.climbsWatermark).toEqual(scopedClimbWatermark);
    expect(result.statsWatermark).toEqual(scopedStatsWatermark);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toEqual(scopedClimbWatermark);
    expect(await getCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5')).toEqual(scopedStatsWatermark);
  });

  it('removes stale scoped rows absent from the artifact before importing replacements', async () => {
    await db.runAsync(
      `INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
       VALUES (?, 'kilter', 1, ?, 0, 1, ?, ?, ?)`,
      ['deleted-before-snapshot', 'deleted-before-snapshot', JSON.stringify([5]), '2026-04-01T00:00:00Z', 1],
    );
    await db.runAsync(
      `INSERT INTO board_climb_stats
        (board_type, climb_uuid, angle, display_difficulty, updated_at, sync_seq)
       VALUES ('kilter', ?, 40, 15, ?, ?)`,
      ['deleted-before-snapshot', '2026-04-01T00:00:00Z', 1],
    );
    await db.runAsync(
      `INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
       VALUES (?, 'kilter', 1, ?, 0, 1, ?, ?, ?)`,
      ['newer-local', 'newer-local', JSON.stringify([5]), '2026-06-01T00:00:00Z', 100],
    );

    const filePath = join(workDir, 'reconcile.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'artifact-row', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'artifact-row', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });

    await bootstrapScopeFromSnapshot({
      db,
      scope: SCOPE_KILTER_5,
      scopeKey: 'kilter:1:5',
      filePath,
    });

    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
    expect(climbs.map((row) => row.uuid)).toEqual(['artifact-row', 'newer-local']);
    const stats = await db.getAllAsync<{ climb_uuid: string }>(
      'SELECT climb_uuid FROM board_climb_stats ORDER BY climb_uuid',
    );
    expect(stats.map((row) => row.climb_uuid)).toEqual(['artifact-row']);
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

  it('clears a leftover attached snapshot alias before attaching the next artifact', async () => {
    const staleFilePath = join(workDir, 'stale-attached.db');
    buildArtifact({
      filePath: staleFilePath,
      climbs: [{ uuid: 'stale-row', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '1' },
      statsWatermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '1' },
    });
    const freshFilePath = join(workDir, 'fresh-after-leftover-attach.db');
    buildArtifact({
      filePath: freshFilePath,
      climbs: [{ uuid: 'fresh-row', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });

    await db.execAsync(`ATTACH DATABASE '${staleFilePath.replace(/'/g, "''")}' AS ${SNAPSHOT_ALIAS}`);

    await bootstrapScopeFromSnapshot({
      db,
      scope: SCOPE_KILTER_5,
      scopeKey: 'kilter:1:5',
      filePath: freshFilePath,
    });

    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
    expect(climbs.map((row) => row.uuid)).toEqual(['fresh-row']);
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
    // back — no imported rows, no checkpoints. Spy on the adapter PROTOTYPE: the
    // import runs on the transaction's own connection (a separate adapter
    // instance, mirroring expo), so an instance spy on `db` would never fire.
    const adapterPrototype = Object.getPrototypeOf(db) as { runAsync: typeof db.runAsync };
    const realRunAsync = adapterPrototype.runAsync;
    let wiped = false;
    vi.spyOn(adapterPrototype, 'runAsync').mockImplementation(async function (
      this: unknown,
      source: string,
      ...rest: unknown[]
    ) {
      if (!wiped && source.includes('INSERT OR REPLACE INTO main.board_climb_stats')) {
        wiped = true;
        setSigningOut(true);
        setSigningOut(false); // epoch stays bumped; isSigningOut back to false
      }
      return realRunAsync.call(this, source, ...(rest as never[]));
    } as typeof db.runAsync);

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
    // may be imported into the freshly wiped DB. Prototype spy: the integrity
    // checks now run on the transaction connection's own adapter instance.
    const adapterPrototype = Object.getPrototypeOf(db) as { getAllAsync: typeof db.getAllAsync };
    const realGetAllAsync = adapterPrototype.getAllAsync;
    let wiped = false;
    vi.spyOn(adapterPrototype, 'getAllAsync').mockImplementation(async function (
      this: unknown,
      source: string,
      ...rest: unknown[]
    ) {
      if (!wiped && source.includes('quick_check')) {
        wiped = true;
        setSigningOut(true);
        setSigningOut(false); // epoch stays bumped; isSigningOut back to false
      }
      return realGetAllAsync.call(this, source, ...(rest as never[]));
    } as typeof db.getAllAsync);

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
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-paged-fallback:kilter:1:5', '1']);
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
    const onBootstrapMetadataChanged = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onBootstrapMetadataChanged,
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
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-paged-fallback:kilter:1:5']),
    ).toBeNull();
    expect(onBootstrapMetadataChanged).toHaveBeenCalledOnce();
    expect(onBootstrapMetadataChanged).toHaveBeenCalledWith({ scopeKey: 'kilter:1:5' });
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

  it('skips the download entirely when the MANIFEST already reports a stale schemaVersion', async () => {
    // The artifact itself is current — only the manifest entry is stale. The
    // pre-check must skip before the (multi-MB) download, not after.
    const filePath = join(workDir, 'stale-manifest.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-artifact', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry({ schemaVersion: LATEST_SCHEMA_VERSION - 1 })]),
      fileForEntry: () => filePath,
    });
    const { fetch } = makeGraphqlFetch({
      climbServerRows: [
        {
          doc: { uuid: 'c-paged', name: 'paged', compatible_size_ids: JSON.stringify([5]) },
          cursor: { updatedAt: '2026-05-03T00:00:00Z', syncSeq: '30' },
        },
      ],
    });

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(source.downloadArtifact).not.toHaveBeenCalled();
    // Paged crawl ran this cycle and no attempt was burned.
    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
    expect(climbs.map((row) => row.uuid)).toEqual(['c-paged']);
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toBeNull();
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

  it('settles scope A metadata before scope B finishes its bootstrap download', async () => {
    const secondDownload = deferred<{ filePath: string } | null>();
    const secondDownloadStarted = deferred<void>();
    const entries = [
      makeEntry(),
      makeEntry({
        boardType: 'tension',
        layoutId: 2,
        key: 'board-snapshots/v1/tension/2/2026-06-01.db',
        url: 'https://example.test/tension-2.db',
      }),
    ];
    const source: SnapshotSource = {
      fetchManifest: vi.fn(async () => makeManifest(entries)),
      downloadArtifact: vi.fn(async (entry: SnapshotManifestEntry) => {
        if (entry.boardType === 'kilter') return null;
        secondDownloadStarted.resolve();
        return secondDownload.promise;
      }),
      deleteArtifact: vi.fn(async () => {}),
    };
    // This assertion is about ORDER, not frame count: each scope now emits
    // several staged progress frames (manifest → download → import, issue
    // #4311), so consecutive repeats of the same scope collapse to one entry.
    const events: string[] = [];
    const pushEvent = (event: string): void => {
      if (events[events.length - 1] !== event) events.push(event);
    };
    const { fetch } = makeGraphqlFetch();

    const syncPromise = pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5', 'tension:2:10'],
      snapshotSource: source,
      onProgress: (progress) => {
        if (progress.phase === 'bootstrap' && progress.currentTable) pushEvent(`progress:${progress.currentTable}`);
      },
      onBootstrapMetadataChanged: ({ scopeKey }) => pushEvent(`settled:${scopeKey}`),
    });

    await secondDownloadStarted.promise;

    expect(events).toEqual(['progress:kilter:1:5', 'settled:kilter:1:5', 'progress:tension:2:10']);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(1);
    expect(await getBootstrapAttempts(db, 'tension:2:10')).toBe(0);

    secondDownload.resolve(null);
    await syncPromise;

    expect(events).toEqual([
      'progress:kilter:1:5',
      'settled:kilter:1:5',
      'progress:tension:2:10',
      'settled:tension:2:10',
    ]);
  });

  it('skips bootstrap for a scope that already has a board checkpoint (mid-crawl user)', async () => {
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '5' });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const { fetch } = makeGraphqlFetch();
    const onBootstrapMetadataChanged = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onBootstrapMetadataChanged,
    });

    // Manifest never fetched, nothing downloaded — the paged pull just runs.
    expect(source.fetchManifest).not.toHaveBeenCalled();
    expect(source.downloadArtifact).not.toHaveBeenCalled();
    expect(await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5'])).toBeNull();
    expect(onBootstrapMetadataChanged).toHaveBeenCalledWith({ scopeKey: 'kilter:1:5' });
  });

  it('falls straight to the paged crawl (no attempt burned) when the manifest has no entry for the layout', async () => {
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry({ layoutId: 99 })]), // different layout
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const { fetch, capturedClimbCursors } = makeGraphqlFetch();
    const onBootstrapMetadataChanged = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onBootstrapMetadataChanged,
    });

    expect(source.downloadArtifact).not.toHaveBeenCalled();
    // Paged pull ran from scratch (no checkpoint → cursor undefined on first page).
    expect(capturedClimbCursors[0]).toBeUndefined();
    // No attempt recorded — the layout may be exported later.
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toBeNull();
    expect(onBootstrapMetadataChanged).toHaveBeenCalledWith({ scopeKey: 'kilter:1:5' });
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

  it('falls straight to the paged crawl when the source marks a download as a permanent miss', async () => {
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => null });
    source.downloadArtifact.mockImplementation(async () => {
      throw new SnapshotPermanentMissError('unsupported content encoding');
    });
    const onSnapshotBootstrapError = vi.fn();
    const { fetch, capturedClimbCursors } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(capturedClimbCursors[0]).toBeUndefined();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(expect.objectContaining({ stage: 'download', attempt: 0 }));
  });

  it('counts an attempt AND skips the paged pull when the manifest fetch fails for a non-transport reason', async () => {
    const source = makeSnapshotSource({ manifestThrows: true });
    const onSnapshotBootstrapError = vi.fn();
    const onBootstrapMetadataChanged = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
      onBootstrapMetadataChanged,
    });

    // Paged pull SKIPPED this cycle (a first-page checkpoint would disqualify bootstrap).
    const climbsCalls = fetch.mock.calls.filter((args) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(0);
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toEqual({
      value: '1',
    });
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'manifest', attempt: 1, expected: false }),
    );
    expect(onBootstrapMetadataChanged).toHaveBeenCalledWith({ scopeKey: 'kilter:1:5' });
  });

  it('persists paged fallback after a transient failure is followed by a permanent miss', async () => {
    const source = makeSnapshotSource({ manifestThrows: true });

    const firstRun = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), firstRun.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(1);

    // The next cycle can reach the source but no usable manifest exists. Abort
    // the paged crawl at its first board request so the explicit decision is
    // tested before a checkpoint or scope-complete marker can mask it.
    source.fetchManifest.mockResolvedValue(null);
    const secondRun = makeGraphqlFetch();
    const failPagedFetch = (async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (query.includes('syncClimbs')) throw new Error('stop after bootstrap outcome');
      return secondRun.fetch<T>(query, variables);
    }) as GraphqlFetchMock;

    await expect(
      pullSync(db, noopQueryClient(), failPagedFetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
      }),
    ).rejects.toThrow('stop after bootstrap outcome');

    expect(await getBootstrapMetadataByScope(db, ['kilter:1:5'])).toEqual(
      new Map([
        [
          'kilter:1:5',
          {
            attempts: 1,
            isBootstrapDone: false,
            isPagedFallback: true,
            hasBoardCheckpoint: false,
            isScopeComplete: false,
          },
        ],
      ]),
    );
  });

  it('records two attempts on repeated corrupt artifacts, heals once, then settles into the paged crawl', async () => {
    const filePath = join(workDir, 'corrupt.db');
    writeFileSync(filePath, 'not a database');
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onBootstrapMetadataChanged = vi.fn();

    const runOnce = async () => {
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onBootstrapMetadataChanged,
      });
      return run;
    };
    const attemptsRow = () =>
      db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']);

    // Runs 1 and 2: import fails → attempts 1 then 2, paged pull skipped both times.
    const run1 = await runOnce();
    expect(run1.fetch.mock.calls.filter((a) => (a[0] as string).includes('syncClimbs'))).toHaveLength(0);
    expect(await attemptsRow()).toEqual({ value: '1' });

    const run2 = await runOnce();
    expect(run2.fetch.mock.calls.filter((a) => (a[0] as string).includes('syncClimbs'))).toHaveLength(0);
    expect(await attemptsRow()).toEqual({ value: '2' });

    // Run 3: over the cap, but the manifest resolves with a usable entry, so the
    // scope spends its ONE heal and tries the snapshot path again (issue #4238).
    // The artifact is still corrupt, so it burns a fresh attempt 1.
    const run3 = await runOnce();
    expect(source.downloadArtifact).toHaveBeenCalledTimes(3);
    expect(run3.fetch.mock.calls.filter((a) => (a[0] as string).includes('syncClimbs'))).toHaveLength(0);
    expect(await attemptsRow()).toEqual({ value: '1' });
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-attempts-healed:kilter:1:5']),
    ).not.toBeNull();

    // Run 4: attempt 2 again.
    await runOnce();
    expect(await attemptsRow()).toEqual({ value: '2' });

    // Run 5: over the cap AND the heal is spent → bootstrap gives up for good and
    // the paged crawl runs from scratch. No sixth download.
    const run5 = await runOnce();
    expect(run5.fetch.mock.calls.filter((a) => (a[0] as string).includes('syncClimbs')).length).toBeGreaterThan(0);
    expect(run5.capturedClimbCursors[0]).toBeUndefined();
    expect(source.downloadArtifact).toHaveBeenCalledTimes(4);
    expect(onBootstrapMetadataChanged).toHaveBeenCalledTimes(5);
  });

  it('Sentry BOARDSESH-AN: stops before the attempt-bookkeeping write when the app backgrounds during the manifest fetch', async () => {
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-paged-fallback:kilter:1:5', '1']);
    const source: SnapshotSource = {
      fetchManifest: async () => {
        setBackgrounded(true);
        throw new Error('network down');
      },
      downloadArtifact: vi.fn(),
      deleteArtifact: vi.fn(async () => {}),
    };
    const { fetch } = makeGraphqlFetch();
    const onBootstrapMetadataChanged = vi.fn();

    try {
      await pullSync(db, noopQueryClient(), fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onBootstrapMetadataChanged,
      });

      // A manifest fetch failure normally counts a bootstrap attempt; backgrounding
      // mid-await must pre-empt that SQLite write, same as a sign-out/wipe caught
      // mid-flight — and abort the whole cycle before deletions/table pulls run.
      expect(
        await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
      ).toBeNull();
      expect(
        await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-paged-fallback:kilter:1:5']),
      ).not.toBeNull();
      expect(onBootstrapMetadataChanged).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      setBackgrounded(false);
    }
  });

  it('Sentry BOARDSESH-AN: stops before importing when the app backgrounds during the artifact download', async () => {
    const source: SnapshotSource = {
      fetchManifest: async () => makeManifest([makeEntry()]),
      downloadArtifact: async () => {
        setBackgrounded(true);
        return { filePath: join(workDir, 'unused.db') };
      },
      deleteArtifact: vi.fn(async () => {}),
    };
    const { fetch } = makeGraphqlFetch();

    try {
      await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

      // The artifact "downloaded" successfully, but backgrounding was detected
      // right after that await — the import transaction (SQLite work) must never
      // run, and no attempt should be recorded either.
      expect(await countRows('board_climbs')).toBe(0);
      expect(
        await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
      ).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      setBackgrounded(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Offline hygiene (issue #4238): connectivity gate, transport failures don't
// burn attempts, and an over-cap scope heals once.
// ---------------------------------------------------------------------------

describe('pullSync connectivity gate', () => {
  it('does nothing at all when the injected probe says the device is offline', async () => {
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => join(workDir, 'x'),
    });
    const { fetch } = makeGraphqlFetch();
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      isOnline: () => false,
      onSnapshotBootstrapError,
    });

    // No manifest fetch means no per-scope Sentry event for a user who simply
    // opened the app on a plane — the whole point of the gate.
    expect(source.fetchManifest).not.toHaveBeenCalled();
    expect(source.downloadArtifact).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(onSnapshotBootstrapError).not.toHaveBeenCalled();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
  });

  it('runs exactly as before when no probe is injected (web and every existing caller)', async () => {
    const source = makeSnapshotSource({ manifest: null });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(source.fetchManifest).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalled();
  });

  it('stops the cycle before the board pulls when connectivity drops mid-run', async () => {
    let online = true;
    const { fetch, capturedClimbCursors } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      isOnline: () => online,
      onProgress: (progress) => {
        // Drop the connection the moment the deletions phase starts.
        if (progress.phase === 'deletions') online = false;
      },
    });

    expect(capturedClimbCursors).toHaveLength(0);
    expect(await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5'])).toBeNull();
  });
});

describe('pullSync bootstrap: transport failures at the manifest stage do not burn an attempt', () => {
  it('reports a transport manifest failure as expected, keeps the counter at 0, and still skips the paged pull', async () => {
    const cause = new TypeError('Network request failed');
    const source = makeSnapshotSource({ manifestError: cause });
    const onSnapshotBootstrapError = vi.fn();
    const onBootstrapMetadataChanged = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
      onBootstrapMetadataChanged,
    });

    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    // Still skipped: a first-page checkpoint would disqualify the snapshot path
    // for good, which is exactly what we're protecting the scope from.
    expect(fetch.mock.calls.filter((args) => (args[0] as string).includes('syncClimbs'))).toHaveLength(0);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith({
      scopeKey: 'kilter:1:5',
      stage: 'manifest',
      attempt: 0,
      cause,
      expected: true,
    });
    // Nothing was persisted, so there is no settled decision to re-read.
    expect(onBootstrapMetadataChanged).not.toHaveBeenCalled();
  });

  it('survives two offline launches with the snapshot path intact', async () => {
    const source = makeSnapshotSource({ manifestError: new TypeError('Network request failed') });

    for (let launch = 0; launch < 2; launch += 1) {
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });
    }
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);

    // Third launch, back online: the scope is still eligible and bootstraps.
    const filePath = join(workDir, 'after-offline.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-in', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c-in', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const onlineSource = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const online = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), online.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: onlineSource,
    });

    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5']),
    ).not.toBeNull();
  });

  it('counts a download failure even when it is transport-shaped — only the severity differs', async () => {
    // The manifest resolved over this same connection moments earlier, so the
    // device is provably online. Exempting this from the cap would let an
    // unresumable 272 MB GET that always times out restart on every foreground
    // forever, and — because a download failure also skips the paged pull — the
    // board would never get an offline catalog by any route.
    const transportSource = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      downloadError: new Error('snapshot download: File.downloadFileAsync failed', {
        cause: new TypeError('Network request failed'),
      }),
    });
    const transportReports = vi.fn();
    const transportRun = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), transportRun.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: transportSource,
      onSnapshotBootstrapError: transportReports,
    });

    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(1);
    // Still reported as expected, so Sentry sees a warning rather than an error.
    expect(transportReports).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'download', attempt: 1, expected: true }),
    );

    // A disk-full device is a real failure the user can act on — that counts too,
    // and reports at full severity.
    const diskFullSource = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      downloadError: new Error('snapshot download: insufficient disk space for kilter:1'),
    });
    const diskReports = vi.fn();
    const diskRun = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), diskRun.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: diskFullSource,
      onSnapshotBootstrapError: diskReports,
    });

    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(2);
    expect(diskReports).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'download', attempt: 2, expected: false }),
    );
  });

  it('settles a board whose huge artifact always times out onto the paged crawl instead of re-downloading forever', async () => {
    // Regression guard for the download-stage cap exemption: an unresumable
    // multi-hundred-MB GET that times out every cycle must not restart on every
    // foreground. Two counted attempts (+ the one-shot heal's second round) and
    // the scope takes the slow-but-working paged path.
    const timeoutSource = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      downloadError: new Error('snapshot download: File.downloadFileAsync failed for kilter:1', {
        // The exact shape the issue's Sentry sample carries on iOS.
        cause: new Error('UnableToDownloadException: The request timed out.'),
      }),
    });

    // Four launches: two burn the initial budget, the third heals it once, the
    // fourth exhausts the healed budget.
    for (let launch = 0; launch < 4; launch += 1) {
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: timeoutSource,
      });
    }
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(2);
    expect(timeoutSource.downloadArtifact).toHaveBeenCalledTimes(4);

    // Fifth launch: over the cap with the heal spent, so the artifact is not
    // fetched again and the paged crawl finally runs for this scope.
    const settled = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), settled.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: timeoutSource,
    });
    expect(timeoutSource.downloadArtifact).toHaveBeenCalledTimes(4);
    expect(settled.capturedClimbCursors).toHaveLength(1);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-paged-fallback:kilter:1:5']),
    ).not.toBeNull();
  });

  it('still counts an import failure — a corrupt artifact is never an offline problem', async () => {
    const filePath = join(workDir, 'corrupt-import.db');
    writeFileSync(filePath, 'not a database');
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onSnapshotBootstrapError = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(1);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'import', attempt: 1, expected: false }),
    );
  });
});

describe('pullSync bootstrap: one-shot heal for an over-cap scope', () => {
  async function seedExhaustedScope(): Promise<void> {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-attempts:kilter:1:5',
      '2',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-paged-fallback:kilter:1:5',
      '1',
    ]);
  }

  it('clears the counter and takes the snapshot path when the manifest finally resolves online', async () => {
    await seedExhaustedScope();
    const filePath = join(workDir, 'heal.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-in', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c-in', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
    expect(climbs.map((row) => row.uuid)).toEqual(['c-in']);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-attempts-healed:kilter:1:5']),
    ).not.toBeNull();
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5']),
    ).not.toBeNull();
  });

  it('drops the paged-fallback marker before the download so My Boards stops saying "slower download"', async () => {
    await seedExhaustedScope();
    const filePath = join(workDir, 'heal-marker.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-in', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c-in', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    // A snapshot download can run for 18 minutes; the row must not claim the slow
    // path for the whole of it once the scope is back on the fast one.
    let fallbackDuringDownload: unknown = 'never read';
    const source: SnapshotSource = {
      fetchManifest: vi.fn(async () => makeManifest([makeEntry()])),
      downloadArtifact: vi.fn(async () => {
        fallbackDuringDownload = await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', [
          'bootstrap-paged-fallback:kilter:1:5',
        ]);
        return { filePath };
      }),
      deleteArtifact: vi.fn(async () => {}),
    };
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(fallbackDuringDownload).toBeNull();
  });

  it('does not heal a second time — the marker is what bounds the re-download', async () => {
    await seedExhaustedScope();
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-attempts-healed:kilter:1:5',
      '1',
    ]);
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const { fetch, capturedClimbCursors } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(source.downloadArtifact).not.toHaveBeenCalled();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(2);
    // The paged crawl runs this cycle, exactly as it did before the heal existed.
    expect(capturedClimbCursors[0]).toBeUndefined();
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-paged-fallback:kilter:1:5']),
    ).not.toBeNull();
  });

  it('does not heal while still offline: the manifest never resolves, so the paged crawl runs and the counter stands', async () => {
    await seedExhaustedScope();
    const source = makeSnapshotSource({ manifestError: new TypeError('Network request failed') });
    const { fetch, capturedClimbCursors } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(2);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-attempts-healed:kilter:1:5']),
    ).toBeNull();
    expect(capturedClimbCursors[0]).toBeUndefined();
  });

  it('does not heal a scope whose layout is not in the manifest', async () => {
    await seedExhaustedScope();
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry({ layoutId: 99 })]) });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(source.downloadArtifact).not.toHaveBeenCalled();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(2);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-attempts-healed:kilter:1:5']),
    ).toBeNull();
  });

  it('does not heal a scope that already has a board checkpoint (nothing to bootstrap into)', async () => {
    await seedExhaustedScope();
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '5' });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(source.fetchManifest).not.toHaveBeenCalled();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(2);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-attempts-healed:kilter:1:5']),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onScopeDownloadComplete — snapshot vs paged telemetry
// ---------------------------------------------------------------------------

describe('pullSync onScopeDownloadComplete', () => {
  it('reports method "snapshot" when the scope bootstrapped successfully this run', async () => {
    const filePath = join(workDir, 'complete-snapshot.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    const info = onScopeDownloadComplete.mock.calls[0][0] as {
      scopeKey: string;
      method: string;
      durationMs: number;
    };
    expect(info.scopeKey).toBe('kilter:1:5');
    expect(info.method).toBe('snapshot');
    expect(info.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports method "snapshot" when the import and the completing delta pull land in different cycles', async () => {
    // Cycle 1 bootstraps the scope but dies mid-delta (connectivity drop on the
    // stats pull) — markBootstrapDone has been persisted, but the scope never
    // reaches the tail, so no completion event fires. Cycle 2 is a fresh
    // pullSync whose in-memory bootstrap state is empty; the one-and-only
    // completion event it emits must still read the persisted marker and
    // attribute the download to the snapshot, not the trailing delta.
    const filePath = join(workDir, 'cross-cycle-snapshot.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onScopeDownloadComplete = vi.fn();

    const run1 = makeGraphqlFetch();
    const failingStatsFetch = (async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (query.includes('syncClimbStats')) throw new Error('network dropped mid-delta');
      return run1.fetch<T>(query, variables);
    }) as GraphqlFetchMock;
    await expect(
      pullSync(db, noopQueryClient(), failingStatsFetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onScopeDownloadComplete,
      }),
    ).rejects.toThrow('network dropped mid-delta');
    expect(onScopeDownloadComplete).not.toHaveBeenCalled();
    // The bootstrap itself committed before the delta died.
    expect(await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5'])).toEqual({
      value: '1',
    });

    const run2 = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), run2.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    const info = onScopeDownloadComplete.mock.calls[0][0] as { scopeKey: string; method: string };
    expect(info.scopeKey).toBe('kilter:1:5');
    expect(info.method).toBe('snapshot');
  });

  it('reports method "paged" when no snapshotSource is configured (pure paged crawl)', async () => {
    const { fetch } = makeGraphqlFetch();
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      onScopeDownloadComplete,
    });

    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    const info = onScopeDownloadComplete.mock.calls[0][0] as { scopeKey: string; method: string };
    expect(info.scopeKey).toBe('kilter:1:5');
    expect(info.method).toBe('paged');
  });

  it('reports scope-download completion only once for an already complete scope', async () => {
    const firstRun = makeGraphqlFetch();
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), firstRun.fetch, {
      enabledBoards: ['kilter:1:5'],
      onScopeDownloadComplete,
    });
    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);

    onScopeDownloadComplete.mockClear();
    const secondRun = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), secondRun.fetch, {
      enabledBoards: ['kilter:1:5'],
      onScopeDownloadComplete,
    });

    expect(onScopeDownloadComplete).not.toHaveBeenCalled();
  });

  it('reports method "paged" when a snapshotSource is configured but the scope is not bootstrap-eligible (mid-crawl)', async () => {
    // Pre-existing checkpoint makes the scope ineligible for bootstrap, so its
    // completion this cycle is a resumed paged crawl even though a snapshotSource
    // is present.
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', {
      updatedAt: '2026-01-01T00:00:00Z',
      syncSeq: '1',
    });
    await setCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5', {
      updatedAt: '2026-01-01T00:00:00Z',
      syncSeq: '1',
    });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const { fetch } = makeGraphqlFetch();
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    expect(source.downloadArtifact).not.toHaveBeenCalled();
    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    const info = onScopeDownloadComplete.mock.calls[0][0] as { scopeKey: string; method: string };
    expect(info.method).toBe('paged');
  });

  it('reports method "paged" for a scope whose artifact was rejected as schema-stale (same-cycle paged fallback)', async () => {
    // A stale-schema artifact is a permanent miss: the bootstrap never marks
    // the scope, the paged crawl runs the SAME cycle, and completion must
    // therefore report 'paged' — not 'snapshot'.
    const filePath = join(workDir, 'stale-method.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
      schemaVersion: LATEST_SCHEMA_VERSION - 1,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    const info = onScopeDownloadComplete.mock.calls[0][0] as { scopeKey: string; method: string };
    expect(info.scopeKey).toBe('kilter:1:5');
    expect(info.method).toBe('paged');
  });

  it('does not fire when a table bails early (sign-out mid-cycle) and the scope never reaches its tail', async () => {
    const { fetch } = makeGraphqlFetch();
    const onScopeDownloadComplete = vi.fn();

    // syncTable's very first guard (`isSigningOut() || ...`) returns
    // `{ reachedTail: false }` before any page fetch, so every table in this
    // cycle bails immediately and allTablesReachedTail stays false —
    // markScopeDownloadComplete (and thus onScopeDownloadComplete) must not fire.
    setSigningOut(true);
    try {
      await pullSync(db, noopQueryClient(), fetch, {
        enabledBoards: ['kilter:1:5'],
        onScopeDownloadComplete,
      });
    } finally {
      setSigningOut(false);
    }

    expect(onScopeDownloadComplete).not.toHaveBeenCalled();
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

    // Rewound to the OLDER (climbs) timestamp, with deletion-domain seq 0 so
    // tombstones at exactly that timestamp are replayed too.
    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual({
      updatedAt: '2026-05-01T00:00:00Z',
      syncSeq: '0',
    });
  });

  it('rewinds same-timestamp deletion cursors to seq 0 because deletion ids are independent of board sync_seq', async () => {
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '9' });

    const filePath = join(workDir, 'same-timestamp.db');
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

    // Board sync_seq 10 is not a deletion id. Rewinding to deletion seq 0 makes
    // `(deleted_at, id) > (watermark, 0)` replay every tombstone at the timestamp.
    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual({
      updatedAt: '2026-05-01T00:00:00Z',
      syncSeq: '0',
    });
  });

  it('leaves the deletions checkpoint untouched when it is already behind the watermark timestamp', async () => {
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, { updatedAt: '2026-04-30T23:59:59Z', syncSeq: '5000' });

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

    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual({
      updatedAt: '2026-04-30T23:59:59Z',
      syncSeq: '5000',
    });
  });
});

// ---------------------------------------------------------------------------
// staged download/import progress frames (issue #4311)
// ---------------------------------------------------------------------------

describe('pullSync bootstrap progress frames', () => {
  const ARTIFACT_WIRE_BYTES = 103_000_000;
  const ARTIFACT_DECODED_BYTES = 271_000_000;

  function progressEntry(overrides: Partial<SnapshotManifestEntry> = {}): SnapshotManifestEntry {
    return makeEntry({
      bytes: ARTIFACT_WIRE_BYTES,
      uncompressedBytes: ARTIFACT_DECODED_BYTES,
      contentEncoding: 'gzip',
      ...overrides,
    });
  }

  /** Every bootstrap frame that carried a snapshot payload, in order. */
  function collectSnapshotFrames(): {
    frames: SnapshotBootstrapProgress[];
    onProgress: (progress: SyncProgress) => void;
    allFrames: SyncProgress[];
  } {
    const frames: SnapshotBootstrapProgress[] = [];
    const allFrames: SyncProgress[] = [];
    return {
      frames,
      allFrames,
      onProgress: (progress) => {
        allFrames.push(progress);
        if (progress.snapshot) frames.push(progress.snapshot);
      },
    };
  }

  it('emits manifest → download → import, all tagged with the scope key', async () => {
    const filePath = join(workDir, 'staged.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({
      manifest: makeManifest([progressEntry()]),
      fileForEntry: () => filePath,
    });
    const collector = collectSnapshotFrames();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onProgress: collector.onProgress,
    });

    expect(collector.frames.map((frame) => frame.stage)).toEqual(['manifest', 'download', 'import']);
    expect(collector.frames.every((frame) => frame.scopeKey === 'kilter:1:5')).toBe(true);
    // Every snapshot payload rides on a bootstrap frame whose currentTable IS
    // its scope key, which is how a row matches it.
    const payloadFrames = collector.allFrames.filter((frame) => frame.snapshot);
    expect(payloadFrames.every((frame) => frame.phase === 'bootstrap' && frame.currentTable === 'kilter:1:5')).toBe(
      true,
    );
    // Wire scale only: the download frame quotes the same 103 MB the confirm
    // dialog did, never the 271 MB decoded size.
    const downloadFrame = collector.frames.find((frame) => frame.stage === 'download')!;
    expect(downloadFrame.wireBytes).toBe(ARTIFACT_WIRE_BYTES);
    expect(collector.frames.some((frame) => frame.wireBytes === ARTIFACT_DECODED_BYTES)).toBe(false);
  });

  it('turns platform byte callbacks into wire-scale frames, never the decoded size', async () => {
    const filePath = join(workDir, 'bytes.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    // An Android-shaped source: decoded byte counts, no usable total.
    const source: SnapshotSource = {
      fetchManifest: vi.fn(async () => makeManifest([progressEntry()])),
      downloadArtifact: vi.fn(
        async (
          _entry: SnapshotManifestEntry,
          options?: { onProgress?: (p: { bytesWritten: number; totalBytes: number | null }) => void },
        ) => {
          options?.onProgress?.({ bytesWritten: ARTIFACT_DECODED_BYTES / 2, totalBytes: -1 });
          return { filePath };
        },
      ),
      deleteArtifact: vi.fn(async () => {}),
    };
    const collector = collectSnapshotFrames();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onProgress: collector.onProgress,
    });

    const halfway = collector.frames.filter((frame) => frame.stage === 'download').at(-1)!;
    expect(halfway.fraction).toBeCloseTo(0.5, 3);
    expect(halfway.wireBytes).toBe(ARTIFACT_WIRE_BYTES);
    expect(halfway.wireBytesDone).toBe(Math.round(0.5 * ARTIFACT_WIRE_BYTES));
    // The decoded figure never reaches a frame the UI can read.
    expect(collector.frames.some((frame) => frame.wireBytesDone === ARTIFACT_DECODED_BYTES / 2)).toBe(false);
  });

  it('drives a full bootstrap from a source written against the OLD one-argument downloadArtifact', async () => {
    const filePath = join(workDir, 'legacy-source.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-legacy', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    // Exactly the pre-#4311 shape: one parameter, no options, no callback.
    const legacySource: SnapshotSource = {
      fetchManifest: async () => makeManifest([progressEntry()]),
      downloadArtifact: async (_entry: SnapshotManifestEntry) => ({ filePath }),
      deleteArtifact: async () => {},
    };
    const collector = collectSnapshotFrames();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: legacySource,
      onProgress: collector.onProgress,
    });

    // The import still ran…
    expect(await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', ['c-legacy'])).not.toBeNull();
    // …and the row still gets its stage captions, just with no byte detail.
    expect(collector.frames.map((frame) => frame.stage)).toEqual(['manifest', 'download', 'import']);
  });

  it('emits ONE download stream for two sizes of the same layout (the artifact is downloaded once)', async () => {
    const filePath = join(workDir, 'shared-layout.db');
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
    const source: SnapshotSource = {
      fetchManifest: vi.fn(async () => makeManifest([progressEntry()])),
      downloadArtifact: vi.fn(
        async (
          _entry: SnapshotManifestEntry,
          options?: { onProgress?: (p: { bytesWritten: number; totalBytes: number | null }) => void },
        ) => {
          options?.onProgress?.({ bytesWritten: ARTIFACT_DECODED_BYTES, totalBytes: ARTIFACT_DECODED_BYTES });
          return { filePath };
        },
      ),
      deleteArtifact: vi.fn(async () => {}),
    };
    const collector = collectSnapshotFrames();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5', 'kilter:1:6'],
      snapshotSource: source,
      onProgress: collector.onProgress,
    });

    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
    // The second size gets manifest + download-start + import captions, but the
    // byte stream belongs solely to the scope that actually pulled the file.
    const byteFrames = collector.frames.filter((frame) => frame.stage === 'download' && (frame.fraction ?? 0) > 0);
    expect(byteFrames.every((frame) => frame.scopeKey === 'kilter:1:5')).toBe(true);
  });

  it('drops a download frame that arrives after the bootstrap phase ended', async () => {
    const filePath = join(workDir, 'late-frame.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    let lateEmit: (() => void) | null = null;
    const source: SnapshotSource = {
      fetchManifest: vi.fn(async () => makeManifest([progressEntry()])),
      downloadArtifact: vi.fn(
        async (
          _entry: SnapshotManifestEntry,
          options?: { onProgress?: (p: { bytesWritten: number; totalBytes: number | null }) => void },
        ) => {
          // Stash the callback and fire it long after the phase is over — the
          // shape of a native downloader whose last event lands late.
          lateEmit = () => options?.onProgress?.({ bytesWritten: ARTIFACT_DECODED_BYTES, totalBytes: -1 });
          return { filePath };
        },
      ),
      deleteArtifact: vi.fn(async () => {}),
    };
    const collector = collectSnapshotFrames();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onProgress: collector.onProgress,
    });

    const frameCountAfterSync = collector.frames.length;
    lateEmit!();
    expect(collector.frames).toHaveLength(frameCountAfterSync);
  });
});
