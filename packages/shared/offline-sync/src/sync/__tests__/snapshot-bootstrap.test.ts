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
import {
  pullSync,
  emptyScopeDownloadPhases,
  type SyncProgress,
  type ScopeDownloadPhaseBreakdown,
} from '../pull-client';
import type { SnapshotBootstrapProgress } from '../snapshot-progress';
import {
  bootstrapScopeFromSnapshot,
  bootstrapScopeGradesFromSnapshot,
  getGradesBootstrapAttempts,
  markBootstrapDone,
  getBootstrapMetadataByScope,
  BOOTSTRAP_METADATA_QUERY,
  BOOTSTRAP_METADATA_PATTERNS,
  SnapshotPermanentMissError,
  SnapshotBackgroundTransferInterruptedError,
  SnapshotSchemaStaleError,
  type SnapshotSource,
} from '../snapshot-bootstrap';
import {
  getBootstrapAttempts,
  readBootstrapRetryState,
  restoreBootstrapRetryBudget,
  EMPTY_BOOTSTRAP_RETRY_STATE,
  MAX_BOOTSTRAP_ATTEMPTS,
  MAX_FREE_BACKGROUND_PAUSES,
  MAX_STRUCTURAL_REARMS,
  MAX_TRANSPORT_DOWNLOAD_FAILURES,
} from '../bootstrap-retry';
import { getCheckpoint, setCheckpoint, markScopeDownloadComplete, DELETIONS_CHECKPOINT_KEY } from '../checkpoints';
import { removeBoardScopeData } from '../scope-teardown';
import { runMigrations, LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import {
  setSigningOut,
  setBackgrounded,
  beginGlobalPurge,
  beginScopePurge,
  __resetDrainerStateForTests,
} from '../../mutation-queue/drainer';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { SCHEMA_STATEMENTS } from '../../db/schema';
import type { OfflineBoardScope } from '../../offline-board-key';
import {
  SNAPSHOT_MANIFEST_FORMAT_VERSION,
  type SnapshotGradesArtifact,
  type SnapshotManifest,
  type SnapshotManifestEntry,
} from '../snapshot-manifest';

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
  builtAt?: string;
  /** Optional metadata-only replay boundary; omitted to model an old artifact. */
  deletionsReplayFrom?: string;
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
    const builtAt = spec.builtAt ?? '2026-06-01T00:00:00.000Z';
    meta.run(
      'board_climbs',
      spec.climbsWatermark.updatedAt,
      spec.climbsWatermark.syncSeq,
      spec.climbsRowCountOverride ?? spec.climbs.length,
      builtAt,
      schemaVersion,
      formatVersion,
    );
    meta.run(
      'board_climb_stats',
      spec.statsWatermark.updatedAt,
      spec.statsWatermark.syncSeq,
      spec.statsRowCountOverride ?? spec.stats.length,
      builtAt,
      schemaVersion,
      formatVersion,
    );
    if (spec.deletionsReplayFrom) {
      meta.run('sync_deletions', spec.deletionsReplayFrom, '0', 0, builtAt, schemaVersion, formatVersion);
    }
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
function makeGraphqlFetch(options?: {
  climbServerRows?: Array<{ doc: Record<string, unknown>; cursor: Cursor }>;
  gradeServerRows?: Array<{ doc: Record<string, unknown>; cursor: Cursor }>;
}) {
  const capturedClimbCursors: Array<Cursor | undefined> = [];
  const capturedStatsCursors: Array<Cursor | undefined> = [];
  const capturedGradeCursors: Array<Cursor | undefined> = [];
  const emptyCursor: Cursor = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };

  const fetch = vi.fn(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const cursor = variables?.cursor as Cursor | undefined;
    if (query.includes('syncDeletions')) {
      return { syncDeletions: { deletions: [], cursor: emptyCursor, hasMore: false } } as T;
    }
    if (query.includes('syncClimbGrades')) {
      capturedGradeCursors.push(cursor);
      const rows = (options?.gradeServerRows ?? []).filter((row) => !cursor || compareCursor(row.cursor, cursor) > 0);
      if (rows.length === 0) {
        return { syncClimbGrades: { documents: [], cursor: cursor ?? emptyCursor, hasMore: false } } as T;
      }
      const last = rows[rows.length - 1];
      return {
        syncClimbGrades: { documents: rows.map((row) => row.doc), cursor: last.cursor, hasMore: false },
      } as T;
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
  return { fetch: typedFetch, capturedClimbCursors, capturedStatsCursors, capturedGradeCursors };
}

/**
 * `count` grade rows the paged crawl can consume, all stamped after the grades
 * artifact's watermark so they survive a cursor the artifact already advanced.
 */
function gradeServerRows(count: number): Array<{ doc: Record<string, unknown>; cursor: Cursor }> {
  return Array.from({ length: count }, (_unused, index) => {
    const syncSeq = String(100 + index);
    const computedAt = '2026-06-01T00:00:00.000Z';
    return {
      doc: {
        board_type: 'kilter',
        climb_uuid: `crawled-grade-${index}`,
        angle: 40,
        local_grade: 20,
        computed_at: computedAt,
        sync_seq: Number(syncSeq),
      },
      cursor: { updatedAt: computedAt, syncSeq },
    };
  });
}

type GraphqlFetchMock = ReturnType<typeof vi.fn> &
  (<T>(query: string, variables?: Record<string, unknown>) => Promise<T>);

const SCOPE_KILTER_5: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 5 };
/** Fixed clock for the retry-ladder tests; the real one is injected via SyncOptions. */
const BASE_NOW = 1_800_000_000_000;
const HOUR_MS = 3_600_000;
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
    // A settled scope's retry row is what My Boards reads to tell "waiting to try
    // again" from "this board is on the slow path for good".
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-retry:tension:2:10',
      JSON.stringify({
        transportFailures: 0,
        structuralFailures: MAX_BOOTSTRAP_ATTEMPTS,
        structuralRearms: 0,
        lastFailureKind: 'structural-device',
        failedBuiltAt: null,
        retryAfter: 1_800_000_000_000,
        hasPriorSnapshotFailure: true,
        mirroredAttempts: MAX_BOOTSTRAP_ATTEMPTS,
        legacyHealSpent: true,
      }),
    ]);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-attempts:kilter:9:20', '1']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [
      'checkpoint:board_climb_stats:kilter:9:20',
      '{}',
    ]);
    // Grades retries are a separate importer-only budget. They must not create
    // a whole-layout BootstrapScopeMetadata row for an otherwise untouched
    // scope.
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [
      'grades-bootstrap-attempts:missing:4:20',
      '2',
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
      retryAfter: null,
      structuralFailures: 0,
      isTerminal: false,
    });
    expect(metadataByScope.get('tension:2:10')).toEqual({
      attempts: 2,
      isBootstrapDone: false,
      isPagedFallback: true,
      hasBoardCheckpoint: false,
      isScopeComplete: false,
      retryAfter: 1_800_000_000_000,
      structuralFailures: MAX_BOOTSTRAP_ATTEMPTS,
      isTerminal: true,
    });
    expect(metadataByScope.get('kilter:9:20')).toEqual({
      attempts: 1,
      isBootstrapDone: false,
      isPagedFallback: false,
      hasBoardCheckpoint: true,
      isScopeComplete: false,
      retryAfter: null,
      structuralFailures: 0,
      isTerminal: false,
    });
    expect(metadataByScope.get('missing:4:20')).toBeUndefined();
    expect(metadataByScope.has('moonboard:3:7')).toBe(false);
  });

  it('binds exactly one placeholder per metadata prefix', () => {
    // The query is built FROM the pattern list, so this can only break if someone
    // hand-writes the clauses again — which is how a prefix gets silently dropped.
    expect((BOOTSTRAP_METADATA_QUERY.match(/\?/g) ?? []).length).toBe(BOOTSTRAP_METADATA_PATTERNS.length);
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

  it('rejects inconsistent embedded snapshot_meta built_at timestamps', async () => {
    const filePath = join(workDir, 'inconsistent-built-at.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const artifact = new DatabaseSync(filePath);
    artifact
      .prepare('UPDATE snapshot_meta SET built_at = ? WHERE table_name = ?')
      .run('2026-06-01T00:00:01.000Z', 'board_climb_stats');
    artifact.close();

    await expect(
      bootstrapScopeFromSnapshot({ db, scope: SCOPE_KILTER_5, scopeKey: 'kilter:1:5', filePath }),
    ).rejects.toThrow(/inconsistent snapshot_meta built_at/);
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

  it('stops at the batch boundary with NO checkpoints when a wipe lands mid-import', async () => {
    const filePath = join(workDir, 'wipe.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });

    // Flip the real wipe epoch the moment the stats INSERT runs (after the climbs
    // batch already COMMITTED), simulating a full sign-out wipe cycle in flight.
    //
    // WHAT CHANGED WITH BATCHING (issue #4310): the climbs batch is its own
    // committed transaction now, so its row SURVIVES. That is the benign half of
    // scope-teardown.ts's asymmetry — rows without markers re-import
    // idempotently and a teardown still removes them. What must NEVER survive is
    // a checkpoint, because the strict `>` delta pull never revisits anything at
    // or below a stamped cursor. Both checkpoints live in the final transaction,
    // after every batch, so the wipe check that fires here stops before them.
    // Spy on the adapter PROTOTYPE: the import runs on the transaction's own
    // connection (a separate adapter instance, mirroring expo), so an instance
    // spy on `db` would never fire.
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

    // Both row batches had already passed their in-lock guard when the epoch
    // moved, so both committed. The wipe is caught by the FINAL transaction's
    // guard, before a single marker is written.
    expect(await countRows('board_climbs')).toBe(1);
    expect(await countRows('board_climb_stats')).toBe(1);
    // The invariant that actually matters.
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toBeNull();
    expect(await getCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5')).toBeNull();
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5']),
    ).toBeNull();
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

  it('checks the snapshot path for a partial scope, then pages when that layout is not exported', async () => {
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '5' });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry({ layoutId: 99 })]),
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const { fetch } = makeGraphqlFetch();
    const onBootstrapMetadataChanged = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onBootstrapMetadataChanged,
    });

    // A page-one checkpoint no longer permanently excludes the fast path. With
    // no artifact for this layout, the existing crawl still finishes normally.
    expect(source.fetchManifest).toHaveBeenCalledTimes(1);
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

  it('fails open to the paged crawl for an unsupported manifest format', async () => {
    const source = makeSnapshotSource({ manifest: null });
    source.fetchManifest.mockResolvedValue({
      formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION + 1,
      generatedAt: '2026-06-01T00:00:00.000Z',
      entries: [],
    });
    const { fetch, capturedClimbCursors } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(capturedClimbCursors[0]).toBeUndefined();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
  });

  it('crawls this cycle on a permanent miss, and charges the device budget because the bytes were already spent', async () => {
    // A DOWNLOAD-stage permanent miss is not free the way a missing manifest
    // entry is: mobile only learns the artifact is undecoded gzip after the
    // whole ~100 MB lands. Leaving it uncharged let a heal-eligible scope pull
    // it again on every cycle, forever.
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

    // The crawl still runs in the same cycle — that part is what the name means.
    expect(capturedClimbCursors[0]).toBeUndefined();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(1);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-paged-fallback:kilter:1:5']),
    ).not.toBeNull();
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(expect.objectContaining({ stage: 'download', attempt: 1 }));
  });

  it('keeps a global manifest failure out of per-scope budgets and schedules a short wake', async () => {
    const source = makeSnapshotSource({ manifestThrows: true });
    const onSnapshotBootstrapError = vi.fn();
    const onBootstrapMetadataChanged = vi.fn();
    const onBootstrapRetryDue = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
      onBootstrapMetadataChanged,
      onBootstrapRetryDue,
      now: () => BASE_NOW,
    });

    // One bad global object must not poison every enabled scope or stamp the
    // first checkpoint before the short retry gets a chance.
    const climbsCalls = fetch.mock.calls.filter((args) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(0);
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).toBeNull();
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'manifest', attempt: 0, expected: false }),
    );
    expect(onBootstrapRetryDue).toHaveBeenCalledWith({ scopeKey: 'kilter:1:5', retryAt: BASE_NOW + 30_000 });
    expect(onBootstrapMetadataChanged).not.toHaveBeenCalled();
  });

  it('retries a malformed current-format manifest and uses the snapshot once it is valid', async () => {
    const filePath = join(workDir, 'manifest-recovered.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    source.fetchManifest.mockResolvedValueOnce({ formatVersion: 1, generatedAt: 'not-a-date', entries: [] });
    const firstRun = makeGraphqlFetch();
    const onBootstrapRetryDue = vi.fn();

    await pullSync(db, noopQueryClient(), firstRun.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onBootstrapRetryDue,
      now: () => BASE_NOW,
    });

    expect(firstRun.fetch.mock.calls.filter((args) => (args[0] as string).includes('syncClimbs'))).toHaveLength(0);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    expect(onBootstrapRetryDue).toHaveBeenCalledWith({ scopeKey: 'kilter:1:5', retryAt: BASE_NOW + 30_000 });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      now: () => BASE_NOW + 30_000,
    });

    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5']),
    ).not.toBeNull();
  });

  it('fails open to paged sync after two consecutive global manifest waits', async () => {
    const source = makeSnapshotSource({ manifest: null });
    source.fetchManifest.mockResolvedValue({
      formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
      generatedAt: 'not-a-date',
      entries: [],
    });
    const onBootstrapRetryDue = vi.fn();
    const runs = [makeGraphqlFetch(), makeGraphqlFetch(), makeGraphqlFetch()];

    for (const [runIndex, run] of runs.entries()) {
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onBootstrapRetryDue,
        now: () => BASE_NOW + runIndex * 30_000,
      });
    }

    // The first two cycles preserve the snapshot fast path without stamping a
    // page-one checkpoint. A persistently broken global object cannot keep the
    // board empty forever, so the third cycle deliberately starts paged sync.
    for (const run of runs.slice(0, 2)) {
      expect(run.fetch.mock.calls.filter((args) => (args[0] as string).includes('syncClimbs'))).toHaveLength(0);
    }
    expect(runs[2].capturedClimbCursors).toHaveLength(1);
    expect(onBootstrapRetryDue).toHaveBeenNthCalledWith(1, {
      scopeKey: 'kilter:1:5',
      retryAt: BASE_NOW + 30_000,
    });
    expect(onBootstrapRetryDue).toHaveBeenNthCalledWith(2, {
      scopeKey: 'kilter:1:5',
      retryAt: BASE_NOW + 60_000,
    });
    expect(onBootstrapRetryDue).toHaveBeenNthCalledWith(3, {
      scopeKey: 'kilter:1:5',
      retryAt: BASE_NOW + 360_000,
    });
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-paged-fallback:kilter:1:5']),
    ).not.toBeNull();
  });

  it('starts a fresh manifest grace window after a global wipe', async () => {
    const source = makeSnapshotSource({ manifest: null });
    source.fetchManifest.mockResolvedValue({
      formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
      generatedAt: 'not-a-date',
      entries: [],
    });

    for (let failure = 0; failure < 2; failure += 1) {
      await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        now: () => BASE_NOW + failure * 30_000,
      });
    }

    // Sign-out/account replacement and owner-mismatch wipes bump this epoch.
    // The next owner must not inherit the previous owner's fail-open count.
    beginGlobalPurge();
    const afterWipe = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), afterWipe.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      now: () => BASE_NOW + 60_000,
    });

    expect(afterWipe.capturedClimbCursors).toHaveLength(0);
  });

  it('clears consecutive manifest failures after a non-error response', async () => {
    const source = makeSnapshotSource({ manifest: null });
    const malformed = {
      formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
      generatedAt: 'not-a-date',
      entries: [],
    };
    source.fetchManifest
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(malformed);

    for (let runIndex = 0; runIndex < 3; runIndex += 1) {
      await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        now: () => BASE_NOW + runIndex * 30_000,
      });
    }

    const freshScopeAfterReset = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), freshScopeAfterReset.fetch, {
      enabledBoards: ['tension:2:10'],
      snapshotSource: source,
      now: () => BASE_NOW + 90_000,
    });

    expect(freshScopeAfterReset.capturedClimbCursors).toHaveLength(0);
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

      // Backgrounding mid-await must pre-empt manifest failure bookkeeping,
      // same as a sign-out/wipe caught mid-flight, and abort the whole cycle
      // before deletions/table pulls run.
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

