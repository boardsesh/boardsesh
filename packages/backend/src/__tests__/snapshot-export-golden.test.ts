// Golden parity test — the contract keeper for the nightly board-snapshot export.
//
// It proves that a row written into a snapshot artifact by the export job
// (scripts/export-board-snapshots.ts) is byte-identical to the row a live
// `syncClimbs` / `syncClimbStats` pull would write into the on-device SQLite. If
// the two paths ever diverge (a column dropped, a timestamp shaped differently,
// an array serialized another way), a warmed-from-snapshot board would disagree
// with an incrementally-pulled one and this test fails.
//
//   Path A — the export core (`exportLayoutSnapshot`) streams Postgres → a SQLite
//            artifact file (node:sqlite).
//   Path B — the REAL resolvers feed the REAL client `pullSync` upsert path into a
//            second node:sqlite DB built from the shared client DDL.
//
// Both DBs are then read back and compared column-for-column. It also pins the
// snapshot_meta watermarks and the 30s stability-window exclusion.

import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionContext, SyncCursorInput } from '@boardsesh/shared-schema';
import type { QueryInvalidator } from '@boardsesh/offline-sync';
import { pullSync, runMigrations, TABLE_CONFIGS } from '@boardsesh/offline-sync';
import { createTestDatabase } from '@boardsesh/offline-sync/testing';
// createPool supplies the real worker Postgres connection to this core-level
// test. The production CLI creates isolated primary/replica pools and declares
// their observer capability explicitly; parser parity is covered separately by
// snapshot-replica-fence.test.ts.
// TODO(#4475 review, finding 9): this golden byte-parity run reads through the
// drizzle pool while production reads through the isolated single-connection
// snapshot pool, so a pool-shaped parser difference stays outside the gate.
import { createPool } from '@boardsesh/db/client';
import { db } from '../db/client';
import { seedWithRestoredSyncCursors } from './helpers/sync-cursor-restore';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { toIso } from '../graphql/resolvers/sync/row-normalize';
import { exportLayoutSnapshot, selectDeletionReplayBoundary } from '../scripts/export-board-snapshots';

const USER_ID = 'snapshot-export-user';
const BOARD_TYPE = 'kilter';
const LAYOUT_ID = 1;
const SIZE_ID = 5;
const SCOPE_KEY = `${BOARD_TYPE}:${LAYOUT_ID}:${SIZE_ID}`;
const BUILT_AT = '2026-06-01T00:00:00.000Z';
const INCLUDE_ALL_STABLE_BEFORE = '2100-01-01T00:00:00.000Z';

async function primaryStableBefore(seconds: number): Promise<string> {
  const rows = await db.execute(sql`
    SELECT ((clock_timestamp() - make_interval(secs => ${seconds})) AT TIME ZONE 'UTC') AS stable_before
  `);
  return toIso((rows[0] as { stable_before: unknown }).stable_before);
}

const CLIMB_COLUMNS = TABLE_CONFIGS.board_climbs.localColumns;
const STATS_COLUMNS = TABLE_CONFIGS.board_climb_stats.localColumns;
const GRADES_COLUMNS = TABLE_CONFIGS.board_climb_grades.localColumns;

function ctx(): ConnectionContext {
  return {
    connectionId: 'snapshot-export-conn',
    isAuthenticated: true,
    userId: USER_ID,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

type EmptyPage = { documents: never[]; cursor: SyncCursorInput; hasMore: false };
type ResolverResponse = Record<string, unknown>;

// A graphqlFetch that routes the two board queries to the REAL resolvers (against
// the seeded Postgres) and serves an empty page for every other sync query and
// deletions — exactly the shape pullSync expects, so the full client upsert path
// runs unchanged.
async function graphqlFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const emptyCursor: SyncCursorInput = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };
  const resolverArgs = variables as Parameters<typeof syncQueries.syncClimbs>[1];

  if (query.includes('syncDeletions')) {
    return { syncDeletions: { deletions: [], cursor: emptyCursor, hasMore: false } } as T;
  }
  // Check stats before climbs: 'syncClimbStats' does not contain the substring
  // 'syncClimbs' (capital S after 'syncClimb'), so ordering is unambiguous.
  if (query.includes('syncClimbStats')) {
    return { syncClimbStats: await syncQueries.syncClimbStats(undefined, resolverArgs, ctx()) } as T;
  }
  if (query.includes('syncClimbGrades')) {
    return { syncClimbGrades: await syncQueries.syncClimbGrades(undefined, resolverArgs, ctx()) } as T;
  }
  if (query.includes('syncClimbs')) {
    return { syncClimbs: await syncQueries.syncClimbs(undefined, resolverArgs, ctx()) } as T;
  }
  const fieldMatch = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/);
  const fieldName = fieldMatch ? fieldMatch[1] : 'unknown';
  const emptyPage: EmptyPage = { documents: [], cursor: emptyCursor, hasMore: false };
  return { [fieldName]: emptyPage } as ResolverResponse as T;
}

