// The DDL a board-snapshot artifact is built from, checked without Postgres.
//
// `boardSnapshotDdlStatements` picks statements out of the client MIGRATIONS by a
// word-boundary match on the snapshot table names. The device also builds tables
// of its own (the derived holds index, DEVICE_ONLY_TABLES) that must never ship in
// a public artifact; this pins both halves: what goes in, and what cannot.
//
// It also pins the two artifact SHAPES (SnapshotArtifactShape). Shape 2 is the
// same DDL rewritten: `WITHOUT ROWID` tables and no secondary index. The
// rewrite is text surgery on statements another package owns, so every way it
// could quietly do nothing is checked here, without a database.

import { describe, it, expect, afterEach } from 'vite-plus/test';
import { DatabaseSync } from 'node:sqlite';
import { artifactSchemaVersion, DEVICE_ONLY_STATEMENTS, DEVICE_ONLY_TABLES, MIGRATIONS } from '@boardsesh/offline-sync';
import {
  boardSnapshotDdlStatements,
  configuredSnapshotArtifactShape,
  DEFAULT_SNAPSHOT_ARTIFACT_SHAPE,
  withoutRowid,
  type SnapshotArtifactShape,
} from '../scripts/export-board-snapshots';

const ARTIFACT_TABLES = ['board_climb_stats', 'board_climbs', 'snapshot_meta'];

/**
 * The device's v1 secondary indexes on artifact tables: the three a shape-1
 * artifact carries and a shape-2 artifact leaves out.
 */
const SECONDARY_INDEXES = ['idx_climbs_search', 'idx_stats_difficulty', 'idx_stats_lookup'];

/**
 * The device's later indexes on artifact tables (v10, v13). They are in
 * DEVICE_ONLY_STATEMENTS and have never been in an artifact of either shape.
 */
const DEVICE_ONLY_INDEXES = ['idx_climbs_sync_seq', 'idx_stats_ascents'];

type TableLayout = {
  /** Table name to whether it is a WITHOUT ROWID table. */
  withoutRowid: Record<string, boolean>;
  /** Every index, the implicit `sqlite_autoindex_*` ones included. */
  indexes: string[];
  /** Table name to its `name type pk-position` column list, in declaration order. */
  columns: Record<string, string[]>;
};