describe('pullSync bootstrap: transport failures never spend the structural budget', () => {
  it('reports a transport manifest failure as expected, keeps the counters at 0, and still skips the paged pull', async () => {
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
    // Still skipped: a first-page checkpoint used to disqualify the snapshot path
    // for good, and the manifest stage is where an offline launch dies.
    expect(fetch.mock.calls.filter((args) => (args[0] as string).includes('syncClimbs'))).toHaveLength(0);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith({
      scopeKey: 'kilter:1:5',
      stage: 'manifest',
      attempt: 0,
      cause,
      expected: true,
      // A real failure, not a teardown — the engine fills both fields in for every
      // report site (issue #4314).
      reason: 'network',
      aborted: false,
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

  it('charges a transport DOWNLOAD failure to the transport budget, leaving the structural one intact', async () => {
    // The regression this whole issue is about: a dropped connection mid-artifact
    // used to burn the same 2-slot counter a corrupt artifact does, so two
    // bad-reception launches condemned the board to the 400+-round-trip crawl.
    const transportSource = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      downloadError: new Error('snapshot download: File.downloadFileAsync failed', {
        cause: new TypeError('Network request failed'),
      }),
    });
    const reports = vi.fn();
    const clock = { now: BASE_NOW };
    const retries: unknown[] = [];

    for (let launch = 0; launch < 2; launch += 1) {
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: transportSource,
        onSnapshotBootstrapError: reports,
        onBootstrapRetryScheduled: (info) => retries.push(info),
        now: () => clock.now,
        random: () => 0,
      });
      clock.now += 3 * HOUR_MS;
    }

    // Two transport failures — the OLD cap — and the scope is still on the fast path.
    expect(transportSource.downloadArtifact).toHaveBeenCalledTimes(2);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-paged-fallback:kilter:1:5']),
    ).toBeNull();
    // Still reported as expected, so Sentry sees a warning rather than an error.
    expect(reports).toHaveBeenCalledWith(expect.objectContaining({ stage: 'download', expected: true }));
    expect(retries).toEqual([
      expect.objectContaining({
        failureKind: 'transport',
        transportFailures: 1,
        structuralFailures: 0,
        terminal: false,
      }),
      expect.objectContaining({ failureKind: 'transport', transportFailures: 2, terminal: false }),
    ]);
  });

  it('waits out the scheduled cooldown instead of re-downloading on every foreground', async () => {
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      downloadError: new Error('boom', { cause: new TypeError('Network request failed') }),
    });
    const clock = { now: BASE_NOW };
    const onBootstrapRetryDue = vi.fn();

    for (let launch = 0; launch < 4; launch += 1) {
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onBootstrapRetryDue,
        now: () => clock.now,
        random: () => 0,
      });
      // Four foregrounds inside the first 2-minute rung.
      clock.now += 20_000;
    }

    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
    // The first callback settles the failure; the other three prove a persisted
    // cooldown observed on a later cycle still re-arms the scheduler lifecycle.
    expect(onBootstrapRetryDue).toHaveBeenCalledTimes(4);
    expect(onBootstrapRetryDue).toHaveBeenLastCalledWith({
      scopeKey: 'kilter:1:5',
      retryAt: BASE_NOW + 2 * 60_000,
    });
  });

  it('stops after the transport budget and lets the paged crawl deliver the board', async () => {
    // Bounded spend, which is the half of the old cap worth keeping: a device on
    // which the unresumable GET can never complete must not retry it forever.
    const timeoutSource = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      downloadError: new Error('snapshot download: File.downloadFileAsync failed for kilter:1', {
        // The exact shape the issue's Sentry sample carries on iOS.
        cause: new Error('UnableToDownloadException: The request timed out.'),
      }),
    });
    const clock = { now: BASE_NOW };
    let climbQueries = 0;

    for (let launch = 0; launch < 40; launch += 1) {
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: timeoutSource,
        now: () => clock.now,
        random: () => 0,
      });
      climbQueries += run.capturedClimbCursors.length;
      clock.now += 25 * HOUR_MS;
    }

    expect(timeoutSource.downloadArtifact).toHaveBeenCalledTimes(MAX_TRANSPORT_DOWNLOAD_FAILURES);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-paged-fallback:kilter:1:5']),
    ).not.toBeNull();
    // …and the board is not left empty while that plays out.
    expect(climbQueries).toBeGreaterThan(0);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5']),
    ).not.toBeNull();
  });

  it('spends only the structural budget for a device-side fault, and no nightly rebuild re-arms it', async () => {
    // A disk-full device would otherwise download 2 x 103 MB every night, because
    // `builtAt` differs on essentially every launch after the first day.
    const diskFullSource = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      downloadError: new Error('snapshot download: insufficient disk space for kilter:1'),
    });
    const clock = { now: BASE_NOW };

    for (let launch = 0; launch < 40; launch += 1) {
      diskFullSource.fetchManifest.mockResolvedValue(
        makeManifest([makeEntry({ builtAt: new Date(clock.now).toISOString() })]),
      );
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: diskFullSource,
        now: () => clock.now,
        random: () => 0,
      });
      // The real Kilter crawl is 400+ serial round trips and does not finish in
      // one cycle; the fake resolver reaches the tail instantly, so drop the
      // completion marker to keep the scope in the state this test is about.
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5']);
      clock.now += 25 * HOUR_MS;
    }

    expect(diskFullSource.downloadArtifact).toHaveBeenCalledTimes(MAX_BOOTSTRAP_ATTEMPTS);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(MAX_BOOTSTRAP_ATTEMPTS);
  });

  it('gives a broken ARTIFACT exactly one extra round when a new build lands, then stops', async () => {
    const filePath = join(workDir, 'corrupt-forever.db');
    writeFileSync(filePath, 'not a database');
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const clock = { now: BASE_NOW };

    for (let launch = 0; launch < 40; launch += 1) {
      source.fetchManifest.mockResolvedValue(makeManifest([makeEntry({ builtAt: new Date(clock.now).toISOString() })]));
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        now: () => clock.now,
        random: () => 0,
      });
      // See above: keep the scope mid-crawl so the budget, not the crawl
      // finishing, is what stops the downloads.
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5']);
      clock.now += 25 * HOUR_MS;
    }

    // 2 structural slots + 2 more from the single lifetime re-arm.
    expect(source.downloadArtifact).toHaveBeenCalledTimes(MAX_BOOTSTRAP_ATTEMPTS * (1 + MAX_STRUCTURAL_REARMS));
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

describe('pullSync bootstrap: healing a scope stranded mid-crawl', () => {
  /** A board that gave up on the snapshot path and then crawled part of its catalog. */
  async function seedStrandedMidCrawl(checkpoint = { updatedAt: '2026-04-01T00:00:00Z', syncSeq: '5' }): Promise<void> {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-attempts:kilter:1:5',
      '2',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-paged-fallback:kilter:1:5',
      '1',
    ]);
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', checkpoint);
  }

  function buildHealArtifact(filePath: string): void {
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-in', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c-in', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
  }

  it('imports the artifact over the partial catalog and moves both checkpoints FORWARD', async () => {
    await seedStrandedMidCrawl();
    const filePath = join(workDir, 'heal.db');
    buildHealArtifact(filePath);
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();
    const recovered = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onBootstrapPathRecovered: recovered,
      now: () => BASE_NOW,
      random: () => 0,
    });

    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs ORDER BY uuid');
    expect(climbs.map((row) => row.uuid)).toEqual(['c-in']);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toEqual(CLIMBS_WATERMARK);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5']),
    ).not.toBeNull();
    expect(recovered).toHaveBeenCalledWith({
      scopeKey: 'kilter:1:5',
      boardType: 'kilter',
      trigger: 'legacy-migration',
      hadBoardCheckpoint: true,
    });
    // Rollback safety: the legacy rows an older bundle reads are still there.
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-attempts:kilter:1:5']),
    ).not.toBeNull();
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-attempts-healed:kilter:1:5']),
    ).not.toBeNull();
  });

  it('reports the healed scope so download-duration comparisons can exclude it', async () => {
    await seedStrandedMidCrawl();
    const filePath = join(workDir, 'heal-telemetry.db');
    buildHealArtifact(filePath);
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
      now: () => BASE_NOW,
      random: () => 0,
    });

    expect(onScopeDownloadComplete).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: 'kilter:1:5', method: 'snapshot', bootstrapHealed: true }),
    );
  });

  it('still reports the heal when the scope completes in a LATER cycle', async () => {
    // The common shape: board_climb_grades is not a snapshot table, so a healed
    // scope routinely reaches completion cycles after the import. An in-memory
    // per-cycle set reported bootstrapHealed:false for exactly those runs —
    // contaminating the comparison the field exists to protect.
    await seedStrandedMidCrawl();
    const filePath = join(workDir, 'heal-late-complete.db');
    buildHealArtifact(filePath);
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
        now: () => BASE_NOW,
        random: () => 0,
      }),
    ).rejects.toThrow('network dropped mid-delta');
    expect(onScopeDownloadComplete).not.toHaveBeenCalled();

    const run2 = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), run2.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
      now: () => BASE_NOW + HOUR_MS,
      random: () => 0,
    });

    expect(onScopeDownloadComplete).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: 'kilter:1:5', method: 'snapshot', bootstrapHealed: true }),
    );
  });

  it('never heals a scope that already serves the whole catalog offline', async () => {
    await seedStrandedMidCrawl();
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'scope-complete:kilter:1:5',
      '1',
    ]);
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      now: () => BASE_NOW,
      random: () => 0,
    });

    expect(source.fetchManifest).not.toHaveBeenCalled();
    expect(source.downloadArtifact).not.toHaveBeenCalled();
  });

  it('heals a mid-crawl scope created before snapshot I/O was available', async () => {
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', { updatedAt: '2026-04-01T00:00:00Z', syncSeq: '5' });
    const filePath = join(workDir, 'cold-launch-heal.db');
    buildHealArtifact(filePath);
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
    });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      now: () => BASE_NOW,
      random: () => 0,
    });

    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5']),
    ).not.toBeNull();
  });

  it('defers the automatic heal on a metered link without burning anything', async () => {
    await seedStrandedMidCrawl();
    const filePath = join(workDir, 'metered.db');
    buildHealArtifact(filePath);
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      isOnUnmeteredNetwork: () => false,
      now: () => BASE_NOW,
      random: () => 0,
    });

    expect(source.downloadArtifact).not.toHaveBeenCalled();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);

    // The crawl ran while the heal was deferred (a deferred scope is never
    // stalled), and the fake resolver reaches the tail instantly. Drop the
    // completion marker so this stays the mid-crawl case the heal exists for.
    await db.runAsync('DELETE FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5']);

    // Back on wifi (and past the deferral), the same scope heals.
    const later = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), later.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      now: () => BASE_NOW + 7 * HOUR_MS,
      random: () => 0,
    });
    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
  });

  it('settles a heal-eligible scope after two permanent misses instead of pulling the artifact every cycle', async () => {
    // The gzip case (#4238): the device's HTTP stack hands back a body it never
    // decoded, which mobile can only detect once the whole artifact has landed.
    // A heal-eligible scope is eligible on EVERY cycle, so an uncharged miss
    // meant ~100 MB down the wire per cycle for the life of the install.
    await seedStrandedMidCrawl();
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => null });
    source.downloadArtifact.mockImplementation(async () => {
      throw new SnapshotPermanentMissError('snapshot artifact arrived still gzip-compressed');
    });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        now: () => BASE_NOW + cycle * 60_000,
        random: () => 0,
      });
      // board_climb_grades is still crawling on a real device, so the scope
      // never completes between cycles — the population this loop punished.
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5']);
    }
    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);

    // Past the 6 h cooldown: the second and last device slot, then it settles.
    for (const hoursLater of [7, 40, 24 * 30]) {
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        now: () => BASE_NOW + hoursLater * HOUR_MS,
        random: () => 0,
      });
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5']);
    }
    expect(source.downloadArtifact).toHaveBeenCalledTimes(2);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(MAX_BOOTSTRAP_ATTEMPTS);
  });

  it('a fresh scope ignores the metered probe — the user just confirmed the size', async () => {
    const filePath = join(workDir, 'metered-fresh.db');
    buildHealArtifact(filePath);
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      isOnUnmeteredNetwork: () => false,
      now: () => BASE_NOW,
      random: () => 0,
    });

    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
  });
});

