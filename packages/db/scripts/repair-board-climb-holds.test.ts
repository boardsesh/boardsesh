import assert from 'node:assert/strict';
import test from 'node:test';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  applyRepairManifest,
  fetchCandidateClimbs,
  getRepairOperatorHint,
  parseRepairArgs,
  runRepair,
  verifyAppliedRepair,
} from './repair-board-climb-holds.js';
import {
  buildRepairManifest,
  digestRepairManifest,
  fingerprintFromRepairRows,
  placementKey,
  type RepairHoldRow,
} from './repair-board-climb-holds-helpers.js';
import { createScriptDb, isLocalDatabaseUrl } from './db-connection.js';
import { executeRows } from '../src/client/index.js';

function compiledQuery(query: unknown) {
  return new PgDialect().sqlToQuery(query as SQL);
}

function renderedSql(query: unknown): string {
  return compiledQuery(query).sql.replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

function blockedRepairManifest() {
  return buildRepairManifest(
    [
      {
        boardType: 'tension',
        uuid: 'blocked-missing-placement',
        layoutId: 1,
        frames: 'p1r1,"p2r2',
        framesCount: 2,
        holdFingerprint: null,
        multiFrameTarget: true,
        rows: [],
      },
    ],
    new Set([placementKey('tension', 1, 1)]),
  );
}

void test('dry-run issues reads only and never starts a transaction', async () => {
  const executed: unknown[] = [];
  let transactionStarted = false;
  const database = {
    db: {
      execute(query: unknown) {
        executed.push(query);
        return Promise.resolve([]);
      },
      transaction() {
        transactionStarted = true;
        throw new Error('dry-run must not start a transaction');
      },
    },
    close: async () => undefined,
  } as unknown as Parameters<typeof runRepair>[1];

  const result = await runRepair(parseRepairArgs([]), database);
  assert.equal(result.applied, false);
  assert.equal(transactionStarted, false);
  assert.equal(executed.length, 1);
  assert.match(renderedSql(executed[0]), /invalid\.hold_id <= 0/);
});

void test('candidate query binds every Aurora board once and preserves both candidate paths', async () => {
  let capturedQuery: unknown;
  const executor = {
    execute(query: unknown) {
      capturedQuery = query;
      return Promise.resolve([]);
    },
  };

  assert.deepEqual(await fetchCandidateClimbs(executor), []);
  assert.ok(capturedQuery);
  const candidateQuery = compiledQuery(capturedQuery);
  const boundParameters = candidateQuery.params.map((parameter): unknown => parameter);
  assert.deepEqual(boundParameters, [...AURORA_BOARDS]);
  assert.equal(
    boundParameters.some((parameter) => String(parameter) === 'moonboard'),
    false,
  );

  const statement = renderedSql(capturedQuery);
  assert.match(statement, /where bc\.board_type in \([^)]*\) and bc\.frames_count > 1/);
  assert.match(statement, /union all select invalid\.board_type/);
  assert.match(statement, /from board_climb_holds invalid where invalid\.hold_id <= 0/);
  assert.match(statement, /inner join board_climbs bc on bc\.uuid = candidate_identity\.uuid/);
  assert.doesNotMatch(
    statement,
    /inner join board_climbs bc on bc\.uuid = candidate_identity\.uuid and bc\.board_type/,
  );
});

void test('apply requires digest, exact count guards, and a maximum affected count', () => {
  assert.throws(() => parseRepairArgs(['--apply']), /requires --expected-digest/);
  assert.deepEqual(
    parseRepairArgs([
      '--apply',
      '--expected-digest',
      'abc',
      '--expected-scanned',
      '10',
      '--expected-changed',
      '2',
      '--expected-invalid',
      '1',
      '--max-affected',
      '3',
    ]),
    {
      apply: true,
      help: false,
      expectedDigest: 'abc',
      expectedScanned: 10,
      expectedChanged: 2,
      expectedInvalid: 1,
      maxAffected: 3,
      reportLimit: 50,
    },
  );
});

void test('lock timeouts include actionable operator guidance without relabeling other failures', () => {
  const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  assert.equal(
    getRepairOperatorHint(lockTimeout),
    'could not acquire repair locks within 5 seconds; retry after write traffic drops',
  );
  assert.equal(
    getRepairOperatorHint(new Error('wrapped query failure', { cause: lockTimeout })),
    'could not acquire repair locks within 5 seconds; retry after write traffic drops',
  );
  assert.equal(getRepairOperatorHint(Object.assign(new Error('statement timeout'), { code: '57014' })), null);
  assert.equal(getRepairOperatorHint('not a PostgreSQL error'), null);
});

