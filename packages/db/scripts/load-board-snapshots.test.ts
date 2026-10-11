import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  booleanToPg,
  buildColumnPlans,
  castExpression,
  CATALOG_LOAD_ORDER,
  DEFERRED_CATALOG_TABLES,
  deriveHoldRows,
  encodeCopyField,
  encodeCopyRow,
  HOLD_COLUMN_PLANS,
  holdRowsForClimb,
  jsonArrayToPgArray,
  looksGzipCompressed,
  mapSqliteRows,
  parseArgs,
  readerFor,
  sqliteColumns,
  STATS_ACCOUNTING_PLANS,
  verifyArtifact,
  type PgColumn,
} from './load-board-snapshots.js';

const column = (name: string, formatType: string, dataType: string, udtName: string): PgColumn => ({
  name,
  formatType,
  dataType,
  udtName,
});

describe('COPY text encoding', () => {
  it('encodes NULL as the unquoted \\N sentinel', () => {
    assert.equal(encodeCopyField(null), '\\N');
  });

  it('leaves a plain value untouched', () => {
    assert.equal(encodeCopyField('crimpy traverse'), 'crimpy traverse');
  });

  // A climb name is user-generated: a literal backslash, a tab or a newline in
  // one would otherwise split the row and shift every later column by one.
  it('escapes the characters that would end a field or a row', () => {
    assert.equal(encodeCopyField('back\\slash'), 'back\\\\slash');
    assert.equal(encodeCopyField('two\tcolumns'), 'two\\tcolumns');
    assert.equal(encodeCopyField('line\nbreak'), 'line\\nbreak');
    assert.equal(encodeCopyField('carriage\rreturn'), 'carriage\\rreturn');
  });

  it('encodes a literal \\N so it cannot be read back as NULL', () => {
    assert.equal(encodeCopyField('\\N'), '\\\\N');
  });

  it('joins fields with tabs and terminates the row with a newline', () => {
    assert.equal(encodeCopyRow(['kilter', null, '40']), 'kilter\t\\N\t40\n');
  });
});

describe('jsonArrayToPgArray', () => {
  it('converts a JSON integer array to a Postgres array literal', () => {
    assert.equal(jsonArrayToPgArray('[1,2,3]', false), '{1,2,3}');
  });

  it('quotes text elements', () => {
    assert.equal(jsonArrayToPgArray('["crimpy","dyno"]', true), '{"crimpy","dyno"}');
  });

  it('escapes quotes and backslashes inside text elements', () => {
    // JSON ["a\"b"] holds the single element a"b, which must reach Postgres as
    // {"a\"b"} — an unescaped quote would terminate the array element early.
    assert.equal(jsonArrayToPgArray(String.raw`["a\"b"]`, true), String.raw`{"a\"b"}`);
    assert.equal(jsonArrayToPgArray(String.raw`["a\\b"]`, true), String.raw`{"a\\b"}`);
  });

  it('treats null and empty string as NULL', () => {
    assert.equal(jsonArrayToPgArray(null, false), null);
    assert.equal(jsonArrayToPgArray('', false), null);
  });

  it('produces an empty array literal for an empty JSON array', () => {
    assert.equal(jsonArrayToPgArray('[]', false), '{}');
  });

  // Silently dropping a malformed array column would ship a dev database whose
  // climbs cannot be filtered by set or size, with nothing in the build log.
  it('throws on a value that is not a JSON array', () => {
    assert.throws(() => jsonArrayToPgArray('not json', false), /expected a JSON array/);
    assert.throws(() => jsonArrayToPgArray('{"a":1}', false), /expected a JSON array/);
  });
});

describe('booleanToPg', () => {
  it('maps SQLite 0/1 to Postgres f/t', () => {
    assert.equal(booleanToPg(1), 't');
    assert.equal(booleanToPg(0), 'f');
    assert.equal(booleanToPg('1'), 't');
    assert.equal(booleanToPg('0'), 'f');
  });

  it('passes NULL through', () => {
    assert.equal(booleanToPg(null), null);
  });

  it('throws on anything else', () => {
    assert.throws(() => booleanToPg('maybe'), /expected a boolean/);
    assert.throws(() => booleanToPg(2), /expected a boolean/);
  });
});