describe('pullSync bootstrap: the watermark-regression guard', () => {
  async function seedStranded(checkpoint: Cursor): Promise<void> {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-attempts:kilter:1:5',
      '2',
    ]);
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', checkpoint);
    await setCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5', checkpoint);
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, checkpoint);
  }

  it('refuses an artifact whose scope filter matches nothing, leaving every checkpoint byte-identical', async () => {
    const localCheckpoint: Cursor = { updatedAt: '2026-04-01T00:00:00Z', syncSeq: '5' };
    await seedStranded(localCheckpoint);
    const filePath = join(workDir, 'empty-scope.db');
    // Every climb is compatible with a size this scope does not have, so the
    // scoped watermark computes as the EPOCH — which would otherwise stamp
    // checkpoint:board_climbs back to 1970 and re-crawl 400+ pages from scratch.
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'other-size', compatibleSizeIds: [77] }],
      stats: [{ climbUuid: 'other-size', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onSnapshotBootstrapError = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
      now: () => BASE_NOW,
      random: () => 0,
    });

    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toEqual(localCheckpoint);
    expect(await getCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5')).toEqual(localCheckpoint);
    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual(localCheckpoint);
    expect(await countRows('board_climbs')).toBe(0);
    // The refusal is RECORDED: it burns the structural budget like any other
    // import failure, because the artifact on offer provably cannot serve this
    // scope and only a rebuilt one can change that.
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(1);
    // It is also something an engineer wants to see, at full severity.
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'import', attempt: 1, expected: false }),
    );
  });

  it('does not re-download the artifact on every cycle after refusing it', async () => {
    // The regression that shipped in the first cut of #4313: the refusal stamped
    // a paged-fallback marker and continued, leaving the scope exactly as
    // eligible as before, so every sync cycle pulled the whole ~100 MB again.
    const aheadOfArtifact: Cursor = { updatedAt: '2026-09-01T00:00:00Z', syncSeq: '999' };
    await seedStranded(aheadOfArtifact);
    const filePath = join(workDir, 'refusal-loop.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-in', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c-in', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const run = makeGraphqlFetch();
      await pullSync(db, noopQueryClient(), run.fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        now: () => BASE_NOW + cycle * 60_000,
        random: () => 0,
      });
      // The scope stays incomplete between cycles — board_climb_grades is still
      // crawling, which is exactly the population the heal targets and the one
      // that kept re-downloading. Completion would end the loop on its own.
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5']);
    }
    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);

    // Past the 6 h cooldown the scope spends its second and last structural
    // attempt; the same artifact refuses again and it settles onto the crawl.
    const afterCooldown = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), afterCooldown.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      now: () => BASE_NOW + 7 * HOUR_MS,
      random: () => 0,
    });

    expect(source.downloadArtifact).toHaveBeenCalledTimes(2);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(MAX_BOOTSTRAP_ATTEMPTS);
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-paged-fallback:kilter:1:5']),
    ).not.toBeNull();
  });

  it('refuses an artifact the local crawl has already run past', async () => {
    const aheadOfArtifact: Cursor = { updatedAt: '2026-09-01T00:00:00Z', syncSeq: '999' };
    await seedStranded(aheadOfArtifact);
    const filePath = join(workDir, 'behind-crawl.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-in', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c-in', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      now: () => BASE_NOW,
      random: () => 0,
    });

    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toEqual(aheadOfArtifact);
    expect(await countRows('board_climbs')).toBe(0);
  });

  it('still imports the same artifact into a FRESH scope', async () => {
    const filePath = join(workDir, 'fresh-ok.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'other-size', compatibleSizeIds: [77] }],
      stats: [{ climbUuid: 'other-size', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      now: () => BASE_NOW,
      random: () => 0,
    });

    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:5']),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// "Try the fast download again" — the consented, size-disclosed retry
// ---------------------------------------------------------------------------

describe('pullSync bootstrap: a user-requested retry', () => {
  /**
   * A board that spent its budget and settled. It ALWAYS carries board
   * checkpoints — a terminal scope is never in `skipPagedPull`, so it crawls
   * while it is settled — which is why it can only ever come back as a
   * heal-over-partial, the one kind the metered probe defers.
   */
  async function seedSettledScope(): Promise<void> {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-retry:kilter:1:5',
      JSON.stringify({
        ...EMPTY_BOOTSTRAP_RETRY_STATE,
        structuralFailures: MAX_BOOTSTRAP_ATTEMPTS,
        lastFailureKind: 'structural-device',
        hasPriorSnapshotFailure: true,
        mirroredAttempts: MAX_BOOTSTRAP_ATTEMPTS,
      }),
    ]);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-paged-fallback:kilter:1:5',
      '1',
    ]);
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', { updatedAt: '2026-04-01T00:00:00Z', syncSeq: '5' });
  }

  /**
   * The fixture's paged crawl reaches its tail on every cycle, which would mark
   * the scope complete and make it permanently bootstrap-ineligible. A real
   * settled board is still crawling `board_climb_grades`, so it is not complete —
   * drop the marker between cycles to keep the fixture honest.
   */
  async function keepScopeIncomplete(): Promise<void> {
    await db.runAsync('DELETE FROM sync_meta WHERE key = ?', ['scope-complete:kilter:1:5']);
  }

  function buildRetryArtifact(filePath: string): void {
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-in', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c-in', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
  }

  it('downloads on a metered link — the climber just confirmed the size', async () => {
    await seedSettledScope();
    const filePath = join(workDir, 'user-retry-metered.db');
    buildRetryArtifact(filePath);
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const recovered = vi.fn();

    // Settled: the engine will not even read the manifest for it.
    const before = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), before.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      isOnUnmeteredNetwork: () => false,
      now: () => BASE_NOW,
      random: () => 0,
    });
    expect(source.downloadArtifact).not.toHaveBeenCalled();
    await keepScopeIncomplete();

    await restoreBootstrapRetryBudget(db, 'kilter:1:5');

    const after = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), after.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      isOnUnmeteredNetwork: () => false,
      onBootstrapPathRecovered: recovered,
      now: () => BASE_NOW + 60_000,
      random: () => 0,
    });

    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
    const climbs = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM board_climbs');
    expect(climbs.map((row) => row.uuid)).toEqual(['c-in']);
    expect(recovered).toHaveBeenCalledWith({
      scopeKey: 'kilter:1:5',
      boardType: 'kilter',
      trigger: 'user-request',
      hadBoardCheckpoint: true,
    });
  });

  it('spends the request on one download, then defers on a metered link again', async () => {
    await seedSettledScope();
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), downloadThrows: true });
    await restoreBootstrapRetryBudget(db, 'kilter:1:5');

    const consented = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), consented.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      isOnUnmeteredNetwork: () => false,
      now: () => BASE_NOW,
      random: () => 0,
    });
    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
    await keepScopeIncomplete();

    // Past the failure's 6 h cooldown, still on cellular: the tap is spent, so
    // this is an ordinary automatic heal again and defers instead of pulling
    // another ~100 MB the climber never asked for.
    const stillMetered = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), stillMetered.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      isOnUnmeteredNetwork: () => false,
      now: () => BASE_NOW + 7 * HOUR_MS,
      random: () => 0,
    });
    expect(source.downloadArtifact).toHaveBeenCalledTimes(1);
    await keepScopeIncomplete();

    // On wifi, past the deferral, the automatic heal runs on its own.
    const onWifi = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), onWifi.fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      now: () => BASE_NOW + 14 * HOUR_MS,
      random: () => 0,
    });
    expect(source.downloadArtifact).toHaveBeenCalledTimes(2);
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

  it('reports method "paged" when a partial scope defers its automatic heal on a metered link', async () => {
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
      isOnUnmeteredNetwork: () => false,
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
  it('uses the export-transaction replay boundary instead of a quiet layout row watermark', async () => {
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, { updatedAt: '2026-09-01T00:00:00Z', syncSeq: '5000' });

    const filePath = join(workDir, 'transaction-boundary-rewind.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      // This layout has been quiet for a month. Replaying from this row cursor
      // would needlessly scan a month of global tombstones.
      climbsWatermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
      statsWatermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' },
      // The exporter captured this from the SAME REPEATABLE READ transaction,
      // after subtracting its stability window.
      deletionsReplayFrom: '2026-05-31T23:59:30.000Z',
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual({
      updatedAt: '2026-05-31T23:59:30.000Z',
      syncSeq: '0',
    });
  });

  it('falls back to min(watermarks) for an old artifact without deletion replay metadata', async () => {
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

  it('falls back to min(watermarks) when deletion replay metadata is malformed', async () => {
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, { updatedAt: '2026-09-01T00:00:00Z', syncSeq: '5000' });

    const filePath = join(workDir, 'malformed-transaction-boundary.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
      statsWatermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' },
      deletionsReplayFrom: '2026-05-31T23:59:30.000Z',
    });
    const artifact = new DatabaseSync(filePath);
    artifact
      .prepare('UPDATE snapshot_meta SET watermark_sync_seq = ? WHERE table_name = ?')
      .run('not-zero', 'sync_deletions');
    artifact.close();

    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual({
      updatedAt: '2026-05-01T00:00:00Z',
      syncSeq: '0',
    });
  });

  it('falls back to min(watermarks) when the replay boundary is after artifact built_at', async () => {
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, { updatedAt: '2026-09-01T00:00:00Z', syncSeq: '5000' });

    const filePath = join(workDir, 'future-transaction-boundary.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
      statsWatermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' },
      builtAt: '2026-06-01T00:00:00.000Z',
      deletionsReplayFrom: '2026-06-01T00:00:01.000Z',
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const { fetch } = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], snapshotSource: source });

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

  /**
   * The stage CAPTIONS a row shows, in order. The import stage emits many frames
   * now that it commits in batches (issue #4310) — the sequence of stages is what
   * these cases are about, and the fractions have their own case below.
   */
  function stageSequence(frames: SnapshotBootstrapProgress[]): string[] {
    return frames.map((frame) => frame.stage).filter((stage, index, all) => stage !== all[index - 1]);
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

    expect(stageSequence(collector.frames)).toEqual(['manifest', 'download', 'import']);
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
    expect(stageSequence(collector.frames)).toEqual(['manifest', 'download', 'import']);
  });

  // Before #4310 the import stage emitted ONE frame with `fraction: null` — a
  // 20-60s indeterminate spinner on Android — because the import was a single
  // exclusive transaction with nowhere safe to emit from inside it. It commits in
  // batches now, so the bar moves.
  it('emits a determinate, non-decreasing import fraction that ends at 1', async () => {
    const filePath = join(workDir, 'determinate-import.db');
    buildArtifact({
      filePath,
      climbs: Array.from({ length: 6 }, (_unused, index) => ({
        uuid: `det-${index}`,
        compatibleSizeIds: [5],
      })),
      stats: Array.from({ length: 6 }, (_unused, index) => ({ climbUuid: `det-${index}`, angle: 40 })),
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({
      manifest: makeManifest([
        progressEntry({
          tables: {
            board_climbs: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 6 },
            board_climb_stats: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 6 },
          },
        }),
      ]),
      fileForEntry: () => filePath,
    });
    const collector = collectSnapshotFrames();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onProgress: collector.onProgress,
    });

    const importFractions = collector.frames.filter((frame) => frame.stage === 'import').map((frame) => frame.fraction);
    expect(importFractions.length).toBeGreaterThan(1);
    // Determinate from the first frame: no null anywhere in the stage.
    expect(importFractions.every((fraction) => fraction !== null)).toBe(true);
    // The stage-change frame is not suppressed by the throttle's monotonic rule
    // even though it drops from download(1) to import(0) — snapshot-progress.ts
    // exempts stage changes, and this is the assertion that pins it.
    expect(importFractions[0]).toBe(0);
    const monotonic = importFractions.every(
      (fraction, index) => index === 0 || (fraction ?? 0) >= (importFractions[index - 1] ?? 0),
    );
    expect(monotonic).toBe(true);
    expect(importFractions[importFractions.length - 1]).toBe(1);
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
    // The second size gets its own manifest + import captions, but no download
    // stage because the layout artifact is already cached in this cycle. Its
    // first frame proves scope A's throttle state did not suppress scope B.
    const byteFrames = collector.frames.filter((frame) => frame.stage === 'download' && (frame.fraction ?? 0) > 0);
    expect(byteFrames.every((frame) => frame.scopeKey === 'kilter:1:5')).toBe(true);
    expect(stageSequence(collector.frames.filter((frame) => frame.scopeKey === 'kilter:1:6'))).toEqual([
      'manifest',
      'import',
    ]);
  });

  it('does not carry a download throttle window from one scope into the next', async () => {
    const firstFilePath = join(workDir, 'progress-layout-1.db');
    const secondFilePath = join(workDir, 'progress-layout-2.db');
    buildArtifact({
      filePath: firstFilePath,
      climbs: [{ uuid: 'layout-1', layoutId: 1, compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    buildArtifact({
      filePath: secondFilePath,
      climbs: [{ uuid: 'layout-2', layoutId: 2, compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const firstEntry = progressEntry({ layoutId: 1, key: 'layout-1.db', url: 'https://example.test/layout-1.db' });
    const secondEntry = progressEntry({ layoutId: 2, key: 'layout-2.db', url: 'https://example.test/layout-2.db' });
    const source: SnapshotSource = {
      fetchManifest: vi.fn(async () => makeManifest([firstEntry, secondEntry])),
      downloadArtifact: vi.fn(
        async (
          entry: SnapshotManifestEntry,
          options?: { onProgress?: (p: { bytesWritten: number; totalBytes: number | null }) => void },
        ) => {
          const fraction = entry.layoutId === 1 ? 0.9 : 0.05;
          options?.onProgress?.({
            bytesWritten: ARTIFACT_DECODED_BYTES * fraction,
            totalBytes: ARTIFACT_DECODED_BYTES,
          });
          return { filePath: entry.layoutId === 1 ? firstFilePath : secondFilePath };
        },
      ),
      deleteArtifact: vi.fn(async () => {}),
    };
    const collector = collectSnapshotFrames();
    vi.spyOn(Date, 'now').mockReturnValue(BASE_NOW);

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5', 'kilter:2:5'],
      snapshotSource: source,
      onProgress: collector.onProgress,
      now: () => BASE_NOW,
    });

    const secondScopeByteFrame = collector.frames.find(
      (frame) => frame.scopeKey === 'kilter:2:5' && frame.stage === 'download' && (frame.fraction ?? 0) > 0,
    );
    expect(secondScopeByteFrame?.fraction).toBeCloseTo(0.05);
  });

  it('uses the injected clock for progress throttling', async () => {
    const filePath = join(workDir, 'progress-clock.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c-clock', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    let nowMs = BASE_NOW;
    const source: SnapshotSource = {
      fetchManifest: vi.fn(async () => makeManifest([progressEntry()])),
      downloadArtifact: vi.fn(
        async (
          _entry: SnapshotManifestEntry,
          options?: { onProgress?: (p: { bytesWritten: number; totalBytes: number | null }) => void },
        ) => {
          options?.onProgress?.({ bytesWritten: ARTIFACT_DECODED_BYTES / 4, totalBytes: ARTIFACT_DECODED_BYTES });
          nowMs += 400;
          options?.onProgress?.({ bytesWritten: ARTIFACT_DECODED_BYTES / 2, totalBytes: ARTIFACT_DECODED_BYTES });
          return { filePath };
        },
      ),
      deleteArtifact: vi.fn(async () => {}),
    };
    const collector = collectSnapshotFrames();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onProgress: collector.onProgress,
      now: () => nowMs,
    });

    expect(
      collector.frames
        .filter((frame) => frame.stage === 'download' && frame.fraction !== 0)
        .map((frame) => frame.fraction),
    ).toEqual([0.25, 0.5]);
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

// ---------------------------------------------------------------------------
// download-funnel Started anchor (issue #4316)
// ---------------------------------------------------------------------------

describe('pullSync onScopeDownloadStart', () => {
  it('fires once with pathIntent snapshot and the artifact size for a fresh snapshot scope', async () => {
    const filePath = join(workDir, 'started-snapshot.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const entry = makeEntry({ bytes: 103_000_000 });
    const source = makeSnapshotSource({ manifest: makeManifest([entry]), fileForEntry: () => filePath });
    const onScopeDownloadStart = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadStart,
    });

    expect(onScopeDownloadStart).toHaveBeenCalledTimes(1);
    expect(onScopeDownloadStart).toHaveBeenCalledWith({
      scopeKey: 'kilter:1:5',
      pathIntent: 'snapshot',
      // On Started specifically, because an ABANDONED download never emits
      // Completed — without this the size of the downloads people give up on
      // would be unknowable.
      artifactBytes: 103_000_000,
    });
  });

  it('fires once with pathIntent paged for a build with no snapshot source', async () => {
    const onScopeDownloadStart = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], onScopeDownloadStart });

    expect(onScopeDownloadStart).toHaveBeenCalledTimes(1);
    expect(onScopeDownloadStart).toHaveBeenCalledWith({
      scopeKey: 'kilter:1:5',
      pathIntent: 'paged',
      artifactBytes: null,
    });
  });

  it('fires once with snapshot intent for a partial scope that can now heal', async () => {
    // A paged crawl writes a checkpoint on its first 500-row page. It remains
    // eligible for the artifact instead of being locked to that path forever.
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '5' });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => join(workDir, 'never.db'),
    });
    const onScopeDownloadStart = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadStart,
    });

    expect(onScopeDownloadStart).toHaveBeenCalledTimes(1);
    expect(onScopeDownloadStart.mock.calls[0][0].pathIntent).toBe('snapshot');
  });

  it('does NOT fire a second time on the next cycle, nor after a failed bootstrap retries', async () => {
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), downloadThrows: true });
    const onScopeDownloadStart = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadStart,
    });
    expect(onScopeDownloadStart).toHaveBeenCalledTimes(1);

    // A retry cycle: the download fails again and the scope is attempted afresh.
    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadStart,
    });
    expect(onScopeDownloadStart).toHaveBeenCalledTimes(1);
  });

  it('fires again after scope teardown clears the marker, so a re-added board re-enters the funnel', async () => {
    const onScopeDownloadStart = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], onScopeDownloadStart });
    expect(onScopeDownloadStart).toHaveBeenCalledTimes(1);

    await removeBoardScopeData({
      db,
      scope: { boardType: 'kilter', layoutId: 1, sizeId: 5 },
      scopeKey: 'kilter:1:5',
      retainedScopes: [],
    });

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], onScopeDownloadStart });
    expect(onScopeDownloadStart).toHaveBeenCalledTimes(2);
  });

  it('carries bytes/rowCount/downloadMs/importMs on Completed when the import ran this cycle', async () => {
    const filePath = join(workDir, 'complete-props.db');
    buildArtifact({
      filePath,
      climbs: [
        { uuid: 'c1', compatibleSizeIds: [5] },
        { uuid: 'c2', compatibleSizeIds: [5] },
      ],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry({ bytes: 103_000_000 })]),
      fileForEntry: () => filePath,
    });
    const onScopeDownloadComplete = vi.fn();
    const { fetch } = makeGraphqlFetch();
    let wallNowMs = BASE_NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => wallNowMs++);

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    const info = onScopeDownloadComplete.mock.calls[0][0];
    expect(info.method).toBe('snapshot');
    expect(info.bytes).toBe(103_000_000);
    expect(info.rowCount).toBe(3); // two climbs + one stats row
    expect(typeof info.downloadMs).toBe('number');
    expect(typeof info.importMs).toBe('number');
    expect(info.downloadMs).toBe(info.phases.downloadMs);
  });

  it('stays SILENT for a board that already finished downloading before the marker existed', async () => {
    // The upgrade case, and the one that would wreck the first weeks of funnel
    // data: every board already downloaded on the device has a `scope-complete:`
    // marker and no `scope-started:` one. It cannot emit Completed again (that
    // event is once-ever too), so an unguarded Started here would show up as one
    // phantom abandoned download per board, on every upgrading device at once.
    const seed = vi.fn();
    const { fetch } = makeGraphqlFetch();
    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], onScopeDownloadStart: seed });
    expect(seed).toHaveBeenCalledTimes(1);
    // Roll the device back to the pre-#4316 state: complete, never "started".
    await db.runAsync('DELETE FROM sync_meta WHERE key = ?', ['scope-started:kilter:1:5']);

    const onScopeDownloadStart = vi.fn();
    const onScopeDownloadComplete = vi.fn();
    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      onScopeDownloadStart,
      onScopeDownloadComplete,
    });

    expect(onScopeDownloadStart).not.toHaveBeenCalled();
    expect(onScopeDownloadComplete).not.toHaveBeenCalled();
    // The marker is still written, so the scope is settled rather than
    // re-evaluated on every future cycle.
    expect(
      await db.getFirstAsync('SELECT key FROM sync_meta WHERE key = ?', ['scope-started:kilter:1:5']),
    ).not.toBeNull();
  });

  it('omits the payload props on a paged completion, rather than reporting zeroes', async () => {
    // The engine has nothing honest to say about work it did not do.
    const onScopeDownloadComplete = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, { enabledBoards: ['kilter:1:5'], onScopeDownloadComplete });

    const info = onScopeDownloadComplete.mock.calls[0][0];
    expect(info.method).toBe('paged');
    expect(info.bytes).toBeUndefined();
    expect(info.rowCount).toBeUndefined();
    expect(info.downloadMs).toBeUndefined();
    expect(info.importMs).toBeUndefined();
  });
});

