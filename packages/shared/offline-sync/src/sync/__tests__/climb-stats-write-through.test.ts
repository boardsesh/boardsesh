// The live stats write-through, against the REAL on-device DDL via node:sqlite.
//
// What these protect: a global per-layout stream is allowed to write local rows
// for climbs this device downloaded, at the revision gate the pull agrees with,
// without ever touching the four columns the pull owns. Every arm of the SQL is
// pinned by a case that fails if the clause is removed — the revision gate, its
// strictness, the board_climbs existence guard, the epoch stamp, and the
// untouched columns.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ClimbStatsEvent } from '@boardsesh/shared-schema';

import {
  writeClimbStatsEvent,
  parseClimbStatsRevision,
  CLIMB_STATS_WRITE_THROUGH_COLUMNS,
  CLIMB_STATS_WRITE_THROUGH_UNTOUCHED_COLUMNS,
  CLIMB_STATS_WRITE_THROUGH_LOCK_TIMEOUT_MS,
  type ClimbStatsWriteThroughInput,
} from '../climb-stats-write-through';
import { TABLE_CONFIGS } from '../table-config';
import { runMigrations } from '../../db/migrations';
import { createTestDatabase, tableColumns, type TestSqliteDb } from '../../testing/sqlite-test-db';
import type { OfflineDatabase, SqlExecutor } from '../../database';

const EPOCH = '1970-01-01T00:00:00.000Z';
const CLIMB_UUID = 'climb-aaa';

type StatsRow = {
  board_type: string;
  climb_uuid: string;
  angle: number;
  display_difficulty: number | null;
  benchmark_difficulty: number | null;
  ascensionist_count: number | null;
  difficulty_average: number | null;
  quality_average: number | null;
  fa_username: string | null;
  fa_at: string | null;
  updated_at: string | null;
  sync_seq: number | null;
};

function makeEvent(overrides: Partial<ClimbStatsWriteThroughInput> = {}): ClimbStatsWriteThroughInput {
  return {
    boardType: 'kilter',
    layoutId: 1,
    climbUuid: CLIMB_UUID,
    angle: 40,
    ascensionistCount: 12,
    qualityAverage: 3.5,
    difficultyAverage: 17.25,
    displayDifficulty: 17,
    faUsername: 'stream-fa',
    faAt: '2026-09-01 10:00:00+00',
    syncSeq: '500',
    ...overrides,
  };
}

let db: TestSqliteDb;

/**
 * A view over the real test database with selected methods replaced. Built by
 * hand rather than by spreading `db`: the adapter's methods live on its
 * prototype, so a spread would produce an object with no methods at all.
 */
function wrapDb(overrides: Partial<OfflineDatabase>): OfflineDatabase {
  const base: OfflineDatabase = {
    execAsync: (source) => db.execAsync(source),
    runAsync: (source: string, ...params: never[]) => db.runAsync(source, ...params),
    getFirstAsync: (source: string, ...params: never[]) => db.getFirstAsync(source, ...params),
    getAllAsync: (source: string, ...params: never[]) => db.getAllAsync(source, ...params),
    withExclusiveTransactionAsync: (task) => db.withExclusiveTransactionAsync(task),
  } as OfflineDatabase;
  return { ...base, ...overrides };
}


async function seedClimb(overrides: { boardType?: string; uuid?: string; compatibleSizeIds?: string | null } = {}) {
  await db.runAsync('INSERT INTO board_climbs (board_type, uuid, layout_id, compatible_size_ids) VALUES (?, ?, ?, ?)', [
    overrides.boardType ?? 'kilter',
    overrides.uuid ?? CLIMB_UUID,
    1,
    overrides.compatibleSizeIds === undefined ? '[5,6]' : overrides.compatibleSizeIds,
  ]);
}