function layoutAfterApplying(statements: readonly string[]): TableLayout {
  const database = new DatabaseSync(':memory:');
  try {
    for (const statement of statements) database.exec(statement);
    const tables = database
      .prepare("SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' ORDER BY name")
      .all() as { name: string; wr: number }[];
    const userTables = tables.filter((table) => !table.name.startsWith('sqlite_'));
    return {
      withoutRowid: Object.fromEntries(userTables.map((table) => [table.name, table.wr === 1])),
      indexes: (
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
      columns: Object.fromEntries(
        userTables.map((table) => [
          table.name,
          (
            database.prepare(`SELECT name, type, pk FROM pragma_table_info('${table.name}') ORDER BY cid`).all() as {
              name: string;
              type: string;
              pk: number;
            }[]
          ).map((column) => `${column.name} ${column.type} ${column.pk}`),
        ]),
      ),
    };
  } finally {
    database.close();
  }
}

function tableNamesAfterApplying(statements: readonly string[]): string[] {
  const database = new DatabaseSync(':memory:');
  try {
    for (const statement of statements) database.exec(statement);
    return (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    database.close();
  }
}

describe('boardSnapshotDdlStatements', () => {
  it('names only the artifact tables in every statement', () => {
    for (const statement of boardSnapshotDdlStatements()) {
      const namesAKnownTable = ARTIFACT_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(statement));
      expect(namesAKnownTable, statement).toBe(true);
    }
  });

  it('creates exactly board_climbs, board_climb_stats and snapshot_meta', () => {
    expect(tableNamesAfterApplying(boardSnapshotDdlStatements())).toEqual(ARTIFACT_TABLES);
  });

  it('never carries a device-only table', () => {
    expect([...DEVICE_ONLY_TABLES].sort()).toEqual([
      'board_climb_hold_postings',
      'board_climb_hold_sets',
      'holds_index_climbs',
    ]);
    for (const statement of boardSnapshotDdlStatements()) {
      for (const table of DEVICE_ONLY_TABLES) {
        expect(statement, statement).not.toMatch(new RegExp(`\\b${table}\\b`));
      }
    }
  });

  // Device-only statements are dropped for EVERY artifact shape, and before the
  // shape-2 rewrite looks at anything: an index it has never heard of would
  // otherwise make it refuse the whole build.
  it('leaves out statements only the device needs, such as the sync_seq index on board_climbs', () => {
    expect(DEVICE_ONLY_STATEMENTS.some((statement) => statement.includes('idx_climbs_sync_seq'))).toBe(true);
    for (const artifactShape of [1, 2] as const) {
      for (const statement of boardSnapshotDdlStatements(['board_climbs', 'board_climb_stats'], artifactShape)) {
        expect(statement).not.toContain('idx_climbs_sync_seq');
        expect(statement).not.toMatch(/hold_sets|hold_postings|holds_index/);
      }
    }
  });

  it('leaves out the ascents ranking index, which the import never reads the artifact by', () => {
    expect(DEVICE_ONLY_STATEMENTS.some((statement) => statement.includes('idx_stats_ascents'))).toBe(true);
    const shape1 = boardSnapshotDdlStatements(['board_climbs', 'board_climb_stats'], 1);
    const shape2 = boardSnapshotDdlStatements(['board_climbs', 'board_climb_stats'], 2);
    for (const statement of [...shape1, ...shape2]) {
      expect(statement).not.toContain('idx_stats_ascents');
    }
    // Shape 1 still carries the indexes an artifact always carried. Shape 2
    // carries no index statement at all, device-only or otherwise.
    expect(shape1.some((statement) => statement.includes('idx_stats_lookup'))).toBe(true);
    expect(shape2.filter((statement) => /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement))).toEqual([]);
  });

  it('keeps the grades artifact to board_climb_grades and snapshot_meta', () => {
    expect(tableNamesAfterApplying(boardSnapshotDdlStatements(['board_climb_grades']))).toEqual([
      'board_climb_grades',
      'snapshot_meta',
    ]);
  });
});