function noopQueryClient(): QueryInvalidator {
  return { invalidateQueries: () => {} } as unknown as QueryInvalidator;
}

async function insertClimb(values: {
  uuid: string;
  name?: string;
  description?: string | null;
  isDraft?: boolean;
  isListed?: boolean | null;
  compatibleSizeIds: number[];
  requiredSetIds?: number[] | null;
  characteristics?: string[] | null;
  frames?: string | null;
  setterId?: number | null;
  updatedAt: string;
}): Promise<void> {
  const compatible = `{${values.compatibleSizeIds.join(',')}}`;
  const requiredSetIds = values.requiredSetIds == null ? null : `{${values.requiredSetIds.join(',')}}`;
  const characteristics = values.characteristics == null ? null : `{${values.characteristics.join(',')}}`;
  // Fixed updated_at values are the whole point of these fixtures (watermarks,
  // stability-window exclusion), so the seed opts into the restore hatch for
  // its own transaction. Everything else in this file writes through the
  // production stamping path.
  await seedWithRestoredSyncCursors(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, setter_id, name, description, is_draft, is_listed,
       compatible_size_ids, required_set_ids, characteristics, frames, updated_at)
    VALUES
      (${values.uuid}, ${BOARD_TYPE}, ${LAYOUT_ID}, ${values.setterId ?? null},
       ${values.name ?? null}, ${values.description ?? null}, ${values.isDraft ?? false},
       ${values.isListed ?? true}, ${compatible}::int[], ${requiredSetIds}::int[],
       ${characteristics}::text[], ${values.frames ?? null}, ${values.updatedAt}::timestamp)
  `);
}

async function insertStat(values: {
  climbUuid: string;
  angle: number;
  displayDifficulty?: number | null;
  ascensionistCount?: number | null;
  qualityAverage?: number | null;
  faUsername?: string | null;
  faAt?: string | null;
  updatedAt: string;
}): Promise<void> {
  await seedWithRestoredSyncCursors(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, display_difficulty, ascensionist_count,
       quality_average, fa_username, fa_at, updated_at)
    VALUES
      (${BOARD_TYPE}, ${values.climbUuid}, ${values.angle}, ${values.displayDifficulty ?? null},
       ${values.ascensionistCount ?? null}, ${values.qualityAverage ?? null},
       ${values.faUsername ?? null}, ${values.faAt ?? null}, ${values.updatedAt}::timestamp)
  `);
}

async function insertGrade(values: {
  climbUuid: string;
  angle: number;
  localGrade?: number | null;
  universalGrade?: number | null;
  gradeLow?: number | null;
  gradeHigh?: number | null;
  confidence?: string | null;
  ascensionistCount?: number | null;
  computedAt: string;
}): Promise<void> {
  // confidence / ascensionist_count / model_version / coeff_version are NOT NULL
  // in board_climb_grades (packages/db/src/schema/app/climb-grades.ts).
  await seedWithRestoredSyncCursors(sql`
    INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high,
       confidence, ascensionist_count, model_version, coeff_version, computed_at)
    VALUES
      (${BOARD_TYPE}, ${values.climbUuid}, ${values.angle}, ${values.localGrade ?? null},
       ${values.universalGrade ?? null}, ${values.gradeLow ?? null}, ${values.gradeHigh ?? null},
       ${values.confidence ?? 'low'}, ${values.ascensionistCount ?? 0}, 'test-model', 'test-coeff',
       ${values.computedAt}::timestamp)
  `);
}

