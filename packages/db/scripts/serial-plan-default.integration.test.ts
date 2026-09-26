/// <reference types="node" />

/**
 * The claim in #5352's fix that no unit test can make: against a real Postgres
 * wearing the production role shape, `ALTER DATABASE ... SET` is refused, and
 * migration 0225's `EXCEPTION WHEN insufficient_privilege THEN RAISE WARNING`
 * turns that refusal into a zero-exit-code success.
 *
 * The shape, from docs/postgres-18-migration.md § "Target roles and secrets" and
 * `production-deploy.yml`'s migrate job:
 *
 *   - the database is owned by a superuser (Railway provisions it that way),
 *   - `<owner>` is NOLOGIN, holds CREATE on the database, and does NOT own it,
 *   - `<migrator>` is the LOGIN credential and may only `SET ROLE <owner>`.
 *
 * This is the PG18 cutover layout. Since the Sep 2026 replication work the
 * production owner role owns the database instead, which
 * `reserveMigrationOwnerSession` also accepts (migration-owner-role.ts).
 *
 * Runs against this job's stock `postgres:17` service; skipped when
 * SERIAL_PLAN_DB_URL is unset, the same gate the migration-journal and
 * migration-owner integration suites use.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import {
  applySerialPlanDatabaseDefault,
  isSerialPlanFailure,
  readSerialPlanState,
  runSerialPlanVerification,
  type SerialPlanClient,
  type SerialPlanTransactionalConnection,
  type SerialPlanConnection,
} from './serial-plan-default.js';

const superuserUrl = process.env.SERIAL_PLAN_DB_URL;

const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const databaseName = `serial_plan_${suffix}`;
const cliDatabaseName = `serial_plan_cli_${suffix}`;
const restoreDatabaseName = `serial_plan_restore_${suffix}`;
const retainedDatabaseName = `serial_plan_retained_${suffix}`;
const precreatedDatabaseName = `serial_plan_precreated_${suffix}`;
const ownerRole = `sp_owner_${suffix}`;
const migratorRole = `sp_migrator_${suffix}`;
const runtimeRole = `sp_runtime_${suffix}`;
const rolePassword = 'serial_plan_integration';

/** Rewrites the superuser URL's credentials and database, keeping host/port/params. */
function urlFor(role: string | null, database: string): string {
  const parsed = new URL(superuserUrl!);
  if (role) {
    parsed.username = role;
    parsed.password = rolePassword;
  }
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Use matching clients from the fixture container in CI, or installed clients locally. */
function runPostgresTool(command: 'pg_dump' | 'pg_restore', args: string[], database: string, input?: Buffer): Buffer {
  const connection = new URL(superuserUrl!);
  const container = process.env.SERIAL_PLAN_PG_CONTAINER;
  const environment = {
    ...process.env,
    PGHOST: container ? '127.0.0.1' : connection.hostname,
    PGPORT: container ? '5432' : connection.port || '5432',
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGDATABASE: database,
  };
  const databaseArgs = ['--dbname', database, ...args];
  const toolArgs = container
    ? [
        'exec',
        '-i',
        ...['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].flatMap((name) => ['--env', name]),
        container,
        command,
        ...databaseArgs,
      ]
    : databaseArgs;
  const result = spawnSync(container ? 'docker' : command, toolArgs, {
    env: environment,
    input,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} failed: ${result.stderr?.toString()}`);
  return result.stdout;
}

function opener(connectionUrl: string): () => Promise<SerialPlanTransactionalConnection> {
  return async () => {
    const pool = postgres(connectionUrl, { max: 1 });
    return {
      client: pool as unknown as SerialPlanClient,
      transaction: <T>(use: (client: SerialPlanClient) => Promise<T>) =>
        pool.begin((transactionClient) =>
          use(transactionClient as unknown as SerialPlanClient),
        ) as unknown as Promise<T>,
      close: () => pool.end(),
    };
  };
}

async function readFreshState(connectionUrl: string) {
  const connection = await opener(connectionUrl)();
  try {
    return await readSerialPlanState(connection.client);
  } finally {
    await connection.close();
  }
}

/**
 * A session shaped exactly like the production migration session: connected as
 * the restricted LOGIN role, then `SET ROLE` to the NOLOGIN owner.
 */
async function migrationShapedSession(): Promise<SerialPlanConnection> {
  const pool = postgres(urlFor(migratorRole, databaseName), { max: 1 });
  await pool.unsafe(`SET ROLE "${ownerRole}"`);
  return { client: pool as unknown as SerialPlanClient, close: () => pool.end() };
}

void describe('serial-plan database default against a real Postgres', { skip: !superuserUrl }, () => {
  before(async () => {
    const bootstrap = postgres(superuserUrl!, { max: 1 });
    try {
      await bootstrap.unsafe(`CREATE DATABASE "${databaseName}"`);
      await bootstrap.unsafe(`CREATE DATABASE "${cliDatabaseName}"`);
      await bootstrap.unsafe(
        `CREATE ROLE "${ownerRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
      );
      for (const role of [migratorRole, runtimeRole]) {
        await bootstrap.unsafe(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
        );
      }
      await bootstrap.unsafe(`GRANT CREATE ON DATABASE "${databaseName}" TO "${ownerRole}"`);
      await bootstrap.unsafe(`GRANT "${ownerRole}" TO "${migratorRole}" WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
    } finally {
      await bootstrap.end();
    }
  });

  after(async () => {
    const bootstrap = postgres(superuserUrl!, { max: 1 });
    try {
      await bootstrap.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await bootstrap.unsafe(`DROP DATABASE IF EXISTS "${cliDatabaseName}" WITH (FORCE)`);
      for (const database of [restoreDatabaseName, retainedDatabaseName, precreatedDatabaseName]) {
        await bootstrap.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      }
      for (const role of [migratorRole, runtimeRole, ownerRole]) {
        await bootstrap.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      }
    } finally {
      await bootstrap.end();
    }
  });

  void it('confirms the database is not owned by the migration owner role', async () => {
    const pool = postgres(urlFor(null, databaseName), { max: 1 });
    try {
      const [row] = (await pool.unsafe(
        `SELECT pg_get_userbyid(datdba) AS "databaseOwner" FROM pg_database WHERE datname = current_database()`,
      )) as unknown as Array<{ databaseOwner: string }>;
      assert.notEqual(row.databaseOwner, ownerRole);
      assert.notEqual(row.databaseOwner, migratorRole);
    } finally {
      await pool.end();
    }
  });

  void it("migration 0225's DO block is a silent no-op under the production role", async () => {
    // Reproduces the merged fix verbatim. It must NOT throw — that is the bug:
    // drizzle records the migration and never retries it.
    const session = await migrationShapedSession();
    try {
      await session.client.unsafe(`
        DO $$
        BEGIN
          EXECUTE format('ALTER DATABASE %I SET max_parallel_workers_per_gather = 0', current_database());
        EXCEPTION
          WHEN insufficient_privilege THEN
            RAISE WARNING 'boardsesh: could not set max_parallel_workers_per_gather on database %', current_database();
        END
        $$;
      `);
    } finally {
      await session.close();
    }

    const runtime = await opener(urlFor(runtimeRole, databaseName))();
    try {
      const reading = await readSerialPlanState(runtime.client);
      assert.equal(reading.databaseDefault, null, 'the migration left no database default behind');
      assert.notEqual(reading.effectiveValue, '0', 'application sessions can still plan a Gather');
    } finally {
      await runtime.close();
    }
  });

  void it('surfaces the refusal rather than swallowing it', async () => {
    const session = await migrationShapedSession();
    const runtime = await opener(urlFor(runtimeRole, databaseName))();
    try {
      const applicationReading = await readSerialPlanState(runtime.client);
      const outcome = await applySerialPlanDatabaseDefault(session.client, applicationReading);
      assert.equal(outcome.status, 'not-permitted');
      assert.equal(isSerialPlanFailure(outcome), true);
      assert.match(outcome.status === 'not-permitted' ? outcome.detail : '', /must be owner of database/);
    } finally {
      await runtime.close();
      await session.close();
    }
  });

  void it('reports privilege refusal from a transaction-pinned admin connection', async () => {
    const warnings: string[] = [];
    const exitCode = await runSerialPlanVerification({
      openApplicationClient: opener(urlFor(runtimeRole, databaseName)),
      openAdminClient: opener(urlFor(migratorRole, databaseName)),
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    assert.equal(exitCode, 1);
    assert.ok(warnings.some((message) => message.includes('ADMIN_DATABASE_URL does not own')));
    assert.ok(warnings.some((message) => message.includes('ALTER DATABASE')));
    const runtime = await opener(urlFor(runtimeRole, databaseName))();
    try {
      assert.equal((await readSerialPlanState(runtime.client)).databaseDefault, null);
    } finally {
      await runtime.close();
    }
  });

  void it('fails the run when no owner-capable credential is configured', async () => {
    const warnings: string[] = [];
    const exitCode = await runSerialPlanVerification({
      openApplicationClient: opener(urlFor(runtimeRole, databaseName)),
      openAdminClient: null,
      log: () => {},
      warn: (message) => warnings.push(message),
    });

    assert.equal(exitCode, 1);
    assert.ok(warnings.some((line) => line.includes(`ALTER DATABASE "${databaseName}"`)));
  });

  void it('--check-only ignores an owner-capable URL and leaves the database default unchanged', async () => {
    const runtimeUrl = urlFor(runtimeRole, cliDatabaseName);
    const adminUrl = urlFor(null, cliDatabaseName);
    const before = await readFreshState(runtimeUrl);
    assert.equal(before.databaseDefault, null);
    assert.notEqual(before.effectiveValue, '0');

    const cliPath = fileURLToPath(new URL('./verify-serial-plan.ts', import.meta.url));
    const cliEnvironment = {
      ...process.env,
      DATABASE_URL: runtimeUrl,
      POSTGRES_URL: runtimeUrl,
      ADMIN_DATABASE_URL: adminUrl,
    };
    const checked = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--check-only'], {
      env: cliEnvironment,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(checked.error);
    assert.equal(checked.status, 1, 'check-only must report the unapplied default');
    assert.match(checked.stderr, /parallel query is ON/);

    assert.deepEqual(await readFreshState(runtimeUrl), before);

    // Positive control: the exact same credentials can apply when the flag is absent.
    const applied = spawnSync(process.execPath, ['--import', 'tsx', cliPath], {
      env: cliEnvironment,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(applied.error);
    assert.equal(applied.status, 0, 'the admin URL must genuinely be capable of applying the default');
    const confirmed = await readFreshState(runtimeUrl);
    assert.equal(confirmed.databaseDefault, '0');
    assert.equal(confirmed.effectiveValue, '0');
  });

  void it('applies the default through an owning connection and application sessions inherit it', async () => {
    const exitCode = await runSerialPlanVerification({
      openApplicationClient: opener(urlFor(runtimeRole, databaseName)),
      openAdminClient: opener(urlFor(null, databaseName)),
      log: () => {},
      warn: () => {},
    });

    assert.equal(exitCode, 0);

    const runtime = await opener(urlFor(runtimeRole, databaseName))();
    try {
      const reading = await readSerialPlanState(runtime.client);
      assert.equal(reading.effectiveValue, '0');
      assert.equal(reading.databaseDefault, '0');
    } finally {
      await runtime.close();
    }
  });

  void it('preserves the default with --create, and requires reapplication for a precreated restore', async () => {
    const bootstrap = postgres(superuserUrl!, { max: 1 });
    try {
      await bootstrap.unsafe(`CREATE DATABASE "${restoreDatabaseName}"`);
      await bootstrap.unsafe(`ALTER DATABASE "${restoreDatabaseName}" SET max_parallel_workers_per_gather = 0`);
      const source = postgres(urlFor(null, restoreDatabaseName), { max: 1 });
      try {
        await source.unsafe('CREATE SCHEMA drizzle');
        await source.unsafe(
          'CREATE TABLE drizzle.__drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL, created_at bigint)',
        );
        await source.unsafe(
          "INSERT INTO drizzle.__drizzle_migrations VALUES (225, 'already-applied-0225', 1780000000000)",
        );
        await source.unsafe(`GRANT USAGE ON SCHEMA drizzle TO "${runtimeRole}"`);
        await source.unsafe(`GRANT SELECT ON drizzle.__drizzle_migrations TO "${runtimeRole}"`);
      } finally {
        await source.end();
      }
      const archive = runPostgresTool('pg_dump', ['--format=custom'], restoreDatabaseName);
      // Keep the source fixture intact while freeing its name: --create restores
      // the archive's database name, not the maintenance connection's database.
      await bootstrap.unsafe(`ALTER DATABASE "${restoreDatabaseName}" RENAME TO "${retainedDatabaseName}"`);
      runPostgresTool('pg_restore', ['--create', '--exit-on-error'], 'postgres', archive);

      const restoredRuntimeUrl = urlFor(runtimeRole, restoreDatabaseName);
      const restoredState = await readFreshState(restoredRuntimeUrl);
      assert.equal(restoredState.databaseDefault, '0');
      assert.equal(restoredState.effectiveValue, '0');
      const restored = postgres(restoredRuntimeUrl, { max: 1 });
      try {
        const rows = await restored.unsafe('SELECT hash FROM drizzle.__drizzle_migrations WHERE id = 225');
        assert.equal(
          rows[0]?.hash,
          'already-applied-0225',
          'the migration ledger survives; migration 0225 will not replay',
        );
      } finally {
        await restored.end();
      }
      assert.equal(
        await runSerialPlanVerification({
          openApplicationClient: opener(restoredRuntimeUrl),
          openAdminClient: null,
          log: () => {},
          warn: () => {},
        }),
        0,
        'a --create restore needs no administrator replay',
      );

      await bootstrap.unsafe(`CREATE DATABASE "${precreatedDatabaseName}"`);
      runPostgresTool('pg_restore', ['--exit-on-error'], precreatedDatabaseName, archive);
      const precreatedRuntimeUrl = urlFor(runtimeRole, precreatedDatabaseName);
      assert.equal((await readFreshState(precreatedRuntimeUrl)).databaseDefault, null);
      assert.equal(
        await runSerialPlanVerification({
          openApplicationClient: opener(precreatedRuntimeUrl),
          openAdminClient: null,
          log: () => {},
          warn: () => {},
        }),
        1,
        'restoring into a precreated database must not pass the cutover check',
      );
      assert.equal(
        await runSerialPlanVerification({
          openApplicationClient: opener(precreatedRuntimeUrl),
          openAdminClient: opener(urlFor(null, precreatedDatabaseName)),
          log: () => {},
          warn: () => {},
        }),
        0,
        'an owner-capable connection can explicitly reapply the missing default',
      );
    } finally {
      await bootstrap.end();
    }
  });

  void it('is idempotent: a second run issues no DDL', async () => {
    let adminOpened = 0;
    const exitCode = await runSerialPlanVerification({
      openApplicationClient: opener(urlFor(runtimeRole, databaseName)),
      openAdminClient: () => {
        adminOpened += 1;
        return opener(urlFor(null, databaseName))();
      },
      log: () => {},
      warn: () => {},
    });

    assert.equal(exitCode, 0);
    assert.equal(adminOpened, 0);
  });
});