// Artifact retention, reuse, and phase telemetry (issue #4310)
// ---------------------------------------------------------------------------

/** A source that records how each artifact was released and can serve retained files. */
function makeRetainingSource(config: {
  manifest: SnapshotManifest;
  fileForEntry: (entry: SnapshotManifestEntry) => string | null;
  /** Files the previous cycle left on disk, returned with `reused: true`. */
  retained?: Set<string>;
}) {
  const released: Array<{ filePath: string; imported: boolean }> = [];
  const deleted: string[] = [];
  const downloadedUrls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const source = {
    fetchManifest: vi.fn(async () => config.manifest),
    downloadArtifact: vi.fn(async (entry: SnapshotManifestEntry, options?: { signal?: AbortSignal }) => {
      const filePath = config.fileForEntry(entry);
      if (!filePath) return null;
      signals.push(options?.signal);
      if (config.retained?.has(filePath)) return { filePath, reused: true };
      downloadedUrls.push(entry.url);
      return { filePath };
    }),
    deleteArtifact: vi.fn(async (filePath: string) => {
      deleted.push(filePath);
    }),
    releaseArtifact: vi.fn(async (filePath: string, options: { imported: boolean }) => {
      released.push({ filePath, imported: options.imported });
    }),
  };
  return { source: source as unknown as SnapshotSource, released, deleted, downloadedUrls, signals };
}

describe('artifact release and reuse', () => {
  it('releases an imported artifact with imported: true', async () => {
    const filePath = join(workDir, 'released-imported.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const { source, released, deleted } = makeRetainingSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(released).toEqual([{ filePath, imported: true }]);
    expect(deleted).toEqual([]);
  });

  it('releases a NEVER-IMPORTED artifact with imported: false so retention can keep it', async () => {
    // Backgrounding after the download but before the import used to delete a
    // 103 MB file in the phase's `finally` and start over on the next wake.
    const filePath = join(workDir, 'released-unimported.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const { source, released } = makeRetainingSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
    });
    const backgroundingSource: SnapshotSource = {
      ...source,
      downloadArtifact: async (entry, options) => {
        const handle = await source.downloadArtifact(entry, options);
        setBackgrounded(true);
        return handle;
      },
    };

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: backgroundingSource,
    });

    expect(released).toEqual([{ filePath, imported: false }]);
    expect(await countRows('board_climbs')).toBe(0);
  });

  it('falls back to deleteArtifact for a source with no releaseArtifact (the shipped contract)', async () => {
    const filePath = join(workDir, 'legacy-source.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(source.deleteArtifact).toHaveBeenCalledWith(filePath);
  });

  it('imports a REUSED artifact without downloading it again', async () => {
    const filePath = join(workDir, 'reused-good.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const { source, downloadedUrls } = makeRetainingSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
      retained: new Set([filePath]),
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(downloadedUrls).toEqual([]);
    expect(await countRows('board_climbs')).toBe(1);
  });

  it('a REUSED artifact that fails to import is deleted and does NOT burn a bootstrap attempt', async () => {
    // The #4313 failure mode retention could otherwise recreate: the same
    // corrupt file on disk would fail twice and settle the scope onto the paged
    // crawl forever. Deleting it is what bounds the uncounted path.
    const filePath = join(workDir, 'reused-corrupt.db');
    writeFileSync(filePath, 'not a sqlite database at all');
    const { source, deleted } = makeRetainingSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
      retained: new Set([filePath]),
    });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    expect(deleted).toEqual([filePath]);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(expect.objectContaining({ stage: 'import', attempt: 0 }));
  });

  it('a FRESHLY-DOWNLOADED artifact that fails to import still burns an attempt', async () => {
    const filePath = join(workDir, 'fresh-corrupt.db');
    writeFileSync(filePath, 'not a sqlite database at all');
    const { source } = makeRetainingSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(1);
  });

  it('hands the downloader an AbortSignal so a torn-down cycle can cancel the transfer', async () => {
    const filePath = join(workDir, 'signal.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const { source, signals } = makeRetainingSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  it('does NOT abort an in-flight transfer when the app backgrounds', async () => {
    // Issue #4390, and the inverse of what this file used to pin. Start new work
    // only in the foreground; never kill work already in flight. Cancelling on a
    // screen lock threw away up to 103 MB and restarted from byte 0 on the next
    // wake — the phone can keep the transfer alive, the engine cannot get the
    // bytes back.
    const filePath = join(workDir, 'stalled.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    let seenSignal: AbortSignal | undefined;
    const source = {
      fetchManifest: vi.fn(async () => makeManifest([makeEntry()])),
      downloadArtifact: vi.fn(async (_entry: SnapshotManifestEntry, options?: { signal?: AbortSignal }) => {
        seenSignal = options?.signal;
        // No progress events at all — the connection is hung.
        setBackgrounded(true);
        return { filePath };
      }),
      deleteArtifact: vi.fn(async () => {}),
      releaseArtifact: vi.fn(async () => {}),
    } as unknown as SnapshotSource;

    try {
      await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
      });
    } finally {
      setBackgrounded(false);
    }

    expect(seenSignal?.aborted).toBe(false);
  });

  it('aborts an in-flight transfer when a wipe starts', async () => {
    // The other half of the same rule: the rows this artifact is for are being
    // deleted, so its bytes are worthless and the native session must stop now.
    const filePath = join(workDir, 'wiped-mid-transfer.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    let seenSignal: AbortSignal | undefined;
    const source = {
      fetchManifest: vi.fn(async () => makeManifest([makeEntry()])),
      downloadArtifact: vi.fn(async (_entry: SnapshotManifestEntry, options?: { signal?: AbortSignal }) => {
        seenSignal = options?.signal;
        beginGlobalPurge();
        return { filePath };
      }),
      deleteArtifact: vi.fn(async () => {}),
      releaseArtifact: vi.fn(async () => {}),
    } as unknown as SnapshotSource;

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(seenSignal?.aborted).toBe(true);
  });

  it('a download that completes while backgrounded is retained and reused next cycle', async () => {
    const filePath = join(workDir, 'completed-while-backgrounded.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const retained = new Set<string>();
    const firstCycle = makeRetainingSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
      retained,
    });
    const backgroundingSource = {
      ...firstCycle.source,
      downloadArtifact: vi.fn(async () => {
        setBackgrounded(true);
        return { filePath };
      }),
    } as unknown as SnapshotSource;

    try {
      await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: backgroundingSource,
      });
    } finally {
      setBackgrounded(false);
    }

    // Handed back unimported, so a retention-capable source keeps the bytes.
    expect(firstCycle.released).toEqual([{ filePath, imported: false }]);
    expect(await countRows('board_climbs')).toBe(0);

    // Next foreground cycle: the same file comes back as reused, no re-fetch.
    retained.add(filePath);
    const secondCycle = makeRetainingSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
      retained,
    });
    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: secondCycle.source,
    });

    expect(secondCycle.downloadedUrls).toEqual([]);
    expect(await countRows('board_climbs')).toBe(1);
  });

  it('a transfer that fails while suspended does not burn a transport attempt', async () => {
    const source = {
      fetchManifest: vi.fn(async () => makeManifest([makeEntry()])),
      downloadArtifact: vi.fn(async () => {
        setBackgrounded(true);
        // The shape iOS produces when it suspends the app mid-transfer.
        throw new Error('The network connection was lost.');
      }),
      deleteArtifact: vi.fn(async () => {}),
      releaseArtifact: vi.fn(async () => {}),
    } as unknown as SnapshotSource;
    const onSnapshotBootstrapError = vi.fn();
    const onBootstrapRetryScheduled = vi.fn();

    try {
      await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onSnapshotBootstrapError,
        onBootstrapRetryScheduled,
      });
    } finally {
      setBackgrounded(false);
    }

    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'download', aborted: true, reason: 'aborted-background', attempt: 0 }),
    );
    expect(onBootstrapRetryScheduled).not.toHaveBeenCalled();
    const { state } = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(state.transportFailures).toBe(0);
    expect(state.retryAfter).toBeNull();
    expect(state.backgroundPauses).toBe(1);
  });

  it('a backgrounded blip, a foreground recovery, then a real network failure still burns a transport attempt', async () => {
    // The masked-failure case the suspension window exists to prevent: one
    // pocketed moment during a nine-minute transfer must not launder every later
    // wifi drop into a free, cooldown-free 100 MB retry loop.
    const source = {
      fetchManifest: vi.fn(async () => makeManifest([makeEntry()])),
      downloadArtifact: vi.fn(
        async (
          _entry: SnapshotManifestEntry,
          options?: { onProgress?: (progress: { bytesWritten: number; totalBytes: number | null }) => void },
        ) => {
          setBackgrounded(true);
          // Back in the foreground, and a byte lands: the transfer demonstrably
          // survived, so the suspension window closes.
          setBackgrounded(false);
          options?.onProgress?.({ bytesWritten: 4096, totalBytes: null });
          throw new Error('The network connection was lost.');
        },
      ),
      deleteArtifact: vi.fn(async () => {}),
      releaseArtifact: vi.fn(async () => {}),
    } as unknown as SnapshotSource;
    const onSnapshotBootstrapError = vi.fn();
    const onBootstrapRetryScheduled = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
      onBootstrapRetryScheduled,
    });

    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'download', aborted: false, reason: 'network', attempt: 1 }),
    );
    expect(onBootstrapRetryScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'download', failureKind: 'transport', transportFailures: 1 }),
    );
    const { state } = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(state.transportFailures).toBe(1);
    expect(state.backgroundPauses).toBe(0);
  });

  it('a non-network failure that arrives after a foreground byte still burns, even though the app backgrounded', async () => {
    // A disk-full is not a suspension kill. Once a byte has arrived in the
    // foreground the window is shut, so `isNetworkError` never even gets asked —
    // this settles on the structural-device ladder like any other on-device fault.
    const source = {
      fetchManifest: vi.fn(async () => makeManifest([makeEntry()])),
      downloadArtifact: vi.fn(
        async (
          _entry: SnapshotManifestEntry,
          options?: { onProgress?: (progress: { bytesWritten: number; totalBytes: number | null }) => void },
        ) => {
          setBackgrounded(true);
          setBackgrounded(false);
          options?.onProgress?.({ bytesWritten: 4096, totalBytes: null });
          throw new Error('snapshot download: insufficient disk space for kilter:1');
        },
      ),
      deleteArtifact: vi.fn(async () => {}),
      releaseArtifact: vi.fn(async () => {}),
    } as unknown as SnapshotSource;
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'download', aborted: false, attempt: 1 }),
    );
    const { state } = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(state.structuralFailures).toBe(1);
    expect(state.backgroundPauses).toBe(0);
  });

  it('charges the FOURTH consecutive background pause to the transport budget', async () => {
    const onSnapshotBootstrapError = vi.fn();
    const onBootstrapRetryScheduled = vi.fn();
    const runSuspendedCycle = async () => {
      const source = {
        fetchManifest: vi.fn(async () => makeManifest([makeEntry()])),
        downloadArtifact: vi.fn(async () => {
          setBackgrounded(true);
          throw new Error('The network connection was lost.');
        }),
        deleteArtifact: vi.fn(async () => {}),
        releaseArtifact: vi.fn(async () => {}),
      } as unknown as SnapshotSource;
      try {
        await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
          enabledBoards: ['kilter:1:5'],
          snapshotSource: source,
          onSnapshotBootstrapError,
          onBootstrapRetryScheduled,
        });
      } finally {
        setBackgrounded(false);
      }
    };

    for (let pause = 0; pause < MAX_FREE_BACKGROUND_PAUSES; pause += 1) await runSuspendedCycle();

    const afterFreePauses = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(afterFreePauses.state.backgroundPauses).toBe(MAX_FREE_BACKGROUND_PAUSES);
    expect(afterFreePauses.state.transportFailures).toBe(0);
    expect(onBootstrapRetryScheduled).not.toHaveBeenCalled();
    expect(onSnapshotBootstrapError).toHaveBeenCalledTimes(MAX_FREE_BACKGROUND_PAUSES);

    await runSuspendedCycle();

    const afterCharge = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(afterCharge.state.backgroundPauses).toBe(0);
    expect(afterCharge.state.transportFailures).toBe(1);
    expect(afterCharge.state.retryAfter).not.toBeNull();
    // Still an abort — the phone went in a pocket, that IS what happened — but
    // the attempt number now tells the truth about the budget.
    expect(onSnapshotBootstrapError).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: 'download', aborted: true, reason: 'aborted-background', attempt: 1 }),
    );
    expect(onBootstrapRetryScheduled).toHaveBeenCalledTimes(1);
    expect(onBootstrapRetryScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: 'transport', transportFailures: 1, terminal: false }),
    );
  });

  it('a completed download resets the free-pause counter', async () => {
    const filePath = join(workDir, 'pause-then-complete.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const suspendedSource = {
      fetchManifest: vi.fn(async () => makeManifest([makeEntry()])),
      downloadArtifact: vi.fn(async () => {
        setBackgrounded(true);
        throw new Error('The network connection was lost.');
      }),
      deleteArtifact: vi.fn(async () => {}),
      releaseArtifact: vi.fn(async () => {}),
    } as unknown as SnapshotSource;

    try {
      await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: suspendedSource,
      });
    } finally {
      setBackgrounded(false);
    }
    const afterPause = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(afterPause.state.backgroundPauses).toBe(1);

    const { source } = makeRetainingSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
    });
    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    const afterSuccess = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(afterSuccess.state.backgroundPauses).toBe(0);
  });

  it('charges the SECOND failed import of the same reused build, so an undeletable file cannot loop', async () => {
    // deleteArtifact is best-effort on every platform (mobile swallows its
    // errors), so a corrupt retained file can come back cycle after cycle. The
    // free round is granted once per (scope, build); after that it settles on
    // the structural ladder like any other on-disk failure.
    const filePath = join(workDir, 'undeletable-corrupt.db');
    writeFileSync(filePath, 'not a sqlite database at all');
    const makeSource = () =>
      makeRetainingSource({
        manifest: makeManifest([makeEntry()]),
        fileForEntry: () => filePath,
        // The delete never takes: the file is still retained next cycle.
        retained: new Set([filePath]),
      });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: makeSource().source,
    });
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: makeSource().source,
    });

    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(1);
  });

  it('gives a DIFFERENT build its own free round', async () => {
    const filePath = join(workDir, 'rebuilt-corrupt.db');
    writeFileSync(filePath, 'not a sqlite database at all');
    const cycle = async (builtAt: string) => {
      const { source } = makeRetainingSource({
        manifest: makeManifest([makeEntry({ builtAt })]),
        fileForEntry: () => filePath,
        retained: new Set([filePath]),
      });
      await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
      });
    };

    await cycle('2026-08-10T02:00:00.000Z');
    await cycle('2026-08-11T02:00:00.000Z');

    // Tonight's rebuilt artifact is a different bet: still uncounted.
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
  });
});

