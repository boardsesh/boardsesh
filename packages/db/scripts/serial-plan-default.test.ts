/**
 * Round 5b of the DSM saga (#5352).
 *
 * Migration 0225 set `max_parallel_workers_per_gather = 0` with
 * `ALTER DATABASE ... SET` and wrapped it in
 * `EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING`. In production the
 * migration role is deliberately not the database owner, so that statement
 * always raised — and the handler turned "I could not do the one thing this
 * migration exists for" into a zero-exit-code success that drizzle recorded and
 * will never retry.
 *
 * These tests pin the opposite shape. The refusal must come back as a value the
 * caller has to deal with, the verification must exit non-zero, and the
 * post-apply confirmation must come from a NEW session — because the session
 * that issues `ALTER DATABASE ... SET` keeps its old value, so re-reading it
 * would be exactly the vacuous check that made 0225 look like it worked.
 *
 * DB-free: the whole decision tree runs against a fake client. The real-Postgres
 * half lives in serial-plan-default.integration.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INSUFFICIENT_PRIVILEGE,
  SERIAL_PLAN_TARGET_VALUE,
  applySerialPlanDatabaseDefault,
  isSerialPlanFailure,
  readSerialPlanState,
  runSerialPlanVerification,
  serialPlanAlterStatement,
  serialPlanRemediation,
  type SerialPlanClient,
  type SerialPlanConnection,
} from './serial-plan-default.js';

type Reading = { databaseName: string; effectiveValue: string; databaseDefault: string | null };

/**
 * A client whose catalog state the test controls. `ALTER DATABASE` updates
 * `databaseDefault` but deliberately leaves `effectiveValue` alone, mirroring
 * Postgres: the issuing session keeps the old value.
 */
function fakeClient(
  initial: Reading,
  options: { alterError?: unknown; alterIsNoOp?: boolean } = {},
): SerialPlanClient & { statements: string[]; state: Reading } {
  const state = { ...initial };
  const statements: string[] = [];
  return {
    statements,
    state,
    unsafe(statement: string) {
      statements.push(statement);
      if (statement.startsWith('ALTER DATABASE')) {
        if (options.alterError) return Promise.reject(options.alterError);
        if (!options.alterIsNoOp) state.databaseDefault = SERIAL_PLAN_TARGET_VALUE;
        return Promise.resolve([]);
      }
      return Promise.resolve([{ ...state }]);
    },
  };
}

function connectionTo(client: SerialPlanClient): () => Promise<SerialPlanConnection> {
  return () => Promise.resolve({ client, close: () => Promise.resolve() });
}

function privilegeError(): Error & { code: string } {
  return Object.assign(new Error('must be owner of database railway'), { code: INSUFFICIENT_PRIVILEGE });
}

const OFF: Reading = { databaseName: 'railway', effectiveValue: '2', databaseDefault: null };
const ON: Reading = { databaseName: 'railway', effectiveValue: '0', databaseDefault: '0' };

void test('the ALTER statement names the database and the target value', () => {
  assert.equal(serialPlanAlterStatement('railway'), 'ALTER DATABASE "railway" SET max_parallel_workers_per_gather = 0');
});

void test('rejects a database name that is not a simple identifier', () => {
  for (const databaseName of ['', 'rail way', 'railway"; DROP DATABASE x; --', '1railway']) {
    assert.throws(() => serialPlanAlterStatement(databaseName), /simple PostgreSQL identifier/);
  }
});

void test('reads the session value and the database default apart', async () => {
  const client = fakeClient({ databaseName: 'railway', effectiveValue: '2', databaseDefault: '0' });
  assert.deepEqual(await readSerialPlanState(client), {
    databaseName: 'railway',
    effectiveValue: '2',
    databaseDefault: '0',
  });
});

void test('applies the database default when the session can own the database', async () => {
  const client = fakeClient(OFF);

  const outcome = await applySerialPlanDatabaseDefault(client);

  assert.equal(outcome.status, 'applied');
  assert.equal(isSerialPlanFailure(outcome), false);
  assert.ok(
    client.statements.includes('ALTER DATABASE "railway" SET max_parallel_workers_per_gather = 0'),
    'the ALTER must actually be issued',
  );
  assert.equal(outcome.reading.databaseDefault, SERIAL_PLAN_TARGET_VALUE);
});

void test('issues nothing when the database already carries the default', async () => {
  const client = fakeClient(ON);

  const outcome = await applySerialPlanDatabaseDefault(client);

  assert.equal(outcome.status, 'already-applied');
  assert.equal(
    client.statements.filter((statement) => statement.startsWith('ALTER DATABASE')).length,
    0,
    'idempotent: a database that already has the default gets no DDL',
  );
});