void test('locked malformed/frame-count drift throws before mutation and rolls back', async () => {
  const emptyDigest = digestRepairManifest(buildRepairManifest([], new Set()));
  let candidateQueryCount = 0;
  let rolledBack = false;
  let committed = false;
  let transactionOptions: unknown;
  const transactionStatements: string[] = [];
  const fakeDb = {
    execute(query: unknown) {
      const statement = renderedSql(query);
      if (statement.includes('with candidate_keys as')) {
        candidateQueryCount += 1;
      }
      if (statement.includes('with candidate_keys as') && candidateQueryCount === 2) {
        return Promise.resolve([
          {
            board_type: 'tension',
            uuid: 'drifted',
            layout_id: 1,
            frames: 'p1r1junk,"p2r2',
            frames_count: 3,
            hold_fingerprint: null,
            multi_frame_target: true,
            hold_id: null,
            frame_number: null,
            hold_state: null,
          },
        ]);
      }
      return Promise.resolve([]);
    },
    async transaction(callback: (executor: unknown) => Promise<unknown>, options: unknown) {
      transactionOptions = options;
      const transactionExecutor = {
        execute(query: unknown) {
          transactionStatements.push(renderedSql(query));
          return fakeDb.execute(query);
        },
      };
      try {
        await callback(transactionExecutor);
        committed = true;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };
  const database = {
    db: fakeDb,
    close: async () => undefined,
  } as unknown as Parameters<typeof runRepair>[1];
  const args = parseRepairArgs([
    '--apply',
    '--expected-digest',
    emptyDigest,
    '--expected-scanned',
    '0',
    '--expected-changed',
    '0',
    '--expected-invalid',
    '0',
    '--max-affected',
    '0',
  ]);

  await assert.rejects(runRepair(args, database), /repair guard failed/);
  assert.equal(rolledBack, true);
  assert.equal(committed, false);
  assert.deepEqual(transactionOptions, { isolationLevel: 'repeatable read' });
  assert.deepEqual(transactionStatements.slice(0, 5), [
    "set local lock_timeout = '5s'",
    "set local statement_timeout = '120s'",
    'lock table board_climbs in share row exclusive mode',
    'lock table board_climb_holds in share row exclusive mode',
    "select pg_advisory_xact_lock(hashtext('boardsesh:repair-board-climb-holds:v1'))",
  ]);
  assert.equal(candidateQueryCount, 2, 'the locked manifest must be rebuilt after the dry-run manifest');
  assert.equal(
    transactionStatements.some((statement) => /delete from|insert into|update board_climbs/.test(statement)),
    false,
    'no mutation should run after locked drift is detected',
  );
});

void test('apply and verification batch changed identities while preserving empty projections', async () => {
  const staleRows: RepairHoldRow[] = [{ holdId: 99, frameNumber: 0, holdState: 'HAND' }];
  const manifest = buildRepairManifest(
    [
      {
        boardType: 'tension',
        uuid: 'batch-a',
        layoutId: 1,
        frames: 'p1r1,"p2r2',
        framesCount: 2,
        holdFingerprint: fingerprintFromRepairRows(staleRows),
        multiFrameTarget: true,
        rows: staleRows,
      },
      {
        boardType: 'kilter',
        uuid: 'batch-b',
        layoutId: 1,
        frames: 'p3r42,"p4r43',
        framesCount: 2,
        holdFingerprint: fingerprintFromRepairRows(staleRows),
        multiFrameTarget: true,
        rows: staleRows,
      },
      {
        boardType: 'tension',
        uuid: 'batch-empty',
        layoutId: 1,
        frames: 'p0r1,"',
        framesCount: 2,
        holdFingerprint: fingerprintFromRepairRows(staleRows),
        multiFrameTarget: true,
        rows: staleRows,
      },
    ],
    new Set([
      placementKey('tension', 1, 1),
      placementKey('tension', 1, 2),
      placementKey('kilter', 1, 3),
      placementKey('kilter', 1, 4),
    ]),
  );
  assert.equal(manifest.counts.changedMultiFrameClimbs, 3);
  assert.equal(manifest.counts.fingerprintUpdates, 3);

  const statements: string[] = [];
  const projectedByIdentity = new Map(
    manifest.entries.map((entry) => [`${entry.boardType}/${entry.uuid}`, entry.projectedRows ?? []]),
  );
  const executor = {
    execute(query: unknown) {
      const statement = renderedSql(query);
      statements.push(statement);
      if (statement.includes('delete from board_climb_holds stored') && statement.includes('using changed')) {
        return Promise.resolve(Array.from({ length: manifest.counts.deleteRows }, () => ({ board_type: 'tension' })));
      }
      if (statement.includes('insert into board_climb_holds')) {
        return Promise.resolve(
          Array.from(projectedByIdentity.values())
            .flat()
            .map(() => ({ board_type: 'tension' })),
        );
      }
      if (statement.includes('update board_climbs stored')) {
        return Promise.resolve([
          { board_type: 'tension', uuid: 'batch-a' },
          { board_type: 'kilter', uuid: 'batch-b' },
          { board_type: 'tension', uuid: 'batch-empty' },
        ]);
      }
      if (statement.includes('inner join targets')) {
        return Promise.resolve(
          manifest.entries.flatMap((entry) =>
            (entry.projectedRows ?? []).map((row) => ({
              board_type: entry.boardType,
              climb_uuid: entry.uuid,
              hold_id: row.holdId,
              frame_number: row.frameNumber,
              hold_state: row.holdState,
            })),
          ),
        );
      }
      if (statement.includes('select count(*)::integer as invalid_count')) {
        return Promise.resolve([{ invalid_count: 0 }]);
      }
      throw new Error(`unexpected statement: ${statement}`);
    },
  };

  await applyRepairManifest(executor, manifest);
  await verifyAppliedRepair(executor, manifest);

  assert.equal(statements.filter((statement) => statement.includes('using changed')).length, 1);
  assert.equal(statements.filter((statement) => statement.includes('update board_climbs stored')).length, 1);
  assert.equal(statements.filter((statement) => statement.includes('inner join targets')).length, 1);

  const failedFingerprintExecutor = {
    execute(query: unknown) {
      const statement = renderedSql(query);
      if (statement.includes('delete from board_climb_holds stored') && statement.includes('using changed')) {
        return Promise.resolve(Array.from({ length: manifest.counts.deleteRows }, () => ({ board_type: 'tension' })));
      }
      if (statement.includes('insert into board_climb_holds')) {
        return Promise.resolve(Array.from({ length: manifest.counts.insertRows }, () => ({ board_type: 'tension' })));
      }
      if (statement.includes('update board_climbs stored')) {
        return Promise.resolve([
          { board_type: 'kilter', uuid: 'batch-b' },
          { board_type: 'tension', uuid: 'batch-a' },
        ]);
      }
      throw new Error(`unexpected statement: ${statement}`);
    },
  };
  await assert.rejects(
    applyRepairManifest(failedFingerprintExecutor, manifest),
    /fingerprint guard failed for tension\/batch-empty/,
  );

  const missingVerificationExecutor = {
    execute(query: unknown) {
      const statement = renderedSql(query);
      if (statement.includes('inner join targets')) {
        return Promise.resolve(
          manifest.entries.flatMap((entry) =>
            (entry.projectedRows ?? [])
              .filter((_row, rowIndex) => entry.uuid !== 'batch-b' || rowIndex !== 0)
              .map((row) => ({
                board_type: entry.boardType,
                climb_uuid: entry.uuid,
                hold_id: row.holdId,
                frame_number: row.frameNumber,
                hold_state: row.holdState,
              })),
          ),
        );
      }
      if (statement.includes('select count(*)::integer as invalid_count')) {
        return Promise.resolve([{ invalid_count: 0 }]);
      }
      throw new Error(`unexpected statement: ${statement}`);
    },
  };
  await assert.rejects(verifyAppliedRepair(missingVerificationExecutor, manifest), /kilter\/batch-b/);
});

void test('direct apply rejects a blocked manifest before executing a mutation', async () => {
  const manifest = blockedRepairManifest();
  let executorCalls = 0;
  const executor = {
    execute() {
      executorCalls += 1;
      return Promise.resolve([]);
    },
  };

  await assert.rejects(applyRepairManifest(executor, manifest), /refusing to apply.*1 blocker/);
  assert.equal(executorCalls, 0);
});

void test('direct apply rejects an underreported blocker summary before executing a mutation', async () => {
  const manifest = blockedRepairManifest();
  const inconsistentManifest = {
    ...manifest,
    counts: { ...manifest.counts, blockers: manifest.counts.blockers - 1 },
  };
  let executorCalls = 0;
  const executor = {
    execute() {
      executorCalls += 1;
      return Promise.resolve([]);
    },
  };

  await assert.rejects(
    applyRepairManifest(executor, inconsistentManifest),
    /inconsistent blocker counts: summary=0 entries=1/,
  );
  assert.equal(executorCalls, 0);
});

void test('direct apply rejects an overreported blocker summary before executing a mutation', async () => {
  const manifest = blockedRepairManifest();
  const inconsistentManifest = {
    ...manifest,
    counts: { ...manifest.counts, blockers: manifest.counts.blockers + 1 },
  };
  let executorCalls = 0;
  const executor = {
    execute() {
      executorCalls += 1;
      return Promise.resolve([]);
    },
  };

  await assert.rejects(
    applyRepairManifest(executor, inconsistentManifest),
    /inconsistent blocker counts: summary=2 entries=1/,
  );
  assert.equal(executorCalls, 0);
});

void test('real Postgres apply deletes, inserts, updates fingerprints, verifies, and reruns idempotently', async (context) => {
  const databaseUrl = process.env.REPAIR_BOARD_CLIMB_HOLDS_TEST_DB_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl || !isLocalDatabaseUrl(databaseUrl)) {
    context.skip('set REPAIR_BOARD_CLIMB_HOLDS_TEST_DB_URL or DATABASE_URL to a local migrated Postgres');
    return;
  }

  const { db, close } = createScriptDb(databaseUrl);
  const multiUuid = 'repair-integration-multi';
  const invalidUuid = 'repair-integration-invalid';
  const frames = 'p1r1,"p2r2';
  const staleRows: RepairHoldRow[] = [{ holdId: 9, frameNumber: 0, holdState: 'HAND' }];
  const invalidRows: RepairHoldRow[] = [
    { holdId: -7, frameNumber: 0, holdState: 'HAND' },
    { holdId: 3, frameNumber: 0, holdState: 'FOOT' },
  ];
  const placementKeys = new Set([
    placementKey('tension', 1, 1),
    placementKey('tension', 1, 2),
    placementKey('tension', 1, 3),
  ]);

  try {
    await db.transaction(async (transaction) => {
      // Session-local tables shadow the real schema, so this exercises the
      // production SQL without touching persistent development data.
      await transaction.execute(sql`
        CREATE TEMP TABLE board_climbs (
          board_type text NOT NULL,
          uuid text PRIMARY KEY,
          layout_id integer NOT NULL,
          frames text,
          frames_count integer,
          hold_fingerprint text
        ) ON COMMIT DROP
      `);
      await transaction.execute(sql`
        CREATE TEMP TABLE board_climb_holds (
          board_type text NOT NULL,
          climb_uuid text NOT NULL,
          hold_id integer NOT NULL,
          frame_number integer NOT NULL,
          hold_state text NOT NULL,
          PRIMARY KEY (board_type, climb_uuid, hold_id)
        ) ON COMMIT DROP
      `);

      const mismatchedUuid = 'repair-integration-mismatched-board';
      await transaction.execute(sql`
        INSERT INTO board_climbs (board_type, uuid, layout_id, frames, frames_count, hold_fingerprint)
        VALUES ('tension', ${mismatchedUuid}, 1, 'p3r4', 1, 'parent-fingerprint')
      `);
      await transaction.execute(sql`
        INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
        VALUES ('kilter', ${mismatchedUuid}, -7, 0, 'HAND')
      `);
      const mismatchedCandidates = await fetchCandidateClimbs(transaction);
      assert.deepEqual(mismatchedCandidates, [
        {
          boardType: 'kilter',
          uuid: mismatchedUuid,
          layoutId: 1,
          frames: 'p3r4',
          framesCount: 1,
          holdFingerprint: null,
          multiFrameTarget: false,
          rows: [{ holdId: -7, frameNumber: 0, holdState: 'HAND' }],
        },
      ]);
      const mismatchedManifest = buildRepairManifest(mismatchedCandidates, new Set());
      await applyRepairManifest(transaction, mismatchedManifest);
      await verifyAppliedRepair(transaction, mismatchedManifest);
      const [{ invalid_count: mismatchedRows } = { invalid_count: -1 }] = await executeRows<{
        invalid_count: number;
      }>(transaction, sql`SELECT COUNT(*)::integer AS invalid_count FROM board_climb_holds`);
      assert.equal(mismatchedRows, 0);
      const [{ hold_fingerprint: parentFingerprint }] = await executeRows<{ hold_fingerprint: string | null }>(
        transaction,
        sql`SELECT hold_fingerprint FROM board_climbs WHERE uuid = ${mismatchedUuid}`,
      );
      assert.equal(parentFingerprint, 'parent-fingerprint');

      const initialManifest = buildRepairManifest(
        [
          {
            boardType: 'tension',
            uuid: multiUuid,
            layoutId: 1,
            frames,
            framesCount: 2,
            holdFingerprint: fingerprintFromRepairRows(staleRows),
            multiFrameTarget: true,
            rows: staleRows,
          },
          {
            boardType: 'tension',
            uuid: invalidUuid,
            layoutId: 1,
            frames: 'p3r4',
            framesCount: 1,
            holdFingerprint: null,
            multiFrameTarget: false,
            rows: invalidRows,
          },
        ],
        placementKeys,
      );
      assert.equal(initialManifest.counts.changedMultiFrameClimbs, 1);
      assert.equal(initialManifest.counts.invalidRows, 1);
      assert.equal(initialManifest.counts.fingerprintUpdates, 1);

      await transaction.execute(sql`
        INSERT INTO board_climbs (board_type, uuid, layout_id, frames, frames_count, hold_fingerprint)
        VALUES
          ('tension', ${multiUuid}, 1, ${frames}, 2, ${fingerprintFromRepairRows(staleRows)}),
          ('tension', ${invalidUuid}, 1, 'p3r4', 1, NULL)
      `);
      await transaction.execute(sql`
        INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
        VALUES
          ('tension', ${multiUuid}, 9, 0, 'HAND'),
          ('tension', ${invalidUuid}, -7, 0, 'HAND'),
          ('tension', ${invalidUuid}, 3, 0, 'FOOT')
      `);

      await applyRepairManifest(transaction, initialManifest);
      await verifyAppliedRepair(transaction, initialManifest);

      const materializedRows = await executeRows<{
        climb_uuid: string;
        hold_id: number;
        frame_number: number;
        hold_state: string;
      }>(
        transaction,
        sql`
          SELECT climb_uuid, hold_id, frame_number, hold_state
          FROM board_climb_holds
          ORDER BY climb_uuid, hold_id
        `,
      );
      assert.deepEqual(Array.from(materializedRows), [
        { climb_uuid: invalidUuid, hold_id: 3, frame_number: 0, hold_state: 'FOOT' },
        { climb_uuid: multiUuid, hold_id: 1, frame_number: 0, hold_state: 'STARTING' },
        { climb_uuid: multiUuid, hold_id: 2, frame_number: 1, hold_state: 'HAND' },
      ]);

      const [{ hold_fingerprint: repairedFingerprint }] = await executeRows<{ hold_fingerprint: string | null }>(
        transaction,
        sql`SELECT hold_fingerprint FROM board_climbs WHERE board_type = 'tension' AND uuid = ${multiUuid}`,
      );
      const repairedRows = materializedRows
        .filter((row) => row.climb_uuid === multiUuid)
        .map((row) => ({ holdId: row.hold_id, frameNumber: row.frame_number, holdState: row.hold_state }));
      assert.equal(repairedFingerprint, fingerprintFromRepairRows(repairedRows));

      const secondManifest = buildRepairManifest(
        [
          {
            boardType: 'tension',
            uuid: multiUuid,
            layoutId: 1,
            frames,
            framesCount: 2,
            holdFingerprint: repairedFingerprint,
            multiFrameTarget: true,
            rows: repairedRows,
          },
        ],
        placementKeys,
      );
      assert.equal(secondManifest.counts.affectedClimbs, 0);
      assert.equal(secondManifest.counts.deleteRows, 0);
      assert.equal(secondManifest.counts.insertRows, 0);
      assert.equal(secondManifest.counts.fingerprintUpdates, 0);
      await applyRepairManifest(transaction, secondManifest);
      await verifyAppliedRepair(transaction, secondManifest);

      await transaction.execute(sql`
        INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
        VALUES ('tension', ${invalidUuid}, -8, 0, 'HAND')
      `);
      await assert.rejects(
        verifyAppliedRepair(transaction, secondManifest),
        /post-write global invalid row count is 1, expected 0/,
      );
    });
  } finally {
    await close();
  }
});
