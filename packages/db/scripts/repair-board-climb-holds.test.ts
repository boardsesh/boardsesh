import assert from 'node:assert/strict';
import test from 'node:test';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  applyRepairManifest,
  DEFAULT_REPAIR_BATCH_LIMITS,
  fetchCandidateClimbs,
  fetchExistingPlacementKeys,
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

function jsonParameter(query: unknown): { json: string; records: Array<Record<string, unknown>> } {
  const jsonParameter = compiledQuery(query).params.find(
    (parameter) => typeof parameter === 'string' && parameter.startsWith('['),
  );
  if (typeof jsonParameter !== 'string') throw new Error('query did not contain a JSON array parameter');
  return { json: jsonParameter, records: JSON.parse(jsonParameter) as Array<Record<string, unknown>> };
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

function twoChangedEntriesManifest(prefix: string) {
  const staleRows: RepairHoldRow[] = [{ holdId: 99, frameNumber: 0, holdState: 'HAND' }];
  return buildRepairManifest(
    [
      {
        boardType: 'tension',
        uuid: `${prefix}-a`,
        layoutId: 1,
        frames: 'p1r1,"p2r2',
        framesCount: 2,
        holdFingerprint: fingerprintFromRepairRows(staleRows),
        multiFrameTarget: true,
        rows: staleRows,
      },
      {
        boardType: 'tension',
        uuid: `${prefix}-b`,
        layoutId: 1,
        frames: 'p3r1,"p4r2',
        framesCount: 2,
        holdFingerprint: fingerprintFromRepairRows(staleRows),
        multiFrameTarget: true,
        rows: staleRows,
      },
    ],
    new Set([
      placementKey('tension', 1, 1),
      placementKey('tension', 1, 2),
      placementKey('tension', 1, 3),
      placementKey('tension', 1, 4),
    ]),
  );
}

function twoInvalidOnlyEntriesManifest(prefix: string) {
  return buildRepairManifest(
    ['a', 'b'].map((suffix, index) => ({
      boardType: 'moonboard',
      uuid: `${prefix}-${suffix}`,
      layoutId: 1,
      frames: 'p1r1',
      framesCount: 1,
      holdFingerprint: null,
      multiFrameTarget: false,
      rows: [{ holdId: -1 - index, frameNumber: 0, holdState: 'HAND' }],
    })),
    new Set(),
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

void test('candidate query scopes multi-frame projection to Aurora and preserves global invalid cleanup', async () => {
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
  assert.doesNotMatch(statement, /from board_climb_holds invalid where invalid\.board_type in/);
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

void test('a late batch guard failure rejects the enclosing transaction after earlier batches ran', async () => {
  const staleRows: RepairHoldRow[] = [{ holdId: 99, frameNumber: 0, holdState: 'HAND' }];
  const climbs = [
    {
      boardType: 'tension',
      uuid: 'late-batch-a',
      layoutId: 1,
      frames: 'p1r1,"p2r2',
      framesCount: 2,
      holdFingerprint: fingerprintFromRepairRows(staleRows),
      multiFrameTarget: true,
      rows: staleRows,
    },
    {
      boardType: 'tension',
      uuid: 'late-batch-b',
      layoutId: 1,
      frames: 'p3r1,"p4r2',
      framesCount: 2,
      holdFingerprint: fingerprintFromRepairRows(staleRows),
      multiFrameTarget: true,
      rows: staleRows,
    },
  ];
  const placementKeys = new Set([
    placementKey('tension', 1, 1),
    placementKey('tension', 1, 2),
    placementKey('tension', 1, 3),
    placementKey('tension', 1, 4),
  ]);
  const manifest = buildRepairManifest(climbs, placementKeys);
  const digest = digestRepairManifest(manifest);
  const candidateRows = climbs.map((climb) => ({
    board_type: climb.boardType,
    uuid: climb.uuid,
    layout_id: climb.layoutId,
    frames: climb.frames,
    frames_count: climb.framesCount,
    hold_fingerprint: climb.holdFingerprint,
    multi_frame_target: true,
    hold_id: staleRows[0]?.holdId ?? null,
    frame_number: staleRows[0]?.frameNumber ?? null,
    hold_state: staleRows[0]?.holdState ?? null,
  }));
  let fingerprintBatch = 0;
  let rolledBack = false;
  let committed = false;
  let closeCalled = false;
  const mutationStatements: string[] = [];

  const execute = (query: unknown): Promise<unknown[]> => {
    const statement = renderedSql(query);
    if (statement.includes('with candidate_keys as')) return Promise.resolve(candidateRows);
    if (statement.includes('with projected as')) {
      return Promise.resolve(jsonParameter(query).records);
    }
    if (statement.includes('set local') || statement.includes('lock table') || statement.includes('pg_advisory')) {
      return Promise.resolve([]);
    }
    mutationStatements.push(statement);
    const records = jsonParameter(query).records;
    if (statement.includes('using changed')) {
      return Promise.resolve([
        { affected_count: records.reduce((total, record) => total + Number(record.expected_rows), 0) },
      ]);
    }
    if (statement.includes('insert into board_climb_holds')) {
      return Promise.resolve([{ affected_count: records.length }]);
    }
    if (statement.includes('update board_climbs stored')) {
      fingerprintBatch += 1;
      return Promise.resolve(
        fingerprintBatch === 1 ? records.map((record) => ({ board_type: record.board_type, uuid: record.uuid })) : [],
      );
    }
    throw new Error(`unexpected statement: ${statement}`);
  };
  const fakeDb = {
    execute,
    async transaction(callback: (executor: { execute: typeof execute }) => Promise<unknown>) {
      try {
        await callback({ execute });
        committed = true;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };
  const database = {
    db: fakeDb,
    close: async () => {
      closeCalled = true;
    },
  } as unknown as Parameters<typeof runRepair>[1];
  const args = parseRepairArgs([
    '--apply',
    '--expected-digest',
    digest,
    '--expected-scanned',
    String(manifest.counts.scannedClimbs),
    '--expected-changed',
    String(manifest.counts.changedMultiFrameClimbs),
    '--expected-invalid',
    String(manifest.counts.invalidRows),
    '--max-affected',
    String(manifest.counts.affectedClimbs),
  ]);

  await assert.rejects(
    runRepair(args, database, {
      maxIdentityRecords: 1,
      maxMutationRecords: 1,
      maxParameterBytes: 1024,
    }),
    /fingerprint guard failed for tension\/late-batch-b/,
  );
  assert.equal(fingerprintBatch, 2, 'the guard fails in the second fingerprint batch');
  assert.ok(mutationStatements.some((statement) => statement.includes('insert into board_climb_holds')));
  assert.equal(rolledBack, true);
  assert.equal(committed, false);
  assert.equal(closeCalled, true);
});

void test('a later changed-delete short count identifies that identity batch', async () => {
  const manifest = twoChangedEntriesManifest('short-delete');
  let deleteBatch = 0;
  const executor = {
    execute(query: unknown) {
      const statement = renderedSql(query);
      assert.match(statement, /using changed/);
      const records = jsonParameter(query).records;
      deleteBatch += 1;
      const expectedCount = records.reduce((total, record) => total + Number(record.expected_rows), 0);
      return Promise.resolve([{ affected_count: deleteBatch === 1 ? expectedCount : expectedCount - 1 }]);
    },
  };

  await assert.rejects(
    applyRepairManifest(executor, manifest, {
      maxIdentityRecords: 1,
      maxMutationRecords: 5_000,
      maxParameterBytes: 1024,
    }),
    /deleted changed-row count did not match.*tension\/short-delete-b.*expected=1 actual=0/,
  );
  assert.equal(deleteBatch, 2);
});

void test('a later insertion short count identifies the affected climb identity', async () => {
  const manifest = twoChangedEntriesManifest('short-insert');
  let insertBatch = 0;
  const executor = {
    execute(query: unknown) {
      const statement = renderedSql(query);
      const records = jsonParameter(query).records;
      if (statement.includes('using changed')) {
        return Promise.resolve([
          { affected_count: records.reduce((total, record) => total + Number(record.expected_rows), 0) },
        ]);
      }
      assert.match(statement, /insert into board_climb_holds/);
      insertBatch += 1;
      return Promise.resolve([{ affected_count: insertBatch === 1 ? records.length : records.length - 1 }]);
    },
  };

  await assert.rejects(
    applyRepairManifest(executor, manifest, {
      maxIdentityRecords: 500,
      maxMutationRecords: 2,
      maxParameterBytes: 1024,
    }),
    /inserted row count did not match.*tension\/short-insert-b.*expected=2 actual=1/,
  );
  assert.equal(insertBatch, 2);
});

void test('a later global invalid-delete short count identifies its non-Aurora identity', async () => {
  const manifest = twoInvalidOnlyEntriesManifest('short-invalid');
  let invalidDeleteBatch = 0;
  const executor = {
    execute(query: unknown) {
      const statement = renderedSql(query);
      assert.match(statement, /using doomed/);
      const records = jsonParameter(query).records;
      invalidDeleteBatch += 1;
      return Promise.resolve([{ affected_count: invalidDeleteBatch === 1 ? records.length : records.length - 1 }]);
    },
  };

  await assert.rejects(
    applyRepairManifest(executor, manifest, {
      maxIdentityRecords: 500,
      maxMutationRecords: 1,
      maxParameterBytes: 1024,
    }),
    /deleted invalid row count did not match.*moonboard\/short-invalid-b.*expected=1 actual=0/,
  );
  assert.equal(invalidDeleteBatch, 2);
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
        return Promise.resolve([{ affected_count: manifest.counts.deleteRows }]);
      }
      if (statement.includes('insert into board_climb_holds')) {
        return Promise.resolve([{ affected_count: Array.from(projectedByIdentity.values()).flat().length }]);
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
        return Promise.resolve([{ affected_count: manifest.counts.deleteRows }]);
      }
      if (statement.includes('insert into board_climb_holds')) {
        return Promise.resolve([{ affected_count: manifest.counts.insertRows }]);
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

void test('placement lookup deduplicates references before record- and byte-bounded queries', async () => {
  const climbs = [
    {
      boardType: 'tension',
      uuid: 'placement-a',
      layoutId: 1,
      frames: 'p1r1p1r2,"p2r2',
      framesCount: 2,
      holdFingerprint: null,
      multiFrameTarget: true,
      rows: [],
    },
    {
      boardType: 'tension',
      uuid: 'placement-b',
      layoutId: 1,
      frames: 'p1r1,"p2r2',
      framesCount: 2,
      holdFingerprint: null,
      multiFrameTarget: true,
      rows: [],
    },
  ];
  const payloads: string[] = [];
  const executor = {
    execute(query: unknown) {
      const { json, records } = jsonParameter(query);
      payloads.push(json);
      return Promise.resolve(records);
    },
  };

  const keys = await fetchExistingPlacementKeys(executor, climbs, {
    maxIdentityRecords: 10,
    maxMutationRecords: 1,
    maxParameterBytes: 120,
  });

  assert.equal(payloads.length, 2, 'the repeated placements collapse to two unique references');
  assert.ok(payloads.every((payload) => Buffer.byteLength(payload) <= 120));
  assert.deepEqual(keys, new Set([placementKey('tension', 1, 1), placementKey('tension', 1, 2)]));
});

void test('apply and verification honor identity, mutation, and serialized-byte batch limits', async () => {
  const staleRows: RepairHoldRow[] = [{ holdId: 99, frameNumber: 0, holdState: 'HAND' }];
  const climbInputs = Array.from({ length: 5 }, (_unused, index) => ({
    boardType: index % 2 === 0 ? 'tension' : 'kilter',
    uuid: `bounded-${index}-${'u'.repeat(45)}`,
    layoutId: 1,
    frames: index === 4 ? 'p0r1,"' : `p${index + 1}r1,"p${index + 11}r2`,
    framesCount: 2,
    holdFingerprint: fingerprintFromRepairRows(staleRows),
    multiFrameTarget: true,
    rows: staleRows,
  }));
  const placementKeys = new Set<string>();
  for (const [index, climb] of climbInputs.entries()) {
    if (index === 4) continue;
    placementKeys.add(placementKey(climb.boardType, 1, index + 1));
    placementKeys.add(placementKey(climb.boardType, 1, index + 11));
  }
  const manifest = buildRepairManifest(climbInputs, placementKeys);
  const projectedByIdentity = new Map(
    manifest.entries.map((entry) => [`${entry.boardType}\u0000${entry.uuid}`, entry.projectedRows ?? []]),
  );
  const payloads: Array<{ statement: string; json: string }> = [];
  const executor = {
    execute(query: unknown) {
      const statement = renderedSql(query);
      if (statement.includes('select count(*)::integer as invalid_count')) {
        return Promise.resolve([{ invalid_count: 0 }]);
      }
      const { json, records } = jsonParameter(query);
      payloads.push({ statement, json });
      if (statement.includes('inner join targets')) {
        return Promise.resolve(
          records.flatMap((record) => {
            const boardType = String(record.board_type);
            const climbUuid = String(record.climb_uuid);
            return (projectedByIdentity.get(`${boardType}\u0000${climbUuid}`) ?? []).map((row) => ({
              board_type: boardType,
              climb_uuid: climbUuid,
              hold_id: row.holdId,
              frame_number: row.frameNumber,
              hold_state: row.holdState,
            }));
          }),
        );
      }
      if (statement.includes('using changed')) {
        return Promise.resolve([
          {
            affected_count: records.reduce((total, record) => total + Number(record.expected_rows), 0),
          },
        ]);
      }
      if (statement.includes('update board_climbs stored')) {
        return Promise.resolve(records.map((record) => ({ board_type: record.board_type, uuid: record.uuid })));
      }
      return Promise.resolve([{ affected_count: records.length }]);
    },
  };
  const limits = { maxIdentityRecords: 2, maxMutationRecords: 3, maxParameterBytes: 400 };

  await applyRepairManifest(executor, manifest, limits);
  await verifyAppliedRepair(executor, manifest, limits);

  assert.ok(payloads.length > 8, 'both record and byte limits create multiple statements');
  assert.ok(payloads.every(({ json }) => Buffer.byteLength(json) <= limits.maxParameterBytes));
  for (const { statement, json } of payloads) {
    const count = (JSON.parse(json) as unknown[]).length;
    const expectedLimit = statement.includes('insert into board_climb_holds') ? 3 : 2;
    assert.ok(count <= expectedLimit, `${statement} exceeded its ${expectedLimit}-record batch cap`);
  }
  assert.ok(
    payloads.filter(({ statement }) => statement.includes('inner join targets')).length >= 3,
    'verification checks every identity batch, including the empty projection',
  );
});

void test('an oversized single JSON record fails before executing SQL', async () => {
  const staleRows: RepairHoldRow[] = [{ holdId: 99, frameNumber: 0, holdState: 'HAND' }];
  const manifest = buildRepairManifest(
    [
      {
        boardType: 'tension',
        uuid: `oversized-${'u'.repeat(300)}`,
        layoutId: 1,
        frames: 'p1r1,"p2r2',
        framesCount: 2,
        holdFingerprint: fingerprintFromRepairRows(staleRows),
        multiFrameTarget: true,
        rows: staleRows,
      },
    ],
    new Set([placementKey('tension', 1, 1), placementKey('tension', 1, 2)]),
  );
  let executorCalls = 0;

  await assert.rejects(
    applyRepairManifest(
      {
        execute() {
          executorCalls += 1;
          return Promise.resolve([]);
        },
      },
      manifest,
      { maxIdentityRecords: 500, maxMutationRecords: 5_000, maxParameterBytes: 128 },
    ),
    /one repair JSON record exceeds the 128-byte parameter limit/,
  );
  assert.equal(executorCalls, 0);
});

void test('apply and verification preserve global invalid cleanup for non-Aurora entries', async () => {
  const manifest = buildRepairManifest(
    [
      {
        boardType: 'moonboard',
        uuid: 'unsupported',
        layoutId: 1,
        frames: 'p1r1',
        framesCount: 1,
        holdFingerprint: null,
        multiFrameTarget: false,
        rows: [{ holdId: -1, frameNumber: 0, holdState: 'HAND' }],
      },
    ],
    new Set(),
  );
  const statements: string[] = [];
  const executor = {
    execute(query: unknown) {
      const statement = renderedSql(query);
      statements.push(statement);
      if (statement.includes('delete from board_climb_holds stored')) {
        return Promise.resolve([{ affected_count: 1 }]);
      }
      if (statement.includes('select count(*)::integer as invalid_count')) {
        return Promise.resolve([{ invalid_count: 0 }]);
      }
      throw new Error(`unexpected statement: ${statement}`);
    },
  };

  await applyRepairManifest(executor, manifest);
  await verifyAppliedRepair(executor, manifest);
  assert.equal(statements.filter((statement) => statement.includes('delete from board_climb_holds stored')).length, 1);
  assert.doesNotMatch(
    statements.find((statement) => statement.includes('select count(*)::integer as invalid_count')) ?? '',
    /board_type in/,
  );
  assert.deepEqual(DEFAULT_REPAIR_BATCH_LIMITS, {
    maxIdentityRecords: 500,
    maxMutationRecords: 5_000,
    maxParameterBytes: 1024 * 1024,
  });
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

void test('real Postgres rolls every earlier batch back when a later fingerprint batch fails', async (context) => {
  const databaseUrl = process.env.REPAIR_BOARD_CLIMB_HOLDS_TEST_DB_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl || !isLocalDatabaseUrl(databaseUrl)) {
    context.skip('set REPAIR_BOARD_CLIMB_HOLDS_TEST_DB_URL or DATABASE_URL to a local migrated Postgres');
    return;
  }

  const { db, close } = createScriptDb(databaseUrl);
  const staleRows: RepairHoldRow[] = [{ holdId: 99, frameNumber: 0, holdState: 'HAND' }];
  const staleFingerprint = fingerprintFromRepairRows(staleRows);
  const manifest = twoChangedEntriesManifest('rollback');
  type StoredHoldSnapshot = {
    board_type: string;
    climb_uuid: string;
    hold_id: number;
    frame_number: number;
    hold_state: string;
  };
  type StoredClimbSnapshot = { board_type: string; uuid: string; hold_fingerprint: string | null };

  try {
    await db.execute(sql`
      CREATE TEMP TABLE board_climbs (
        board_type text NOT NULL,
        uuid text PRIMARY KEY,
        layout_id integer NOT NULL,
        frames text,
        frames_count integer,
        hold_fingerprint text
      ) ON COMMIT PRESERVE ROWS
    `);
    await db.execute(sql`
      CREATE TEMP TABLE board_climb_holds (
        board_type text NOT NULL,
        climb_uuid text NOT NULL,
        hold_id integer NOT NULL,
        frame_number integer NOT NULL,
        hold_state text NOT NULL,
        PRIMARY KEY (board_type, climb_uuid, hold_id)
      ) ON COMMIT PRESERVE ROWS
    `);
    await db.execute(sql`
      INSERT INTO board_climbs (board_type, uuid, layout_id, frames, frames_count, hold_fingerprint)
      VALUES
        ('tension', 'rollback-a', 1, 'p1r1,"p2r2', 2, ${staleFingerprint}),
        ('tension', 'rollback-b', 1, 'p3r1,"p4r2', 2, 'forced-late-guard-mismatch')
    `);
    await db.execute(sql`
      INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
      VALUES
        ('tension', 'rollback-a', 99, 0, 'HAND'),
        ('tension', 'rollback-b', 99, 0, 'HAND')
    `);

    const holdsBefore = await executeRows<StoredHoldSnapshot>(
      db,
      sql`
        SELECT board_type, climb_uuid, hold_id, frame_number, hold_state
        FROM board_climb_holds
        ORDER BY board_type, climb_uuid, hold_id
      `,
    );
    const climbsBefore = await executeRows<StoredClimbSnapshot>(
      db,
      sql`
        SELECT board_type, uuid, hold_fingerprint
        FROM board_climbs
        ORDER BY board_type, uuid
      `,
    );

    await assert.rejects(
      db.transaction(async (transaction) => {
        await applyRepairManifest(transaction, manifest, {
          maxIdentityRecords: 1,
          maxMutationRecords: 1,
          maxParameterBytes: 1024,
        });
      }),
      /fingerprint guard failed for tension\/rollback-b/,
    );

    const holdsAfter = await executeRows<StoredHoldSnapshot>(
      db,
      sql`
        SELECT board_type, climb_uuid, hold_id, frame_number, hold_state
        FROM board_climb_holds
        ORDER BY board_type, climb_uuid, hold_id
      `,
    );
    const climbsAfter = await executeRows<StoredClimbSnapshot>(
      db,
      sql`
        SELECT board_type, uuid, hold_fingerprint
        FROM board_climbs
        ORDER BY board_type, uuid
      `,
    );
    assert.deepEqual(Array.from(holdsAfter), Array.from(holdsBefore));
    assert.deepEqual(Array.from(climbsAfter), Array.from(climbsBefore));
  } finally {
    await close();
  }
});