describe('pullSync scope-download phase breakdown', () => {
  it('reports the artifact bytes and a per-table paged-crawl split on the completion event', async () => {
    const filePath = join(workDir, 'phases.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry({ bytes: 108_000_000 })]),
      fileForEntry: () => filePath,
    });
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    const { phases } = onScopeDownloadComplete.mock.calls[0][0] as { phases: Record<string, number | boolean> };
    expect(phases.artifactBytes).toBe(108_000_000);
    expect(phases.artifactReused).toBe(false);
    // Every phase is measured, even when a fast test makes them all 0ms.
    for (const key of ['manifestMs', 'downloadMs', 'importMs', 'climbsPullMs', 'statsPullMs', 'gradesPullMs']) {
      expect(phases[key], key).toBeGreaterThanOrEqual(0);
    }
    // A fresh crawl with no grades checkpoint and genuinely zero rows: the 0 is a
    // real measurement, so the key is PRESENT. No grades artifact rode along, so
    // that key is absent rather than 0 (issue #4393).
    expect(phases.gradesRows).toBe(0);
    expect(Object.hasOwn(phases, 'gradesRows')).toBe(true);
    expect(Object.hasOwn(phases, 'gradesArtifactRows')).toBe(false);
  });

  it('counts the grade rows a same-cycle fresh crawl consumed', async () => {
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch({ gradeServerRows: gradeServerRows(3) }).fetch, {
      enabledBoards: ['kilter:1:5'],
      onScopeDownloadComplete,
    });

    const { phases } = onScopeDownloadComplete.mock.calls[0][0] as { phases: ScopeDownloadPhaseBreakdown };
    expect(phases.gradesRows).toBe(3);
    expect(Object.hasOwn(phases, 'gradesArtifactRows')).toBe(false);
    expect(phases.gradesPullMs).toBeGreaterThanOrEqual(0);
  });

  // The #4393 regression anchor: a cycle that only picked up the tail of a crawl
  // an EARLIER cycle started has no idea how many rows the board has, and the 0
  // it used to report read as "this board has no grades" in the #4310 analysis.
  it('omits gradesRows when an earlier cycle already crawled the grades', async () => {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'checkpoint:board_climb_grades:kilter:1:5',
      JSON.stringify({ updatedAt: '2026-05-01T00:00:00.000Z', syncSeq: '10' }),
    ]);
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      onScopeDownloadComplete,
    });

    const call = onScopeDownloadComplete.mock.calls[0][0] as {
      method: string;
      durationMs: number | null;
      phases: ScopeDownloadPhaseBreakdown;
    };
    expect(call.phases.gradesRows).toBeUndefined();
    // Structural, not just undefined: a re-introduced 0 must fail here.
    expect(Object.hasOwn(call.phases, 'gradesRows')).toBe(false);
    expect(Object.hasOwn(call.phases, 'gradesArtifactRows')).toBe(false);
    // The timings are unaffected — they are real measurements of this cycle.
    expect(typeof call.phases.gradesPullMs).toBe('number');
    expect(typeof call.phases.manifestMs).toBe('number');
    expect(call.method).toBe('paged');
    expect(call.durationMs).not.toBeUndefined();
  });

  it('omits gradesRows when an earlier cycle’s crawl is only being finished', async () => {
    // The partial-tail case: 2 rows this cycle, nothing distinguishing them from
    // the tail of 40,000 an earlier cycle already pulled.
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'checkpoint:board_climb_grades:kilter:1:5',
      JSON.stringify({ updatedAt: '2026-05-01T00:00:00.000Z', syncSeq: '10' }),
    ]);
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch({ gradeServerRows: gradeServerRows(2) }).fetch, {
      enabledBoards: ['kilter:1:5'],
      onScopeDownloadComplete,
    });

    const { phases } = onScopeDownloadComplete.mock.calls[0][0] as { phases: ScopeDownloadPhaseBreakdown };
    expect(await countRows('board_climb_grades')).toBe(2);
    expect(phases.gradesRows).toBeUndefined();
    expect(Object.hasOwn(phases, 'gradesRows')).toBe(false);
    expect(phases.gradesPullMs).toBeGreaterThanOrEqual(0);
  });

  it('emptyScopeDownloadPhases() reports no grade counts', () => {
    const phases = emptyScopeDownloadPhases();
    expect(Object.hasOwn(phases, 'gradesRows')).toBe(false);
    expect(Object.hasOwn(phases, 'gradesArtifactRows')).toBe(false);
  });

  it('measures a download that spans cycles from its FIRST cycle, not the last', async () => {
    // Cycle 1 downloads and imports, then the phone backgrounds before the
    // delta pull reaches the tail. Cycle 2 finishes. The reported duration must
    // cover both, which is only possible because the start stamp is persisted.
    const filePath = join(workDir, 'spanning.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onScopeDownloadComplete = vi.fn();

    // Cycle 1: stamp the start, then background out the moment the artifact
    // lands — exactly the "user locks the phone mid-download" shape.
    const backgroundingSource: SnapshotSource = {
      ...source,
      downloadArtifact: async (entry, options) => {
        const handle = await source.downloadArtifact(entry, options);
        setBackgrounded(true);
        return handle;
      },
    };
    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: backgroundingSource,
    });
    const startedRow = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
      'scope-download-started:kilter:1:5',
    ]);
    expect(startedRow).not.toBeNull();
    // Backdate the stamp by a minute — the second cycle must report ~60s, not ~0s.
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'scope-download-started:kilter:1:5',
      String(Date.now() - 60_000),
    ]);
    setBackgrounded(false);

    // Cycle 2 completes the scope.
    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    const { durationMs } = onScopeDownloadComplete.mock.calls[0][0] as { durationMs: number | null };
    expect(durationMs).toBeGreaterThanOrEqual(60_000);
  });

  it('reports a null duration when the start stamp is older than the plausibility window', async () => {
    // A stamp nobody cleared (a crash, or an app left closed for a week) is not
    // a week-long download — reporting it would poison the percentiles.
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'scope-download-started:kilter:1:5',
      String(Date.now() - 9 * 24 * 60 * 60 * 1000),
    ]);
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      onScopeDownloadComplete,
    });

    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    const { durationMs } = onScopeDownloadComplete.mock.calls[0][0] as { durationMs: number | null };
    expect(durationMs).toBeNull();
  });

  it('clears the start stamp once the scope completes', async () => {
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      onScopeDownloadComplete,
    });

    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
      'scope-download-started:kilter:1:5',
    ]);
    expect(row).toBeNull();
  });
});

// Boardsesh grades from the separate artifact (issue #4310)
// ---------------------------------------------------------------------------

const GRADES_META_DDL = SNAPSHOT_META_DDL;

type GradeInput = {
  climbUuid: string;
  boardType?: string;
  angle?: number;
  localGrade?: number | null;
  computedAt?: string;
  syncSeq?: number;
};

