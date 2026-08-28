import assert from 'node:assert/strict';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { reserveMigrationOwnerSession } from './migration-owner-role.js';
import { reconcileMigrationRuntimeAcl, runMigrationWithRuntimeAclContract } from './migration-runtime-acl.js';

const databaseUrl = process.env.MIGRATION_OWNER_TEST_DATABASE_URL;
const adminDatabaseUrl = process.env.MIGRATION_OWNER_TEST_ADMIN_DATABASE_URL;
const runtimeDatabaseUrl = process.env.MIGRATION_OWNER_TEST_RUNTIME_DATABASE_URL;
const loginRole = process.env.MIGRATION_OWNER_TEST_LOGIN_ROLE ?? 'pg18_migration_integration_login';
const ownerRole = process.env.MIGRATION_OWNER_TEST_OWNER_ROLE ?? 'boardsesh_owner';
const snapshotFenceOwnerRole = process.env.MIGRATION_OWNER_TEST_FENCE_OWNER_ROLE ?? 'boardsesh_snapshot_fence_owner';
const subscriberRole = process.env.MIGRATION_OWNER_TEST_SUBSCRIBER_ROLE;
const subscriptionName = process.env.MIGRATION_OWNER_TEST_SUBSCRIPTION_NAME;
const expectSubscriberAbsent = process.env.MIGRATION_OWNER_TEST_EXPECT_SUBSCRIBER_ABSENT === 'true';
const databaseName = process.env.MIGRATION_OWNER_TEST_DATABASE_NAME ?? 'main';
const runtimeRole = process.env.MIGRATION_OWNER_TEST_RUNTIME_ROLE ?? 'pg18_smoke_runtime';
const runtimeSchemas = (process.env.MIGRATION_OWNER_TEST_RUNTIME_SCHEMAS ?? 'public drizzle')
  .split(/\s+/)
  .filter(Boolean);
assert.match(databaseName, /^[A-Za-z_][A-Za-z0-9_]*$/);
const quotedDatabaseName = `"${databaseName}"`;

