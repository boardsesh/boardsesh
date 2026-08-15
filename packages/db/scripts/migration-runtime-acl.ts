import type postgres from 'postgres';

const SIMPLE_POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface MigrationRuntimeAclContract {
  ownerRole: string;
  runtimeRole: string;
  schemas: string[];
}

function assertIdentifier(label: string, identifier: string): void {
  if (!SIMPLE_POSTGRES_IDENTIFIER.test(identifier)) {
    throw new Error(`${label} must contain only simple PostgreSQL identifiers`);
  }
}

export function validateMigrationRuntimeAclContract(contract: MigrationRuntimeAclContract): void {
  assertIdentifier('MIGRATION_OWNER_ROLE', contract.ownerRole);
  assertIdentifier('MIGRATION_RUNTIME_ROLE', contract.runtimeRole);
  if (contract.schemas.length === 0) {
    throw new Error('MIGRATION_RUNTIME_SCHEMAS must list at least one schema');
  }
  for (const schema of contract.schemas) {
    assertIdentifier('MIGRATION_RUNTIME_SCHEMAS', schema);
  }
  if (new Set(contract.schemas).size !== contract.schemas.length) {
    throw new Error('MIGRATION_RUNTIME_SCHEMAS must not contain duplicates');
  }
}

/**
 * Run every runtime role/schema check before Drizzle can commit DDL or a ledger
 * row. Reconciliation repeats this preflight after migrations so catalog drift
 * cannot turn a successful deploy into a partially granted schema.
 */
export async function preflightMigrationRuntimeAcl(
  client: postgres.Sql,
  contract: MigrationRuntimeAclContract,
): Promise<void> {
  validateMigrationRuntimeAclContract(contract);

  const [roleContract] = await client<
    {
      hasNoDatabaseCreate: boolean;
      hasNoIncomingMemberships: boolean;
      hasNoMemberships: boolean;
      hasNoOwnership: boolean;
      hasNoSchemaCreate: boolean;
      isNotDatabaseOwner: boolean;
      matchesAttributes: boolean;
    }[]
  >`
    WITH runtime_role AS (
      SELECT * FROM pg_catalog.pg_roles WHERE rolname = ${contract.runtimeRole}
    )
    SELECT EXISTS (
             SELECT 1 FROM runtime_role
             WHERE rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
               AND NOT rolcreaterole AND rolinherit AND NOT rolreplication
               AND NOT rolbypassrls
           ) AS "matchesAttributes",
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_auth_members AS membership, runtime_role
             WHERE membership.member = runtime_role.oid
           ) AS "hasNoMemberships",
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_auth_members AS membership, runtime_role
             WHERE membership.roleid = runtime_role.oid
           ) AS "hasNoIncomingMemberships",
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_shdepend AS dependency, runtime_role
             WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
               AND dependency.refobjid = runtime_role.oid
               AND dependency.deptype = 'o'
           ) AS "hasNoOwnership",
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_database AS database, runtime_role
             WHERE database.datdba = runtime_role.oid
           ) AS "isNotDatabaseOwner",
           NOT pg_catalog.has_database_privilege(
             (SELECT oid FROM runtime_role), current_database(), 'CREATE'
           ) AS "hasNoDatabaseCreate",
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_namespace AS namespace, runtime_role
             WHERE namespace.nspname <> 'information_schema'
               AND namespace.nspname !~ '^pg_'
               AND pg_catalog.has_schema_privilege(runtime_role.oid, namespace.oid, 'CREATE')
           ) AS "hasNoSchemaCreate"
  `;
  if (
    !roleContract?.matchesAttributes ||
    !roleContract.hasNoMemberships ||
    !roleContract.hasNoIncomingMemberships ||
    !roleContract.hasNoOwnership ||
    !roleContract.isNotDatabaseOwner ||
    !roleContract.hasNoDatabaseCreate ||
    !roleContract.hasNoSchemaCreate
  ) {
    throw new Error('MIGRATION_RUNTIME_ROLE does not match the exact restricted runtime contract');
  }

  const existingSchemas = await client<{ schemaName: string }[]>`
    SELECT namespace.nspname AS "schemaName"
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname = ANY(${contract.schemas}::text[])
    ORDER BY namespace.nspname
  `;
  if (existingSchemas.length !== contract.schemas.length) {
    throw new Error('MIGRATION_RUNTIME_SCHEMAS includes a schema that does not exist');
  }
}

