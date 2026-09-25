/// <reference types="node" />

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
  type SerialPlanTransactionalConnection,
} from './serial-plan-default.js';

type Reading = {
  databaseName: string;
  serverAddress: string | null;
  serverPort: number | null;
  serverStartedAt: string | null;
  effectiveValue: string;
  databaseDefault: string | null;
};

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

function connectionTo(client: SerialPlanClient): () => Promise<SerialPlanTransactionalConnection> {
  return () =>
    Promise.resolve({
      client,
      transaction: <T>(use: (transactionClient: SerialPlanClient) => Promise<T>) => use(client),
      close: () => Promise.resolve(),
    });
}

function privilegeError(): Error & { code: string } {
  return Object.assign(new Error('must be owner of database railway'), { code: INSUFFICIENT_PRIVILEGE });
}

const SERVER = { serverAddress: '10.0.0.1', serverPort: 5432, serverStartedAt: '2026-09-24 10:00:00+00' };
const OFF: Reading = { databaseName: 'railway', ...SERVER, effectiveValue: '2', databaseDefault: null };
const ON: Reading = { databaseName: 'railway', ...SERVER, effectiveValue: '0', databaseDefault: '0' };

void test('the ALTER statement names the database and the target value', () => {
  assert.equal(serialPlanAlterStatement('railway'), 'ALTER DATABASE "railway" SET max_parallel_workers_per_gather = 0');
});

void test('rejects a database name that is not a simple identifier', () => {
  for (const databaseName of [
    '',
    'rail way',
    'railway-abc123',
    'râilway',
    'railway"; DROP DATABASE x; --',
    '1railway',
  ]) {
    assert.throws(() => serialPlanAlterStatement(databaseName), /simple PostgreSQL identifier/);
  }
});

void test('reads the session value and the database default apart', async () => {
  const client = fakeClient({ ...OFF, databaseDefault: '0' });
  assert.deepEqual(await readSerialPlanState(client), {
    databaseName: 'railway',
    ...SERVER,
    effectiveValue: '2',
    databaseDefault: '0',
  });
});

void test('applies the database default when the session can own the database', async () => {
  const client = fakeClient(OFF);

  const outcome = await applySerialPlanDatabaseDefault(client, OFF);

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

  const outcome = await applySerialPlanDatabaseDefault(client, OFF);

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

  const outcome = await applySerialPlanDatabaseDefault(client, OFF);

  assert.equal(outcome.status, 'not-permitted');
  assert.equal(isSerialPlanFailure(outcome), true);
  assert.match(outcome.status === 'not-permitted' ? outcome.detail : '', /must be owner of database/);
});

void test('does not misread an unrelated error as a privilege refusal', async () => {
  // Classifying every failure as "the role cannot do this" would rebuild the
  // silent no-op with a different label.
  const client = fakeClient(OFF, { alterError: Object.assign(new Error('connection terminated'), { code: '57P01' }) });

  await assert.rejects(() => applySerialPlanDatabaseDefault(client, OFF), /connection terminated/);
});