/** Builds a standalone grades artifact: one data table, one snapshot_meta row. */
function buildGradesArtifact(spec: {
  filePath: string;
  grades: GradeInput[];
  watermark: Cursor;
  rowCountOverride?: number;
  schemaVersion?: number;
}): void {
  const artifactDb = new DatabaseSync(spec.filePath);
  try {
    // board_climb_grades arrives in a later MIGRATION, not in the v1
    // SCHEMA_STATEMENTS — the same source the export's DDL builder reads.
    for (const migration of [...MIGRATIONS].sort((left, right) => left.version - right.version)) {
      for (const statement of migration.statements) {
        if (statement.includes('board_climb_grades')) artifactDb.exec(statement);
      }
    }
    artifactDb.exec(GRADES_META_DDL);
    for (const grade of spec.grades) {
      artifactDb
        .prepare(
          `INSERT OR REPLACE INTO board_climb_grades
            (board_type, climb_uuid, angle, local_grade, computed_at, sync_seq)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grade.boardType ?? 'kilter',
          grade.climbUuid,
          grade.angle ?? 40,
          grade.localGrade ?? 20,
          grade.computedAt ?? spec.watermark.updatedAt,
          grade.syncSeq ?? Number(spec.watermark.syncSeq),
        );
    }
    artifactDb
      .prepare(
        `INSERT OR REPLACE INTO snapshot_meta
          (table_name, watermark_updated_at, watermark_sync_seq, row_count, built_at, schema_version, format_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'board_climb_grades',
        spec.watermark.updatedAt,
        spec.watermark.syncSeq,
        spec.rowCountOverride ?? spec.grades.length,
        '2026-06-01T00:00:00.000Z',
        spec.schemaVersion ?? LATEST_SCHEMA_VERSION,
        1,
      );
  } finally {
    artifactDb.close();
  }
}

function gradesArtifactBlock(overrides: Partial<SnapshotGradesArtifact> = {}): SnapshotGradesArtifact {
  return {
    key: 'board-snapshots/v1-gzip/kilter/1/2026-06-01-grades.db',
    url: 'https://example.test/kilter-1-grades.db',
    bytes: 2048,
    contentEncoding: 'gzip',
    builtAt: '2026-06-01T00:00:00.000Z',
    schemaVersion: LATEST_SCHEMA_VERSION,
    tables: { board_climb_grades: { watermarkUpdatedAt: '2026-05-01T00:00:00Z', watermarkSyncSeq: '10', rowCount: 1 } },
    ...overrides,
  };
}

/** A source that also serves the layout's grades artifact. */
function makeGradesSource(config: {
  manifest: SnapshotManifest;
  climbsFile: string;
  gradesFile?: string | null;
  gradesDownloadThrows?: boolean;
}) {
  const gradesDownloads: string[] = [];
  const source = {
    fetchManifest: vi.fn(async () => config.manifest),
    downloadArtifact: vi.fn(async () => ({ filePath: config.climbsFile })),
    downloadGradesArtifact: vi.fn(async (artifact: SnapshotGradesArtifact) => {
      gradesDownloads.push(artifact.key);
      if (config.gradesDownloadThrows) throw new Error('grades download failed');
      return config.gradesFile ? { filePath: config.gradesFile } : null;
    }),
    deleteArtifact: vi.fn(async () => {}),
  };
  return { source: source as unknown as SnapshotSource, gradesDownloads };
}

async function seedScopeClimb(uuid: string): Promise<void> {
  await db.runAsync(
    `INSERT OR REPLACE INTO board_climbs (uuid, board_type, layout_id, name, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
     VALUES (?, 'kilter', 1, ?, 0, 1, ?, '2026-05-01T00:00:00Z', 10)`,
    [uuid, `name-${uuid}`, JSON.stringify([5])],
  );
}

describe('bootstrapScopeGradesFromSnapshot', () => {
  const SCOPE: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 5 };

  it('imports the scope’s grades and stamps the checkpoint at their computed_at watermark', async () => {
    await seedScopeClimb('c1');
    const gradesPath = join(workDir, 'grades.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [
        { climbUuid: 'c1', angle: 40, computedAt: '2026-05-01T00:00:00Z', syncSeq: 10 },
        { climbUuid: 'c1', angle: 50, computedAt: '2026-05-03T00:00:00Z', syncSeq: 44 },
      ],
      watermark: { updatedAt: '2026-05-03T00:00:00Z', syncSeq: '44' },
    });

    const result = await bootstrapScopeGradesFromSnapshot({
      db,
      scope: SCOPE,
      scopeKey: 'kilter:1:5',
      filePath: gradesPath,
    });

    expect(result.rowsImported).toBe(2);
    expect(await countRows('board_climb_grades')).toBe(2);
    // Stamped on computed_at, the column grades actually cursor on.
    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).toEqual({
      updatedAt: '2026-05-03T00:00:00Z',
      syncSeq: '44',
    });
  });

  it('drops grades whose climb is outside the scope, and never stamps past them', async () => {
    await seedScopeClimb('in-scope');
    const gradesPath = join(workDir, 'grades-scoped.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [
        { climbUuid: 'in-scope', computedAt: '2026-05-01T00:00:00Z', syncSeq: 10 },
        // No matching board_climbs row → outside this scope.
        { climbUuid: 'other-layout', computedAt: '2026-05-09T00:00:00Z', syncSeq: 99 },
      ],
      watermark: { updatedAt: '2026-05-09T00:00:00Z', syncSeq: '99' },
    });

    await bootstrapScopeGradesFromSnapshot({ db, scope: SCOPE, scopeKey: 'kilter:1:5', filePath: gradesPath });

    const rows = await db.getAllAsync<{ climb_uuid: string }>('SELECT climb_uuid FROM board_climb_grades');
    expect(rows.map((row) => row.climb_uuid)).toEqual(['in-scope']);
    // The stamped cursor covers only what landed — the artifact's snapshot_meta
    // watermark (which covers the excluded row) would have skipped it forever.
    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).toEqual({
      updatedAt: '2026-05-01T00:00:00Z',
      syncSeq: '10',
    });
  });

  it('stamps from the ARTIFACT rows, never from newer rows a sibling scope already crawled into main', async () => {
    // board_climb_grades is shared across scopes. A sibling scope of the same
    // layout (say kilter:1:7, synced for months) has already crawled rows for
    // shared climbs with cursors far NEWER than this artifact. Stamping this
    // scope's checkpoint off main would land at the sibling's tail, silently
    // skipping every grade row computed since the artifact was built for
    // climbs exclusive to THIS scope — the strict `>` delta never revisits
    // anything at-or-below the stamp.
    await seedScopeClimb('shared-climb');
    await db.runAsync(
      `INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, computed_at, sync_seq)
       VALUES ('kilter', 'shared-climb', 45, 21, '2026-08-01T00:00:00Z', 900)`,
    );
    const gradesPath = join(workDir, 'grades-sibling.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'shared-climb', angle: 40, computedAt: '2026-05-03T00:00:00Z', syncSeq: 44 }],
      watermark: { updatedAt: '2026-05-03T00:00:00Z', syncSeq: '44' },
    });

    await bootstrapScopeGradesFromSnapshot({ db, scope: SCOPE, scopeKey: 'kilter:1:5', filePath: gradesPath });

    // The sibling's newer row is untouched, and the stamp stops at the
    // artifact's own scoped watermark so the delta still covers
    // (artifact, sibling-tail] for this scope's exclusive climbs.
    expect(await countRows('board_climb_grades')).toBe(2);
    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).toEqual({
      updatedAt: '2026-05-03T00:00:00Z',
      syncSeq: '44',
    });
  });

  it('stamps NOTHING and imports nothing when the artifact is corrupt', async () => {
    await seedScopeClimb('c1');
    const gradesPath = join(workDir, 'grades-corrupt.db');
    writeFileSync(gradesPath, 'definitely not sqlite');

    await expect(
      bootstrapScopeGradesFromSnapshot({ db, scope: SCOPE, scopeKey: 'kilter:1:5', filePath: gradesPath }),
    ).rejects.toThrow();

    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).toBeNull();
    expect(await countRows('board_climb_grades')).toBe(0);
  });

  it('refuses an artifact whose snapshot_meta row_count disagrees with its actual rows', async () => {
    await seedScopeClimb('c1');
    const gradesPath = join(workDir, 'grades-truncated.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1' }],
      watermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
      rowCountOverride: 900,
    });

    await expect(
      bootstrapScopeGradesFromSnapshot({ db, scope: SCOPE, scopeKey: 'kilter:1:5', filePath: gradesPath }),
    ).rejects.toThrow(/row_count/);
    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).toBeNull();
  });

  it('surfaces the real error when the post-COMMIT BEGIN fails, instead of a masked ROLLBACK', async () => {
    // Issue #4310 gave this function its own COMMIT (so `gradesLockMs` covers the
    // hold) and a trailing empty BEGIN for the wrapper to close. That opened a
    // window the pre-change shape did not have: a throw from that BEGIN meets
    // expo's unconditional ROLLBACK with no transaction active, and "cannot
    // rollback - no transaction is active" would MASK the error the caller
    // dispatches on. The restore-BEGIN wrapper is what keeps the real cause.
    await seedScopeClimb('c1');
    const gradesPath = join(workDir, 'grades-post-commit-begin.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1' }],
      watermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
    });

    const adapterPrototype = Object.getPrototypeOf(db) as { execAsync: typeof db.execAsync };
    const realExecAsync = adapterPrototype.execAsync;
    let commits = 0;
    let failedBegins = 0;
    vi.spyOn(adapterPrototype, 'execAsync').mockImplementation(async function (this: unknown, source: string) {
      if (source === 'COMMIT') commits += 1;
      // The exclusive transaction's COMMIT is the second one — the first closes
      // the wrapper's deferred BEGIN in the preamble. Fail the BEGIN that follows
      // it exactly ONCE, which is the transient shape the restore is for: a
      // connection that cannot open ANY transaction masks the cause either way,
      // same as the whole-layout import's own `.catch(() => {})`.
      if (source === 'BEGIN' && commits >= 2 && failedBegins === 0) {
        failedBegins += 1;
        throw new Error('post-commit BEGIN exploded');
      }
      return realExecAsync.call(this, source);
    } as typeof db.execAsync);

    await expect(
      bootstrapScopeGradesFromSnapshot({ db, scope: SCOPE, scopeKey: 'kilter:1:5', filePath: gradesPath }),
    ).rejects.toThrow(/post-commit BEGIN exploded/);

    vi.restoreAllMocks();
  });

  it('leaves the deletions checkpoint alone — grades have no delete trigger to replay', async () => {
    await seedScopeClimb('c1');
    const deletionsCursor = { updatedAt: '2026-07-01T00:00:00Z', syncSeq: '500' };
    await setCheckpoint(db, DELETIONS_CHECKPOINT_KEY, deletionsCursor);
    const gradesPath = join(workDir, 'grades-deletions.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1' }],
      watermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
    });

    await bootstrapScopeGradesFromSnapshot({ db, scope: SCOPE, scopeKey: 'kilter:1:5', filePath: gradesPath });

    expect(await getCheckpoint(db, DELETIONS_CHECKPOINT_KEY)).toEqual(deletionsCursor);
  });
});

