import assert from 'node:assert/strict';
import test from 'node:test';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { runBackfillBoardClimbHolds, type BackfillQueryExecutor } from './backfill-board-climb-holds.js';

type BatchRow = { uuid: string; frames: string };

type RecordedQuery = {
  sql: string;
  params: unknown[];
};

function normalizeSql(statement: string): string {
  return statement.replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

function fakeBackfillExecutor(options: {
  pages: BatchRow[][];
  insertCounts?: number[];
  remaining?: Array<{ board_type: string; remaining: string }>;
}) {
  const recordedQueries: RecordedQuery[] = [];
  let nextPage = 0;
  let nextInsertCount = 0;
  const executor: BackfillQueryExecutor = {
    execute(query) {
      const compiled = new PgDialect().sqlToQuery(query as SQL);
      const statement = normalizeSql(compiled.sql);
      recordedQueries.push({ sql: statement, params: compiled.params.map((parameter): unknown => parameter) });
      if (statement.includes('as eligible_count')) {
        return Promise.resolve([{ board_type: 'tension', eligible_count: String(options.pages.flat().length) }]);
      }
      if (statement.includes('select bc.uuid, bc.frames')) {
        const page = options.pages[nextPage] ?? [];
        nextPage += 1;
        return Promise.resolve(page);
      }
      if (statement.includes('insert into board_climb_holds')) {
        const count = options.insertCounts?.[nextInsertCount] ?? 0;
        nextInsertCount += 1;
        return Promise.resolve({ count });
      }
      if (statement.includes('as remaining')) return Promise.resolve(options.remaining ?? []);
      throw new Error(`unexpected query: ${statement}`);
    },
  };
  return { executor, recordedQueries };
}

void test('keyset pagination advances past a full empty-projection page and inserts a later valid page', async () => {
  const { executor, recordedQueries } = fakeBackfillExecutor({
    pages: [
      [
        { uuid: 'a-raw', frames: 'p0r1' },
        { uuid: 'B-RAW', frames: 'p1r999' },
      ],
      [{ uuid: 'c-raw', frames: 'p2r2' }],
      [],
    ],
    insertCounts: [1],
    remaining: [{ board_type: 'tension', remaining: '2' }],
  });
  const logs: string[] = [];

  const result = await runBackfillBoardClimbHolds(executor, { batchSize: 2, dryRun: false }, (message) =>
    logs.push(message),
  );

  assert.deepEqual(result.boards, [
    { boardType: 'tension', totalEligible: 3, processed: 3, inserted: 1, skippedUnparseable: 2 },
  ]);
  assert.deepEqual(result.remaining, [{ board_type: 'tension', remaining: '2' }]);
  assert.ok(logs.some((message) => message.includes('2 still missing (unparseable frames)')));

  const pageQueries = recordedQueries.filter((query) => query.sql.includes('select bc.uuid, bc.frames'));
  assert.equal(pageQueries.length, 3, 'a short page must still be followed by an empty fetch');
  assert.deepEqual(
    pageQueries.map((query) => query.params),
    [
      ['tension', 2],
      ['tension', 'B-RAW', 2],
      ['tension', 'c-raw', 2],
    ],
  );
  assert.equal(pageQueries[0]?.sql.includes('bc.uuid >'), false);
  for (const query of pageQueries.slice(1)) {
    assert.match(query.sql, /bc\.uuid > \$2/);
    assert.doesNotMatch(query.sql, /bc\.uuid >=|lower\(bc\.uuid\)/);
  }
  for (const query of pageQueries) assert.match(query.sql, /order by bc\.uuid asc/);

  const insertQueries = recordedQueries.filter((query) => query.sql.includes('insert into board_climb_holds'));
  assert.equal(insertQueries.length, 1);
  assert.match(insertQueries[0]?.sql ?? '', /on conflict \(board_type, climb_uuid, hold_id\) do nothing/);
  const verificationQuery = recordedQueries.find((query) => query.sql.includes('as remaining'));
  assert.ok(verificationQuery);
  assert.match(verificationQuery.sql, /not exists/);
  assert.match(verificationQuery.sql, /bc\.board_type != 'moonboard'/);
});

void test('multiple full zero-projection pages advance monotonically and terminate only on the empty fetch', async () => {
  const { executor, recordedQueries } = fakeBackfillExecutor({
    pages: [
      [
        { uuid: 'a', frames: 'p0r1' },
        { uuid: 'b', frames: 'p-1r2' },
      ],
      [
        { uuid: 'c', frames: 'p2r999' },
        { uuid: 'd', frames: 'x2' },
      ],
      [],
    ],
  });

  const result = await runBackfillBoardClimbHolds(executor, { batchSize: 2, dryRun: false }, () => {});

  assert.deepEqual(result.boards, [
    { boardType: 'tension', totalEligible: 4, processed: 4, inserted: 0, skippedUnparseable: 4 },
  ]);
  const pageQueries = recordedQueries.filter((query) => query.sql.includes('select bc.uuid, bc.frames'));
  assert.deepEqual(
    pageQueries.map((query) => query.params),
    [
      ['tension', 2],
      ['tension', 'b', 2],
      ['tension', 'd', 2],
    ],
  );
  assert.equal(
    recordedQueries.some((query) => query.sql.includes('insert into board_climb_holds')),
    false,
  );
});

void test('a zero-count insert still advances beyond the page boundary without replaying it', async () => {
  const { executor, recordedQueries } = fakeBackfillExecutor({
    pages: [[{ uuid: 'boundary-row', frames: 'p2r2' }], []],
    insertCounts: [0],
  });

  const result = await runBackfillBoardClimbHolds(executor, { batchSize: 1, dryRun: false }, () => {});

  assert.deepEqual(result.boards, [
    { boardType: 'tension', totalEligible: 1, processed: 1, inserted: 0, skippedUnparseable: 0 },
  ]);
  const pageQueries = recordedQueries.filter((query) => query.sql.includes('select bc.uuid, bc.frames'));
  assert.deepEqual(
    pageQueries.map((query) => query.params),
    [
      ['tension', 1],
      ['tension', 'boundary-row', 1],
    ],
  );
  assert.match(pageQueries[1]?.sql ?? '', /bc\.uuid > \$2/);
  assert.equal(recordedQueries.filter((query) => query.sql.includes('insert into board_climb_holds')).length, 1);
});