describe('readerFor', () => {
  it('reads a boolean column through the boolean encoder', () => {
    const read = readerFor(column('is_listed', 'boolean', 'boolean', 'bool'));
    assert.equal(read({ is_listed: 1 }), 't');
  });

  it('reads an int array column unquoted', () => {
    const read = readerFor(column('required_set_ids', 'integer[]', 'ARRAY', '_int4'));
    assert.equal(read({ required_set_ids: '[1,2]' }), '{1,2}');
  });

  it('reads a text array column quoted', () => {
    const read = readerFor(column('characteristics', 'text[]', 'ARRAY', '_text'));
    assert.equal(read({ characteristics: '["crimpy"]' }), '{"crimpy"}');
  });

  it('stringifies a numeric column and passes NULL through', () => {
    const read = readerFor(column('angle', 'integer', 'integer', 'int4'));
    assert.equal(read({ angle: 40 }), '40');
    assert.equal(read({ angle: null }), null);
  });
});

describe('buildColumnPlans', () => {
  const pgCols = [
    column('uuid', 'text', 'text', 'text'),
    column('name', 'text', 'text', 'text'),
    column('user_id', 'text', 'text', 'text'),
    column('synced', 'boolean', 'boolean', 'bool'),
  ];

  // `user_id` is in the list despite being absent from the artifact because it
  // is forced-null; the shared-column rule and the forced-null rule are separate,
  // and both are asserted below.
  it('orders columns by the Postgres ordinal, not the artifact order', () => {
    const plans = buildColumnPlans(pgCols, ['name', 'uuid'], 'board_climbs');
    assert.deepEqual(
      plans.map((plan) => plan.name),
      ['uuid', 'name', 'user_id'],
    );
  });

  // `synced` exists in Postgres but not in the artifact, and is not forced-null:
  // it must be dropped so its Postgres default applies.
  it('drops a Postgres column the artifact does not carry', () => {
    const plans = buildColumnPlans(pgCols, ['uuid'], 'board_climbs');
    assert.equal(
      plans.some((plan) => plan.name === 'synced'),
      false,
    );
  });

  // board_climbs.user_id references production `users` rows, so it is included
  // as an explicit NULL rather than carried over — a foreign key would reject it.
  it('includes a forced-null column even when the artifact has no value for it', () => {
    const plans = buildColumnPlans(pgCols, ['uuid'], 'board_climbs');
    const userId = plans.find((plan) => plan.name === 'user_id');
    assert.ok(userId);
    assert.equal(userId.read({ user_id: 'a-production-user' }), null);
  });

  it('does not force-null the same column on an unrelated table', () => {
    const plans = buildColumnPlans(pgCols, ['user_id'], 'board_climb_stats');
    const userId = plans.find((plan) => plan.name === 'user_id');
    assert.ok(userId);
    assert.equal(userId.read({ user_id: 'kept' }), 'kept');
  });

  it('ignores artifact columns this schema does not have', () => {
    const plans = buildColumnPlans(pgCols, ['uuid', 'a_column_from_the_future'], 'board_climbs');
    assert.equal(
      plans.some((plan) => plan.name === 'a_column_from_the_future'),
      false,
    );
  });
});

describe('castExpression', () => {
  it('leaves text columns uncast', () => {
    assert.equal(castExpression({ name: 'name', formatType: 'text', read: () => null }), 'name');
  });

  it('casts every other type out of the all-text staging table', () => {
    assert.equal(castExpression({ name: 'angle', formatType: 'integer', read: () => null }), 'angle::integer');
    assert.equal(
      castExpression({ name: 'updated_at', formatType: 'timestamp without time zone', read: () => null }),
      'updated_at::timestamp without time zone',
    );
    assert.equal(
      castExpression({ name: 'compatible_size_ids', formatType: 'integer[]', read: () => null }),
      'compatible_size_ids::integer[]',
    );
  });
});

describe('STATS_ACCOUNTING_PLANS', () => {
  it('seeds the upstream terms from the published blend and zeroes the Boardsesh terms', () => {
    const row = { ascensionist_count: 12, quality_average: 4.5 };
    const read = (name: string) => STATS_ACCOUNTING_PLANS.find((plan) => plan.name === name)?.read(row);
    assert.equal(read('upstream_ascensionist_count'), '12');
    assert.equal(read('upstream_quality_average'), '4.5');
    assert.equal(read('boardsesh_ascensionist_count'), '0');
    assert.equal(read('boardsesh_quality_sum'), '0');
    assert.equal(read('boardsesh_quality_count'), '0');
    assert.equal(read('quality_normalized'), 't');
  });

  // recomputeClimbStatsBulk computes ascensionist_count as upstream + boardsesh;
  // a NULL upstream term would make every seeded tick produce a NULL count.
  it('passes a NULL ascent count through rather than inventing a zero', () => {
    const plan = STATS_ACCOUNTING_PLANS.find((entry) => entry.name === 'upstream_ascensionist_count');
    assert.ok(plan);
    assert.equal(plan.read({ ascensionist_count: null }), null);
  });
});

