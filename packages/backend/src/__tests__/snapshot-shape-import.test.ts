// Does the client import, exactly as shipped, read a shape-2 artifact the way it
// reads a shape-1 one?
//
// Shape 2 (`WITHOUT ROWID`, no secondary index, vacuumed; see SnapshotArtifactShape
// in export-board-snapshots.ts) changes how an artifact is stored and nothing
// about what it holds. No app update goes with it, so the claim has to hold for
// the import code already in the field: `bootstrapScopeFromSnapshot` and
// `bootstrapScopeGradesFromSnapshot`, called here unmodified.
//
// Each case builds BOTH shapes from one seeded Postgres with the real export
// core, runs the real import on each into its own client database, and requires
// the two outcomes to be identical: every row of all three tables, the returned
// watermarks and row counts, and every `sync_meta` row the import stamped. Then
// it checks that outcome against hand-written expectations, so "identical"
// cannot mean "identically empty".
//
// What the import relies on in an attached artifact, all of it shape-neutral:
// `PRAGMA quick_check`, `pragma_table_info`, `COUNT(*)`, `snapshot_meta` by
// table name, a scan of `board_climbs`, and a primary-key range seek on
// `board_climb_stats`. Its one `rowid` is on its own TEMP staging table, never
// on the artifact, and it names no index.
//
// FILE-BACKED client databases, like snapshot-import-batching.test.ts and for
// its reason: the device runs an exclusive transaction on a separate
// connection, and ATTACH is per connection. The in-memory double hides that.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapScopeFromSnapshot,
  bootstrapScopeGradesFromSnapshot,
  configureMainConnection,
  ensureMutationQueueTable,
  MIGRATIONS,
  runMigrations,
  type OfflineBoardScope,
  type SyncCheckpoint,
} from '@boardsesh/offline-sync';
import { createTestDatabase, __resetDrainerStateForTests, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { createPool } from '@boardsesh/db/client';
import { db } from '../db/client';
import { exportLayoutSnapshot, type SnapshotArtifactShape } from '../scripts/export-board-snapshots';

const BUILT_AT = '2026-06-01T00:00:00.000Z';
const DELETIONS_CHECKPOINT_KEY = 'checkpoint:deletions';

// Small enough that the fixture below spans many import transactions: the climbs
// import walks its staging table in rowid ranges and the stats import walks the
// artifact's primary key in keyset pages, and both have to cross a boundary to
// be tested at all.
const IMPORT_BATCH_ROWS = 7;

const KILTER_SIZE_10: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 10 };
const KILTER_SIZE_7: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 7 };
// MoonBoard is the board that is NOT size-scoped: the scope is the whole layout
// and the import's `json_each` size membership check is never built.
const MOONBOARD_LAYOUT: OfflineBoardScope = { boardType: 'moonboard', layoutId: 2, sizeId: 1 };

const scopeKeyOf = (scope: OfflineBoardScope): string => `${scope.boardType}:${scope.layoutId}:${scope.sizeId}`;

// --- Postgres fixture ---------------------------------------------------------

/**
 * One group of climbs with two stats rows and one grade row each. Uuids are
 * md5 hashes, so key order is unrelated to the order rows are inserted and
 * streamed in: a shape-1 artifact holds them in arrival order and a shape-2
 * one in key order, which is the difference under test.
 *
 * `startsAt` spaces the groups out in time, so each scope has its own
 * watermark and a scoped watermark differs from the artifact-wide one.
 */
