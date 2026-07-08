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
import { createReadPool } from '@boardsesh/db/client';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { toIso } from '../graphql/resolvers/sync/row-normalize';
import { exportLayoutSnapshot } from '../scripts/export-board-snapshots';

const USER_ID = 'snapshot-export-user';
const BOARD_TYPE = 'kilter';
const LAYOUT_ID = 1;
const SIZE_ID = 5;
const SCOPE_KEY = `${BOARD_TYPE}:${LAYOUT_ID}:${SIZE_ID}`;
const BUILT_AT = '2026-06-01T00:00:00.000Z';

const CLIMB_COLUMNS = TABLE_CONFIGS.board_climbs.localColumns;
const STATS_COLUMNS = TABLE_CONFIGS.board_climb_stats.localColumns;

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
  await db.execute(sql`
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
  await db.execute(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, display_difficulty, ascensionist_count,
       quality_average, fa_username, fa_at, updated_at)
    VALUES
      (${BOARD_TYPE}, ${values.climbUuid}, ${values.angle}, ${values.displayDifficulty ?? null},
       ${values.ascensionistCount ?? null}, ${values.qualityAverage ?? null},
       ${values.faUsername ?? null}, ${values.faAt ?? null}, ${values.updatedAt}::timestamp)
  `);
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
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats RESTART IDENTITY CASCADE`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('board-snapshot export ↔ live pull parity', () => {
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
      sqlClient: createReadPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      builtAt: BUILT_AT,
      stabilityWindowSeconds: 0, // match the resolvers' test window so row sets align
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
      sqlClient: createReadPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      builtAt: BUILT_AT,
      stabilityWindowSeconds: 0,
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
      sqlClient: createReadPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      builtAt: BUILT_AT,
      stabilityWindowSeconds: 30,
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