describe('catalogue load order', () => {
  // Every foreign key in the catalogue points backwards, so a table must never
  // appear before one it references.
  const dependencies: Record<string, readonly string[]> = {
    board_layouts: ['board_products'],
    board_product_sizes: ['board_products'],
    board_placement_roles: ['board_products'],
    board_holes: ['board_products'],
    board_placements: ['board_holes', 'board_layouts', 'board_sets', 'board_placement_roles'],
    board_leds: ['board_holes', 'board_product_sizes'],
    board_product_sizes_layouts_sets: ['board_layouts', 'board_product_sizes', 'board_sets'],
  };

  it('places every table after the tables it references', () => {
    for (const [table, needs] of Object.entries(dependencies)) {
      const position = CATALOG_LOAD_ORDER.indexOf(table as (typeof CATALOG_LOAD_ORDER)[number]);
      assert.notEqual(position, -1, `${table} is missing from CATALOG_LOAD_ORDER`);
      for (const need of needs) {
        const needPosition = CATALOG_LOAD_ORDER.indexOf(need as (typeof CATALOG_LOAD_ORDER)[number]);
        assert.notEqual(needPosition, -1, `${need} is missing from CATALOG_LOAD_ORDER`);
        assert.ok(needPosition < position, `${table} must load after ${need}`);
      }
    }
  });

  it('defers the tables that reference board_climbs out of the main order', () => {
    for (const deferred of DEFERRED_CATALOG_TABLES) {
      assert.equal(
        CATALOG_LOAD_ORDER.includes(deferred.table as (typeof CATALOG_LOAD_ORDER)[number]),
        false,
        `${deferred.table} must not be in the pre-climbs load order`,
      );
    }
  });

  // An alias whose canonical climb is missing (a climb updated inside the
  // export's stability window) would violate board_climb_aliases_canonical_fk.
  it('filters aliases against the climbs that actually loaded', () => {
    const aliases = DEFERRED_CATALOG_TABLES.find((entry) => entry.table === 'board_climb_aliases');
    assert.ok(aliases);
    assert.equal(aliases.requiresClimb, 'canonical_uuid');
  });
});

describe('parseArgs', () => {
  it('defaults to the public snapshot host with catalogue and holds enabled', () => {
    const options = parseArgs([]);
    assert.equal(options.snapshotBaseUrl, 'https://snapshots.boardsesh.com');
    assert.equal(options.skipCatalog, false);
    assert.equal(options.skipHolds, false);
  });

  it('strips a trailing slash from the base URL', () => {
    assert.equal(parseArgs(['--snapshot-base-url', 'https://example.test/']).snapshotBaseUrl, 'https://example.test');
  });

  it('reads the filters and flags', () => {
    const options = parseArgs(['--board', 'kilter', '--layout', '8', '--skip-catalog', '--skip-holds']);
    assert.equal(options.board, 'kilter');
    assert.equal(options.layout, 8);
    assert.equal(options.skipCatalog, true);
    assert.equal(options.skipHolds, true);
  });

  it('rejects a non-integer layout', () => {
    assert.throws(() => parseArgs(['--layout', 'eight']), /--layout must be an integer/);
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    assert.throws(() => parseArgs(['--bord', 'kilter']), /Unknown argument/);
  });

  it('rejects a flag with no value', () => {
    assert.throws(() => parseArgs(['--board']), /--board requires a value/);
  });
});