export async function runMigrationWithRuntimeAclContract(
  client: postgres.ReservedSql,
  contract: MigrationRuntimeAclContract,
  runMigration: () => Promise<void>,
): Promise<void> {
  await preflightMigrationRuntimeAcl(client, contract);
  await runMigration();
  await reconcileMigrationRuntimeAcl(client, contract);
}

/**
 * Reconcile app-object ACLs after every production migration. Table defaults
 * intentionally do not grant runtime CRUD because they would also expose a
 * newly-created Drizzle ledger. Instead, this transaction grants every current
 * app object except either supported ledger identity before the deploy proceeds.
 */
export async function reconcileMigrationRuntimeAcl(
  client: postgres.ReservedSql,
  contract: MigrationRuntimeAclContract,
): Promise<void> {
  await preflightMigrationRuntimeAcl(client, contract);

  await client.begin(async (transaction) => {
    const statements = await transaction<{ statement: string }[]>`
      WITH acl_statement(statement, sort_order, schema_name, object_name) AS (
        SELECT pg_catalog.format(
                 'REVOKE CREATE ON SCHEMA %I FROM PUBLIC; REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I; GRANT USAGE ON SCHEMA %I TO %I;',
                 namespace.nspname, namespace.nspname, ${contract.runtimeRole}::text,
                 namespace.nspname, ${contract.runtimeRole}::text
               ), 10, namespace.nspname, ''
        FROM pg_catalog.pg_namespace AS namespace
        WHERE namespace.nspname = ANY(${contract.schemas}::text[])

        UNION ALL

        SELECT pg_catalog.format(
                 CASE WHEN relation.relkind IN ('r', 'p')
                   THEN 'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, %I; GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I;'
                   ELSE 'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, %I; GRANT SELECT ON TABLE %I.%I TO %I;'
                 END,
                 namespace.nspname, relation.relname, ${contract.runtimeRole}::text,
                 namespace.nspname, relation.relname, ${contract.runtimeRole}::text
               ), 20, namespace.nspname, relation.relname
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relkind IN ('r', 'p', 'v', 'm')
          AND namespace.nspname = ANY(${contract.schemas}::text[])
          AND NOT (
            relation.relname = '__drizzle_migrations'
            AND namespace.nspname IN ('public', 'drizzle')
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend AS dependency
            WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              AND dependency.objid = relation.oid AND dependency.deptype = 'e'
          )

        UNION ALL

        SELECT pg_catalog.format(
                 'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM PUBLIC, %I;',
                 attribute.attname, namespace.nspname, relation.relname,
                 ${contract.runtimeRole}::text
               ), 25, namespace.nspname, relation.relname || '.' || attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        WHERE relation.relkind IN ('r', 'p', 'v', 'm')
          AND namespace.nspname = ANY(${contract.schemas}::text[])
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND privilege.grantee IN (
            0,
            (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${contract.runtimeRole})
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend AS dependency
            WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              AND dependency.objid = relation.oid AND dependency.deptype = 'e'
          )

        UNION ALL

        SELECT pg_catalog.format(
                 CASE WHEN owner_table.relname = '__drizzle_migrations'
                            AND owner_namespace.nspname IN ('public', 'drizzle')
                   THEN 'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC, %I;'
                   ELSE 'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC, %I; GRANT USAGE ON SEQUENCE %I.%I TO %I;'
                 END,
                 namespace.nspname, relation.relname, ${contract.runtimeRole}::text,
                 namespace.nspname, relation.relname, ${contract.runtimeRole}::text
               ), 30, namespace.nspname, relation.relname
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        LEFT JOIN pg_catalog.pg_depend AS ownership
          ON ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND ownership.objid = relation.oid
         AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND ownership.deptype IN ('a', 'i')
         AND ownership.refobjsubid > 0
        LEFT JOIN pg_catalog.pg_class AS owner_table ON owner_table.oid = ownership.refobjid
        LEFT JOIN pg_catalog.pg_namespace AS owner_namespace ON owner_namespace.oid = owner_table.relnamespace
        WHERE relation.relkind = 'S'
          AND namespace.nspname = ANY(${contract.schemas}::text[])
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend AS dependency
            WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              AND dependency.objid = relation.oid AND dependency.deptype = 'e'
          )

        UNION ALL

        SELECT pg_catalog.format(
                 'REVOKE ALL PRIVILEGES ON ROUTINE %s FROM PUBLIC, %I; GRANT EXECUTE ON ROUTINE %s TO %I;',
                 procedure.oid::pg_catalog.regprocedure, ${contract.runtimeRole}::text,
                 procedure.oid::pg_catalog.regprocedure, ${contract.runtimeRole}::text
               ), 40, namespace.nspname, procedure.proname
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = ANY(${contract.schemas}::text[])
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend AS dependency
            WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
              AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
          )

        UNION ALL

        SELECT pg_catalog.format(
                 'REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM PUBLIC, %I; GRANT USAGE ON TYPE %I.%I TO %I;',
                 namespace.nspname, type_row.typname, ${contract.runtimeRole}::text,
                 namespace.nspname, type_row.typname, ${contract.runtimeRole}::text
               ), 50, namespace.nspname, type_row.typname
        FROM pg_catalog.pg_type AS type_row
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
        -- Multiranges inherit the owning range ACL and reject direct GRANT.
        WHERE type_row.typtype IN ('c', 'd', 'e', 'r')
          AND (type_row.typrelid = 0 OR EXISTS (
            SELECT 1 FROM pg_catalog.pg_class AS composite_relation
            WHERE composite_relation.oid = type_row.typrelid AND composite_relation.relkind = 'c'
          ))
          AND namespace.nspname = ANY(${contract.schemas}::text[])
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend AS dependency
            WHERE dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
              AND dependency.objid = type_row.oid AND dependency.deptype = 'e'
          )
      )
      SELECT statement
      FROM acl_statement
      ORDER BY sort_order, schema_name, object_name, statement
    `;
    for (const { statement } of statements) {
      await transaction.unsafe(statement);
    }

    await transaction.unsafe(`
      ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}"
        REVOKE ALL ON TABLES FROM PUBLIC, "${contract.runtimeRole}";
      ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}"
        REVOKE ALL ON SEQUENCES FROM PUBLIC, "${contract.runtimeRole}";
      ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}"
        REVOKE ALL ON ROUTINES FROM PUBLIC, "${contract.runtimeRole}";
      ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}"
        REVOKE ALL ON TYPES FROM PUBLIC, "${contract.runtimeRole}";
    `);
    for (const schema of contract.schemas) {
      await transaction.unsafe(`
        ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}" IN SCHEMA "${schema}"
          REVOKE ALL ON TABLES FROM PUBLIC, "${contract.runtimeRole}";
        ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}" IN SCHEMA "${schema}"
          REVOKE ALL ON ROUTINES FROM PUBLIC, "${contract.runtimeRole}";
        ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}" IN SCHEMA "${schema}"
          GRANT EXECUTE ON ROUTINES TO "${contract.runtimeRole}";
        ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}" IN SCHEMA "${schema}"
          REVOKE ALL ON SEQUENCES FROM PUBLIC, "${contract.runtimeRole}";
        ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}" IN SCHEMA "${schema}"
          REVOKE ALL ON TYPES FROM PUBLIC, "${contract.runtimeRole}";
        ALTER DEFAULT PRIVILEGES FOR ROLE "${contract.ownerRole}" IN SCHEMA "${schema}"
          GRANT USAGE ON TYPES TO "${contract.runtimeRole}";
      `);
    }

    // Ledgers are explicitly denied after every migration, even if a legacy
    // default ACL briefly applied while Drizzle created one in this transaction.
    for (const schema of contract.schemas.filter((schema) => schema === 'public' || schema === 'drizzle')) {
      const [ledger] = await transaction<{ exists: boolean }[]>`
        SELECT pg_catalog.to_regclass(${`${schema}.__drizzle_migrations`}) IS NOT NULL AS exists
      `;
      if (ledger?.exists) {
        await transaction.unsafe(
          `REVOKE ALL PRIVILEGES ON TABLE "${schema}"."__drizzle_migrations" FROM PUBLIC, "${contract.runtimeRole}"`,
        );
      }
    }

    const [columnAclContract] = await transaction<{ matches: boolean }[]>`
      SELECT NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        WHERE relation.relkind IN ('r', 'p', 'v', 'm')
          AND namespace.nspname = ANY(${contract.schemas}::text[])
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND privilege.grantee IN (
            0,
            (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${contract.runtimeRole})
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_depend AS dependency
            WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              AND dependency.objid = relation.oid AND dependency.deptype = 'e'
          )
      ) AS matches
    `;
    if (!columnAclContract?.matches) {
      throw new Error('runtime/PUBLIC relation column ACLs remain after reconciliation');
    }
  });
}