/** A pull-shaped row: all twelve columns populated, as a real sync leaves them. */
async function seedPulledStatsRow(overrides: Partial<StatsRow> = {}) {
  const row: StatsRow = {
    board_type: 'kilter',
    climb_uuid: CLIMB_UUID,
    angle: 40,
    display_difficulty: 10,
    benchmark_difficulty: 11,
    ascensionist_count: 3,
    difficulty_average: 10.5,
    quality_average: 2,
    fa_username: 'pulled-fa',
    fa_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-09-01T12:00:00.000Z',
    sync_seq: 100,
    ...overrides,
  };
  await db.runAsync(
    `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
      ascensionist_count, difficulty_average, quality_average, fa_username, fa_at, updated_at, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.board_type,
      row.climb_uuid,
      row.angle,
      row.display_difficulty,
      row.benchmark_difficulty,
      row.ascensionist_count,
      row.difficulty_average,
      row.quality_average,
      row.fa_username,
      row.fa_at,
      row.updated_at,
      row.sync_seq,
    ],
  );
  return row;
}

async function readStatsRow(angle = 40, boardType = 'kilter'): Promise<StatsRow | null> {
  return db.getFirstAsync<StatsRow>(
    'SELECT * FROM board_climb_stats WHERE board_type = ? AND climb_uuid = ? AND angle = ?',
    [boardType, CLIMB_UUID, angle],
  );
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
});

describe('writeClimbStatsEvent — inserting a row the pull has not seen', () => {
  it('applies the event and reports the climb’s compatible sizes', async () => {
    await seedClimb();

    const result = await writeClimbStatsEvent(db, makeEvent());

    expect(result).toEqual({ status: 'applied', compatibleSizeIds: [5, 6] });
    const row = await readStatsRow();
    expect(row).toMatchObject({
      display_difficulty: 17,
      ascensionist_count: 12,
      difficulty_average: 17.25,
      quality_average: 3.5,
      sync_seq: 500,
    });
  });

  it('stamps the epoch watermark so a tombstone or snapshot reconcile can still delete the row', async () => {
    await seedClimb();

    await writeClimbStatsEvent(db, makeEvent());

    // "now" here would sit ahead of every checkpoint and make the row
    // undeletable by `updated_at <= ?` forever.
    expect((await readStatsRow())?.updated_at).toBe(EPOCH);
  });

  it('leaves the columns the pull owns NULL rather than inventing values', async () => {
    await seedClimb();

    await writeClimbStatsEvent(db, makeEvent());

    const row = await readStatsRow();
    expect(row?.benchmark_difficulty).toBeNull();
    expect(row?.fa_username).toBeNull();
    expect(row?.fa_at).toBeNull();
  });
});

describe('writeClimbStatsEvent — the revision gate', () => {
  it('updates a row on a strictly newer revision', async () => {
    await seedClimb();
    await seedPulledStatsRow();

    const result = await writeClimbStatsEvent(db, makeEvent({ syncSeq: '101' }));

    expect(result.status).toBe('applied');
    expect(await readStatsRow()).toMatchObject({ ascensionist_count: 12, display_difficulty: 17, sync_seq: 101 });
  });

  it('leaves benchmark_difficulty, fa_username, fa_at and updated_at byte-identical on an update', async () => {
    await seedClimb();
    const pulled = await seedPulledStatsRow();

    await writeClimbStatsEvent(db, makeEvent({ syncSeq: '101' }));

    const row = await readStatsRow();
    expect(row?.benchmark_difficulty).toBe(pulled.benchmark_difficulty);
    expect(row?.fa_username).toBe(pulled.fa_username);
    expect(row?.fa_at).toBe(pulled.fa_at);
    expect(row?.updated_at).toBe(pulled.updated_at);
  });

  it('reports an equal revision as stale and changes nothing (the publisher republishes on every pass)', async () => {
    await seedClimb();
    const pulled = await seedPulledStatsRow();

    const result = await writeClimbStatsEvent(db, makeEvent({ syncSeq: '100' }));

    expect(result.status).toBe('stale');
    expect(await readStatsRow()).toEqual(pulled);
  });

  it('reports an older revision as stale and changes nothing', async () => {
    await seedClimb();
    const pulled = await seedPulledStatsRow();

    const result = await writeClimbStatsEvent(db, makeEvent({ syncSeq: '99' }));

    expect(result.status).toBe('stale');
    expect(await readStatsRow()).toEqual(pulled);
  });

  it('applies over a NULL local sync_seq', async () => {
    await seedClimb();
    await seedPulledStatsRow({ sync_seq: null });

    const result = await writeClimbStatsEvent(db, makeEvent({ syncSeq: '1' }));

    expect(result.status).toBe('applied');
    expect((await readStatsRow())?.sync_seq).toBe(1);
  });

  it('compares numerically, not lexically, against a text-stored sync_seq', async () => {
    await seedClimb();
    // SQLite columns are loosely typed: a text '9' can land in an INTEGER column.
    // Lexically '10' < '9'; numerically 10 > 9, and numerically is what the
    // server's sequence means.
    await db.runAsync(
      'INSERT INTO board_climb_stats (board_type, climb_uuid, angle, sync_seq) VALUES (?, ?, ?, ?)',
      ['kilter', CLIMB_UUID, 40, '9'],
    );

    const result = await writeClimbStatsEvent(db, makeEvent({ syncSeq: '10' }));

    expect(result.status).toBe('applied');
    expect((await readStatsRow())?.sync_seq).toBe(10);
  });

  it.each([
    ['empty', ''],
    ['non-numeric', 'abc'],
    ['negative', '-1'],
    ['leading zero', '01'],
    ['fractional', '1.5'],
    ['past MAX_SAFE_INTEGER', '9007199254740993'],
  ])('rejects a %s revision without running any SQL', async (_label, syncSeq) => {
    await seedClimb();
    const reads = vi.fn(db.getFirstAsync.bind(db));
    const writes = vi.fn(db.withExclusiveTransactionAsync.bind(db));
    const countingDb = wrapDb({
      getFirstAsync: reads as unknown as OfflineDatabase['getFirstAsync'],
      withExclusiveTransactionAsync: writes,
    });

    const result = await writeClimbStatsEvent(countingDb, makeEvent({ syncSeq }));

    expect(result).toEqual({ status: 'invalid_revision', compatibleSizeIds: null });
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it('parses revisions the same way the gate does', () => {
    expect(parseClimbStatsRevision('0')).toBe(0);
    expect(parseClimbStatsRevision('9007199254740991')).toBe(9007199254740991);
    expect(parseClimbStatsRevision('9007199254740993')).toBeNull();
    expect(parseClimbStatsRevision(' 5 ')).toBeNull();
  });
});

describe('writeClimbStatsEvent — climbs this device does not hold', () => {
  it('reports climb_not_local without opening a write transaction', async () => {
    const writes = vi.fn(db.withExclusiveTransactionAsync.bind(db));
    const countingDb = wrapDb({ withExclusiveTransactionAsync: writes });

    const result = await writeClimbStatsEvent(countingDb, makeEvent());

    expect(result).toEqual({ status: 'climb_not_local', compatibleSizeIds: null });
    expect(writes).not.toHaveBeenCalled();
    expect(await readStatsRow()).toBeNull();
  });

  it('does not treat the same uuid under another board type as local', async () => {
    await seedClimb({ boardType: 'tension' });

    const result = await writeClimbStatsEvent(db, makeEvent({ boardType: 'kilter' }));

    expect(result.status).toBe('climb_not_local');
  });

  it('writes no orphan row when the climb is deleted between the size read and the write', async () => {
    await seedClimb();
    // A scope teardown landing mid-event. Teardown finds stats rows by joining
    // board_climbs and never sweeps orphans, so a row written here would be
    // permanent.
    const racingDb = wrapDb({
      getFirstAsync: (async (source: string, ...params: never[]) => {
        const row = await db.getFirstAsync(source, ...params);
        await db.runAsync('DELETE FROM board_climbs WHERE board_type = ? AND uuid = ?', ['kilter', CLIMB_UUID]);
        return row;
      }) as OfflineDatabase['getFirstAsync'],
    });

    const result = await writeClimbStatsEvent(racingDb, makeEvent());

    expect(result.status).toBe('stale');
    expect(await readStatsRow()).toBeNull();
  });

  it('reports null compatible sizes for a NULL or non-array column', async () => {
    await seedClimb({ compatibleSizeIds: null });
    expect((await writeClimbStatsEvent(db, makeEvent())).compatibleSizeIds).toBeNull();

    await db.runAsync('UPDATE board_climbs SET compatible_size_ids = ? WHERE uuid = ?', ['not json', CLIMB_UUID]);
    expect((await writeClimbStatsEvent(db, makeEvent({ syncSeq: '501' }))).compatibleSizeIds).toBeNull();
  });
});

describe('writeClimbStatsEvent — the write connection', () => {
  it('takes the write lock immediately with the short stats timeout', async () => {
    await seedClimb();
    const statements: string[] = [];
    const recordingDb = wrapDb({
      withExclusiveTransactionAsync: (task) =>
        db.withExclusiveTransactionAsync(async (txn) =>
          task({
            execAsync: async (source: string) => {
              statements.push(source);
              await txn.execAsync(source);
            },
            runAsync: (source: string, ...params: never[]) => txn.runAsync(source, ...params),
            getFirstAsync: (source: string, ...params: never[]) => txn.getFirstAsync(source, ...params),
            getAllAsync: (source: string, ...params: never[]) => txn.getAllAsync(source, ...params),
          } as SqlExecutor),
        ),
    });

    await writeClimbStatsEvent(recordingDb, makeEvent());

    expect(statements).toContain(`PRAGMA busy_timeout = ${CLIMB_STATS_WRITE_THROUGH_LOCK_TIMEOUT_MS}`);
    expect(statements).toContain('BEGIN IMMEDIATE');
    expect(CLIMB_STATS_WRITE_THROUGH_LOCK_TIMEOUT_MS).toBe(250);
  });

  it('drops the event when another writer holds the lock, without throwing', async () => {
    await seedClimb();
    const lockedDb = wrapDb({
      withExclusiveTransactionAsync: async () => {
        throw new Error("Calling the 'execAsync' function has failed → Caused by: Error code 5: database is locked");
      },
    });

    const result = await writeClimbStatsEvent(lockedDb, makeEvent());

    expect(result).toEqual({ status: 'lock_lost', compatibleSizeIds: [5, 6] });
  });

  it('drops the event when the database was closed underneath it', async () => {
    await seedClimb();
    const closedDb = wrapDb({
      withExclusiveTransactionAsync: async () => {
        throw new Error('Access to closed resource: the database is closed');
      },
    });

    expect((await writeClimbStatsEvent(closedDb, makeEvent())).status).toBe('lock_lost');
  });

  it('rethrows a genuinely broken database by identity', async () => {
    await seedClimb();
    const diskFull = new Error('database or disk is full');
    const brokenDb = wrapDb({
      withExclusiveTransactionAsync: async () => {
        throw diskFull;
      },
    });

    await expect(writeClimbStatsEvent(brokenDb, makeEvent())).rejects.toBe(diskFull);
  });
});

describe('writeClimbStatsEvent — column contract', () => {
  it('splits board_climb_stats into exactly the written and untouched columns', () => {
    const declared = [...CLIMB_STATS_WRITE_THROUGH_COLUMNS, ...CLIMB_STATS_WRITE_THROUGH_UNTOUCHED_COLUMNS];
    expect([...declared].sort()).toEqual([...TABLE_CONFIGS.board_climb_stats.localColumns].sort());
  });

  it('names only columns the on-device DDL really has', async () => {
    const columns = await tableColumns(db, 'board_climb_stats');
    for (const column of [...CLIMB_STATS_WRITE_THROUGH_COLUMNS, ...CLIMB_STATS_WRITE_THROUGH_UNTOUCHED_COLUMNS]) {
      expect(columns).toContain(column);
    }
  });

  it('accepts a wire ClimbStatsEvent as input', () => {
    const wireEvent: ClimbStatsEvent = {
      boardType: 'kilter',
      layoutId: 1,
      climbUuid: CLIMB_UUID,
      angle: 40,
      ascensionistCount: 12,
      qualityAverage: 3.5,
      difficultyAverage: 17.25,
      displayDifficulty: 17,
      difficulty: '7A',
      faUsername: 'stream-fa',
      faAt: '2026-09-01 10:00:00+00',
      syncSeq: '500',
    };
    const asInput: ClimbStatsWriteThroughInput = wireEvent;
    expect(asInput.syncSeq).toBe('500');
  });
});