describe('holdRowsForClimb', () => {
  // board_climb_holds is not published — every one of its ~10M rows is derived
  // from this parse, so it is the load's largest single trust assumption.
  const holdIds = (rows: readonly (readonly (string | null)[])[]) => rows.map((row) => row[2]);

  it('derives one row per lit hold of a single-frame climb', () => {
    const rows = holdRowsForClimb('kilter', 'climb-1', 'p2476r35p2537r33p2543r32');
    assert.deepEqual(holdIds(rows), ['2476', '2537', '2543']);
    for (const row of rows) {
      assert.equal(row[0], 'kilter');
      assert.equal(row[1], 'climb-1');
      assert.equal(row[3], '0');
      // The four roles board_climb_holds actually carries; an unmapped state
      // would mean the board's hold-state table drifted from the frames.
      assert.ok(['STARTING', 'HAND', 'FOOT', 'FINISH'].includes(String(row[4])));
    }
  });

  // board_climb_holds is keyed (board_type, climb_uuid, hold_id), so a hold lit
  // in two frames must contribute ONE row or the COPY hits a duplicate key.
  it('collapses a hold repeated across frames to a single row', () => {
    const rows = holdRowsForClimb('kilter', 'climb-2', 'p1143r12p1175r12,p1143r13p1198r13');
    assert.deepEqual(holdIds(rows).sort(), ['1143', '1175', '1198']);
    assert.equal(new Set(holdIds(rows)).size, holdIds(rows).length);
  });

  it('lets the last frame win the role and frame number of a repeated hold', () => {
    const rows = holdRowsForClimb('kilter', 'climb-3', 'p1143r12,p1143r13');
    assert.equal(rows.length, 1);
    // Frame 1 is the later frame, so its frame number and role are what land.
    assert.equal(rows[0][3], '1');
    assert.equal(rows[0][4], 'HAND');
  });

  // `x<id>` is an un-light marker in the frames string. This parser ignores it
  // rather than emitting an OFF row, so a hold lit earlier keeps its earlier
  // state. That matches what the published image already contains — neither it
  // nor a snapshot-seeded one holds a single OFF row — so the behaviour is
  // pinned here rather than "fixed" into a difference.
  it('ignores un-light markers rather than emitting an OFF row', () => {
    const rows = holdRowsForClimb('kilter', 'climb-4', 'p1143r12p1175r12,x1143p1198r13');
    assert.deepEqual(holdIds(rows).sort(), ['1143', '1175', '1198']);
    assert.equal(rows.find((row) => row[2] === '1143')?.[4], 'STARTING');
    assert.equal(
      rows.some((row) => row[4] === 'OFF'),
      false,
    );
    assert.deepEqual(holdRowsForClimb('kilter', 'climb-4b', 'x1143'), []);
  });

  it('returns nothing for an empty or unparseable frames string', () => {
    assert.deepEqual(holdRowsForClimb('kilter', 'climb-5', ''), []);
    assert.deepEqual(holdRowsForClimb('kilter', 'climb-6', 'not-a-frames-string'), []);
  });

  it('emits exactly the five columns the COPY declares', () => {
    for (const row of holdRowsForClimb('tension', 'climb-7', 'p1143r12p1175r12')) {
      assert.equal(row.length, 5);
    }
  });
});