void test('surfaces a privilege refusal instead of swallowing it', async () => {
  // The whole bug. 0225 caught this SQLSTATE and turned it into a warning.
  const client = fakeClient(OFF, { alterError: privilegeError() });

  const outcome = await applySerialPlanDatabaseDefault(client);

  assert.equal(outcome.status, 'not-permitted');
  assert.equal(isSerialPlanFailure(outcome), true);
  assert.match(outcome.status === 'not-permitted' ? outcome.detail : '', /must be owner of database/);
});

void test('does not misread an unrelated error as a privilege refusal', async () => {
  // Classifying every failure as "the role cannot do this" would rebuild the
  // silent no-op with a different label.
  const client = fakeClient(OFF, { alterError: Object.assign(new Error('connection terminated'), { code: '57P01' }) });

  await assert.rejects(() => applySerialPlanDatabaseDefault(client), /connection terminated/);
});

void test('refuses to report success when the catalog did not change', async () => {
  const client = fakeClient(OFF, { alterIsNoOp: true });

  await assert.rejects(() => applySerialPlanDatabaseDefault(client), /reported success but/);
});

void test('the remediation names the exact statement an operator must run', () => {
  const lines = serialPlanRemediation('railway');

  assert.ok(
    lines.some((line) => line.includes('ALTER DATABASE "railway" SET max_parallel_workers_per_gather = 0')),
    'an operator handoff that does not carry the statement is not a handoff',
  );
  assert.ok(lines.some((line) => line.includes('/health/db')));
});

void test('verification passes, and touches nothing, when application sessions are already serial', async () => {
  const application = fakeClient(ON);
  let adminOpened = 0;

  const exitCode = await runSerialPlanVerification({
    openApplicationClient: connectionTo(application),
    openAdminClient: () => {
      adminOpened += 1;
      return Promise.resolve({ client: fakeClient(ON), close: () => Promise.resolve() });
    },
    log: () => {},
    warn: () => {},
  });

  assert.equal(exitCode, 0);
  assert.equal(adminOpened, 0, 'no admin connection is opened when there is nothing to fix');
  assert.equal(application.statements.filter((statement) => statement.startsWith('ALTER DATABASE')).length, 0);
});

void test('a run with no owner-capable credential fails instead of recording success', async () => {
  // The production shape today: the deploy connects as a role that is
  // deliberately not the database owner, and nothing can apply the setting.
  const warnings: string[] = [];

  const exitCode = await runSerialPlanVerification({
    openApplicationClient: connectionTo(fakeClient(OFF)),
    openAdminClient: null,
    log: () => {},
    warn: (message) => warnings.push(message),
  });

  assert.equal(exitCode, 1);
  assert.ok(
    warnings.some((line) => line.includes('ALTER DATABASE "railway" SET max_parallel_workers_per_gather = 0')),
    'the failure has to carry its own fix',
  );
});

void test('an admin credential that does not own the database still fails the run', async () => {
  const exitCode = await runSerialPlanVerification({
    openApplicationClient: connectionTo(fakeClient(OFF)),
    openAdminClient: connectionTo(fakeClient(OFF, { alterError: privilegeError() })),
    log: () => {},
    warn: () => {},
  });

  assert.equal(exitCode, 1);
});

void test('an owning admin credential applies the default and re-checks on a NEW session', async () => {
  // `ALTER DATABASE ... SET` never changes the session that issued it, so the
  // confirmation has to come from a connection opened afterwards.
  const admin = fakeClient(OFF);
  const applicationSessions: Array<ReturnType<typeof fakeClient>> = [];

  const exitCode = await runSerialPlanVerification({
    openApplicationClient: () => {
      // Session 1 sees the pre-apply value; session 2 is opened after the ALTER
      // and inherits the new database default.
      const client = fakeClient(applicationSessions.length === 0 ? OFF : ON);
      applicationSessions.push(client);
      return Promise.resolve({ client, close: () => Promise.resolve() });
    },
    openAdminClient: connectionTo(admin),
    log: () => {},
    warn: () => {},
  });

  assert.equal(exitCode, 0);
  assert.equal(applicationSessions.length, 2, 'the confirmation must be a second, fresh application session');
  assert.ok(admin.statements.some((statement) => statement.startsWith('ALTER DATABASE')));
});

void test('an apply that never reaches application sessions is a failure, not a success', async () => {
  // A database default present in the catalog but not effective for the app —
  // e.g. a role-level override, or a pooler handing back a pinned session — is
  // no fix at all, and must not be reported as one.
  const exitCode = await runSerialPlanVerification({
    openApplicationClient: connectionTo(fakeClient(OFF)),
    openAdminClient: connectionTo(fakeClient(OFF)),
    log: () => {},
    warn: () => {},
  });

  assert.equal(exitCode, 1);
});