void test('refuses to report success when the catalog did not change', async () => {
  const client = fakeClient(OFF, { alterIsNoOp: true });

  await assert.rejects(() => applySerialPlanDatabaseDefault(client, OFF), /reported success but/);
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
      return connectionTo(fakeClient(ON))();
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

for (const databaseName of ['railway-test', 'râilway', 'railway"; DROP DATABASE x; --']) {
  void test(`unsupported database name ${JSON.stringify(databaseName)} reports a failure without opening admin`, async () => {
    for (const hasAdminCredential of [false, true]) {
      const application = fakeClient({ ...OFF, databaseName });
      const warnings: string[] = [];
      let adminOpened = false;
      const exitCode = await runSerialPlanVerification({
        openApplicationClient: connectionTo(application),
        openAdminClient: hasAdminCredential
          ? () => {
              adminOpened = true;
              return connectionTo(fakeClient({ ...OFF, databaseName }))();
            }
          : null,
        log: () => {},
        warn: (message) => warnings.push(message),
      });

      assert.equal(exitCode, 1);
      assert.equal(adminOpened, false);
      assert.ok(warnings.some((line) => line.includes('simple ASCII PostgreSQL identifiers')));
      assert.ok(warnings.some((line) => line.includes('database owner')));
      assert.ok(warnings.some((line) => line.includes('/health/db')));
      assert.equal(
        application.statements.some((statement) => statement.startsWith('ALTER DATABASE')),
        false,
      );
      assert.equal(
        warnings.some((line) => line.includes('ALTER DATABASE')),
        false,
      );
      assert.equal(
        warnings.some((line) => line.includes('Or set ADMIN_DATABASE_URL')),
        false,
      );
    }
  });
}

void test('an admin credential that does not own the database still fails the run', async () => {
  const exitCode = await runSerialPlanVerification({
    openApplicationClient: connectionTo(fakeClient(OFF)),
    openAdminClient: connectionTo(fakeClient(OFF, { alterError: privilegeError() })),
    log: () => {},
    warn: () => {},
  });

  assert.equal(exitCode, 1);
});

void test('refuses to ALTER a database other than the application database', async () => {
  // ADMIN_DATABASE_URL pointed at a maintenance database (`/postgres`) with a
  // superuser: the ALTER would succeed — on the wrong database.
  const maintenance = fakeClient({ ...OFF, databaseName: 'postgres' });

  const outcome = await applySerialPlanDatabaseDefault(maintenance, OFF);

  assert.equal(outcome.status, 'wrong-database');
  assert.equal(isSerialPlanFailure(outcome), true);
  assert.equal(
    maintenance.statements.filter((statement) => statement.startsWith('ALTER DATABASE')).length,
    0,
    'no DDL may reach a database the application does not use',
  );
});

void test('an admin credential on a different database fails the run without touching it', async () => {
  const maintenance = fakeClient({ ...OFF, databaseName: 'postgres' });
  const warnings: string[] = [];

  const exitCode = await runSerialPlanVerification({
    openApplicationClient: connectionTo(fakeClient(OFF)),
    openAdminClient: connectionTo(maintenance),
    log: () => {},
    warn: (message) => warnings.push(message),
  });

  assert.equal(exitCode, 1);
  assert.equal(maintenance.statements.filter((statement) => statement.startsWith('ALTER DATABASE')).length, 0);
  assert.equal(maintenance.state.databaseDefault, null);
  assert.ok(
    warnings.some((line) => line.includes('ALTER DATABASE "railway" SET max_parallel_workers_per_gather = 0')),
    'the remediation must name the application database, not the admin one',
  );
});

void test('same database name on another PostgreSQL server never receives ALTER', async () => {
  for (const differentIdentity of [
    { serverAddress: '10.0.0.2' },
    { serverPort: 5433 },
    { serverStartedAt: '2026-09-24 11:00:00+00' },
  ]) {
    const otherCluster = fakeClient({ ...OFF, ...differentIdentity });
    const warnings: string[] = [];

    const exitCode = await runSerialPlanVerification({
      openApplicationClient: connectionTo(fakeClient(OFF)),
      openAdminClient: connectionTo(otherCluster),
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    assert.equal(exitCode, 1);
    assert.equal(otherCluster.state.databaseDefault, null);
    assert.equal(
      otherCluster.statements.some((statement) => statement.startsWith('ALTER DATABASE')),
      false,
    );
    assert.ok(warnings.some((message) => message.includes('same live PostgreSQL server')));
  }
});

void test('missing server identity fails closed before ALTER', async () => {
  for (const missingIdentity of [{ serverAddress: null }, { serverPort: null }, { serverStartedAt: null }]) {
    const admin = fakeClient({ ...OFF, ...missingIdentity });
    const exitCode = await runSerialPlanVerification({
      openApplicationClient: connectionTo(fakeClient(OFF)),
      openAdminClient: connectionTo(admin),
      log: () => {},
      warn: () => {},
    });
    assert.equal(exitCode, 1);
    assert.equal(
      admin.statements.some((statement) => statement.startsWith('ALTER DATABASE')),
      false,
    );

    const adminForMissingApplication = fakeClient(OFF);
    const missingApplicationExit = await runSerialPlanVerification({
      openApplicationClient: connectionTo(fakeClient({ ...OFF, ...missingIdentity })),
      openAdminClient: connectionTo(adminForMissingApplication),
      log: () => {},
      warn: () => {},
    });
    assert.equal(missingApplicationExit, 1);
    assert.equal(
      adminForMissingApplication.statements.some((statement) => statement.startsWith('ALTER DATABASE')),
      false,
    );
  }
});

void test('the application transaction stays pinned until the admin decision is complete', async () => {
  let applicationClosed = false;
  let applicationTransactionActive = false;
  const admin = fakeClient(OFF);
  const adminClient: SerialPlanClient = {
    unsafe(statement) {
      if (statement.startsWith('ALTER DATABASE')) {
        assert.equal(applicationClosed, false);
        assert.equal(applicationTransactionActive, true);
      }
      return admin.unsafe(statement);
    },
  };
  let applicationOpened = 0;
  const exitCode = await runSerialPlanVerification({
    openApplicationClient: () => {
      const client = fakeClient(applicationOpened++ === 0 ? OFF : ON);
      return Promise.resolve({
        client,
        transaction: async <T>(use: (transactionClient: SerialPlanClient) => Promise<T>) => {
          applicationTransactionActive = true;
          try {
            return await use(client);
          } finally {
            applicationTransactionActive = false;
          }
        },
        close: () => {
          applicationClosed = true;
          return Promise.resolve();
        },
      });
    },
    openAdminClient: connectionTo(adminClient),
    log: () => {},
    warn: () => {},
  });
  assert.equal(exitCode, 0);
  assert.equal(applicationClosed, true);
});

void test('admin probe and ALTER use one pinned transaction behind a routing pool', async () => {
  const pinnedAdmin = fakeClient(OFF);
  let transactionCalls = 0;
  let unpinnedCalls = 0;
  let applicationOpens = 0;

  const exitCode = await runSerialPlanVerification({
    openApplicationClient: () => connectionTo(fakeClient(applicationOpens++ === 0 ? OFF : ON))(),
    openAdminClient: () =>
      Promise.resolve({
        client: {
          unsafe() {
            unpinnedCalls += 1;
            return Promise.resolve([{ ...OFF, serverAddress: '10.0.0.2' }]);
          },
        },
        transaction: <T>(use: (client: SerialPlanClient) => Promise<T>) => {
          transactionCalls += 1;
          return use(pinnedAdmin);
        },
        close: () => Promise.resolve(),
      }),
    log: () => {},
    warn: () => {},
  });

  assert.equal(exitCode, 0);
  assert.equal(transactionCalls, 1);
  assert.equal(unpinnedCalls, 0);
  assert.ok(pinnedAdmin.statements.some((statement) => statement.startsWith('ALTER DATABASE')));
});

void test('a privilege failure that aborts the admin transaction reports remediation', async () => {
  const warnings: string[] = [];
  const admin = fakeClient(OFF, { alterError: privilegeError() });
  const exitCode = await runSerialPlanVerification({
    openApplicationClient: connectionTo(fakeClient(OFF)),
    openAdminClient: () =>
      Promise.resolve({
        client: admin,
        transaction: async <T>(use: (client: SerialPlanClient) => Promise<T>) => {
          await use(admin);
          throw privilegeError();
        },
        close: () => Promise.resolve(),
      }),
    log: () => {},
    warn: (message) => warnings.push(message),
  });

  assert.equal(exitCode, 1);
  assert.ok(warnings.some((message) => message.includes('ADMIN_DATABASE_URL does not own')));
  assert.ok(warnings.some((message) => message.includes('ALTER DATABASE')));
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
      return Promise.resolve({
        client,
        transaction: <T>(use: (transactionClient: SerialPlanClient) => Promise<T>) => use(client),
        close: () => Promise.resolve(),
      });
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

void test('a cleanup warning preserves the verification exit code', async () => {
  for (const [reading, expectedExit] of [
    [ON, 0],
    [OFF, 1],
  ] as const) {
    const warnings: string[] = [];
    const exitCode = await runSerialPlanVerification({
      openApplicationClient: () =>
        Promise.resolve({
          client: fakeClient(reading),
          transaction: <T>(use: (transactionClient: SerialPlanClient) => Promise<T>) => use(fakeClient(reading)),
          close: () => Promise.reject(new Error('pool close failed')),
        }),
      openAdminClient: null,
      log: () => {},
      warn: (message) => warnings.push(message),
    });
    assert.equal(exitCode, expectedExit);
    assert.ok(warnings.includes('[serial-plan] connection cleanup failed: pool close failed'));
  }
});

void test('a cleanup warning preserves the original operation error', async () => {
  const operationError = new Error('runtime probe failed');
  const warnings: string[] = [];
  await assert.rejects(
    runSerialPlanVerification({
      openApplicationClient: () =>
        Promise.resolve({
          client: { unsafe: () => Promise.reject(operationError) },
          transaction: <T>(use: (transactionClient: SerialPlanClient) => Promise<T>) =>
            use({ unsafe: () => Promise.reject(operationError) }),
          close: () => {
            throw new Error('pool close also failed');
          },
        }),
      openAdminClient: null,
      log: () => {},
      warn: (message) => warnings.push(message),
    }),
    (error: unknown) => error === operationError,
  );
  assert.deepEqual(warnings, ['[serial-plan] connection cleanup failed: pool close also failed']);
});