describe('looksGzipCompressed', () => {
  // Whether the bytes on disk are still gzip depends on the HTTP stack, so this
  // sniff decides whether the artifact is decoded before SQLite ever opens it.
  // Getting it wrong means every artifact fails `PRAGMA quick_check`.
  const withTempFile = async (bytes: Buffer, assertion: (isGzip: boolean) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'gzip-sniff-'));
    const file = join(dir, 'artifact.db');
    try {
      writeFileSync(file, bytes);
      assertion(await looksGzipCompressed(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('detects the gzip magic bytes', async () => {
    await withTempFile(Buffer.from([0x1f, 0x8b, 0x08, 0x00]), (isGzip) => assert.equal(isGzip, true));
  });

  it('does not mistake a plain SQLite header for gzip', async () => {
    await withTempFile(Buffer.from('SQLite format 3\0', 'latin1'), (isGzip) => assert.equal(isGzip, false));
  });

  it('reports a file shorter than the magic as not gzip', async () => {
    await withTempFile(Buffer.from([0x1f]), (isGzip) => assert.equal(isGzip, false));
    await withTempFile(Buffer.alloc(0), (isGzip) => assert.equal(isGzip, false));
  });
});

describe('positional hold plans', () => {
  // deriveHoldRows supplies these values by position. If a future change routed
  // them through mapSqliteRows instead, a silent reader would emit ~10M all-NULL
  // rows; this makes that a loud failure at the first row.
  it('refuse to be read, rather than yielding null', () => {
    for (const plan of HOLD_COLUMN_PLANS) {
      assert.throws(() => plan.read({}), /supplied positionally/);
    }
  });

  it('declare exactly the columns deriveHoldRows yields', () => {
    const [row] = holdRowsForClimb('kilter', 'c', 'p1143r12');
    assert.equal(row.length, HOLD_COLUMN_PLANS.length);
    assert.deepEqual(
      HOLD_COLUMN_PLANS.map((plan) => plan.name),
      ['board_type', 'climb_uuid', 'hold_id', 'frame_number', 'hold_state'],
    );
  });
});

// The export publishes artifacts in one of two storage shapes
// (docs/board-snapshots.md, "Artifact shape"): shape 1 is rowid tables with the
// device's secondary indexes, in the order rows arrived; shape 2 is the same
// tables WITHOUT ROWID with no secondary index, vacuumed into key order. The
// loader has to read either. This package cannot import the export job, so the
// two files below are built from DDL written out by hand in the shapes the
// export emits; the round trip through the real export is a manual check
// recorded with the change that introduced shape 2.
describe('reading an artifact in either shape', () => {
  type ArtifactShape = 1 | 2;

  const climbs = [
    // Deliberately not in uuid order: shape 1 keeps this order, shape 2 does not.
    { uuid: 'climb-m', name: 'Middle', frames: 'p1143r12p1144r13', sizes: '[10,11]', listed: 1 },
    { uuid: 'climb-z', name: 'Last', frames: 'p1145r14', sizes: '[10]', listed: 0 },
    { uuid: 'climb-a', name: 'First', frames: '', sizes: null, listed: 1 },
  ];
  const stats = [
    { climbUuid: 'climb-z', angle: 40, ascents: 12, quality: 2.5 },
    { climbUuid: 'climb-a', angle: 45, ascents: null, quality: null },
    { climbUuid: 'climb-a', angle: 40, ascents: 3, quality: 1.5 },
  ];

  function buildArtifact(filePath: string, shape: ArtifactShape, recordedClimbCount = climbs.length): void {
    const tableSuffix = shape === 2 ? ' WITHOUT ROWID' : '';
    const artifact = new DatabaseSync(filePath);
    try {
      artifact.exec(`CREATE TABLE IF NOT EXISTS board_climbs (
  uuid TEXT PRIMARY KEY,
  board_type TEXT,
  layout_id INTEGER,
  name TEXT,
  frames TEXT,
  is_listed INTEGER,
  compatible_size_ids TEXT
)${tableSuffix};`);
      artifact.exec(`CREATE TABLE IF NOT EXISTS board_climb_stats (
  board_type TEXT NOT NULL,
  climb_uuid TEXT NOT NULL,
  angle INTEGER NOT NULL,
  ascensionist_count INTEGER,
  quality_average REAL,
  PRIMARY KEY (board_type, climb_uuid, angle)
)${tableSuffix};`);
      // Added by ALTER after the CREATE, as the client migrations do.
      artifact.exec('ALTER TABLE board_climbs ADD COLUMN is_hidden INTEGER;');
      if (shape === 1) {
        artifact.exec('CREATE INDEX idx_climbs_search ON board_climbs (board_type, layout_id, is_listed);');
        artifact.exec('CREATE INDEX idx_stats_lookup ON board_climb_stats (board_type, climb_uuid, angle);');
      }
      artifact.exec(
        'CREATE TABLE snapshot_meta (table_name TEXT PRIMARY KEY, row_count INTEGER, watermark_updated_at TEXT);',
      );
      const insertClimb = artifact.prepare(
        `INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, is_listed, compatible_size_ids, is_hidden)
         VALUES (?, 'kilter', 1, ?, ?, ?, ?, 0)`,
      );
      for (const climb of climbs) insertClimb.run(climb.uuid, climb.name, climb.frames, climb.listed, climb.sizes);
      const insertStat = artifact.prepare(
        `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, quality_average)
         VALUES ('kilter', ?, ?, ?, ?)`,
      );
      for (const stat of stats) insertStat.run(stat.climbUuid, stat.angle, stat.ascents, stat.quality);
      const insertMeta = artifact.prepare('INSERT INTO snapshot_meta (table_name, row_count) VALUES (?, ?)');
      insertMeta.run('board_climbs', recordedClimbCount);
      insertMeta.run('board_climb_stats', stats.length);
      // Metadata only: names no table, and the loader must not go looking for one.
      insertMeta.run('sync_deletions', 0);
      if (shape === 2) artifact.exec('VACUUM');
    } finally {
      artifact.close();
    }
  }

  function withArtifact<T>(shape: ArtifactShape, read: (artifact: DatabaseSync) => T, recordedClimbCount?: number): T {
    const dir = mkdtempSync(join(tmpdir(), 'loader-artifact-shape-'));
    const filePath = join(dir, 'artifact.db');
    try {
      buildArtifact(filePath, shape, recordedClimbCount);
      // Read-only, exactly as the loader opens a downloaded artifact.
      const artifact = new DatabaseSync(filePath, { readOnly: true });
      try {
        return read(artifact);
      } finally {
        artifact.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const climbPgColumns: PgColumn[] = [
    column('uuid', 'text', 'text', 'text'),
    column('board_type', 'text', 'text', 'text'),
    column('layout_id', 'integer', 'integer', 'int4'),
    column('name', 'text', 'text', 'text'),
    column('frames', 'text', 'text', 'text'),
    column('is_listed', 'boolean', 'boolean', 'bool'),
    column('is_hidden', 'boolean', 'boolean', 'bool'),
    column('compatible_size_ids', 'integer[]', 'ARRAY', '_int4'),
  ];
  const statsPgColumns: PgColumn[] = [
    column('board_type', 'text', 'text', 'text'),
    column('climb_uuid', 'text', 'text', 'text'),
    column('angle', 'integer', 'integer', 'int4'),
    column('ascensionist_count', 'bigint', 'bigint', 'int8'),
    column('quality_average', 'double precision', 'double precision', 'float8'),
  ];

  /** Every row the loader would COPY for a table, as encoded field lists. */
  function loadedRows(artifact: DatabaseSync, table: string, pgColumns: PgColumn[]): string[] {
    const artifactColumns = sqliteColumns(artifact, table);
    const plans = buildColumnPlans(pgColumns, artifactColumns, table);
    return [...mapSqliteRows(artifact, `SELECT ${artifactColumns.join(', ')} FROM ${table}`, plans)].map((fields) =>
      encodeCopyRow(fields),
    );
  }

  it('passes the integrity gate for both shapes', () => {
    for (const shape of [1, 2] as const) {
      withArtifact(shape, (artifact) => assert.doesNotThrow(() => verifyArtifact(artifact, `shape ${shape}`)));
    }
  });

  it('still catches a short table in a shape-2 artifact', () => {
    withArtifact(
      2,
      (artifact) =>
        assert.throws(() => verifyArtifact(artifact, 'short'), /board_climbs has 3 rows, snapshot_meta says 4/),
      climbs.length + 1,
    );
  });

  it('finds the same columns in both shapes, ALTER-added ones included', () => {
    const shape1Columns = withArtifact(1, (artifact) => sqliteColumns(artifact, 'board_climbs'));
    const shape2Columns = withArtifact(2, (artifact) => sqliteColumns(artifact, 'board_climbs'));
    assert.deepEqual(shape2Columns, shape1Columns);
    assert.ok(shape2Columns.includes('is_hidden'));
  });

  it('reads the same climbs and stats from both shapes, in whatever order each stores them', () => {
    const shape1 = withArtifact(1, (artifact) => ({
      climbs: loadedRows(artifact, 'board_climbs', climbPgColumns),
      stats: loadedRows(artifact, 'board_climb_stats', statsPgColumns),
    }));
    const shape2 = withArtifact(2, (artifact) => ({
      climbs: loadedRows(artifact, 'board_climbs', climbPgColumns),
      stats: loadedRows(artifact, 'board_climb_stats', statsPgColumns),
    }));

    // The load is an `INSERT ... ON CONFLICT DO NOTHING` of a set, so the order
    // rows come back in is not part of the contract. The rows themselves are.
    assert.deepEqual([...shape2.climbs].sort(), [...shape1.climbs].sort());
    assert.deepEqual([...shape2.stats].sort(), [...shape1.stats].sort());
    assert.equal(shape2.climbs.length, climbs.length);
    assert.equal(shape2.stats.length, stats.length);
    assert.ok(
      shape2.climbs.includes(
        encodeCopyRow(['climb-m', 'kilter', '1', 'Middle', 'p1143r12p1144r13', 't', 'f', '{10,11}']),
      ),
    );
    assert.ok(shape2.stats.includes(encodeCopyRow(['kilter', 'climb-a', '45', null, null])));
  });

  it('derives the same hold rows from both shapes', () => {
    const shape1Holds = withArtifact(1, (artifact) =>
      [...deriveHoldRows(artifact)].map((fields) => encodeCopyRow(fields)),
    );
    const shape2Holds = withArtifact(2, (artifact) =>
      [...deriveHoldRows(artifact)].map((fields) => encodeCopyRow(fields)),
    );

    assert.deepEqual([...shape2Holds].sort(), [...shape1Holds].sort());
    // Two holds on climb-m, one on climb-z, none for the climb with no frames.
    assert.equal(shape2Holds.length, 3);
  });
});