async function seedClimbGroup(group: {
  boardType: string;
  layoutId: number;
  uuidPrefix: string;
  climbCount: number;
  compatibleSizeIds: number[] | null;
  startsAt: string;
}): Promise<void> {
  const sizes = group.compatibleSizeIds === null ? null : `{${group.compatibleSizeIds.join(',')}}`;
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, frames, is_draft, is_listed, compatible_size_ids, updated_at)
    SELECT md5(${group.uuidPrefix} || climb_number), ${group.boardType}, ${group.layoutId},
           ${group.uuidPrefix} || climb_number, 'p1145r12p1146r13', false, true, ${sizes}::int[],
           ${group.startsAt}::timestamp + climb_number * interval '1 second'
    FROM generate_series(1, ${group.climbCount}) AS climb_number
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, quality_average, updated_at)
    SELECT ${group.boardType}, md5(${group.uuidPrefix} || climb_number), stat_angle, 18 + (climb_number % 9),
           climb_number, 2.5,
           ${group.startsAt}::timestamp + interval '1 hour' + (climb_number * 2 + stat_angle) * interval '1 second'
    FROM generate_series(1, ${group.climbCount}) AS climb_number
    CROSS JOIN (VALUES (40), (45)) AS angles(stat_angle)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence,
       ascensionist_count, model_version, coeff_version, computed_at)
    SELECT ${group.boardType}, md5(${group.uuidPrefix} || climb_number), 40, 20.5, 19.25, 19, 22, 'high',
           climb_number, 'test-model', 'test-coeff',
           ${group.startsAt}::timestamp + interval '2 hours' + climb_number * interval '1 second'
    FROM generate_series(1, ${group.climbCount}) AS climb_number
  `);
}

const KILTER_ONLY_10 = 40;
const KILTER_BOTH_SIZES = 12;
const KILTER_ONLY_7 = 25;
const KILTER_NO_SIZES = 5;
const MOONBOARD_CLIMBS = 45;

async function seedCatalog(): Promise<void> {
  // Size 10 only, then climbs on both sizes, then size 7 only, LAST in time: the
  // artifact's own watermark belongs to a climb outside the size-10 scope.
  await seedClimbGroup({
    boardType: 'kilter',
    layoutId: 1,
    uuidPrefix: 'k10-',
    climbCount: KILTER_ONLY_10,
    compatibleSizeIds: [10, 11],
    startsAt: '2026-05-01T00:00:00Z',
  });
  await seedClimbGroup({
    boardType: 'kilter',
    layoutId: 1,
    uuidPrefix: 'k7and10-',
    climbCount: KILTER_BOTH_SIZES,
    compatibleSizeIds: [7, 10],
    startsAt: '2026-05-02T00:00:00Z',
  });
  await seedClimbGroup({
    boardType: 'kilter',
    layoutId: 1,
    uuidPrefix: 'k7-',
    climbCount: KILTER_ONLY_7,
    compatibleSizeIds: [7],
    startsAt: '2026-05-03T00:00:00Z',
  });
  // NULL sizes: in the artifact, in no size scope, exactly as Postgres
  // `NULL @> ARRAY[x]` excludes them.
  await seedClimbGroup({
    boardType: 'kilter',
    layoutId: 1,
    uuidPrefix: 'knull-',
    climbCount: KILTER_NO_SIZES,
    compatibleSizeIds: null,
    startsAt: '2026-05-04T00:00:00Z',
  });
  // Another layout of the same board. Its stats and grades share the
  // `board_type` partition the layout-1 artifact is cut from.
  await seedClimbGroup({
    boardType: 'kilter',
    layoutId: 2,
    uuidPrefix: 'kother-',
    climbCount: 8,
    compatibleSizeIds: [10],
    startsAt: '2026-05-05T00:00:00Z',
  });
  await seedClimbGroup({
    boardType: 'moonboard',
    layoutId: 2,
    uuidPrefix: 'mb-',
    climbCount: MOONBOARD_CLIMBS,
    compatibleSizeIds: null,
    startsAt: '2026-05-06T00:00:00Z',
  });
}

// --- Artifacts ----------------------------------------------------------------

type LayoutArtifacts = { filePath: string; gradesFilePath: string; deletionsReplayFrom: string };

let workDir: string;
let openedDatabases: TestSqliteDb[] = [];

async function exportLayout(
  boardType: string,
  layoutId: number,
  artifactShape: SnapshotArtifactShape,
): Promise<LayoutArtifacts> {
  const filePath = join(workDir, `${boardType}-${layoutId}-shape${artifactShape}.db`);
  const gradesFilePath = join(workDir, `${boardType}-${layoutId}-shape${artifactShape}-grades.db`);
  const result = await exportLayoutSnapshot({
    sqlClient: createPool(),
    boardType,
    layoutId,
    filePath,
    gradesFilePath,
    builtAt: BUILT_AT,
    stabilityWindowSeconds: 0,
    artifactShape,
  });
  if (!result.grades || result.deletionsReplayFrom === null) {
    throw new Error(`fixture export for ${boardType}:${layoutId} produced no grades file or no replay boundary`);
  }
  // Each case asserts on which shape it imported, so a regression in the
  // switch cannot turn this suite into "shape 1 equals shape 1".
  const artifactDb = new DatabaseSync(filePath, { readOnly: true });
  try {
    const climbsTable = artifactDb
      .prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = 'board_climbs'")
      .get() as { wr: number };
    expect(climbsTable.wr === 1).toBe(artifactShape === 2);
  } finally {
    artifactDb.close();
  }
  return { filePath, gradesFilePath, deletionsReplayFrom: result.deletionsReplayFrom };
}

// --- Client side --------------------------------------------------------------

async function freshClientDb(name: string): Promise<TestSqliteDb> {
  const clientDb = createTestDatabase(join(workDir, `client-${name}.db`));
  openedDatabases.push(clientDb);
  await configureMainConnection(clientDb);
  await runMigrations(clientDb);
  await ensureMutationQueueTable(clientDb);
  return clientDb;
}

type ImportOutcome = {
  layout: {
    climbsWatermark: SyncCheckpoint;
    statsWatermark: SyncCheckpoint;
    climbsImported: number;
    statsImported: number;
    importBatches: number;
  };
  grades: { gradesWatermark: SyncCheckpoint; rowsImported: number };
};

/** The shipped layout import followed by the shipped grades import, as `runBootstrapPhase` orders them. */
async function importScope(
  clientDb: TestSqliteDb,
  scope: OfflineBoardScope,
  artifacts: LayoutArtifacts,
  existingCheckpoints?: Parameters<typeof bootstrapScopeFromSnapshot>[0]['existingCheckpoints'],
): Promise<ImportOutcome> {
  const layout = await bootstrapScopeFromSnapshot({
    db: clientDb,
    scope,
    scopeKey: scopeKeyOf(scope),
    filePath: artifacts.filePath,
    batchRows: IMPORT_BATCH_ROWS,
    ...(existingCheckpoints ? { existingCheckpoints } : {}),
  });
  const grades = await bootstrapScopeGradesFromSnapshot({
    db: clientDb,
    scope,
    scopeKey: scopeKeyOf(scope),
    filePath: artifacts.gradesFilePath,
  });
  // The timing fields (importVerifyMs and friends) are wall-clock and are the
  // only part of either result that may differ between two runs.
  return {
    layout: {
      climbsWatermark: layout.climbsWatermark,
      statsWatermark: layout.statsWatermark,
      climbsImported: layout.climbsImported,
      statsImported: layout.statsImported,
      importBatches: layout.importBatches,
    },
    grades: { gradesWatermark: grades.gradesWatermark, rowsImported: grades.rowsImported },
  };
}

type ClientState = {
  climbs: Record<string, unknown>[];
  stats: Record<string, unknown>[];
  grades: Record<string, unknown>[];
  /** Every `sync_meta` row but the deletions cursor, which is checked on its own. */
  syncMeta: Record<string, string>;
  deletionsCheckpoint: SyncCheckpoint | null;
};

async function readClientState(clientDb: TestSqliteDb): Promise<ClientState> {
  const metaRows = await clientDb.getAllAsync<{ key: string; value: string }>(
    'SELECT key, value FROM sync_meta ORDER BY key',
  );
  const deletionsRow = metaRows.find((row) => row.key === DELETIONS_CHECKPOINT_KEY);
  return {
    climbs: await clientDb.getAllAsync<Record<string, unknown>>('SELECT * FROM board_climbs ORDER BY uuid'),
    stats: await clientDb.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM board_climb_stats ORDER BY board_type, climb_uuid, angle',
    ),
    grades: await clientDb.getAllAsync<Record<string, unknown>>(
      'SELECT * FROM board_climb_grades ORDER BY board_type, climb_uuid, angle',
    ),
    syncMeta: Object.fromEntries(
      metaRows.filter((row) => row.key !== DELETIONS_CHECKPOINT_KEY).map((row) => [row.key, row.value]),
    ),
    deletionsCheckpoint: deletionsRow ? (JSON.parse(deletionsRow.value) as SyncCheckpoint) : null,
  };
}

/** The newest `(updated_at, sync_seq)` among rows Postgres holds for a set of climbs, as the client stamps it. */
async function expectedWatermark(
  table: 'board_climbs' | 'board_climb_stats' | 'board_climb_grades',
  boardType: string,
  uuidPrefixes: string[],
): Promise<SyncCheckpoint> {
  const cursorColumn = table === 'board_climb_grades' ? sql`computed_at` : sql`updated_at`;
  const uuidColumn = table === 'board_climbs' ? sql`uuid` : sql`climb_uuid`;
  // The export renders a timestamp through toIso; to_char in the same shape
  // (seconds only, every fixture timestamp is whole) keeps this independent of it.
  const rows = await db.execute(sql`
    SELECT to_char(${cursorColumn}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cursor_at, sync_seq::text AS sync_seq
    FROM ${sql.identifier(table)}
    WHERE board_type = ${boardType}
      AND ${uuidColumn} IN (
        SELECT uuid FROM board_climbs
        WHERE board_type = ${boardType}
          AND name ~ ${`^(${uuidPrefixes.join('|')})[0-9]+$`}
      )
    ORDER BY ${cursorColumn} DESC, sync_seq DESC
    LIMIT 1
  `);
  const newest = rows[0] as { cursor_at: string; sync_seq: string };
  return { updatedAt: newest.cursor_at, syncSeq: newest.sync_seq };
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'snapshot-shape-import-'));
  openedDatabases = [];
  __resetDrainerStateForTests();
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades RESTART IDENTITY CASCADE`);
  await seedCatalog();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetDrainerStateForTests();
  for (const clientDb of openedDatabases) {
    try {
      clientDb.close();
    } catch {
      // Already closed.
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('the shipped client import on a shape-2 artifact', () => {
  it('imports a size-scoped scope to the same rows, watermarks and checkpoints as shape 1', async () => {
    const outcomes: ImportOutcome[] = [];
    const states: ClientState[] = [];
    for (const artifactShape of [1, 2] as const) {
      const artifacts = await exportLayout('kilter', 1, artifactShape);
      const clientDb = await freshClientDb(`size-scoped-shape${artifactShape}`);
      outcomes.push(await importScope(clientDb, KILTER_SIZE_10, artifacts));
      states.push(await readClientState(clientDb));
    }
    const [shape1Outcome, shape2Outcome] = outcomes;
    const [shape1State, shape2State] = states;

    expect(shape2Outcome).toEqual(shape1Outcome);
    expect(shape2State).toEqual(shape1State);

    // And it is the right outcome. Size 10 is the size-10-only climbs plus the
    // climbs on both sizes: not size 7, not the NULL-size climbs, not layout 2.
    const scopedClimbs = KILTER_ONLY_10 + KILTER_BOTH_SIZES;
    expect(shape2Outcome.layout.climbsImported).toBe(scopedClimbs);
    expect(shape2Outcome.layout.statsImported).toBe(scopedClimbs * 2);
    expect(shape2Outcome.grades.rowsImported).toBe(scopedClimbs);
    expect(shape2State.climbs).toHaveLength(scopedClimbs);
    expect(shape2State.stats).toHaveLength(scopedClimbs * 2);
    expect(shape2State.grades).toHaveLength(scopedClimbs);
    const importedNames = shape2State.climbs.map((climb) => String(climb.name));
    expect(importedNames.every((name) => /^(k10-|k7and10-)\d+$/.test(name))).toBe(true);
    // Many transactions, not one: both batch walks crossed boundaries.
    expect(shape2Outcome.layout.importBatches).toBeGreaterThan(10);

    // Watermarks are the SCOPE's, read from the artifact rows the import
    // selected. The artifact's own newest climb is a size-7 one, later in time.
    expect(shape2Outcome.layout.climbsWatermark).toEqual(
      await expectedWatermark('board_climbs', 'kilter', ['k10-', 'k7and10-']),
    );
    expect(shape2Outcome.layout.statsWatermark).toEqual(
      await expectedWatermark('board_climb_stats', 'kilter', ['k10-', 'k7and10-']),
    );
    expect(shape2Outcome.grades.gradesWatermark).toEqual(
      await expectedWatermark('board_climb_grades', 'kilter', ['k10-', 'k7and10-']),
    );
    const artifactWideWatermark = await expectedWatermark('board_climbs', 'kilter', ['k7-', 'knull-']);
    expect(shape2Outcome.layout.climbsWatermark.updatedAt < artifactWideWatermark.updatedAt).toBe(true);

    // The checkpoints a later delta pull resumes from are those watermarks.
    const scopeKey = scopeKeyOf(KILTER_SIZE_10);
    expect(JSON.parse(shape2State.syncMeta[`checkpoint:board_climbs:${scopeKey}`])).toEqual(
      shape2Outcome.layout.climbsWatermark,
    );
    expect(JSON.parse(shape2State.syncMeta[`checkpoint:board_climb_stats:${scopeKey}`])).toEqual(
      shape2Outcome.layout.statsWatermark,
    );
    expect(JSON.parse(shape2State.syncMeta[`checkpoint:board_climb_grades:${scopeKey}`])).toEqual(
      shape2Outcome.grades.gradesWatermark,
    );
  });

  it('imports a whole layout (a board that is not size-scoped) to the same outcome as shape 1', async () => {
    const outcomes: ImportOutcome[] = [];
    const states: ClientState[] = [];
    for (const artifactShape of [1, 2] as const) {
      const artifacts = await exportLayout('moonboard', 2, artifactShape);
      const clientDb = await freshClientDb(`full-layout-shape${artifactShape}`);
      outcomes.push(await importScope(clientDb, MOONBOARD_LAYOUT, artifacts));
      states.push(await readClientState(clientDb));
    }
    const [shape1Outcome, shape2Outcome] = outcomes;
    const [shape1State, shape2State] = states;

    expect(shape2Outcome).toEqual(shape1Outcome);
    expect(shape2State).toEqual(shape1State);

    // Every climb of the layout, NULL `compatible_size_ids` and all.
    expect(shape2Outcome.layout.climbsImported).toBe(MOONBOARD_CLIMBS);
    expect(shape2Outcome.layout.statsImported).toBe(MOONBOARD_CLIMBS * 2);
    expect(shape2Outcome.grades.rowsImported).toBe(MOONBOARD_CLIMBS);
    expect(shape2State.climbs).toHaveLength(MOONBOARD_CLIMBS);
    // With no size filter the scope's watermark IS the artifact's.
    expect(shape2Outcome.layout.climbsWatermark).toEqual(await expectedWatermark('board_climbs', 'moonboard', ['mb-']));
    expect(shape2Outcome.layout.statsWatermark).toEqual(
      await expectedWatermark('board_climb_stats', 'moonboard', ['mb-']),
    );
    expect(shape2Outcome.grades.gradesWatermark).toEqual(
      await expectedWatermark('board_climb_grades', 'moonboard', ['mb-']),
    );
  });

  it('reconciles a partly crawled scope to the same outcome as shape 1', async () => {
    // The heal-over-partial path. Local rows the artifact does not have are
    // deleted when they are in scope and at or before the watermark, by two
    // DELETEs whose NOT EXISTS probes the attached artifact by primary key.
    const crawledTo: SyncCheckpoint = { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '1' };
    const farFuture: SyncCheckpoint = { updatedAt: '2030-01-01T00:00:00Z', syncSeq: '0' };
    const outcomes: ImportOutcome[] = [];
    const states: ClientState[] = [];
    const replayBoundaries: string[] = [];

    for (const artifactShape of [1, 2] as const) {
      const artifacts = await exportLayout('kilter', 1, artifactShape);
      const clientDb = await freshClientDb(`reconcile-shape${artifactShape}`);
      // An artifact climb the phone already holds, under a stale name.
      const artifactDb = new DatabaseSync(artifacts.filePath, { readOnly: true });
      const knownClimb = artifactDb.prepare("SELECT uuid FROM board_climbs WHERE name = 'k10-1'").get() as {
        uuid: string;
      };
      artifactDb.close();

      const insertLocalClimb = (uuid: string, name: string, sizes: string, updatedAt: string): Promise<unknown> =>
        clientDb.runAsync(
          `INSERT INTO board_climbs (uuid, board_type, layout_id, name, compatible_size_ids, updated_at, sync_seq)
           VALUES (?, 'kilter', 1, ?, ?, ?, 1)`,
          [uuid, name, sizes, updatedAt],
        );
      const insertLocalStat = (climbUuid: string, angle: number, updatedAt: string): Promise<unknown> =>
        clientDb.runAsync(
          `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, updated_at, sync_seq)
           VALUES ('kilter', ?, ?, 12, ?, 1)`,
          [climbUuid, angle, updatedAt],
        );
      // In scope, gone from the catalog, older than the watermark: deleted.
      await insertLocalClimb('local-withdrawn', 'withdrawn', '[10]', '2026-01-01T00:00:00Z');
      await insertLocalStat('local-withdrawn', 40, '2026-01-01T00:00:00Z');
      // In scope, absent from the artifact, but NEWER than it: the delta pull's to judge, kept.
      await insertLocalClimb('local-newer', 'newer than the artifact', '[10]', '2029-01-01T00:00:00Z');
      // Out of scope (another size): never this import's to delete.
      await insertLocalClimb('local-other-size', 'other size', '[7]', '2026-01-01T00:00:00Z');
      // In the artifact: replaced by the artifact's row.
      await insertLocalClimb(knownClimb.uuid, 'stale local name', '[10]', '2026-01-01T00:00:00Z');
      // A stats row for that climb at an angle the artifact does not have: deleted.
      await insertLocalStat(knownClimb.uuid, 99, '2026-01-01T00:00:00Z');
      await clientDb.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [
        DELETIONS_CHECKPOINT_KEY,
        JSON.stringify(farFuture),
      ]);

      outcomes.push(
        await importScope(clientDb, KILTER_SIZE_10, artifacts, {
          board_climbs: crawledTo,
          board_climb_stats: crawledTo,
        }),
      );
      states.push(await readClientState(clientDb));
      replayBoundaries.push(artifacts.deletionsReplayFrom);
    }
    const [shape1Outcome, shape2Outcome] = outcomes;
    const [shape1State, shape2State] = states;

    expect(shape2Outcome).toEqual(shape1Outcome);
    // The deletions cursor is rewound to each artifact's OWN replay boundary,
    // which is its export transaction's clock, so that one value is compared
    // against its artifact and everything else against the other shape.
    expect({ ...shape2State, deletionsCheckpoint: null }).toEqual({ ...shape1State, deletionsCheckpoint: null });
    for (const [index, state] of states.entries()) {
      expect(state.deletionsCheckpoint).toEqual({ updatedAt: replayBoundaries[index], syncSeq: '0' });
    }

    const climbNames = new Map(shape2State.climbs.map((climb) => [String(climb.uuid), String(climb.name)]));
    expect(climbNames.has('local-withdrawn')).toBe(false);
    expect(climbNames.get('local-newer')).toBe('newer than the artifact');
    expect(climbNames.get('local-other-size')).toBe('other size');
    expect([...climbNames.values()]).not.toContain('stale local name');
    expect([...climbNames.values()]).toContain('k10-1');
    const scopedClimbs = KILTER_ONLY_10 + KILTER_BOTH_SIZES;
    expect(shape2State.climbs).toHaveLength(scopedClimbs + 2);
    // Exactly the artifact's stats: the withdrawn climb's row and the angle-99 row are gone.
    expect(shape2State.stats).toHaveLength(scopedClimbs * 2);
    expect(shape2State.stats.some((stat) => stat.angle === 99 || stat.climb_uuid === 'local-withdrawn')).toBe(false);
  });

  it('adds a second size of the same layout to the same outcome as shape 1', async () => {
    // The second import of one artifact into one database: its reconcile and
    // its grades filter now meet the first size's rows, some of them shared.
    const outcomes: ImportOutcome[][] = [];
    const states: ClientState[] = [];
    for (const artifactShape of [1, 2] as const) {
      const artifacts = await exportLayout('kilter', 1, artifactShape);
      const clientDb = await freshClientDb(`second-size-shape${artifactShape}`);
      outcomes.push([
        await importScope(clientDb, KILTER_SIZE_10, artifacts),
        await importScope(clientDb, KILTER_SIZE_7, artifacts),
      ]);
      states.push(await readClientState(clientDb));
    }
    const [shape1Outcomes, shape2Outcomes] = outcomes;
    const [shape1State, shape2State] = states;

    expect(shape2Outcomes).toEqual(shape1Outcomes);
    expect(shape2State).toEqual(shape1State);

    const eitherSize = KILTER_ONLY_10 + KILTER_BOTH_SIZES + KILTER_ONLY_7;
    expect(shape2Outcomes[1].layout.climbsImported).toBe(KILTER_BOTH_SIZES + KILTER_ONLY_7);
    expect(shape2State.climbs).toHaveLength(eitherSize);
    expect(shape2State.stats).toHaveLength(eitherSize * 2);
    expect(shape2State.grades).toHaveLength(eitherSize);
    // Size 7 holds the artifact's newest climb, so its cursor is ahead of size 10's.
    expect(shape2Outcomes[1].layout.climbsWatermark).toEqual(
      await expectedWatermark('board_climbs', 'kilter', ['k7-', 'k7and10-']),
    );
    expect(
      shape2Outcomes[0].layout.climbsWatermark.updatedAt < shape2Outcomes[1].layout.climbsWatermark.updatedAt,
    ).toBe(true);
  });

  // Row sets cannot show this. The import pages through the artifact in ~150
  // batches on a Kilter layout, and each batch has to SEEK to its place. With
  // the secondary indexes gone, a batch that fell back to scanning would still
  // import the right rows, at about 150 times the reads, on the phone.
  it('reaches each batch by a primary-key seek on a shape-2 artifact, exactly as on shape 1', async () => {
    const plansByShape = new Map<SnapshotArtifactShape, { climbs: string; stats: string }>();
    for (const artifactShape of [1, 2] as const) {
      const artifacts = await exportLayout('kilter', 1, artifactShape);
      const clientDb = await freshClientDb(`plan-shape${artifactShape}`);
      const executedSql: string[] = [];
      const adapterPrototype = Object.getPrototypeOf(clientDb) as { runAsync: typeof clientDb.runAsync };
      const realRunAsync = adapterPrototype.runAsync;
      const spy = vi.spyOn(adapterPrototype, 'runAsync').mockImplementation(async function (
        this: unknown,
        source: string,
        ...rest: unknown[]
      ) {
        executedSql.push(source);
        return realRunAsync.call(this, source, ...(rest as never[]));
      } as typeof clientDb.runAsync);
      await importScope(clientDb, KILTER_SIZE_10, artifacts);
      spy.mockRestore();

      // The statements the import ACTUALLY ran, planned against this artifact.
      const climbsInsert = executedSql.find((source) => source.includes('INSERT OR REPLACE INTO main.board_climbs'));
      const statsInsert = executedSql.find((source) =>
        source.includes('INSERT OR REPLACE INTO main.board_climb_stats'),
      );
      if (!climbsInsert || !statsInsert) throw new Error('the import ran no batch insert');
      const planDb = new DatabaseSync(':memory:');
      try {
        for (const migration of MIGRATIONS) for (const statement of migration.statements) planDb.exec(statement);
        planDb.prepare('ATTACH DATABASE ? AS bs_snapshot').run(artifacts.filePath);
        planDb.exec('CREATE TEMP TABLE bs_import_climbs (uuid TEXT PRIMARY KEY)');
        const planOf = (statement: string): string => {
          const bindCount = statement.split('?').length - 1;
          const plan = planDb
            .prepare(`EXPLAIN QUERY PLAN ${statement}`)
            .all(...Array.from({ length: bindCount }, () => null)) as Array<{ detail: string }>;
          return plan.map((row) => row.detail).join(' | ');
        };
        plansByShape.set(artifactShape, { climbs: planOf(climbsInsert), stats: planOf(statsInsert) });
      } finally {
        planDb.close();
      }
    }

    for (const [artifactShape, plans] of plansByShape) {
      // Whitespace-tolerant, like the plan pin in snapshot-import-batching.test.ts.
      // Stats: a (climb_uuid, angle) range seek under the board_type equality.
      expect(plans.stats, `shape ${artifactShape}`).toMatch(/SEARCH s USING [A-Z_ a-z0-9]*\(\s*board_type\s*=\s*\?/);
      expect(plans.stats, `shape ${artifactShape}`).toMatch(/\(\s*climb_uuid\s*,\s*angle\s*\)\s*>/);
      // Climbs: one uuid lookup per staged row.
      expect(plans.climbs, `shape ${artifactShape}`).toMatch(/SEARCH c USING [A-Z_ a-z0-9]*\(\s*uuid\s*=\s*\?\s*\)/);
      // No full pass over an artifact table in either batch.
      expect(`${plans.climbs} | ${plans.stats}`, `shape ${artifactShape}`).not.toMatch(/SCAN [cs]\b/);
    }
    // And on shape 2 that seek is the table's own key: there is no index left to use.
    expect(plansByShape.get(2)?.stats).toContain('USING PRIMARY KEY');
    expect(plansByShape.get(2)?.climbs).toContain('USING PRIMARY KEY');
    expect(plansByShape.get(1)?.climbs).toContain('sqlite_autoindex_board_climbs_1');
  });
});