function readArtifactTableNames(filePath: string): string[] {
  const artifactDb = new DatabaseSync(filePath);
  try {
    return (
      artifactDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    artifactDb.close();
  }
}

function readArtifactMetaTableNames(filePath: string): string[] {
  const artifactDb = new DatabaseSync(filePath);
  try {
    return (
      artifactDb.prepare('SELECT table_name FROM snapshot_meta ORDER BY table_name').all() as {
        table_name: string;
      }[]
    ).map((row) => row.table_name);
  } finally {
    artifactDb.close();
  }
}

function readArtifactRows(filePath: string, table: string, columns: readonly string[]): Record<string, unknown>[] {
  const artifactDb = new DatabaseSync(filePath);
  try {
    const orderBy = table === 'board_climbs' ? 'uuid' : 'climb_uuid, angle';
    return artifactDb.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${orderBy}`).all() as Record<
      string,
      unknown
    >[];
  } finally {
    artifactDb.close();
  }
}

function readArtifactMeta(filePath: string, table: string): Record<string, unknown> | undefined {
  const artifactDb = new DatabaseSync(filePath);
  try {
    return artifactDb.prepare('SELECT * FROM snapshot_meta WHERE table_name = ?').get(table) as
      | Record<string, unknown>
      | undefined;
  } finally {
    artifactDb.close();
  }
}

let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'snapshot-golden-'));
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades RESTART IDENTITY CASCADE`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('board-snapshot export ↔ live pull parity', () => {
  it('models a long-running delete older than the stability window and fails closed without activity visibility', () => {
    const boundary = selectDeletionReplayBoundary({
      artifactBuiltAt: '2026-06-01T11:59:50.000Z',
      stableBefore: '2026-06-01T11:59:30.000Z',
      exportTransactionStartedAt: '2026-06-01T12:00:00.000Z',
      // This DELETE began two minutes before the export. Its deleted_at can be
      // older than the ordinary 30-second stability boundary even though its
      // uncommitted row remains visible in the artifact snapshot.
      oldestActiveTransactionStartedAt: '2026-06-01T11:58:00.000Z',
      visibilityEstablished: true,
    });
    expect(boundary).toBe('2026-06-01T11:58:00.000Z');

    expect(
      selectDeletionReplayBoundary({
        artifactBuiltAt: '2026-06-01T11:59:50.000Z',
        stableBefore: '2026-06-01T11:59:30.000Z',
        exportTransactionStartedAt: '2026-06-01T12:00:00.000Z',
        oldestActiveTransactionStartedAt: null,
        visibilityEstablished: false,
      }),
    ).toBeNull();

    expect(
      selectDeletionReplayBoundary({
        artifactBuiltAt: new Date('invalid'),
        stableBefore: '2026-06-01T11:59:30.000Z',
        exportTransactionStartedAt: '2026-06-01T12:00:00.000Z',
        oldestActiveTransactionStartedAt: null,
        visibilityEstablished: true,
      }),
    ).toBeNull();
  });

  it('samples an open delete transaction before fixing the artifact snapshot', async () => {
    await insertClimb({ uuid: 'open-delete', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });

    let releaseDeleteTransaction = (): void => {};
    const deleteTransactionRelease = new Promise<void>((resolve) => {
      releaseDeleteTransaction = resolve;
    });
    let resolveDeleteStarted!: (startedAt: string) => void;
    let rejectDeleteStarted!: (error: unknown) => void;
    const deleteStarted = new Promise<string>((resolve, reject) => {
      resolveDeleteStarted = resolve;
      rejectDeleteStarted = reject;
    });
    const deleteTransaction = createPool()
      .begin(async (transaction) => {
        await transaction.unsafe('DELETE FROM board_climbs WHERE uuid = $1', ['open-delete']);
        const startRows = await transaction.unsafe('SELECT transaction_timestamp() AS xact_start');
        const startRow = startRows[0] as unknown as { xact_start: unknown };
        resolveDeleteStarted(new Date(Date.parse(toIso(startRow.xact_start))).toISOString());
        await deleteTransactionRelease;
      })
      .catch((error: unknown) => {
        rejectDeleteStarted(error);
        throw error;
      });

    const deleteStartedAt = await deleteStarted;
    const builtAtRow = (await db.execute(sql`SELECT clock_timestamp() AS built_at`))[0] as { built_at: unknown };
    const artifactBuiltAt = toIso(builtAtRow.built_at);
    const filePath = join(workDir, 'open-delete-artifact.db');
    let replayBoundary: string | null = null;
    try {
      const result = await exportLayoutSnapshot({
        sqlClient: createPool(),
        deletionObserverConnectionAvailable: true,
        boardType: BOARD_TYPE,
        layoutId: LAYOUT_ID,
        filePath,
        builtAt: artifactBuiltAt,
        stableBefore: artifactBuiltAt,
      });

      // The uncommitted DELETE is invisible to the RR snapshot, so the row is
      // present in the artifact. Its old transaction timestamp must therefore
      // be the replay boundary that catches the tombstone after commit.
      expect(readArtifactRows(filePath, 'board_climbs', ['uuid'])).toEqual([{ uuid: 'open-delete' }]);
      const rawReplayBoundary = readArtifactMeta(filePath, 'sync_deletions')?.watermark_updated_at;
      replayBoundary = typeof rawReplayBoundary === 'string' ? rawReplayBoundary : null;
      expect(replayBoundary).toBe(deleteStartedAt);
      expect(result.deletionsReplayFrom).toBe(deleteStartedAt);
      expect(result.deletionsReplayFallbackReason).toBeNull();
    } finally {
      releaseDeleteTransaction();
      await deleteTransaction;
    }

    const tombstone = (
      await db.execute(sql`
        SELECT deleted_at
        FROM sync_deletions
        WHERE table_name = 'board_climbs' AND record_id = 'open-delete'
        ORDER BY id DESC
        LIMIT 1
      `)
    )[0] as { deleted_at: unknown };
    expect(Date.parse(replayBoundary ?? '')).toBeLessThanOrEqual(Date.parse(toIso(tombstone.deleted_at)));
  });

  it('produces byte-identical board_climbs / board_climb_stats rows via the export core and the real resolver pull', async () => {
    // Tricky shapes: booleans, int[] and text[] arrays, NULLs in arrays/text,
    // fractional-second timestamps, multi-angle stats, and a climb with no stats.
    await insertClimb({
      uuid: 'c1',
      name: 'Crimp Master',
      description: 'a real description',
      isDraft: false,
      isListed: true,
      setterId: 42,
      compatibleSizeIds: [5, 6],
      requiredSetIds: [10, 20],
      characteristics: ['crimpy', 'powerful'],
      frames: 'p1145r12p1146r13',
      updatedAt: '2026-05-01T00:00:00Z',
    });
    await insertClimb({
      uuid: 'c2',
      name: 'Draft Problem',
      description: null,
      isDraft: true,
      isListed: false,
      compatibleSizeIds: [5],
      requiredSetIds: null,
      characteristics: null,
      frames: null,
      updatedAt: '2026-05-01T00:00:01.5Z', // fractional seconds
    });
    await insertClimb({
      uuid: 'c3',
      name: 'Über Sloper ✦',
      compatibleSizeIds: [5, 7],
      requiredSetIds: [10],
      characteristics: ['slopey'],
      frames: 'p900r15',
      updatedAt: '2026-05-02T09:30:00Z',
    });

    await insertStat({
      climbUuid: 'c1',
      angle: 40,
      displayDifficulty: 21.5,
      ascensionistCount: 1234,
      qualityAverage: 4.6,
      faUsername: 'setterfa',
      faAt: '2023-01-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    });
    await insertStat({
      climbUuid: 'c1',
      angle: 50,
      displayDifficulty: 24.0,
      ascensionistCount: 88,
      qualityAverage: null,
      faUsername: null,
      faAt: null,
      updatedAt: '2026-05-01T00:00:30Z',
    });
    await insertStat({
      climbUuid: 'c2',
      angle: 40,
      displayDifficulty: null,
      ascensionistCount: null,
      updatedAt: '2026-05-01T00:00:02Z',
    });
    // c3 deliberately has no stats — the stats table must still round-trip cleanly.

    // --- Path A: export core → SQLite artifact ---
    const filePath = join(workDir, 'artifact.db');
    await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });
    const artifactClimbs = readArtifactRows(filePath, 'board_climbs', CLIMB_COLUMNS);
    const artifactStats = readArtifactRows(filePath, 'board_climb_stats', STATS_COLUMNS);

    // --- Path B: real resolvers → real client upsert ---
    const clientDb = createTestDatabase();
    await runMigrations(clientDb);
    await pullSync(clientDb, noopQueryClient(), graphqlFetch, { enabledBoards: [SCOPE_KEY] });
    const pulledClimbs = await clientDb.getAllAsync<Record<string, unknown>>(
      `SELECT ${CLIMB_COLUMNS.join(', ')} FROM board_climbs ORDER BY uuid`,
    );
    const pulledStats = await clientDb.getAllAsync<Record<string, unknown>>(
      `SELECT ${STATS_COLUMNS.join(', ')} FROM board_climb_stats ORDER BY climb_uuid, angle`,
    );

    // The export and the live pull must agree exactly.
    expect(artifactClimbs).toEqual(pulledClimbs);
    expect(artifactStats).toEqual(pulledStats);

    // Sanity: they actually carry the seeded data (not both empty).
    expect(artifactClimbs.map((row) => row.uuid)).toEqual(['c1', 'c2', 'c3']);
    expect(artifactStats).toHaveLength(3);
    // Spot-check the tricky coercions landed as the manifest dictates.
    const c1 = artifactClimbs.find((row) => row.uuid === 'c1')!;
    expect(c1.is_draft).toBe(0);
    expect(c1.is_listed).toBe(1);
    expect(c1.compatible_size_ids).toBe(JSON.stringify([5, 6]));
    expect(c1.characteristics).toBe(JSON.stringify(['crimpy', 'powerful']));
    expect(c1.updated_at).toBe('2026-05-01T00:00:00Z');
    const c2 = artifactClimbs.find((row) => row.uuid === 'c2')!;
    expect(c2.characteristics).toBeNull();
    expect(c2.updated_at).toBe('2026-05-01T00:00:01.5Z');
  });

  it('records snapshot_meta watermarks equal to the max keyset cursor of the exported rows', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    await insertClimb({ uuid: 'c2', compatibleSizeIds: [5], updatedAt: '2026-05-02T09:30:00Z' });
    await insertStat({ climbUuid: 'c1', angle: 40, updatedAt: '2026-05-01T00:00:00Z' });
    await insertStat({ climbUuid: 'c2', angle: 40, updatedAt: '2026-05-03T00:00:00Z' });

    const filePath = join(workDir, 'artifact.db');
    await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });

    // Expected watermark = the greatest (updated_at, sync_seq) among the scoped rows.
    const climbWatermarkRow = (
      await db.execute(sql`
        SELECT updated_at, sync_seq FROM board_climbs
        WHERE board_type = ${BOARD_TYPE} AND layout_id = ${LAYOUT_ID}
        ORDER BY updated_at DESC, sync_seq DESC LIMIT 1
      `)
    )[0] as { updated_at: unknown; sync_seq: unknown };
    const statsWatermarkRow = (
      await db.execute(sql`
        SELECT s.updated_at, s.sync_seq FROM board_climb_stats s
        WHERE s.board_type = ${BOARD_TYPE}
          AND EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = s.climb_uuid AND bc.layout_id = ${LAYOUT_ID})
        ORDER BY s.updated_at DESC, s.sync_seq DESC LIMIT 1
      `)
    )[0] as { updated_at: unknown; sync_seq: unknown };

    const climbMeta = readArtifactMeta(filePath, 'board_climbs')!;
    expect(climbMeta.row_count).toBe(2);
    expect(climbMeta.watermark_updated_at).toBe(toIso(climbWatermarkRow.updated_at));
    expect(climbMeta.watermark_sync_seq).toBe(String(climbWatermarkRow.sync_seq));
    expect(climbMeta.schema_version).toBeGreaterThanOrEqual(1);
    expect(climbMeta.format_version).toBe(1);

    const statsMeta = readArtifactMeta(filePath, 'board_climb_stats')!;
    expect(statsMeta.row_count).toBe(2);
    expect(statsMeta.watermark_updated_at).toBe(toIso(statsWatermarkRow.updated_at));
    expect(statsMeta.watermark_sync_seq).toBe(String(statsWatermarkRow.sync_seq));
  });

  it('uses the authoritative run-wide stable_before as the deletion replay boundary', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    const stabilityWindowSeconds = 30;
    const beforeRow = (
      await db.execute(sql`
        SELECT
          clock_timestamp() AS built_at,
          clock_timestamp() - (${stabilityWindowSeconds} * INTERVAL '1 second') AS stable_before
      `)
    )[0] as { built_at: unknown; stable_before: unknown };
    const artifactBuiltAt = toIso(beforeRow.built_at);
    const stableBefore = toIso(beforeRow.stable_before);

    const filePath = join(workDir, 'artifact-deletion-replay.db');
    await exportLayoutSnapshot({
      sqlClient: createPool(),
      deletionObserverConnectionAvailable: true,
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      builtAt: artifactBuiltAt,
      stableBefore,
    });

    const deletionMeta = readArtifactMeta(filePath, 'sync_deletions')!;
    expect(Date.parse(String(deletionMeta.watermark_updated_at))).toBe(Date.parse(stableBefore));
    expect(deletionMeta).toMatchObject({
      table_name: 'sync_deletions',
      watermark_sync_seq: '0',
      row_count: 0,
      built_at: artifactBuiltAt,
      schema_version: expect.any(Number),
      format_version: 1,
    });
  });

  it('excludes a row inside the stability window from both the artifact and its watermark', async () => {
    // Old rows are well outside any window; the recent row is inside a 30s window.
    await insertClimb({ uuid: 'old-1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    await insertClimb({ uuid: 'old-2', compatibleSizeIds: [5], updatedAt: '2026-05-02T00:00:00Z' });
    // updated_at = now() → inside a 30s stability window.
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, updated_at)
      VALUES ('recent', ${BOARD_TYPE}, ${LAYOUT_ID}, '{5}'::int[], now())
    `);

    const filePath = join(workDir, 'artifact.db');
    await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      builtAt: BUILT_AT,
      stableBefore: await primaryStableBefore(30),
    });

    const artifactClimbs = readArtifactRows(filePath, 'board_climbs', ['uuid']);
    const uuids = artifactClimbs.map((row) => row.uuid);
    expect(uuids).toEqual(['old-1', 'old-2']); // 'recent' excluded
    expect(uuids).not.toContain('recent');

    // The watermark stops at the newest STABLE row, never covering the excluded one.
    const stableWatermarkRow = (
      await db.execute(sql`
        SELECT sync_seq FROM board_climbs
        WHERE board_type = ${BOARD_TYPE} AND layout_id = ${LAYOUT_ID} AND uuid = 'old-2'
      `)
    )[0] as { sync_seq: unknown };
    const recentRow = (await db.execute(sql`SELECT sync_seq FROM board_climbs WHERE uuid = 'recent'`))[0] as {
      sync_seq: unknown;
    };

    const climbMeta = readArtifactMeta(filePath, 'board_climbs')!;
    expect(climbMeta.row_count).toBe(2);
    expect(climbMeta.watermark_sync_seq).toBe(String(stableWatermarkRow.sync_seq));
    expect(Number(climbMeta.watermark_sync_seq)).toBeLessThan(Number(recentRow.sync_seq));
  });
});

// The SEPARATE per-layout grades artifact (issue #4310). Boardsesh grades are
// the one per-board table the whole-layout artifact never carried, so every
// Kilter/Tension download paid hundreds of serial authenticated GraphQL pages
// for them — which is why a MoonBoard layout of the same byte size finishes
// roughly six times faster.
describe('board_climb_grades snapshot artifact', () => {
  it('produces byte-identical grade rows via the export core and the real syncClimbGrades pull', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    await insertClimb({ uuid: 'c2', compatibleSizeIds: [5, 7], updatedAt: '2026-05-01T00:00:00Z' });
    await insertGrade({
      climbUuid: 'c1',
      angle: 40,
      localGrade: 21.5,
      universalGrade: 19.25,
      gradeLow: 20,
      gradeHigh: 23,
      confidence: 'high',
      ascensionistCount: 1234,
      computedAt: '2026-05-01T00:00:00Z',
    });
    await insertGrade({
      climbUuid: 'c1',
      angle: 50,
      localGrade: null,
      universalGrade: null,
      confidence: 'low',
      ascensionistCount: 0,
      computedAt: '2026-05-01T00:00:01.5Z', // fractional seconds
    });
    await insertGrade({ climbUuid: 'c2', angle: 40, localGrade: 15, computedAt: '2026-05-02T09:30:00Z' });

    const filePath = join(workDir, 'artifact.db');
    const gradesFilePath = join(workDir, 'artifact-grades.db');
    await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      gradesFilePath,
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });
    const artifactGrades = readArtifactRows(gradesFilePath, 'board_climb_grades', GRADES_COLUMNS);

    const clientDb = createTestDatabase();
    await runMigrations(clientDb);
    await pullSync(clientDb, noopQueryClient(), graphqlFetch, { enabledBoards: [SCOPE_KEY] });
    const pulledGrades = await clientDb.getAllAsync<Record<string, unknown>>(
      `SELECT ${GRADES_COLUMNS.join(', ')} FROM board_climb_grades ORDER BY climb_uuid, angle`,
    );

    expect(artifactGrades).toEqual(pulledGrades);
    expect(artifactGrades).toHaveLength(3);
  });

  it('adds deletion replay metadata without changing the whole-layout data tables', async () => {
    // Every already-shipped binary queries its two required snapshot_meta rows
    // by name rather than requiring an exact row count. The metadata-only
    // sync_deletions row is therefore ignored by old clients, while the file's
    // actual board data tables remain byte-compatible.
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    await insertGrade({ climbUuid: 'c1', angle: 40, localGrade: 20, computedAt: '2026-05-01T00:00:00Z' });

    const filePath = join(workDir, 'artifact.db');
    await exportLayoutSnapshot({
      sqlClient: createPool(),
      deletionObserverConnectionAvailable: true,
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      gradesFilePath: join(workDir, 'artifact-grades.db'),
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });

    expect(readArtifactMetaTableNames(filePath)).toEqual(['board_climb_stats', 'board_climbs', 'sync_deletions']);
    expect(readArtifactTableNames(filePath)).not.toContain('board_climb_grades');
    expect(readArtifactTableNames(filePath)).not.toContain('sync_deletions');
  });

  it('fails closed without inspecting private pool options when observer capacity is not declared', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });

    const primaryPool = createPool();
    const clientWithoutPublicCapacityMetadata = new Proxy(primaryPool, {
      get(target, property) {
        if (property === 'options') throw new Error('private postgres.js options must not be inspected');
        return Reflect.get(target, property, target);
      },
    });
    const filePath = join(workDir, 'observer-fallback-artifact.db');
    const result = await exportLayoutSnapshot({
      sqlClient: clientWithoutPublicCapacityMetadata,
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });

    expect(result.deletionsReplayFrom).toBeNull();
    expect(result.deletionsReplayFallbackReason).toBe('observer-pool-capacity');
    expect(readArtifactMetaTableNames(filePath)).toEqual(['board_climb_stats', 'board_climbs']);
  });

  it('uses a primary-fenced cutoff without requiring a second reader connection', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });

    const primaryPool = createPool();
    const stableBefore = '2026-05-31T23:59:30.000Z';
    const filePath = join(workDir, 'fenced-boundary-artifact.db');
    const result = await exportLayoutSnapshot({
      sqlClient: primaryPool,
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      builtAt: BUILT_AT,
      stableBefore,
      stableBeforeIncludesActiveTransactions: true,
    });

    expect(result.deletionsReplayFrom).toBe(stableBefore);
    expect(result.deletionsReplayFallbackReason).toBeNull();
    expect(readArtifactMetaTableNames(filePath)).toEqual(['board_climb_stats', 'board_climbs', 'sync_deletions']);

    const builtAtFirstFilePath = join(workDir, 'fenced-built-at-boundary-artifact.db');
    const builtAtFirstResult = await exportLayoutSnapshot({
      sqlClient: primaryPool,
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath: builtAtFirstFilePath,
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
      stableBeforeIncludesActiveTransactions: true,
    });
    expect(builtAtFirstResult.deletionsReplayFrom).toBe(BUILT_AT);
  });

  it('carries ONLY board_climb_grades and its own one-row snapshot_meta', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    await insertGrade({ climbUuid: 'c1', angle: 40, localGrade: 20, computedAt: '2026-05-01T00:00:00Z' });

    const gradesFilePath = join(workDir, 'artifact-grades.db');
    await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath: join(workDir, 'artifact.db'),
      gradesFilePath,
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });

    const tables = readArtifactTableNames(gradesFilePath);
    expect(tables).toContain('board_climb_grades');
    expect(tables).not.toContain('board_climbs');
    expect(tables).not.toContain('board_climb_stats');
    expect(readArtifactMetaTableNames(gradesFilePath)).toEqual(['board_climb_grades']);
  });

  it('cursors the grades watermark on computed_at, not updated_at (the column grades do not have)', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    await insertGrade({ climbUuid: 'c1', angle: 40, localGrade: 20, computedAt: '2026-05-01T00:00:00Z' });
    await insertGrade({ climbUuid: 'c1', angle: 50, localGrade: 22, computedAt: '2026-05-04T00:00:00Z' });

    const gradesFilePath = join(workDir, 'artifact-grades.db');
    const result = await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath: join(workDir, 'artifact.db'),
      gradesFilePath,
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });

    const latest = (
      await db.execute(sql`
        SELECT computed_at, sync_seq FROM board_climb_grades
        WHERE board_type = ${BOARD_TYPE}
        ORDER BY computed_at DESC, sync_seq DESC LIMIT 1
      `)
    )[0] as { computed_at: unknown; sync_seq: unknown };

    const meta = readArtifactMeta(gradesFilePath, 'board_climb_grades')!;
    expect(meta.row_count).toBe(2);
    expect(meta.watermark_updated_at).toBe(toIso(latest.computed_at));
    expect(meta.watermark_sync_seq).toBe(String(latest.sync_seq));
    expect(result.grades?.tables.board_climb_grades.rowCount).toBe(2);
  });

  it('excludes a grade inside the stability window from the artifact AND its watermark', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    await insertGrade({ climbUuid: 'c1', angle: 40, localGrade: 20, computedAt: '2026-05-01T00:00:00Z' });
    await db.execute(sql`
      INSERT INTO board_climb_grades
        (board_type, climb_uuid, angle, local_grade, confidence, model_version, coeff_version, computed_at)
      VALUES (${BOARD_TYPE}, 'c1', 50, 22, 'low', 'test-model', 'test-coeff', now())
    `);

    const gradesFilePath = join(workDir, 'artifact-grades.db');
    await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath: join(workDir, 'artifact.db'),
      gradesFilePath,
      builtAt: BUILT_AT,
      stableBefore: await primaryStableBefore(30),
    });

    const angles = readArtifactRows(gradesFilePath, 'board_climb_grades', ['angle']).map((row) => row.angle);
    expect(angles).toEqual([40]);
    const meta = readArtifactMeta(gradesFilePath, 'board_climb_grades')!;
    expect(meta.row_count).toBe(1);
  });

  it('scopes grades to the layout’s climbs — a grade for another layout never lands', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids, updated_at)
      VALUES ('other-layout', ${BOARD_TYPE}, 99, '{5}'::int[], '2026-05-01T00:00:00Z'::timestamp)
    `);
    await insertGrade({ climbUuid: 'c1', angle: 40, localGrade: 20, computedAt: '2026-05-01T00:00:00Z' });
    await insertGrade({ climbUuid: 'other-layout', angle: 40, localGrade: 20, computedAt: '2026-05-01T00:00:00Z' });

    const gradesFilePath = join(workDir, 'artifact-grades.db');
    await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath: join(workDir, 'artifact.db'),
      gradesFilePath,
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });

    const uuids = readArtifactRows(gradesFilePath, 'board_climb_grades', ['climb_uuid']).map((row) => row.climb_uuid);
    expect(uuids).toEqual(['c1']);
  });

  it('publishes NO grades result for a layout with zero grade rows (every MoonBoard layout)', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });

    const result = await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath: join(workDir, 'artifact.db'),
      gradesFilePath: join(workDir, 'artifact-grades.db'),
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });

    expect(result.grades).toBeUndefined();
  });

  it('omits grades entirely when no gradesFilePath is requested (the identity rollback pass)', async () => {
    await insertClimb({ uuid: 'c1', compatibleSizeIds: [5], updatedAt: '2026-05-01T00:00:00Z' });
    await insertGrade({ climbUuid: 'c1', angle: 40, localGrade: 20, computedAt: '2026-05-01T00:00:00Z' });

    const result = await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath: join(workDir, 'artifact.db'),
      builtAt: BUILT_AT,
      stableBefore: INCLUDE_ALL_STABLE_BEFORE,
    });

    expect(result.grades).toBeUndefined();
  });
});