describe('boardSnapshotDdlStatements: artifact shapes', () => {
  it('builds shape 2 unless told otherwise', () => {
    expect(DEFAULT_SNAPSHOT_ARTIFACT_SHAPE).toBe(2);
    expect(boardSnapshotDdlStatements()).toEqual(boardSnapshotDdlStatements(['board_climbs', 'board_climb_stats'], 2));
  });

  it('shape 2 stores both data tables WITHOUT ROWID and carries no secondary index', () => {
    const layout = layoutAfterApplying(boardSnapshotDdlStatements(['board_climbs', 'board_climb_stats'], 2));

    expect(layout.withoutRowid).toEqual({ board_climb_stats: true, board_climbs: true, snapshot_meta: false });
    // A WITHOUT ROWID table is its own primary-key b-tree, so even the implicit
    // autoindexes are gone. snapshot_meta keeps its three-row one.
    expect(layout.indexes).toEqual(['sqlite_autoindex_snapshot_meta_1']);
  });

  it('shape 2 stores the grades table WITHOUT ROWID too', () => {
    const layout = layoutAfterApplying(boardSnapshotDdlStatements(['board_climb_grades'], 2));

    expect(layout.withoutRowid).toEqual({ board_climb_grades: true, snapshot_meta: false });
    expect(layout.indexes).toEqual(['sqlite_autoindex_snapshot_meta_1']);
  });

  it('shape 1 is the client DDL untouched: rowid tables with their three secondary indexes', () => {
    const statements = boardSnapshotDdlStatements(['board_climbs', 'board_climb_stats'], 1);
    const layout = layoutAfterApplying(statements);

    expect(layout.withoutRowid).toEqual({ board_climb_stats: false, board_climbs: false, snapshot_meta: false });
    expect(layout.indexes).toEqual([
      ...SECONDARY_INDEXES,
      'sqlite_autoindex_board_climb_stats_1',
      'sqlite_autoindex_board_climbs_1',
      'sqlite_autoindex_snapshot_meta_1',
    ]);
    // Not merely equivalent DDL: the very statements the migrations hold, so the
    // rollback publishes the files the exporter published before shapes existed.
    const migrationStatements = new Set(
      MIGRATIONS.flatMap((migration) => migration.statements.map((statement) => statement.trim())),
    );
    for (const statement of statements.slice(0, -1)) expect(migrationStatements.has(statement), statement).toBe(true);
    expect(statements.join('\n')).not.toMatch(/WITHOUT ROWID/i);
  });

  it('gives both shapes the same columns, types and primary keys', () => {
    for (const tables of [['board_climbs', 'board_climb_stats'], ['board_climb_grades']] as const) {
      const shape1 = layoutAfterApplying(boardSnapshotDdlStatements(tables, 1));
      const shape2 = layoutAfterApplying(boardSnapshotDdlStatements(tables, 2));
      expect(shape2.columns).toEqual(shape1.columns);
      expect(Object.values(shape2.columns).every((columns) => columns.length > 0)).toBe(true);
    }
  });

  it('changes only the three CREATE TABLEs and the three index statements between shapes', () => {
    const shape1 = boardSnapshotDdlStatements(['board_climbs', 'board_climb_stats'], 1);
    const shape2 = boardSnapshotDdlStatements(['board_climbs', 'board_climb_stats'], 2);

    const droppedFromShape1 = shape1.filter((statement) => !shape2.includes(statement));
    const addedInShape2 = shape2.filter((statement) => !shape1.includes(statement));
    expect(droppedFromShape1.filter((statement) => statement.startsWith('CREATE INDEX'))).toHaveLength(3);
    expect(droppedFromShape1.filter((statement) => statement.startsWith('CREATE TABLE'))).toHaveLength(2);
    expect(droppedFromShape1).toHaveLength(5);
    expect(addedInShape2).toHaveLength(2);
    for (const statement of addedInShape2) {
      expect(statement).toMatch(/^CREATE TABLE IF NOT EXISTS board_climb(?:s|_stats) \(/);
      expect(statement.endsWith(') WITHOUT ROWID;')).toBe(true);
      // The same statement as shape 1's, plus the two words.
      expect(shape1).toContain(statement.replace(') WITHOUT ROWID;', ');'));
    }
  });
});

describe('the device schema is untouched by artifact shapes', () => {
  // Shape 2 leaves three indexes out of the ARTIFACT. The phone's own queries
  // still need all three, and it creates them from migration v1 exactly as
  // before: nothing about the shape reaches MIGRATIONS.
  it('still creates every one of its indexes on rowid tables from its own migrations', () => {
    const device = layoutAfterApplying(
      MIGRATIONS.flatMap((migration) => migration.statements.map((statement) => statement.trim())),
    );

    // The three a shape-2 artifact leaves out, and the two no artifact ever had.
    for (const indexName of [...SECONDARY_INDEXES, ...DEVICE_ONLY_INDEXES]) {
      expect(device.indexes).toContain(indexName);
    }
    expect(device.withoutRowid.board_climbs).toBe(false);
    expect(device.withoutRowid.board_climb_stats).toBe(false);
    expect(device.withoutRowid.board_climb_grades).toBe(false);
  });

  // The three indexes are left out by a list of the EXPORTER's, not by the shared
  // DEVICE_ONLY_STATEMENTS. The device reads that list too (artifactSchemaVersion
  // derives ARTIFACT_SCHEMA_VERSION from it), and a shape-1 run has to put the
  // indexes back, so they must never move there.
  it('keeps the three indexes out of the shared device-only list the device also reads', () => {
    for (const statement of DEVICE_ONLY_STATEMENTS) {
      for (const indexName of SECONDARY_INDEXES) expect(statement).not.toContain(indexName);
    }
  });

  // A device-only index is a schema migration on the phone (v10, v13) and no
  // change to any artifact, in either shape. So it must not make the artifacts
  // already published look stale, and it must not change a byte of the DDL an
  // artifact is built from.
  it('does not move the artifact schema version or the artifact DDL when the device adds an index of its own', () => {
    for (const indexName of DEVICE_ONLY_INDEXES) {
      expect(
        DEVICE_ONLY_STATEMENTS.some((statement) => statement.includes(indexName)),
        indexName,
      ).toBe(true);
    }
    const isDeviceOnly = (statement: string): boolean => DEVICE_ONLY_STATEMENTS.includes(statement.trim());

    // v13 is `idx_stats_ascents` and nothing else. Clients on it still accept a
    // v12 artifact. Filtered to explicit versions, so a later migration that
    // does change an artifact table cannot turn this into a false alarm.
    const throughV13 = MIGRATIONS.filter((migration) => migration.version <= 13);
    expect(throughV13.at(-1)?.statements.every(isDeviceOnly)).toBe(true);
    expect(artifactSchemaVersion(throughV13)).toBe(12);
    expect(artifactSchemaVersion(throughV13)).toBe(
      artifactSchemaVersion(MIGRATIONS.filter((migration) => migration.version <= 12)),
    );

    // The artifact DDL with the device-only statements, and with them deleted
    // from the migrations altogether: identical, in both shapes.
    const withoutDeviceOnlyStatements = MIGRATIONS.map((migration) => ({
      version: migration.version,
      statements: migration.statements.filter((statement) => !isDeviceOnly(statement)),
    }));
    for (const artifactShape of [1, 2] as const) {
      for (const tables of [['board_climbs', 'board_climb_stats'], ['board_climb_grades']] as const) {
        expect(boardSnapshotDdlStatements(tables, artifactShape)).toEqual(
          boardSnapshotDdlStatements(tables, artifactShape, withoutDeviceOnlyStatements),
        );
      }
    }
  });
});

describe('withoutRowid', () => {
  it('appends WITHOUT ROWID to a column-level and to a table-level primary key', () => {
    expect(withoutRowid('CREATE TABLE IF NOT EXISTS climbs (\n  uuid TEXT PRIMARY KEY,\n  name TEXT\n);')).toBe(
      'CREATE TABLE IF NOT EXISTS climbs (\n  uuid TEXT PRIMARY KEY,\n  name TEXT\n) WITHOUT ROWID;',
    );
    expect(
      withoutRowid(
        'CREATE TABLE IF NOT EXISTS stats (\n  a TEXT NOT NULL,\n  b INTEGER NOT NULL,\n  PRIMARY KEY (a, b)\n);',
      ),
    ).toBe(
      'CREATE TABLE IF NOT EXISTS stats (\n  a TEXT NOT NULL,\n  b INTEGER NOT NULL,\n  PRIMARY KEY (a, b)\n) WITHOUT ROWID;',
    );
  });

  it('refuses a table with no explicit primary key', () => {
    expect(() => withoutRowid('CREATE TABLE IF NOT EXISTS climbs (\n  uuid TEXT,\n  name TEXT\n);')).toThrow(
      /climbs declares no PRIMARY KEY/,
    );
  });

  it('refuses a statement that is not the shape it knows how to rewrite', () => {
    for (const unexpected of [
      // Already WITHOUT ROWID: appending again would be a syntax error at export time.
      'CREATE TABLE IF NOT EXISTS climbs (\n  uuid TEXT PRIMARY KEY\n) WITHOUT ROWID;',
      // No trailing semicolon, a single-line body, a missing IF NOT EXISTS, a STRICT table.
      'CREATE TABLE IF NOT EXISTS climbs (\n  uuid TEXT PRIMARY KEY\n)',
      'CREATE TABLE IF NOT EXISTS climbs (uuid TEXT PRIMARY KEY);',
      'CREATE TABLE climbs (\n  uuid TEXT PRIMARY KEY\n);',
      'CREATE TABLE IF NOT EXISTS climbs (\n  uuid TEXT PRIMARY KEY\n) STRICT;',
      'ALTER TABLE climbs ADD COLUMN name TEXT;',
    ]) {
      expect(() => withoutRowid(unexpected), unexpected).toThrow(/not a "CREATE TABLE IF NOT EXISTS/);
    }
  });

  it('produces DDL SQLite accepts, and that still takes the later ALTER TABLE ADD COLUMNs', () => {
    const layout = layoutAfterApplying(boardSnapshotDdlStatements(['board_climbs', 'board_climb_stats'], 2));
    // Columns added by ALTER after the CREATE (v2, v5, v7, v11, v12) are all there.
    for (const column of [
      'characteristics',
      'is_hidden',
      'missing_hold_count',
      'revision_number',
      'retired_by_reset',
    ]) {
      expect(layout.columns.board_climbs.some((declared) => declared.startsWith(`${column} `))).toBe(true);
    }
  });
});

// The refusals. None of these statements is in a shipped migration, so each
// case hands the rewrite a migration list of its own. What they guard is the
// day somebody edits the client schema: the export must stop, with a message
// that says what to fix, instead of publishing a file that is quietly shape 1
// in part. Shape 1 takes every one of them as it comes, which is what keeps the
// rollback usable even when the rewrite is the thing that broke.
describe('boardSnapshotDdlStatements: what the shape-2 rewrite refuses', () => {
  const CLIMBS_TABLE = 'CREATE TABLE IF NOT EXISTS board_climbs (\n  uuid TEXT PRIMARY KEY,\n  name TEXT\n);';
  const STATS_TABLE =
    'CREATE TABLE IF NOT EXISTS board_climb_stats (\n  board_type TEXT NOT NULL,\n  climb_uuid TEXT NOT NULL,\n  angle INTEGER NOT NULL,\n  PRIMARY KEY (board_type, climb_uuid, angle)\n);';
  const SEARCH_INDEX = 'CREATE INDEX IF NOT EXISTS idx_climbs_search ON board_climbs (name);';
  const LOOKUP_INDEX =
    'CREATE INDEX IF NOT EXISTS idx_stats_lookup ON board_climb_stats (board_type, climb_uuid, angle);';
  const DIFFICULTY_INDEX = 'CREATE INDEX IF NOT EXISTS idx_stats_difficulty ON board_climb_stats (board_type, angle);';
  const baseline = [CLIMBS_TABLE, STATS_TABLE, SEARCH_INDEX, LOOKUP_INDEX, DIFFICULTY_INDEX];
  const LAYOUT_TABLES = ['board_climbs', 'board_climb_stats'] as const;

  const rewrite = (statements: string[], shape: SnapshotArtifactShape = 2): string[] =>
    boardSnapshotDdlStatements(LAYOUT_TABLES, shape, [{ version: 1, statements }]);

  it('accepts the baseline it is about to break, so each refusal below is the one thing changed', () => {
    const layout = layoutAfterApplying(rewrite(baseline));
    expect(layout.withoutRowid).toEqual({ board_climb_stats: true, board_climbs: true, snapshot_meta: false });
    expect(layout.indexes).toEqual(['sqlite_autoindex_snapshot_meta_1']);
  });

  it('refuses a new index on an artifact table that nobody listed', () => {
    const newIndex = 'CREATE INDEX IF NOT EXISTS idx_climbs_by_name ON board_climbs (name);';
    expect(() => rewrite([...baseline, newIndex])).toThrow(
      /migration v1 adds an index a shape-2 artifact does not know how to leave out: CREATE INDEX IF NOT EXISTS idx_climbs_by_name/,
    );
    expect(() => rewrite([...baseline, 'CREATE UNIQUE INDEX idx_climbs_unique_name ON board_climbs (name);'])).toThrow(
      /does not know how to leave out/,
    );
  });

  it('refuses a listed index that has moved to another table', () => {
    const moved = baseline.map((statement) =>
      statement === SEARCH_INDEX
        ? 'CREATE INDEX IF NOT EXISTS idx_climbs_search ON board_climb_stats (angle);'
        : statement,
    );
    expect(() => rewrite(moved)).toThrow(/does not know how to leave out/);
  });

  it('refuses when a listed index is no longer created by any migration', () => {
    expect(() => rewrite(baseline.filter((statement) => statement !== DIFFICULTY_INDEX))).toThrow(
      /expected to leave out idx_stats_difficulty on board_climb_stats, but no migration creates it/,
    );
  });

  it('refuses a CREATE TABLE it cannot rewrite, in every form that would otherwise slip through', () => {
    const withClimbsTable = (climbsTable: string): string[] =>
      baseline.map((statement) => (statement === CLIMBS_TABLE ? climbsTable : statement));

    // No primary key: SQLite would reject WITHOUT ROWID at export time, per layout.
    expect(() =>
      rewrite(withClimbsTable('CREATE TABLE IF NOT EXISTS board_climbs (\n  uuid TEXT,\n  name TEXT\n);')),
    ).toThrow(/board_climbs declares no PRIMARY KEY/);
    // Reformatted onto one line, or without IF NOT EXISTS: the anchored pattern no longer matches.
    for (const reshaped of [
      'CREATE TABLE IF NOT EXISTS board_climbs (uuid TEXT PRIMARY KEY, name TEXT);',
      'CREATE TABLE board_climbs (\n  uuid TEXT PRIMARY KEY,\n  name TEXT\n);',
      'CREATE TABLE IF NOT EXISTS board_climbs (\n  uuid TEXT PRIMARY KEY,\n  name TEXT\n) WITHOUT ROWID;',
    ]) {
      expect(() => rewrite(withClimbsTable(reshaped)), reshaped).toThrow(
        /has a CREATE TABLE the shape-2 transform does not recognise/,
      );
    }
    // Created twice.
    expect(() => rewrite([...baseline, CLIMBS_TABLE])).toThrow(/does not recognise/);
    // Another table whose DDL merely mentions an artifact table.
    expect(() =>
      rewrite([
        ...baseline,
        'CREATE TABLE IF NOT EXISTS climb_notes (\n  climb_uuid TEXT PRIMARY KEY REFERENCES board_climbs (uuid)\n);',
      ]),
    ).toThrow(/does not recognise/);
  });

  it('refuses when a requested table has no CREATE TABLE at all', () => {
    const withoutStatsTable = baseline.filter((statement) => statement !== STATS_TABLE);
    expect(() => rewrite(withoutStatsTable)).toThrow(/no CREATE TABLE found for board_climb_stats/);
  });

  it('still passes ALTER TABLE through, and still drops what DEVICE_ONLY_STATEMENTS lists', () => {
    const statements = rewrite([
      ...baseline,
      'ALTER TABLE board_climbs ADD COLUMN is_hidden INTEGER;',
      ...DEVICE_ONLY_STATEMENTS,
    ]);
    expect(statements).toContain('ALTER TABLE board_climbs ADD COLUMN is_hidden INTEGER;');
    // Dropped BEFORE the rewrite's own index check: neither is in its list, so
    // seeing either one there would have thrown instead.
    for (const indexName of DEVICE_ONLY_INDEXES) expect(statements.join('\n')).not.toContain(indexName);
  });

  it('leaves shape 1 able to build from every statement shape 2 refuses', () => {
    const awkward = [
      'CREATE TABLE board_climbs (uuid TEXT, name TEXT);',
      STATS_TABLE,
      'CREATE INDEX IF NOT EXISTS idx_climbs_by_name ON board_climbs (name);',
    ];
    expect(() => rewrite(awkward)).toThrow();
    expect(rewrite(awkward, 1).slice(0, -1)).toEqual(awkward);
  });
});

describe('configuredSnapshotArtifactShape (SNAPSHOT_ARTIFACT_SHAPE)', () => {
  const originalValue = process.env.SNAPSHOT_ARTIFACT_SHAPE;
  afterEach(() => {
    if (originalValue === undefined) delete process.env.SNAPSHOT_ARTIFACT_SHAPE;
    else process.env.SNAPSHOT_ARTIFACT_SHAPE = originalValue;
  });

  const shapeFor = (value: string | undefined): SnapshotArtifactShape => {
    if (value === undefined) delete process.env.SNAPSHOT_ARTIFACT_SHAPE;
    else process.env.SNAPSHOT_ARTIFACT_SHAPE = value;
    return configuredSnapshotArtifactShape();
  };

  it('is shape 2 when unset or blank', () => {
    expect(shapeFor(undefined)).toBe(2);
    // A blank passthrough (an unset deploy variable rendered as '') means unset.
    expect(shapeFor('')).toBe(2);
    expect(shapeFor('   ')).toBe(2);
  });

  it('reads 1 as the rollback and 2 as the default, whitespace tolerated', () => {
    expect(shapeFor('1')).toBe(1);
    expect(shapeFor(' 1 ')).toBe(1);
    expect(shapeFor('2')).toBe(2);
  });

  it('throws on anything else, so a typo never picks a shape by accident', () => {
    for (const typo of ['0', '3', 'one', 'true', '1.0', 'shape1']) {
      expect(() => shapeFor(typo), typo).toThrow(/SNAPSHOT_ARTIFACT_SHAPE must be 1 or 2/);
    }
  });
});