describe('pullSync grades bootstrap', () => {
  it('imports grades right after the whole-layout import and skips the crawl', async () => {
    const climbsPath = join(workDir, 'grades-flow-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const gradesPath = join(workDir, 'grades-flow-grades.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1', computedAt: '2026-05-02T00:00:00Z', syncSeq: 21 }],
      watermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '21' },
    });
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: climbsPath,
      gradesFile: gradesPath,
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(gradesDownloads).toEqual([gradesArtifactBlock().key]);
    expect(await countRows('board_climb_grades')).toBe(1);
    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).toEqual({
      updatedAt: '2026-05-02T00:00:00Z',
      syncSeq: '21',
    });
  });

  // The dominant snapshot path, and the shape that made the naive "a checkpoint
  // existed ⇒ report nothing" rule unreadable: the artifact stamps the grades
  // checkpoint mid-cycle, so the delta crawl behind it truthfully consumes 0
  // rows. gradesArtifactRows is what says where the grades actually came from.
  it('reports the artifact’s grade rows when the crawl behind it has nothing left to fetch', async () => {
    const climbsPath = join(workDir, 'grades-rows-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const gradesPath = join(workDir, 'grades-rows-grades.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [
        { climbUuid: 'c1', angle: 40, computedAt: '2026-05-02T00:00:00Z', syncSeq: 21 },
        { climbUuid: 'c1', angle: 45, computedAt: '2026-05-02T00:00:00Z', syncSeq: 21 },
      ],
      watermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '21' },
    });
    const { source } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: climbsPath,
      gradesFile: gradesPath,
    });
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    const { phases } = onScopeDownloadComplete.mock.calls[0][0] as { phases: ScopeDownloadPhaseBreakdown };
    expect(phases.gradesArtifactRows).toBe(2);
    // A real measurement of the crawl, not a fabricated one — so it stays present.
    expect(phases.gradesRows).toBe(0);
    expect(Object.hasOwn(phases, 'gradesRows')).toBe(true);
  });

  it('still counts the crawl behind a same-cycle grades artifact', async () => {
    const climbsPath = join(workDir, 'grades-delta-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const gradesPath = join(workDir, 'grades-delta-grades.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1', computedAt: '2026-05-02T00:00:00Z', syncSeq: 21 }],
      watermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '21' },
    });
    const { source } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: climbsPath,
      gradesFile: gradesPath,
    });
    const onScopeDownloadComplete = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch({ gradeServerRows: gradeServerRows(4) }).fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    const { phases } = onScopeDownloadComplete.mock.calls[0][0] as { phases: ScopeDownloadPhaseBreakdown };
    // The artifact's own mid-cycle checkpoint stamp must not read as an earlier cycle.
    expect(phases.gradesRows).toBe(4);
    expect(phases.gradesArtifactRows).toBe(1);
  });

  it('carries no grades row counts when the artifact imported in an earlier cycle', async () => {
    const climbsPath = join(workDir, 'grades-spanning-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const gradesPath = join(workDir, 'grades-spanning-grades.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1', computedAt: '2026-05-02T00:00:00Z', syncSeq: 21 }],
      watermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '21' },
    });
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: climbsPath,
      gradesFile: gradesPath,
    });

    // Cycle 1 imports both artifacts, then the phone backgrounds the moment the
    // board-data loop starts crawling — the scope does not complete.
    const backgroundingFetch = makeGraphqlFetch();
    const cycleOneFetch = ((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('syncClimbs')) setBackgrounded(true);
      return backgroundingFetch.fetch(query, variables);
    }) as unknown as typeof backgroundingFetch.fetch;
    const neverCompletes = vi.fn();
    await pullSync(db, noopQueryClient(), cycleOneFetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete: neverCompletes,
    });
    expect(neverCompletes).not.toHaveBeenCalled();
    expect(gradesDownloads).toEqual([gradesArtifactBlock().key]);
    setBackgrounded(false);

    // Cycle 2 finishes the crawl. Nothing it did wrote a grade row: the artifact
    // landed yesterday and the crawl resumes from the cursor it stamped.
    const onScopeDownloadComplete = vi.fn();
    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onScopeDownloadComplete,
    });

    expect(onScopeDownloadComplete).toHaveBeenCalledTimes(1);
    const { phases } = onScopeDownloadComplete.mock.calls[0][0] as { phases: ScopeDownloadPhaseBreakdown };
    expect(gradesDownloads).toHaveLength(1);
    expect(phases.gradesRows).toBeUndefined();
    expect(phases.gradesArtifactRows).toBeUndefined();
    expect(Object.hasOwn(phases, 'gradesRows')).toBe(false);
    expect(Object.hasOwn(phases, 'gradesArtifactRows')).toBe(false);
  });

  // Retention (#4310) keeps an UNIMPORTED whole-layout artifact for the next
  // cycle and recognises a superseded build by the `<board>-<layout>` prefix in
  // its filename. A grades file, named from its manifest key, matches no prefix
  // — so a retained one would never be swept and would sit in the cache
  // directory forever. It is deleted outright instead, on every exit path.
  it('deletes the grades artifact rather than handing it to releaseArtifact', async () => {
    const climbsPath = join(workDir, 'grades-release-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const gradesPath = join(workDir, 'grades-release-grades.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1', computedAt: '2026-05-02T00:00:00Z', syncSeq: 21 }],
      watermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '21' },
    });
    const { source } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: climbsPath,
      gradesFile: gradesPath,
    });
    const releaseArtifact = vi.fn(async () => {});
    (source as unknown as { releaseArtifact: typeof releaseArtifact }).releaseArtifact = releaseArtifact;

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(source.deleteArtifact).toHaveBeenCalledWith(gradesPath);
    expect(releaseArtifact).not.toHaveBeenCalledWith(gradesPath, expect.anything());
    // The whole-layout artifact still goes through the retention seam.
    expect(releaseArtifact).toHaveBeenCalledWith(climbsPath, { imported: true });
  });

  // A failed grades import must not strand the file either: the same finally
  // runs on every exit path.
  it('deletes the grades artifact when its import failed', async () => {
    const climbsPath = join(workDir, 'grades-failed-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    // Not a grades artifact at all — ATTACH finds no board_climb_grades table.
    const notAGradesFile = join(workDir, 'grades-failed-grades.db');
    buildArtifact({
      filePath: notAGradesFile,
      climbs: [],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const { source } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: climbsPath,
      gradesFile: notAGradesFile,
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(source.deleteArtifact).toHaveBeenCalledWith(notAGradesFile);
    // Proof the import really failed rather than the assertion above passing
    // over a healthy run: a successful import stamps this.
    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).toBeNull();
  });

  it('takes today’s path verbatim when the manifest entry has no grades block', async () => {
    const climbsPath = join(workDir, 'no-grades-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry()]),
      climbsFile: climbsPath,
      gradesFile: null,
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(gradesDownloads).toEqual([]);
    // The paged crawl still stamps its own (empty-page) grades checkpoint.
    expect(await countRows('board_climb_grades')).toBe(0);
  });

  it('retro-fits a scope that was bootstrapped BEFORE grades artifacts existed', async () => {
    // Whole-layout artifact already imported (the catalog is complete) and the
    // grades checkpoint absent = no grade page was ever consumed, so importing
    // from the artifact cannot skip anything.
    await seedScopeClimb('c1');
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', CLIMBS_WATERMARK);
    await setCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5', STATS_WATERMARK);
    await markBootstrapDone(db, 'kilter:1:5');
    const gradesPath = join(workDir, 'retrofit-grades.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1', computedAt: '2026-05-02T00:00:00Z', syncSeq: 21 }],
      watermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '21' },
    });
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: join(workDir, 'never-downloaded.db'),
      gradesFile: gradesPath,
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(gradesDownloads).toHaveLength(1);
    expect(await countRows('board_climb_grades')).toBe(1);
    // The whole-layout artifact is NOT re-downloaded — the scope is past that.
    expect(source.downloadArtifact).not.toHaveBeenCalled();
  });

  it('retro-fits a scope whose PAGED crawl finished every table', async () => {
    // scope-complete is the other proof of a whole catalog: the crawl reached
    // every table's tail. (Its grades checkpoint is cleared below to model the
    // pre-#4310 shape where grades were the term still missing.)
    await seedScopeClimb('c1');
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', CLIMBS_WATERMARK);
    await setCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5', STATS_WATERMARK);
    await markScopeDownloadComplete(db, 'kilter:1:5');
    const gradesPath = join(workDir, 'retrofit-complete-grades.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1', computedAt: '2026-05-02T00:00:00Z', syncSeq: 21 }],
      watermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '21' },
    });
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: join(workDir, 'never-downloaded-complete.db'),
      gradesFile: gradesPath,
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(gradesDownloads).toHaveLength(1);
    expect(await countRows('board_climb_grades')).toBe(1);
  });

  it('does NOT retro-fit a scope whose climb catalog is only half crawled', async () => {
    // Board checkpoints exist (syncTable stamps one per page) but neither
    // bootstrap-done nor scope-complete does, so main.board_climbs is a
    // fraction of the layout. Importing here would stamp the grades cursor at
    // the watermark of the grades whose climbs happen to be local, and the
    // strict `>` delta would never fetch the rest.
    await seedScopeClimb('c1');
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', CLIMBS_WATERMARK);
    await setCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5', STATS_WATERMARK);
    const gradesPath = join(workDir, 'retrofit-partial-grades.db');
    buildGradesArtifact({
      filePath: gradesPath,
      grades: [{ climbUuid: 'c1', computedAt: '2026-05-02T00:00:00Z', syncSeq: 21 }],
      watermark: { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '21' },
    });
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: join(workDir, 'never-downloaded-partial.db'),
      gradesFile: gradesPath,
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(gradesDownloads).toEqual([]);
    // No artifact rows, and no artifact watermark stamped over the crawl.
    expect(await countRows('board_climb_grades')).toBe(0);
    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).not.toEqual({
      updatedAt: '2026-05-02T00:00:00Z',
      syncSeq: '21',
    });
  });

  it('does NOT retro-fit a scope that already has a grades checkpoint', async () => {
    await seedScopeClimb('c1');
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', CLIMBS_WATERMARK);
    await setCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5', STATS_WATERMARK);
    await markBootstrapDone(db, 'kilter:1:5');
    await setCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5', {
      updatedAt: '2026-04-01T00:00:00Z',
      syncSeq: '3',
    });
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: join(workDir, 'unused.db'),
      gradesFile: join(workDir, 'unused-grades.db'),
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(gradesDownloads).toEqual([]);
  });

  it('a failed grades import never costs the scope its whole-layout bootstrap attempt', async () => {
    const climbsPath = join(workDir, 'grades-fail-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const gradesPath = join(workDir, 'grades-fail-grades.db');
    writeFileSync(gradesPath, 'not sqlite');
    const { source } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: climbsPath,
      gradesFile: gradesPath,
    });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    // The climbs/stats import succeeded and stays intact.
    expect(await countRows('board_climbs')).toBe(1);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).toBeNull();
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(expect.objectContaining({ stage: 'grades-import' }));
    // Its own budget was spent instead.
    const attempts = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
      'grades-bootstrap-attempts:kilter:1:5',
    ]);
    expect(attempts?.value).toBe('1');
  });

  it('counts a grades download that returns null, so it cannot re-fetch forever', async () => {
    const climbsPath = join(workDir, 'grades-null-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: climbsPath,
      // A source that signals "unusable this cycle" by returning null rather
      // than throwing — the same thing a throw means under SnapshotSource.
      gradesFile: null,
    });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(gradesDownloads).toHaveLength(1);
    expect(await getGradesBootstrapAttempts(db, 'kilter:1:5')).toBe(1);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'grades-download', attempt: 1 }),
    );
    // The whole-layout budget is untouched, as ever.
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
  });

  it('interrupts the cycle when a grades download rejects after backgrounding and foregrounding', async () => {
    // The grades artifact only ever gets three tries, and a pocketed phone was
    // spending them: three screen locks left a Kilter board crawling grades over
    // GraphQL for the life of the install (issue #4390). AppState can already be
    // active by the time the native rejection reaches JS, so the transfer must
    // carry its latched teardown verdict out to the parent cycle.
    const climbsPath = join(workDir, 'grades-teardown-climbs.db');
    buildArtifact({
      filePath: climbsPath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const source = {
      fetchManifest: vi.fn(async () => makeManifest([makeEntry({ grades: gradesArtifactBlock() })])),
      downloadArtifact: vi.fn(async () => ({ filePath: climbsPath })),
      downloadGradesArtifact: vi.fn(async () => {
        setBackgrounded(true);
        setBackgrounded(false);
        throw new Error('The network connection was lost.');
      }),
      deleteArtifact: vi.fn(async () => {}),
    } as unknown as SnapshotSource;
    const onSnapshotBootstrapError = vi.fn();
    const progressFrames: SyncProgress[] = [];
    const { fetch } = makeGraphqlFetch();

    try {
      await pullSync(db, noopQueryClient(), fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onSnapshotBootstrapError,
        onProgress: (progress) => progressFrames.push(progress),
      });
    } finally {
      setBackgrounded(false);
    }

    // The main artifact landed before grades began, and stays imported.
    expect(await countRows('board_climbs')).toBe(1);
    expect(await getGradesBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'grades-download', attempt: 0, aborted: true, reason: 'aborted-background' }),
    );
    expect(
      fetch.mock.calls.some(([query]) =>
        ['syncDeletions', 'syncClimbs', 'syncClimbStats', 'syncClimbGrades'].some((field) =>
          String(query).includes(field),
        ),
      ),
    ).toBe(false);
    expect(progressFrames.at(-1)).toEqual({
      phase: 'idle',
      currentTable: null,
      documentsProcessed: 0,
      interrupted: true,
    });
    expect(progressFrames.filter((progress) => progress.phase === 'idle')).toHaveLength(1);
  });

  it('stops trying grades once its own attempt budget is spent', async () => {
    await seedScopeClimb('c1');
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', CLIMBS_WATERMARK);
    await setCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5', STATS_WATERMARK);
    await markBootstrapDone(db, 'kilter:1:5');
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'grades-bootstrap-attempts:kilter:1:5',
      '2',
    ]);
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile: join(workDir, 'unused.db'),
      gradesFile: join(workDir, 'unused-grades.db'),
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(gradesDownloads).toEqual([]);
  });

  it('skips a grades artifact built at an older client schema', async () => {
    await seedScopeClimb('c1');
    await setCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5', CLIMBS_WATERMARK);
    await setCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5', STATS_WATERMARK);
    await markBootstrapDone(db, 'kilter:1:5');
    const { source, gradesDownloads } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock({ schemaVersion: 0 }) })]),
      climbsFile: join(workDir, 'unused.db'),
      gradesFile: join(workDir, 'unused-grades.db'),
    });

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
    });

    expect(gradesDownloads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Teardown reporting (issue #4314)
//
// Every one of these used to `break` in SILENCE: `Offline Board Download
// Started` fired, the cycle was torn down by a sign-out / a global wipe / a purge
// of this board's own namespace / the app backgrounding, and no terminal event ever
// followed. The funnel could not tell an abandoned 100 MB transfer from a
// download that is still running. They report through the same
// `onSnapshotBootstrapError` seam now, marked `aborted: true` so a failure RATE
// can exclude them — nothing broke, and no retry budget was spent.
// ---------------------------------------------------------------------------

describe('pullSync bootstrap teardown reporting', () => {
  /** A valid artifact, so only the teardown under test can end the phase. */
  function buildScopeArtifact(filePath: string): void {
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
  }

  it("reports a removal of this board's own layout that lands while the artifact is downloading", async () => {
    const filePath = join(workDir, 'purged-mid-download.db');
    buildScopeArtifact(filePath);
    const source: SnapshotSource = {
      fetchManifest: async () => makeManifest([makeEntry()]),
      downloadArtifact: async () => {
        // The scope being downloaded is the one being removed, so this transfer
        // SHOULD die. A removal of a different layout must not (issue #4370) —
        // see the scoped-purge suite below.
        beginScopePurge('kilter:1')();
        return { filePath };
      },
      deleteArtifact: vi.fn(async () => {}),
    };
    const onSnapshotBootstrapError = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(onSnapshotBootstrapError).toHaveBeenCalledTimes(1);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'kilter:1:5',
        stage: 'download',
        attempt: 0,
        aborted: true,
        reason: 'aborted-wipe',
        expected: true,
      }),
    );
    // Torn down, not failed: no rows, no budget spent, so the same scope simply
    // runs again on the next cycle.
    expect(await countRows('board_climbs')).toBe(0);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
  });

  it('reports the app backgrounding during the artifact download as its own reason', async () => {
    const filePath = join(workDir, 'backgrounded-mid-download.db');
    buildScopeArtifact(filePath);
    const source: SnapshotSource = {
      fetchManifest: async () => makeManifest([makeEntry()]),
      downloadArtifact: async () => {
        setBackgrounded(true);
        return { filePath };
      },
      deleteArtifact: vi.fn(async () => {}),
    };
    const onSnapshotBootstrapError = vi.fn();
    const { fetch } = makeGraphqlFetch();

    try {
      await pullSync(db, noopQueryClient(), fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onSnapshotBootstrapError,
      });
    } finally {
      setBackgrounded(false);
    }

    expect(onSnapshotBootstrapError).toHaveBeenCalledTimes(1);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'download', aborted: true, reason: 'aborted-background' }),
    );
    expect(await countRows('board_climbs')).toBe(0);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
  });

  it('closes the tightest window of all: a teardown between Started and the transfer', async () => {
    const filePath = join(workDir, 'purged-at-start.db');
    buildScopeArtifact(filePath);
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onSnapshotBootstrapError = vi.fn();
    const { fetch } = makeGraphqlFetch();

    await pullSync(db, noopQueryClient(), fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      // Fired on the line directly above the bail, so this is a teardown landing
      // in the gap between Started and the first byte.
      onScopeDownloadStart: () => beginScopePurge('kilter:1')(),
      onSnapshotBootstrapError,
    });

    expect(source.downloadArtifact).not.toHaveBeenCalled();
    expect(onSnapshotBootstrapError).toHaveBeenCalledTimes(1);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'download', attempt: 0, aborted: true, reason: 'aborted-wipe' }),
    );
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
  });

  it('reports a SnapshotWipedError from the import as an abort, not a failure', async () => {
    const filePath = join(workDir, 'wiped-mid-import.db');
    buildScopeArtifact(filePath);
    // Bump the epoch the moment the stats INSERT runs — after
    // bootstrapScopeFromSnapshot captured its start epoch, so the next batch's
    // in-lock guard raises SnapshotWipedError. Since #4310 the climbs batch has
    // already COMMITTED by then, so its row survives; what must not survive is a
    // checkpoint, and neither may the retry budget move.
    // Prototype spy: the import runs on the transaction's own adapter instance.
    const adapterPrototype = Object.getPrototypeOf(db) as { runAsync: typeof db.runAsync };
    const realRunAsync = adapterPrototype.runAsync;
    let purged = false;
    vi.spyOn(adapterPrototype, 'runAsync').mockImplementation(async function (
      this: unknown,
      source: string,
      ...rest: unknown[]
    ) {
      if (!purged && source.includes('INSERT OR REPLACE INTO main.board_climb_stats')) {
        purged = true;
        beginScopePurge('kilter:1')();
      }
      return realRunAsync.call(this, source, ...(rest as never[]));
    } as typeof db.runAsync);

    const snapshotSource = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      fileForEntry: () => filePath,
    });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource,
      onSnapshotBootstrapError,
    });

    expect(onSnapshotBootstrapError).toHaveBeenCalledTimes(1);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'kilter:1:5',
        stage: 'import',
        attempt: 0,
        aborted: true,
        reason: 'aborted-wipe',
        expected: true,
      }),
    );
    // Rows without markers is the benign direction; the budget is untouched.
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:5')).toBeNull();
    expect(await getCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:5')).toBeNull();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
  });

  it('still charges a GENUINE import failure, reported as a non-abort with a real reason', async () => {
    // The behaviour the abort reporting must not have changed: a freshly
    // downloaded artifact whose meta disagrees with its contents is broken, not
    // torn down, and it burns a structural attempt exactly as it always did.
    const filePath = join(workDir, 'truncated-artifact.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
      climbsRowCountOverride: 999, // claims 999 rows, artifact holds 1
    });
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'kilter:1:5',
        stage: 'import',
        attempt: 1,
        aborted: false,
        reason: 'artifact-invalid',
        expected: false,
      }),
    );
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(1);
  });

  it('says nothing at all about a bootstrap that worked', async () => {
    const filePath = join(workDir, 'clean-bootstrap.db');
    buildScopeArtifact(filePath);
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(onSnapshotBootstrapError).not.toHaveBeenCalled();
    expect(await countRows('board_climbs')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The funnel's terminal-event invariant (issue #4316)
//
// EVERY `Offline Board Download Started` gets exactly one terminal event. #4314
// wired the three teardown bail-outs by hand and a device still went silent —
// six Starteds carrying a 103 MB artifactBytes, no Completed, no Failed, no
// Sentry. Per-site reporting only ever covers the sites somebody remembered, so
// the phase now arms a guard at the Started emission and closes it from a
// `finally`. These pin the two exit classes that were still silent afterwards,
// plus the no-double-emit rule. The guard's own exit matrix — including the
// unregistered `break` that can no longer be written by construction — is
// covered in download-funnel-guard.test.ts.
// ---------------------------------------------------------------------------

describe('pullSync bootstrap funnel invariant', () => {
  function buildScopeArtifact(filePath: string): void {
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
  }

  it('reports an exception thrown outside the import try instead of unwinding in silence', async () => {
    // Everything between the Started emission and `bootstrapScopeFromSnapshot`
    // sits outside any catch: the retry-state writes, the paged-fallback markers,
    // and the two consumer callbacks. A SQLITE_BUSY on any of them used to end
    // the phase with no terminal event at all. The progress sink stands in for
    // that whole region here because it is the one seam a test can throw from.
    const filePath = join(workDir, 'locked-after-download.db');
    buildScopeArtifact(filePath);
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onSnapshotBootstrapError = vi.fn();
    const lockError = new Error("Calling the 'execAsync' function has failed", {
      cause: new Error('Error code 5: database is locked'),
    });

    await expect(
      pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onSnapshotBootstrapError,
        onProgress: (progress) => {
          if (progress.snapshot?.stage === 'import') throw lockError;
        },
      }),
    ).rejects.toBe(lockError);

    expect(onSnapshotBootstrapError).toHaveBeenCalledTimes(1);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'kilter:1:5',
        stage: 'import',
        // Classified off the real cause, so the Sentry issue lands under
        // reason:database-locked instead of a blank unknown.
        reason: 'database-locked',
        aborted: false,
        expected: false,
        // A bystander never spends the scope's retry budget.
        attempt: 0,
      }),
    );
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
  });

  it('ends the cycle as interrupted when a suspended transfer rejects after the phone foregrounds', async () => {
    // Background URLSession work is allowed to continue, but the OS can still
    // kill the transfer while the process is suspended. The phone may foreground
    // before that rejection reaches JS, so the suspension window — not the live
    // AppState flag — must stop this stale cycle before deletions or paged pulls.
    const filePath = join(workDir, 'backgrounded-then-foregrounded.db');
    buildScopeArtifact(filePath);
    let seenSignal: AbortSignal | undefined;
    const source: SnapshotSource = {
      fetchManifest: async () => makeManifest([makeEntry()]),
      downloadArtifact: async (_entry, options) => {
        seenSignal = options?.signal;
        setBackgrounded(true);
        setBackgrounded(false);
        throw new Error('The network connection was lost.');
      },
      deleteArtifact: vi.fn(async () => {}),
    };
    const onSnapshotBootstrapError = vi.fn();
    const onBootstrapRetryScheduled = vi.fn();
    const progressFrames: SyncProgress[] = [];
    const { fetch } = makeGraphqlFetch();

    try {
      await pullSync(db, noopQueryClient(), fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onSnapshotBootstrapError,
        onBootstrapRetryScheduled,
        onProgress: (progress) => progressFrames.push(progress),
      });
    } finally {
      setBackgrounded(false);
    }

    // Kept outside the downloader: an assertion thrown inside that callback is
    // intentionally caught as a download failure and cannot prove anything.
    expect(seenSignal?.aborted).toBe(false);
    expect(onSnapshotBootstrapError).toHaveBeenCalledTimes(1);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'kilter:1:5',
        stage: 'download',
        reason: 'aborted-background',
        aborted: true,
        attempt: 0,
      }),
    );
    // Nothing was spent and no cooldown was scheduled: the same scope simply runs
    // again on the next foreground.
    expect(onBootstrapRetryScheduled).not.toHaveBeenCalled();
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(0);
    const { state } = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(state.transportFailures).toBe(0);
    expect(state.structuralFailures).toBe(0);
    expect(progressFrames.at(-1)).toEqual({
      phase: 'idle',
      currentTable: null,
      documentsProcessed: 0,
      interrupted: true,
    });
    expect(progressFrames.filter((progress) => progress.phase === 'idle')).toHaveLength(1);
    expect(
      fetch.mock.calls.some(([query]) =>
        ['syncDeletions', 'syncClimbs', 'syncClimbStats', 'syncClimbGrades'].some((field) =>
          String(query).includes(field),
        ),
      ),
    ).toBe(false);
  });

  it('charges a typed background-task marker to transport when AppState is active', async () => {
    const marker = new SnapshotBackgroundTransferInterruptedError('cannot decode raw data');
    const source: SnapshotSource = {
      fetchManifest: async () => makeManifest([makeEntry()]),
      downloadArtifact: async () => {
        throw marker;
      },
      deleteArtifact: vi.fn(async () => {}),
    };
    const onSnapshotBootstrapError = vi.fn();
    const onBootstrapRetryScheduled = vi.fn();
    const progressFrames: SyncProgress[] = [];

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
      onBootstrapRetryScheduled,
      onProgress: (progress) => progressFrames.push(progress),
      now: () => BASE_NOW,
      random: () => 0,
    });

    const { state } = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(state.transportFailures).toBe(1);
    expect(state.backgroundPauses).toBe(0);
    expect(onBootstrapRetryScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: 'transport', transportFailures: 1 }),
    );
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'background-transfer-decode',
        expected: true,
        aborted: false,
        attempt: 1,
      }),
    );
    expect(progressFrames.at(-1)).toEqual(expect.objectContaining({ phase: 'idle', currentTable: null }));
    expect(progressFrames.at(-1)?.interrupted).toBeUndefined();
  });

  it('treats the typed marker as a bounded background pause while the suspension window stays open', async () => {
    const source: SnapshotSource = {
      fetchManifest: async () => makeManifest([makeEntry()]),
      downloadArtifact: async () => {
        setBackgrounded(true);
        setBackgrounded(false);
        throw new SnapshotBackgroundTransferInterruptedError('cannot decode raw data');
      },
      deleteArtifact: vi.fn(async () => {}),
    };
    const onSnapshotBootstrapError = vi.fn();
    const onBootstrapRetryScheduled = vi.fn();
    const progressFrames: SyncProgress[] = [];

    try {
      await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
        enabledBoards: ['kilter:1:5'],
        snapshotSource: source,
        onSnapshotBootstrapError,
        onBootstrapRetryScheduled,
        onProgress: (progress) => progressFrames.push(progress),
        now: () => BASE_NOW,
        random: () => 0,
      });
    } finally {
      setBackgrounded(false);
    }

    const { state } = await readBootstrapRetryState(db, 'kilter:1:5', { now: BASE_NOW, random: () => 0 }, false);
    expect(state.backgroundPauses).toBe(1);
    expect(state.transportFailures).toBe(0);
    expect(onBootstrapRetryScheduled).not.toHaveBeenCalled();
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'aborted-background',
        aborted: true,
        attempt: 0,
      }),
    );
    expect(progressFrames.at(-1)).toEqual(
      expect.objectContaining({ phase: 'idle', currentTable: null, interrupted: true }),
    );
  });

  it('emits exactly one terminal event for a download that genuinely failed', async () => {
    // The no-double-emit rule at the engine level: the settled failure reports,
    // and the guard's finally must add nothing on top of it.
    const source = makeSnapshotSource({
      manifest: makeManifest([makeEntry()]),
      downloadError: new Error('Network request failed'),
    });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(onSnapshotBootstrapError).toHaveBeenCalledTimes(1);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'download', reason: 'network', aborted: false }),
    );
  });

  it('adds nothing to a successful import, whose terminal event is the later Completed', async () => {
    // The one settlement the guard cannot read off a report: a scope that
    // imported owes the funnel a Completed from the board-data loop — on Kilter
    // usually cycles later, once the grades crawl finishes — so a Failed here
    // would be a second terminal event for the same Started.
    const filePath = join(workDir, 'clean-funnel.db');
    buildScopeArtifact(filePath);
    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onSnapshotBootstrapError = vi.fn();
    const onScopeDownloadStart = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: ['kilter:1:5'],
      snapshotSource: source,
      onSnapshotBootstrapError,
      onScopeDownloadStart,
    });

    expect(onScopeDownloadStart).toHaveBeenCalledTimes(1);
    expect(onSnapshotBootstrapError).not.toHaveBeenCalled();
    expect(await countRows('board_climbs')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-board purge scoping (issue #4370)
//
// Removing one board used to bump ONE global epoch, so a Tension removal killed
// a 100 MB Kilter transfer mid-flight and the climber watched it restart from
// zero on the next foreground. The epoch is now per `boardType:layoutId` — the
// exact predicate removeBoardScopeData deletes on, and the exact key both
// snapshot artifacts are already cached under.
// ---------------------------------------------------------------------------

describe('pullSync bootstrap purge scoping', () => {
  const KILTER_KEY = 'kilter:1:5';
  const TENSION_KEY = 'tension:2:8';

  function buildTwoLayoutArtifacts(): { kilterFile: string; tensionFile: string; manifest: SnapshotManifest } {
    const kilterFile = join(workDir, 'scoped-kilter.db');
    const tensionFile = join(workDir, 'scoped-tension.db');
    buildArtifact({
      filePath: kilterFile,
      climbs: [{ uuid: 'kilter-c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'kilter-c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    buildArtifact({
      filePath: tensionFile,
      climbs: [{ uuid: 'tension-c1', boardType: 'tension', layoutId: 2, compatibleSizeIds: [8] }],
      stats: [{ climbUuid: 'tension-c1', boardType: 'tension', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const manifest = makeManifest([
      makeEntry(),
      makeEntry({
        boardType: 'tension',
        layoutId: 2,
        key: 'board-snapshots/v1/tension/2/2026-06-01.db',
        url: 'https://example.test/tension-2.db',
      }),
    ]);
    return { kilterFile, tensionFile, manifest };
  }

  /** A source serving both layouts, with a hook that fires per downloaded layout. */
  function makeTwoLayoutSource(
    files: { kilterFile: string; tensionFile: string; manifest: SnapshotManifest },
    onDownload: (boardType: string) => void,
  ): SnapshotSource {
    return {
      fetchManifest: async () => files.manifest,
      downloadArtifact: async (entry: SnapshotManifestEntry) => {
        onDownload(entry.boardType);
        return { filePath: entry.boardType === 'tension' ? files.tensionFile : files.kilterFile };
      },
      deleteArtifact: vi.fn(async () => {}),
    } as unknown as SnapshotSource;
  }

  // THE WIN. Before this, the Kilter transfer died to the Tension removal.
  it("imports the untouched layout while another layout's board is removed mid-download", async () => {
    const files = buildTwoLayoutArtifacts();
    const source = makeTwoLayoutSource(files, (boardType) => {
      if (boardType === 'kilter') beginScopePurge('tension:2')();
    });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: [KILTER_KEY, TENSION_KEY],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    // Kilter imported, which is the whole point: before #4370 this row count was 0.
    expect(await countRows('board_climbs')).toBe(1);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${KILTER_KEY}`)).not.toBeNull();

    // Tension is processed AFTER kilter, so its purge lands before it ever arms
    // the funnel: it bails at the phase's loop top having emitted no Started, so
    // it is owed no terminal event and nothing at all is reported. (A scope
    // already armed when its own layout is purged DOES report — see the next
    // test.) Its budget is untouched either way.
    expect(onSnapshotBootstrapError).not.toHaveBeenCalled();
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${TENSION_KEY}`)).toBeNull();
    expect(await getBootstrapAttempts(db, TENSION_KEY)).toBe(0);
  });

  // The other half: the removed layout's own transfer must still die.
  it("aborts the removed layout's own download and still imports the other", async () => {
    const files = buildTwoLayoutArtifacts();
    const source = makeTwoLayoutSource(files, (boardType) => {
      if (boardType === 'kilter') beginScopePurge('kilter:1')();
    });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: [KILTER_KEY, TENSION_KEY],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(await getCheckpoint(db, `checkpoint:board_climbs:${KILTER_KEY}`)).toBeNull();
    expect(await getBootstrapAttempts(db, KILTER_KEY)).toBe(0);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: KILTER_KEY, stage: 'download', aborted: true, reason: 'aborted-wipe' }),
    );
    // Tension was never touched by the purge, so it imported.
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${TENSION_KEY}`)).not.toBeNull();
  });

  // Pins the scoping of the two guards inside the import transaction: a purge of
  // a DIFFERENT namespace must not raise SnapshotWipedError and roll this back.
  it("does not roll back an import when a different layout's board is purged", async () => {
    const filePath = join(workDir, 'other-layout-purged-mid-import.db');
    buildArtifact({
      filePath,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    const adapterPrototype = Object.getPrototypeOf(db) as { runAsync: typeof db.runAsync };
    const realRunAsync = adapterPrototype.runAsync;
    let purged = false;
    vi.spyOn(adapterPrototype, 'runAsync').mockImplementation(async function (
      this: unknown,
      sql: string,
      ...rest: unknown[]
    ) {
      if (!purged && sql.includes('INSERT OR REPLACE INTO main.board_climb_stats')) {
        purged = true;
        beginScopePurge('tension:2')();
      }
      return realRunAsync.call(this, sql, ...(rest as never[]));
    } as typeof db.runAsync);

    const source = makeSnapshotSource({ manifest: makeManifest([makeEntry()]), fileForEntry: () => filePath });
    const onSnapshotBootstrapError = vi.fn();

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: [KILTER_KEY],
      snapshotSource: source,
      onSnapshotBootstrapError,
    });

    expect(purged).toBe(true);
    expect(await countRows('board_climbs')).toBe(1);
    expect(await getCheckpoint(db, `checkpoint:board_climbs:${KILTER_KEY}`)).not.toBeNull();
    expect(onSnapshotBootstrapError).not.toHaveBeenCalled();
  });

  // The grades artifact rides the same namespace key, so a sibling layout's
  // removal must not stop it either — and it must not burn a grades attempt.
  it("imports grades through another layout's purge without burning an attempt", async () => {
    const climbsFile = join(workDir, 'grades-scoped-climbs.db');
    const gradesFile = join(workDir, 'grades-scoped-grades.db');
    buildArtifact({
      filePath: climbsFile,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    buildGradesArtifact({
      filePath: gradesFile,
      grades: [{ climbUuid: 'c1', angle: 40 }],
      watermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
    });
    const { source } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile,
      gradesFile,
    });
    const originalDownloadGrades = source.downloadGradesArtifact?.bind(source);
    source.downloadGradesArtifact = async (artifact) => {
      beginScopePurge('tension:2')();
      return originalDownloadGrades ? originalDownloadGrades(artifact) : null;
    };

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: [KILTER_KEY],
      snapshotSource: source,
    });

    expect(await getCheckpoint(db, `checkpoint:board_climb_grades:${KILTER_KEY}`)).not.toBeNull();
    expect(await getGradesBootstrapAttempts(db, KILTER_KEY)).toBe(0);
  });

  // Term-count regression guard for the whole rewrite: every guard is
  // `isSigningOut() || <purge> || isBackgrounded()`, and only the middle term
  // changed. Dropping isBackgrounded() in front of the grades import would
  // reopen the BOARDSESH-AN class of bug.
  it('still bails the grades import when the app backgrounds and nothing was purged', async () => {
    const climbsFile = join(workDir, 'grades-bg-climbs.db');
    const gradesFile = join(workDir, 'grades-bg-grades.db');
    buildArtifact({
      filePath: climbsFile,
      climbs: [{ uuid: 'c1', compatibleSizeIds: [5] }],
      stats: [{ climbUuid: 'c1', angle: 40 }],
      climbsWatermark: CLIMBS_WATERMARK,
      statsWatermark: STATS_WATERMARK,
    });
    buildGradesArtifact({
      filePath: gradesFile,
      grades: [{ climbUuid: 'c1', angle: 40 }],
      watermark: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: '10' },
    });
    const { source } = makeGradesSource({
      manifest: makeManifest([makeEntry({ grades: gradesArtifactBlock() })]),
      climbsFile,
      gradesFile,
    });
    const originalDownloadGrades = source.downloadGradesArtifact?.bind(source);
    source.downloadGradesArtifact = async (artifact) => {
      const result = originalDownloadGrades ? await originalDownloadGrades(artifact) : null;
      setBackgrounded(true);
      return result;
    };
    const onSnapshotBootstrapError = vi.fn();
    const progressFrames: SyncProgress[] = [];
    const { fetch } = makeGraphqlFetch();

    try {
      await pullSync(db, noopQueryClient(), fetch, {
        enabledBoards: [KILTER_KEY],
        snapshotSource: source,
        onSnapshotBootstrapError,
        onProgress: (progress) => progressFrames.push(progress),
      });
    } finally {
      setBackgrounded(false);
    }

    expect(await countRows('board_climbs')).toBe(1);
    expect(await getCheckpoint(db, `checkpoint:board_climb_grades:${KILTER_KEY}`)).toBeNull();
    expect(await getGradesBootstrapAttempts(db, KILTER_KEY)).toBe(0);
    expect(onSnapshotBootstrapError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'grades-download', attempt: 0, aborted: true, reason: 'aborted-background' }),
    );
    expect(
      fetch.mock.calls.some(([query]) =>
        ['syncDeletions', 'syncClimbs', 'syncClimbStats', 'syncClimbGrades'].some((field) =>
          String(query).includes(field),
        ),
      ),
    ).toBe(false);
    expect(progressFrames.at(-1)).toEqual({
      phase: 'idle',
      currentTable: null,
      documentsProcessed: 0,
      interrupted: true,
    });
    expect(progressFrames.filter((progress) => progress.phase === 'idle')).toHaveLength(1);
  });

  // THE FUNNEL INVARIANT under `break` → `continue`: every Started still gets
  // exactly one terminal event. The per-scope `finally` closes the guard once per
  // scope now instead of once per cycle, which is what preserves it.
  it('emits exactly one terminal event per Started across a mid-flight scope purge', async () => {
    const files = buildTwoLayoutArtifacts();
    const source = makeTwoLayoutSource(files, (boardType) => {
      if (boardType === 'kilter') beginScopePurge('tension:2')();
    });
    const started: string[] = [];
    const terminals: string[] = [];

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: [KILTER_KEY, TENSION_KEY],
      snapshotSource: source,
      onScopeDownloadStart: (info) => started.push(info.scopeKey),
      onSnapshotBootstrapError: (report) => terminals.push(report.scopeKey),
      onScopeDownloadComplete: (info) => terminals.push(info.scopeKey),
    });

    // The purged scope never announced a Started, so it is owed nothing; the
    // surviving one announced exactly one and got exactly one terminal.
    expect(started).toEqual([KILTER_KEY]);
    for (const scopeKey of started) {
      expect(terminals.filter((key) => key === scopeKey)).toHaveLength(1);
    }
    expect(terminals).not.toContain(TENSION_KEY);
  });

  it('emits exactly one terminal event per Started across a mid-flight GLOBAL purge', async () => {
    const files = buildTwoLayoutArtifacts();
    const source = makeTwoLayoutSource(files, (boardType) => {
      if (boardType === 'kilter') beginGlobalPurge();
    });
    const started: string[] = [];
    const terminals: string[] = [];

    await pullSync(db, noopQueryClient(), makeGraphqlFetch().fetch, {
      enabledBoards: [KILTER_KEY, TENSION_KEY],
      snapshotSource: source,
      onScopeDownloadStart: (info) => started.push(info.scopeKey),
      onSnapshotBootstrapError: (report) => terminals.push(report.scopeKey),
      onScopeDownloadComplete: (info) => terminals.push(info.scopeKey),
    });

    for (const scopeKey of started) {
      expect(terminals.filter((key) => key === scopeKey)).toHaveLength(1);
    }
  });
});