void test(
  'reserved migration session preserves owner identity and resets before release',
  { skip: !databaseUrl || !adminDatabaseUrl || !runtimeDatabaseUrl },
  async () => {
    const connectionPool = postgres(databaseUrl!, { max: 1 });
    const adminPool = postgres(adminDatabaseUrl!, { max: 1 });
    const runtimePool = postgres(runtimeDatabaseUrl!, { max: 1 });
    let migrationSession: Awaited<ReturnType<typeof reserveMigrationOwnerSession>> | undefined;
    try {
      migrationSession = await reserveMigrationOwnerSession(connectionPool, {
        databaseName,
        loginRole,
        ownerRole,
        snapshotFenceOwnerRole,
      });
      const db = drizzle(migrationSession.client);

      await migrationSession.client.unsafe('DROP SCHEMA IF EXISTS migration_owner_contract CASCADE');
      await db.transaction(async (transaction) => {
        await transaction.execute(sql.raw('CREATE SCHEMA migration_owner_contract'));
        await transaction.execute(
          sql.raw(`
          CREATE TABLE migration_owner_contract.__drizzle_migrations (
            id integer PRIMARY KEY,
            hash text NOT NULL
          )
        `),
        );
        await transaction.execute(
          sql.raw("INSERT INTO migration_owner_contract.__drizzle_migrations VALUES (1, 'owner-ledger')"),
        );
        const [identity] = await transaction.execute<{ currentRole: string; sessionRole: string }>(
          sql.raw(`
        SELECT current_user AS "currentRole", session_user AS "sessionRole"
      `),
        );
        assert.equal(identity?.currentRole, ownerRole);
        assert.equal(identity?.sessionRole, loginRole);
      });

      const [ownership] = await migrationSession.client<
        { ledgerOwner: string; ledgerRows: number; schemaOwner: string }[]
      >`
      SELECT pg_catalog.pg_get_userbyid(namespace.nspowner) AS "schemaOwner",
             pg_catalog.pg_get_userbyid(relation.relowner) AS "ledgerOwner",
             (SELECT count(*)::integer FROM migration_owner_contract.__drizzle_migrations) AS "ledgerRows"
      FROM pg_catalog.pg_namespace AS namespace
      JOIN pg_catalog.pg_class AS relation
        ON relation.relnamespace = namespace.oid
       AND relation.relname = '__drizzle_migrations'
      WHERE namespace.nspname = 'migration_owner_contract'
    `;
      assert.deepEqual(ownership, { schemaOwner: ownerRole, ledgerOwner: ownerRole, ledgerRows: 1 });

      await assert.rejects(
        db.transaction(async (transaction) => {
          await transaction.execute(sql.raw('CREATE TABLE migration_owner_contract.must_rollback (id integer)'));
          throw new Error('force migration rollback');
        }),
        /force migration rollback/,
      );
      const [rollbackState] = await migrationSession.client<{ currentRole: string; rolledBack: boolean }[]>`
      SELECT current_user AS "currentRole",
             pg_catalog.to_regclass('migration_owner_contract.must_rollback') IS NULL AS "rolledBack"
    `;
      assert.deepEqual(rollbackState, { currentRole: ownerRole, rolledBack: true });

      await migrationSession.close();
      migrationSession = undefined;

      const releasedConnection = await connectionPool.reserve();
      try {
        const [releasedIdentity] = await releasedConnection<{ currentRole: string; sessionRole: string }[]>`
        SELECT current_user AS "currentRole", session_user AS "sessionRole"
      `;
        assert.deepEqual(releasedIdentity, { currentRole: loginRole, sessionRole: loginRole });
        await assert.rejects(
          releasedConnection.unsafe('CREATE SCHEMA migration_owner_contract_login_escape'),
          /permission denied for database/,
        );
      } finally {
        releasedConnection.release();
      }

      migrationSession = await reserveMigrationOwnerSession(connectionPool, {
        databaseName,
        loginRole,
        ownerRole,
        snapshotFenceOwnerRole,
      });
      await migrationSession.client.unsafe('DROP SCHEMA migration_owner_contract CASCADE');
      await migrationSession.close();
      migrationSession = undefined;

      // The local/dev no-owner path deliberately uses the ordinary pool. Prove
      // it remains directly compatible with Drizzle transactions after the
      // reserved owner session has been reset and released.
      const localDb = drizzle(connectionPool);
      await localDb.transaction(async (transaction) => {
        const [localIdentity] = await transaction.execute<{ currentRole: string; sessionRole: string }>(
          sql.raw('SELECT current_user AS "currentRole", session_user AS "sessionRole"'),
        );
        assert.deepEqual(localIdentity, { currentRole: loginRole, sessionRole: loginRole });
      });

      migrationSession = await reserveMigrationOwnerSession(connectionPool, {
        databaseName,
        loginRole,
        ownerRole,
        snapshotFenceOwnerRole,
      });
      const appSchema = runtimeSchemas[0]!;
      const testTable = `"${appSchema}".migration_runtime_acl_new_table`;
      const ledgerSchemas = runtimeSchemas.filter((schema) => schema === 'public' || schema === 'drizzle');
      const [publicLedgerState] = await migrationSession.client<{ existed: boolean }[]>`
        SELECT pg_catalog.to_regclass('public.__drizzle_migrations') IS NOT NULL AS existed
      `;
      await migrationSession.client.unsafe(`
        CREATE TABLE ${testTable} (
          id integer PRIMARY KEY,
          marker text NOT NULL
        );
        CREATE FUNCTION "${appSchema}".migration_runtime_acl_function()
          RETURNS integer LANGUAGE sql AS 'SELECT 1';
        CREATE PROCEDURE "${appSchema}".migration_runtime_acl_procedure()
          LANGUAGE sql AS 'SELECT 1'
      `);
      if (ledgerSchemas.includes('public')) {
        await migrationSession.client.unsafe(`CREATE TABLE IF NOT EXISTS public.__drizzle_migrations (
          id integer PRIMARY KEY,
          hash text NOT NULL
        )`);
      }
      await migrationSession.client.unsafe(`
        GRANT SELECT (marker) ON TABLE ${testTable} TO PUBLIC, "${runtimeRole}"
      `);
      for (const ledgerSchema of ledgerSchemas) {
        await migrationSession.client.unsafe(`
          GRANT SELECT (id) ON TABLE "${ledgerSchema}".__drizzle_migrations
            TO PUBLIC, "${runtimeRole}"
        `);
      }
      await reconcileMigrationRuntimeAcl(migrationSession.client, {
        ownerRole,
        runtimeRole,
        schemas: runtimeSchemas,
      });

      await runtimePool.unsafe(`
        INSERT INTO ${testTable} VALUES (1, 'insert');
        SELECT * FROM ${testTable};
        UPDATE ${testTable} SET marker = 'update' WHERE id = 1;
        DELETE FROM ${testTable} WHERE id = 1;
        SELECT "${appSchema}".migration_runtime_acl_function();
        CALL "${appSchema}".migration_runtime_acl_procedure()
      `);
      await assert.rejects(runtimePool.unsafe(`TRUNCATE ${testTable}`), /permission denied/);
      for (const ledger of ledgerSchemas.map((schema) => `${schema}.__drizzle_migrations`)) {
        for (const statement of [
          `SELECT * FROM ${ledger}`,
          `INSERT INTO ${ledger} DEFAULT VALUES`,
          `UPDATE ${ledger} SET hash = hash`,
          `DELETE FROM ${ledger}`,
          `TRUNCATE ${ledger}`,
        ]) {
          await assert.rejects(runtimePool.unsafe(statement), /permission denied/);
        }
      }
      const [columnAclState] = await migrationSession.client<{ forbiddenAclCount: number }[]>`
        SELECT count(*)::integer AS "forbiddenAclCount"
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        WHERE namespace.nspname = ANY(${runtimeSchemas}::text[])
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND privilege.grantee IN (
            0,
            (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${runtimeRole})
          )
      `;
      assert.equal(columnAclState?.forbiddenAclCount, 0);

      const futureTable = `"${appSchema}".migration_runtime_acl_future_table`;
      const futureFunction = `"${appSchema}".migration_runtime_acl_future_function()`;
      const futureProcedure = `"${appSchema}".migration_runtime_acl_future_procedure()`;
      const futureType = `"${appSchema}".migration_runtime_acl_future_type`;
      await migrationSession.client.unsafe(`
        CREATE TABLE ${futureTable} (id integer PRIMARY KEY, marker text NOT NULL);
        CREATE FUNCTION ${futureFunction}
          RETURNS integer LANGUAGE sql AS 'SELECT 2';
        CREATE PROCEDURE ${futureProcedure}
          LANGUAGE sql AS 'SELECT 2';
        CREATE TYPE ${futureType} AS ENUM ('future')
      `);
      await assert.rejects(runtimePool.unsafe(`SELECT * FROM ${futureTable}`), /permission denied/);
      await runtimePool.unsafe(`
        SELECT ${futureFunction};
        CALL ${futureProcedure};
        SELECT 'future'::${futureType}
      `);
      const [futureDefaultAclState] = await migrationSession.client<
        { publicFunctionExecute: number; publicProcedureExecute: number; publicTypeUsage: number }[]
      >`
        SELECT (
                 SELECT count(*)::integer
                 FROM pg_catalog.pg_proc AS procedure
                 CROSS JOIN LATERAL pg_catalog.aclexplode(
                   coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
                 ) AS privilege
                 WHERE procedure.oid = ${futureFunction}::pg_catalog.regprocedure
                   AND privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE'
               ) AS "publicFunctionExecute",
               (
                 SELECT count(*)::integer
                 FROM pg_catalog.pg_proc AS procedure
                 CROSS JOIN LATERAL pg_catalog.aclexplode(
                   coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
                 ) AS privilege
                 WHERE procedure.oid = ${futureProcedure}::pg_catalog.regprocedure
                   AND privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE'
               ) AS "publicProcedureExecute",
               (
                 SELECT count(*)::integer
                 FROM pg_catalog.pg_type AS type_row
                 CROSS JOIN LATERAL pg_catalog.aclexplode(
                   coalesce(type_row.typacl, pg_catalog.acldefault('T', type_row.typowner))
                 ) AS privilege
                 WHERE type_row.oid = ${futureType}::pg_catalog.regtype
                   AND privilege.grantee = 0
                   AND privilege.privilege_type = 'USAGE'
               ) AS "publicTypeUsage"
      `;
      assert.deepEqual(futureDefaultAclState, {
        publicFunctionExecute: 0,
        publicProcedureExecute: 0,
        publicTypeUsage: 0,
      });
      await reconcileMigrationRuntimeAcl(migrationSession.client, {
        ownerRole,
        runtimeRole,
        schemas: runtimeSchemas,
      });
      await runtimePool.unsafe(`
        INSERT INTO ${futureTable} VALUES (1, 'future');
        SELECT * FROM ${futureTable};
        UPDATE ${futureTable} SET marker = 'reconciled' WHERE id = 1;
        DELETE FROM ${futureTable} WHERE id = 1
      `);
      await migrationSession.client.unsafe(`
        DROP TABLE ${testTable};
        DROP FUNCTION "${appSchema}".migration_runtime_acl_function();
        DROP PROCEDURE "${appSchema}".migration_runtime_acl_procedure();
        DROP TABLE ${futureTable};
        DROP FUNCTION ${futureFunction};
        DROP PROCEDURE ${futureProcedure};
        DROP TYPE ${futureType}
      `);
      if (ledgerSchemas.includes('public') && !publicLedgerState?.existed) {
        await migrationSession.client.unsafe('DROP TABLE public.__drizzle_migrations');
      }

      await adminPool.unsafe(`GRANT USAGE ON SCHEMA "${appSchema}" TO ${runtimeRole} WITH GRANT OPTION`);
      await reconcileMigrationRuntimeAcl(migrationSession.client, {
        ownerRole,
        runtimeRole,
        schemas: runtimeSchemas,
      });
      const [runtimeSchemaAcl] = await migrationSession.client<{ matches: boolean }[]>`
        SELECT count(*) = 1 AND pg_catalog.bool_and(
                 privilege.privilege_type = 'USAGE' AND NOT privilege.is_grantable
               ) AS matches
        FROM pg_catalog.pg_namespace AS namespace
        JOIN pg_catalog.pg_roles AS runtime_role ON runtime_role.rolname = ${runtimeRole}
        CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
        WHERE namespace.nspname = ${appSchema}
          AND privilege.grantee = runtime_role.oid
      `;
      assert.equal(runtimeSchemaAcl?.matches, true);

      let driftedRuntimeMigrationRan = false;
      await adminPool.unsafe(`ALTER ROLE ${runtimeRole} CREATEDB`);
      await assert.rejects(
        runMigrationWithRuntimeAclContract(
          migrationSession.client,
          { ownerRole, runtimeRole, schemas: runtimeSchemas },
          async () => {
            driftedRuntimeMigrationRan = true;
            await migrationSession!.client.unsafe(
              `CREATE TABLE "${appSchema}".must_not_run_before_runtime_preflight (id integer)`,
            );
          },
        ),
        /exact restricted runtime contract/,
      );
      assert.equal(driftedRuntimeMigrationRan, false);
      await adminPool.unsafe(`ALTER ROLE ${runtimeRole} NOCREATEDB`);
      const [preflightMarker] = await migrationSession.client<{ exists: boolean }[]>`
        SELECT pg_catalog.to_regclass(${`${appSchema}.must_not_run_before_runtime_preflight`}) IS NOT NULL AS exists
      `;
      assert.equal(preflightMarker?.exists, false);

      await migrationSession.close();
      migrationSession = undefined;

      const expectContractRejection = async (expectedMessage: RegExp) => {
        await assert.rejects(
          reserveMigrationOwnerSession(connectionPool, {
            databaseName,
            loginRole,
            ownerRole,
            snapshotFenceOwnerRole,
          }),
          expectedMessage,
        );
      };

      await adminPool.unsafe(`GRANT CREATE ON DATABASE ${quotedDatabaseName} TO ${loginRole}`);
      await expectContractRejection(/exact restricted LOGIN role/);
      await adminPool.unsafe(`REVOKE CREATE ON DATABASE ${quotedDatabaseName} FROM ${loginRole}`);

      await adminPool.unsafe(`GRANT CREATE ON DATABASE ${quotedDatabaseName} TO PUBLIC`);
      await expectContractRejection(/exact restricted LOGIN role/);
      await adminPool.unsafe(`REVOKE CREATE ON DATABASE ${quotedDatabaseName} FROM PUBLIC`);

      await adminPool.unsafe(`GRANT CREATE ON SCHEMA public TO ${loginRole}`);
      await expectContractRejection(/exact restricted LOGIN role/);
      await adminPool.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${loginRole}`);

      await adminPool.unsafe('GRANT CREATE ON SCHEMA public TO PUBLIC');
      await expectContractRejection(/exact restricted LOGIN role/);
      await adminPool.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');

      await adminPool.unsafe(`ALTER DATABASE ${quotedDatabaseName} OWNER TO ${loginRole}`);
      await expectContractRejection(/exact restricted LOGIN role/);
      await adminPool.unsafe(`ALTER DATABASE ${quotedDatabaseName} OWNER TO postgres`);

      await adminPool.unsafe(`
        GRANT CREATE ON SCHEMA public TO ${loginRole};
        CREATE TABLE public.pg18_login_owned_rogue (id integer);
        ALTER TABLE public.pg18_login_owned_rogue OWNER TO ${loginRole};
        REVOKE CREATE ON SCHEMA public FROM ${loginRole}
      `);
      await expectContractRejection(/exact restricted LOGIN role/);
      await adminPool.unsafe(`
        ALTER TABLE public.pg18_login_owned_rogue OWNER TO postgres;
        DROP TABLE public.pg18_login_owned_rogue
      `);

      await adminPool.unsafe(`ALTER DATABASE ${quotedDatabaseName} OWNER TO ${ownerRole}`);
      await expectContractRejection(/restricted owner contract/);
      await adminPool.unsafe(`ALTER DATABASE ${quotedDatabaseName} OWNER TO postgres`);
      // ALTER DATABASE ... OWNER rebuilds the database ACL. Restore the exact
      // non-grantable owner CREATE edge that the remaining contract checks
      // deliberately depend on.
      await adminPool.unsafe(`GRANT CREATE ON DATABASE ${quotedDatabaseName} TO ${ownerRole}`);

      await adminPool.unsafe(`
        CREATE ROLE pg18_login_incoming_rogue NOLOGIN;
        GRANT ${loginRole} TO pg18_login_incoming_rogue
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
      `);
      await expectContractRejection(/exact restricted LOGIN role/);
      await adminPool.unsafe(`
        REVOKE ${loginRole} FROM pg18_login_incoming_rogue;
        DROP ROLE pg18_login_incoming_rogue
      `);

      await adminPool.unsafe(`
        CREATE ROLE pg18_migration_rogue NOLOGIN;
        GRANT ${ownerRole} TO pg18_migration_rogue
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
      `);
      await expectContractRejection(/restricted owner contract/);
      await adminPool.unsafe(`
        REVOKE ${ownerRole} FROM pg18_migration_rogue;
        DROP ROLE pg18_migration_rogue
      `);

      await adminPool.unsafe(`ALTER ROLE ${snapshotFenceOwnerRole} NOINHERIT`);
      await expectContractRejection(/restricted owner contract/);
      await adminPool.unsafe(`ALTER ROLE ${snapshotFenceOwnerRole} INHERIT`);

      await adminPool.unsafe(`
        CREATE ROLE pg18_fence_rogue NOLOGIN;
        GRANT ${snapshotFenceOwnerRole} TO pg18_fence_rogue
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
      `);
      await expectContractRejection(/restricted owner contract/);
      await adminPool.unsafe(`
        REVOKE ${snapshotFenceOwnerRole} FROM pg18_fence_rogue;
        DROP ROLE pg18_fence_rogue
      `);

      await adminPool.unsafe(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO PUBLIC`);
      await expectContractRejection(/restricted owner contract/);
      await adminPool.unsafe(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC`);

      await adminPool.unsafe(`
        REVOKE ALL ON FUNCTION pg_catalog.pg_control_system()
          FROM ${snapshotFenceOwnerRole};
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system()
          TO ${snapshotFenceOwnerRole} WITH GRANT OPTION
      `);
      await expectContractRejection(/restricted owner contract/);
      await adminPool.unsafe(`
        REVOKE ALL ON FUNCTION pg_catalog.pg_control_system()
          FROM ${snapshotFenceOwnerRole};
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system()
          TO ${snapshotFenceOwnerRole}
      `);

      await adminPool.unsafe(`
        CREATE TABLE public.pg18_fence_acl_rogue (id integer);
        GRANT SELECT ON TABLE public.pg18_fence_acl_rogue TO ${snapshotFenceOwnerRole}
      `);
      await expectContractRejection(/restricted owner contract/);
      await adminPool.unsafe(`
        REVOKE ALL ON TABLE public.pg18_fence_acl_rogue FROM ${snapshotFenceOwnerRole};
        GRANT SELECT (id) ON TABLE public.pg18_fence_acl_rogue TO ${snapshotFenceOwnerRole}
      `);
      await expectContractRejection(/restricted owner contract/);
      await adminPool.unsafe(`
        REVOKE SELECT (id) ON TABLE public.pg18_fence_acl_rogue FROM ${snapshotFenceOwnerRole};
        DROP TABLE public.pg18_fence_acl_rogue
      `);

      await adminPool.unsafe(`CREATE TABLE public.pg18_fence_owned_rogue (id integer)`);
      await adminPool.unsafe(`ALTER TABLE public.pg18_fence_owned_rogue OWNER TO ${snapshotFenceOwnerRole}`);
      await expectContractRejection(/restricted owner contract/);
      await adminPool.unsafe(`ALTER TABLE public.pg18_fence_owned_rogue OWNER TO postgres`);
      await adminPool.unsafe(`DROP TABLE public.pg18_fence_owned_rogue`);

      const runtimeSession = await reserveMigrationOwnerSession(connectionPool, {
        databaseName,
        loginRole,
        ownerRole,
        snapshotFenceOwnerRole,
      });
      try {
        await adminPool.unsafe(`
          CREATE ROLE pg18_runtime_incoming_rogue NOLOGIN;
          GRANT ${runtimeRole} TO pg18_runtime_incoming_rogue
            WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
        `);
        await assert.rejects(
          reconcileMigrationRuntimeAcl(runtimeSession.client, {
            ownerRole,
            runtimeRole,
            schemas: runtimeSchemas,
          }),
          /exact restricted runtime contract/,
        );
        await adminPool.unsafe(`
          REVOKE ${runtimeRole} FROM pg18_runtime_incoming_rogue;
          DROP ROLE pg18_runtime_incoming_rogue
        `);

        await adminPool.unsafe('CREATE TABLE public.pg18_runtime_owned_rogue (id integer)');
        await adminPool.unsafe(`ALTER TABLE public.pg18_runtime_owned_rogue OWNER TO ${runtimeRole}`);
        await assert.rejects(
          reconcileMigrationRuntimeAcl(runtimeSession.client, {
            ownerRole,
            runtimeRole,
            schemas: runtimeSchemas,
          }),
          /exact restricted runtime contract/,
        );
        await adminPool.unsafe('ALTER TABLE public.pg18_runtime_owned_rogue OWNER TO postgres');
        await adminPool.unsafe('DROP TABLE public.pg18_runtime_owned_rogue');
      } finally {
        await runtimeSession.close();
      }
    } finally {
      await migrationSession?.close().catch(() => {});
      await connectionPool.end().catch(() => {});
      await adminPool.end().catch(() => {});
      await runtimePool.end().catch(() => {});
    }
  },
);

void test(
  'active restricted subscriber is the only additional owner SET edge',
  { skip: !databaseUrl || !adminDatabaseUrl || !subscriberRole || !subscriptionName },
  async () => {
    const connectionPool = postgres(databaseUrl!, { max: 1 });
    const adminPool = postgres(adminDatabaseUrl!, { max: 1 });
    const exactContract = {
      databaseName,
      loginRole,
      ownerRole,
      snapshotFenceOwnerRole,
      subscriberRole: subscriberRole!,
      subscriptionName: subscriptionName!,
    };
    try {
      const exactSession = await reserveMigrationOwnerSession(connectionPool, exactContract);
      await exactSession.close();

      await assert.rejects(
        reserveMigrationOwnerSession(connectionPool, {
          databaseName,
          loginRole,
          ownerRole,
          snapshotFenceOwnerRole,
        }),
        /restricted owner contract/,
      );
      await assert.rejects(
        reserveMigrationOwnerSession(connectionPool, {
          ...exactContract,
          subscriptionName: `${subscriptionName!}_wrong`,
        }),
        /restricted owner contract/,
      );

      await adminPool.unsafe(`ALTER ROLE ${subscriberRole!} CREATEDB`);
      await assert.rejects(reserveMigrationOwnerSession(connectionPool, exactContract), /restricted owner contract/);
      await adminPool.unsafe(`ALTER ROLE ${subscriberRole!} NOCREATEDB`);

      await adminPool.unsafe(`
        CREATE ROLE pg18_active_subscriber_owner_rogue NOLOGIN;
        GRANT ${ownerRole} TO pg18_active_subscriber_owner_rogue
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
      `);
      await assert.rejects(reserveMigrationOwnerSession(connectionPool, exactContract), /restricted owner contract/);
      await adminPool.unsafe(`
        REVOKE ${ownerRole} FROM pg18_active_subscriber_owner_rogue;
        DROP ROLE pg18_active_subscriber_owner_rogue
      `);
    } finally {
      await adminPool.unsafe(`ALTER ROLE ${subscriberRole!} NOCREATEDB`).catch(() => {});
      await adminPool
        .unsafe(`
        REVOKE ${ownerRole} FROM pg18_active_subscriber_owner_rogue;
        DROP ROLE IF EXISTS pg18_active_subscriber_owner_rogue
      `)
        .catch(() => {});
      await connectionPool.end().catch(() => {});
      await adminPool.end().catch(() => {});
    }
  },
);

void test(
  'post-teardown owner graph accepts no subscriber allowance',
  { skip: !databaseUrl || !expectSubscriberAbsent },
  async () => {
    const connectionPool = postgres(databaseUrl!, { max: 1 });
    try {
      const migrationSession = await reserveMigrationOwnerSession(connectionPool, {
        databaseName,
        loginRole,
        ownerRole,
        snapshotFenceOwnerRole,
      });
      await migrationSession.close();
    } finally {
      await connectionPool.end().catch(() => {});
    }
  },
);
