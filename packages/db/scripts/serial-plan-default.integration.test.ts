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
 * `reserveMigrationOwnerSession` asserts `ownerDoesNotOwnDatabase` as a
 * precondition (migration-owner-role.ts), so this is not an accident of
 * provisioning that could be fixed by granting ownership — it is the contract.
 *
 * Runs against this job's stock `postgres:17` service; skipped when
 * SERIAL_PLAN_DB_URL is unset, the same gate the migration-journal and
 * migration-owner integration suites use.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import {
  applySerialPlanDatabaseDefault,
  isSerialPlanFailure,
  readSerialPlanState,
  runSerialPlanVerification,
  type SerialPlanClient,
  type SerialPlanConnection,
} from './serial-plan-default.js';

const superuserUrl = process.env.SERIAL_PLAN_DB_URL;

const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const databaseName = `serial_plan_${suffix}`;
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

function opener(connectionUrl: string): () => Promise<SerialPlanConnection> {
  return async () => {
    const pool = postgres(connectionUrl, { max: 1 });
    return { client: pool as unknown as SerialPlanClient, close: () => pool.end() };
  };
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
    try {
      const outcome = await applySerialPlanDatabaseDefault(session.client);
      assert.equal(outcome.status, 'not-permitted');
      assert.equal(isSerialPlanFailure(outcome), true);
      assert.match(outcome.status === 'not-permitted' ? outcome.detail : '', /must be owner of database/);
    } finally {
      await session.close();
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
