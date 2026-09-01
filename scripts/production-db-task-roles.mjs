#!/usr/bin/env node
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  MIGRATION_OWNER_ROLE,
  PRODUCTION_DATABASE_NAME,
  PRODUCTION_MANAGED_SCHEMAS,
  PRODUCTION_SCHEMA_NAME,
  PRODUCTION_TASK_RELATION_GRANTS,
  PRODUCTION_TASK_ROLES,
  PRODUCTION_TASK_ROLE_BY_NAME,
} from './lib/production-db-task-role-contract.mjs';

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const APPLICATION_NAME_PATTERN = /^[a-z0-9-]+$/;
const PASSWORD_PATTERN = /^[a-f0-9]{64}$/;
const FORWARDER_HOST_PATTERN = /^boardsesh-db-forwarder\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;
const APPLY_CONFIRMATION = 'APPLY_EXACT_SIX_TASK_ROLES';
const ROLLBACK_CONFIRMATION = 'DROP_EXACT_SIX_TASK_ROLES';
const DISPOSABLE_LOCAL_CONFIRMATION = 'ALLOW_EXACT_LOOPBACK_FIXTURE';
const MANAGED_ROLE_NAMES = PRODUCTION_TASK_ROLES.map(({ name }) => name);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_PUBLIC_BOUNDARY_KEYS = new Set(
  PRODUCTION_TASK_ROLES[0].databasePrivileges
    .filter((privilege) =>
      PRODUCTION_TASK_ROLES.every(({ databasePrivileges }) => databasePrivileges.includes(privilege)),
    )
    .map((privilege) => `database|${PRODUCTION_DATABASE_NAME}|${privilege}`),
);

function fail(message) {
  throw new Error(message);
}

function quoteIdentifier(identifier) {
  if (!IDENTIFIER_PATTERN.test(identifier)) fail(`unsafe PostgreSQL identifier: ${identifier}`);
  return `"${identifier}"`;
}

function quoteLiteral(literal) {
  return `'${String(literal).replaceAll("'", "''")}'`;
}

function valuesList(values) {
  return values.map(quoteLiteral).join(', ');
}

function roleNameListSql() {
  return valuesList(MANAGED_ROLE_NAMES);
}

function assertStaticContract() {
  if (PRODUCTION_TASK_ROLES.length !== 6 || new Set(MANAGED_ROLE_NAMES).size !== 6) {
    fail('task-role contract must contain exactly six unique LOGIN roles');
  }
  const applicationNames = new Set();
  const githubSecrets = new Set();
  const relationGrantKeys = new Set();
  for (const roleContract of PRODUCTION_TASK_ROLES) {
    quoteIdentifier(roleContract.name);
    if (!APPLICATION_NAME_PATTERN.test(roleContract.applicationName)) {
      fail(`invalid application_name for ${roleContract.name}`);
    }
    if (applicationNames.has(roleContract.applicationName)) fail('task application_name values must be unique');
    if (githubSecrets.has(roleContract.githubSecret)) fail('task GitHub secret names must be unique');
    applicationNames.add(roleContract.applicationName);
    githubSecrets.add(roleContract.githubSecret);
  }
  for (const grantContract of PRODUCTION_TASK_RELATION_GRANTS) {
    if (!PRODUCTION_TASK_ROLE_BY_NAME.has(grantContract.role)) fail(`unknown grant role ${grantContract.role}`);
    quoteIdentifier(grantContract.relation);
    if (grantContract.privileges.length === 0) fail(`empty privileges for ${grantContract.role}`);
    const relationGrantKey = `${grantContract.role}|${grantContract.relation}`;
    if (relationGrantKeys.has(relationGrantKey)) fail(`duplicate relation grant ${relationGrantKey}`);
    relationGrantKeys.add(relationGrantKey);
  }
}

function credentialsFilePath() {
  const filePath = process.env.ROLE_CREDENTIALS_FILE;
  if (!filePath || !isAbsolute(filePath)) fail('ROLE_CREDENTIALS_FILE must be an absolute path');
  const relativeToRepository = relative(REPOSITORY_ROOT, resolve(filePath));
  if (
    relativeToRepository === '' ||
    (!relativeToRepository.startsWith(`..${sep}`) && relativeToRepository !== '..' && !isAbsolute(relativeToRepository))
  ) {
    fail('ROLE_CREDENTIALS_FILE must be outside the repository');
  }
  return filePath;
}

function readProtectedCredentials() {
  const filePath = credentialsFilePath();
  const fileStats = lstatSync(filePath);
  if (!fileStats.isFile() || fileStats.isSymbolicLink())
    fail('ROLE_CREDENTIALS_FILE must be a regular non-symlink file');
  if ((fileStats.mode & 0o077) !== 0) fail('ROLE_CREDENTIALS_FILE must not be accessible by group or other users');
  if (typeof process.getuid === 'function' && fileStats.uid !== process.getuid()) {
    fail('ROLE_CREDENTIALS_FILE must be owned by the current user');
  }
  if (fileStats.size > 32768) fail('ROLE_CREDENTIALS_FILE is unexpectedly large');

  let parsedCredentials;
  try {
    parsedCredentials = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    fail('ROLE_CREDENTIALS_FILE is not valid JSON');
  }
  if (parsedCredentials?.version !== 1 || typeof parsedCredentials.forwarderHost !== 'string') {
    fail('ROLE_CREDENTIALS_FILE has an unsupported format');
  }
  if (!FORWARDER_HOST_PATTERN.test(parsedCredentials.forwarderHost)) {
    fail('ROLE_CREDENTIALS_FILE contains an invalid forwarder host');
  }
  const credentialRoleNames = Object.keys(parsedCredentials.roles ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
  const expectedRoleNames = [...MANAGED_ROLE_NAMES].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(credentialRoleNames) !== JSON.stringify(expectedRoleNames)) {
    fail('ROLE_CREDENTIALS_FILE must contain exactly the six managed roles');
  }

  for (const roleContract of PRODUCTION_TASK_ROLES) {
    const credential = parsedCredentials.roles[roleContract.name];
    if (
      credential?.applicationName !== roleContract.applicationName ||
      credential?.githubSecret !== roleContract.githubSecret ||
      !PASSWORD_PATTERN.test(credential?.password ?? '')
    ) {
      fail(`ROLE_CREDENTIALS_FILE entry for ${roleContract.name} does not match its exact contract`);
    }
    validateGeneratedDatabaseUrl(
      credential.databaseUrl,
      parsedCredentials.forwarderHost,
      roleContract,
      credential.password,
    );
  }
  return parsedCredentials;
}

function validateGeneratedDatabaseUrl(rawDatabaseUrl, expectedHost, roleContract, expectedPassword) {
  let databaseUrl;
  try {
    databaseUrl = new URL(rawDatabaseUrl);
  } catch {
    fail(`generated database URL for ${roleContract.name} is invalid`);
  }
  const queryEntries = [...databaseUrl.searchParams.entries()];
  if (
    databaseUrl.protocol !== 'postgresql:' ||
    databaseUrl.hostname !== expectedHost ||
    databaseUrl.port !== '5432' ||
    databaseUrl.pathname !== `/${PRODUCTION_DATABASE_NAME}` ||
    decodeURIComponent(databaseUrl.username) !== roleContract.name ||
    decodeURIComponent(databaseUrl.password) !== expectedPassword ||
    databaseUrl.hash !== '' ||
    queryEntries.length !== 2 ||
    databaseUrl.searchParams.getAll('application_name').length !== 1 ||
    databaseUrl.searchParams.get('application_name') !== roleContract.applicationName ||
    databaseUrl.searchParams.getAll('sslmode').length !== 1 ||
    databaseUrl.searchParams.get('sslmode') !== 'require'
  ) {
    fail(`generated database URL for ${roleContract.name} does not match its exact private route`);
  }
}

function generateCredentials() {
  const filePath = credentialsFilePath();
  const forwarderHost = process.env.POSTGRES_FORWARDER_HOST ?? '';
  if (!FORWARDER_HOST_PATTERN.test(forwarderHost)) {
    fail('POSTGRES_FORWARDER_HOST must be the full boardsesh-db-forwarder MagicDNS name');
  }

  const protectedCredentials = { version: 1, forwarderHost, roles: {} };
  for (const roleContract of PRODUCTION_TASK_ROLES) {
    const password = randomBytes(32).toString('hex');
    const databaseUrl = new URL(`postgresql://${roleContract.name}:${password}@${forwarderHost}:5432/railway`);
    databaseUrl.searchParams.set('application_name', roleContract.applicationName);
    databaseUrl.searchParams.set('sslmode', 'require');
    protectedCredentials.roles[roleContract.name] = {
      applicationName: roleContract.applicationName,
      githubSecret: roleContract.githubSecret,
      password,
      databaseUrl: databaseUrl.toString(),
    };
  }

  const fileDescriptor = openSync(filePath, 'wx', 0o600);
  try {
    writeFileSync(fileDescriptor, `${JSON.stringify(protectedCredentials, null, 2)}\n`, { encoding: 'utf8' });
    const fileStats = fstatSync(fileDescriptor);
    if ((fileStats.mode & 0o077) !== 0) fail('generated credential file mode is not private');
  } finally {
    closeSync(fileDescriptor);
  }
  console.info('Generated one protected credential file for all six task roles; no credential was printed.');
}

function adminDatabaseUrl() {
  const rawDatabaseUrl = process.env.ADMIN_DATABASE_URL;
  delete process.env.ADMIN_DATABASE_URL;
  if (!rawDatabaseUrl) fail('ADMIN_DATABASE_URL is required through the environment');
  let databaseUrl;
  try {
    databaseUrl = new URL(rawDatabaseUrl);
  } catch {
    fail('ADMIN_DATABASE_URL is invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) fail('ADMIN_DATABASE_URL must use PostgreSQL');
  if (!databaseUrl.username || !databaseUrl.password) fail('ADMIN_DATABASE_URL must contain administrator credentials');
  if (decodeURIComponent(databaseUrl.pathname.slice(1)) !== PRODUCTION_DATABASE_NAME) {
    fail(`ADMIN_DATABASE_URL must name the canonical ${PRODUCTION_DATABASE_NAME} database`);
  }
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname.replace(/^\[|\]$/g, ''));
  const disposableLocalConfirmation = process.env.ALLOW_DISPOSABLE_TASK_ROLE_SMOKE;
  delete process.env.ALLOW_DISPOSABLE_TASK_ROLE_SMOKE;
  if (isLocal) {
    if (disposableLocalConfirmation !== DISPOSABLE_LOCAL_CONFIRMATION) {
      fail('loopback ADMIN_DATABASE_URL is allowed only by the disposable-smoke confirmation');
    }
    if (databaseUrl.searchParams.size !== 0 || databaseUrl.hash !== '') {
      fail('disposable loopback ADMIN_DATABASE_URL must not contain query parameters or a fragment');
    }
    return rawDatabaseUrl;
  }

  const forwarderHost = process.env.POSTGRES_FORWARDER_HOST ?? '';
  delete process.env.POSTGRES_FORWARDER_HOST;
  if (!FORWARDER_HOST_PATTERN.test(forwarderHost)) {
    fail('POSTGRES_FORWARDER_HOST must be the full boardsesh-db-forwarder MagicDNS name');
  }
  if (
    databaseUrl.hostname !== forwarderHost ||
    databaseUrl.port !== '5432' ||
    databaseUrl.hash !== '' ||
    databaseUrl.searchParams.size !== 1 ||
    databaseUrl.searchParams.getAll('sslmode').length !== 1 ||
    databaseUrl.searchParams.get('sslmode') !== 'require'
  ) {
    fail('remote ADMIN_DATABASE_URL must use the exact PostGIS forwarder host:5432 with only sslmode=require');
  }
  return rawDatabaseUrl;
}

function createAdminClient(rawDatabaseUrl) {
  return postgres(rawDatabaseUrl, {
    max: 1,
    prepare: false,
    onnotice: (notice) => console.info(`[task-role-notice] ${notice.code ?? 'unknown'}`),
  });
}

async function assertAdminBoundary(sqlClient) {
  const [databaseIdentity] = await sqlClient.unsafe(`
    SELECT current_database() AS database_name,
           current_user AS admin_role,
           coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false)
             AS is_superuser
  `);
  if (databaseIdentity?.database_name !== PRODUCTION_DATABASE_NAME) {
    fail(`administrator connected to ${databaseIdentity?.database_name ?? 'unknown'}, not ${PRODUCTION_DATABASE_NAME}`);
  }
  if (MANAGED_ROLE_NAMES.includes(databaseIdentity.admin_role)) fail('a managed task role cannot provision itself');
  if (!databaseIdentity.is_superuser) {
    fail('administrator must be SUPERUSER so every direct grant can be audited and reconciled atomically');
  }

  const [ownerContract] = await sqlClient.unsafe(
    `SELECT count(*) = 1
       AND bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
                    AND rolinherit AND NOT rolreplication AND NOT rolbypassrls) AS matches
     FROM pg_catalog.pg_roles WHERE rolname = ${quoteLiteral(MIGRATION_OWNER_ROLE)}`,
  );
  if (!ownerContract?.matches) fail(`${MIGRATION_OWNER_ROLE} must already exist as the exact restricted NOLOGIN owner`);
}

async function expectedSequenceAclKeys(sqlClient) {
  const insertContracts = PRODUCTION_TASK_RELATION_GRANTS.filter(({ privileges }) => privileges.includes('INSERT'));
  if (insertContracts.length === 0) return new Set();
  const expectedValues = insertContracts
    .map(({ role, relation }) => `(${quoteLiteral(role)}, ${quoteLiteral(relation)})`)
    .join(',\n');
  const sequenceRows = await sqlClient.unsafe(`
    WITH expected(role_name, relation_name) AS (VALUES ${expectedValues})
    SELECT DISTINCT expected.role_name,
           pg_catalog.format('%I.%I', sequence_namespace.nspname, sequence_relation.relname) AS object_name
    FROM expected
    JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.nspname = ${quoteLiteral(PRODUCTION_SCHEMA_NAME)}
    JOIN pg_catalog.pg_class AS table_relation
      ON table_relation.relnamespace = table_namespace.oid AND table_relation.relname = expected.relation_name
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = table_relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
     AND dependency.refobjid = table_relation.oid
     AND dependency.refobjsubid = attribute.attnum
     AND dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
     AND dependency.deptype IN ('a', 'i')
    JOIN pg_catalog.pg_class AS sequence_relation
      ON sequence_relation.oid = dependency.objid AND sequence_relation.relkind = 'S'
    JOIN pg_catalog.pg_namespace AS sequence_namespace ON sequence_namespace.oid = sequence_relation.relnamespace
  `);
  return new Set(
    sequenceRows.map(({ role_name: roleName, object_name: objectName }) => `${roleName}|sequence|${objectName}|USAGE`),
  );
}

async function missingRelations(sqlClient) {
  const expectedRelations = [...new Set(PRODUCTION_TASK_RELATION_GRANTS.map(({ relation }) => relation))].sort(
    (left, right) => left.localeCompare(right),
  );
  const rows = await sqlClient.unsafe(`
    SELECT relation_name
    FROM unnest(ARRAY[${valuesList(expectedRelations)}]::text[]) AS expected(relation_name)
    WHERE pg_catalog.to_regclass(${quoteLiteral(PRODUCTION_SCHEMA_NAME)} || '.' || relation_name) IS NULL
    ORDER BY relation_name
  `);
  return rows.map(({ relation_name: relationName }) => relationName);
}

async function collectDirectAclKeys(sqlClient) {
  const rows = await sqlClient.unsafe(`
    WITH managed AS (
      SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname IN (${roleNameListSql()})
    ), direct_acl AS (
      SELECT managed.rolname AS role_name, 'database'::text AS object_kind,
             database.datname AS object_name, privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_database AS database
      CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'schema', namespace.nspname,
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname,
             CASE WHEN relation.relkind = 'S' THEN 'sequence' ELSE 'relation' END,
             pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'column',
             pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, attribute.attname),
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
      UNION ALL
      SELECT managed.rolname, 'routine', procedure.oid::pg_catalog.regprocedure::text,
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'type',
             pg_catalog.format('%I.%I', namespace.nspname, type_row.typname),
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_type AS type_row
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'large_object', large_object.oid::text,
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_largeobject_metadata AS large_object
      CROSS JOIN LATERAL pg_catalog.aclexplode(large_object.lomacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'parameter', parameter.parname,
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_parameter_acl AS parameter
      CROSS JOIN LATERAL pg_catalog.aclexplode(parameter.paracl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'language', language.lanname,
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_language AS language
      CROSS JOIN LATERAL pg_catalog.aclexplode(language.lanacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'foreign_data_wrapper', wrapper.fdwname,
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_foreign_data_wrapper AS wrapper
      CROSS JOIN LATERAL pg_catalog.aclexplode(wrapper.fdwacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'foreign_server', server.srvname,
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_foreign_server AS server
      CROSS JOIN LATERAL pg_catalog.aclexplode(server.srvacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'tablespace', tablespace.spcname,
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_tablespace AS tablespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(tablespace.spcacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
      UNION ALL
      SELECT managed.rolname, 'default',
             grantor.rolname || ':' || coalesce(namespace.nspname, '*') || ':' || default_acl.defaclobjtype::text,
             privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_default_acl AS default_acl
      JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = default_acl.defaclrole
      LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
      JOIN managed ON managed.oid = privilege.grantee
    )
    SELECT * FROM direct_acl ORDER BY role_name, object_kind, object_name, privilege_type
  `);
  const keys = new Set();
  const grantableKeys = [];
  for (const aclRow of rows) {
    const aclKey = `${aclRow.role_name}|${aclRow.object_kind}|${aclRow.object_name}|${aclRow.privilege_type}`;
    keys.add(aclKey);
    if (aclRow.is_grantable) grantableKeys.push(aclKey);
  }
  return { keys, grantableKeys };
}

async function collectClusterWideBoundaryDifferences(sqlClient) {
  const differences = [];
  const schemaRows = await sqlClient.unsafe(`
    SELECT expected.schema_name
    FROM unnest(ARRAY[${valuesList(PRODUCTION_MANAGED_SCHEMAS)}]::text[]) AS expected(schema_name)
    LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = expected.schema_name
    WHERE namespace.oid IS NULL
    ORDER BY expected.schema_name
  `);
  for (const { schema_name: schemaName } of schemaRows) {
    differences.push(
      `cluster prerequisite missing schema ${schemaName}; reviewed remediation: complete the PG18 owner/runtime schema transition`,
    );
  }

  const publicAclRows = await sqlClient.unsafe(`
    WITH public_acl AS (
      SELECT 'database'::text AS object_kind,
             database.datname AS object_name,
             privilege.privilege_type,
             privilege.is_grantable,
             pg_catalog.format('REVOKE %s ON DATABASE %I FROM PUBLIC',
                               privilege.privilege_type, database.datname) AS remediation
      FROM pg_catalog.pg_database AS database
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
      ) AS privilege
      WHERE database.datname = ${quoteLiteral(PRODUCTION_DATABASE_NAME)}
        AND privilege.grantee = 0

      UNION ALL
      SELECT 'schema', namespace.nspname, privilege.privilege_type, privilege.is_grantable,
             pg_catalog.format('REVOKE %s ON SCHEMA %I FROM PUBLIC',
                               privilege.privilege_type, namespace.nspname)
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
      ) AS privilege
      WHERE namespace.nspname IN (${valuesList(PRODUCTION_MANAGED_SCHEMAS)})
        AND privilege.grantee = 0

      UNION ALL
      SELECT CASE WHEN relation.relkind = 'S' THEN 'sequence' ELSE 'relation' END,
             pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
             privilege.privilege_type,
             privilege.is_grantable,
             pg_catalog.format(
               CASE WHEN relation.relkind = 'S'
                 THEN 'REVOKE %s ON SEQUENCE %I.%I FROM PUBLIC'
                 ELSE 'REVOKE %s ON TABLE %I.%I FROM PUBLIC' END,
               privilege.privilege_type, namespace.nspname, relation.relname)
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(
          relation.relacl,
          pg_catalog.acldefault(
            CASE WHEN relation.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END,
            relation.relowner
          )
        )
      ) AS privilege
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND namespace.nspname IN (${valuesList(PRODUCTION_MANAGED_SCHEMAS)})
        AND privilege.grantee = 0
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND dependency.objid = relation.oid AND dependency.deptype = 'e'
        )

      UNION ALL
      SELECT 'column',
             pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, attribute.attname),
             privilege.privilege_type,
             privilege.is_grantable,
             pg_catalog.format('REVOKE %s (%I) ON TABLE %I.%I FROM PUBLIC',
                               privilege.privilege_type, attribute.attname,
                               namespace.nspname, relation.relname)
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND namespace.nspname IN (${valuesList(PRODUCTION_MANAGED_SCHEMAS)})
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND privilege.grantee = 0
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND dependency.objid = relation.oid AND dependency.deptype = 'e'
        )

      UNION ALL
      SELECT 'routine', procedure.oid::pg_catalog.regprocedure::text,
             privilege.privilege_type,
             privilege.is_grantable,
             pg_catalog.format('REVOKE %s ON ROUTINE %s FROM PUBLIC',
                               privilege.privilege_type, procedure.oid::pg_catalog.regprocedure)
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      ) AS privilege
      WHERE namespace.nspname IN (${valuesList(PRODUCTION_MANAGED_SCHEMAS)})
        AND privilege.grantee = 0
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
        )

      UNION ALL
      SELECT 'type', pg_catalog.format('%I.%I', namespace.nspname, type_row.typname),
             privilege.privilege_type,
             privilege.is_grantable,
             pg_catalog.format('REVOKE %s ON TYPE %I.%I FROM PUBLIC',
                               privilege.privilege_type, namespace.nspname, type_row.typname)
      FROM pg_catalog.pg_type AS type_row
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(type_row.typacl, pg_catalog.acldefault('T', type_row.typowner))
      ) AS privilege
      WHERE type_row.typtype IN ('c', 'd', 'e', 'r')
        AND (
          type_row.typrelid = 0
          OR EXISTS (
            SELECT 1 FROM pg_catalog.pg_class AS composite_relation
            WHERE composite_relation.oid = type_row.typrelid AND composite_relation.relkind = 'c'
          )
        )
        AND namespace.nspname IN (${valuesList(PRODUCTION_MANAGED_SCHEMAS)})
        AND privilege.grantee = 0
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend AS dependency
          WHERE dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
            AND dependency.objid = type_row.oid AND dependency.deptype = 'e'
        )
    ), owner_role AS (
      SELECT oid, rolname FROM pg_catalog.pg_roles
      WHERE rolname = ${quoteLiteral(MIGRATION_OWNER_ROLE)}
    ), default_kind(catalog_object_type, acl_default_object_type, sql_kind) AS (
      VALUES ('r'::"char", 'r'::"char", 'TABLES'::text),
             ('S'::"char", 's'::"char", 'SEQUENCES'::text),
             ('f'::"char", 'f'::"char", 'ROUTINES'::text),
             ('T'::"char", 'T'::"char", 'TYPES'::text)
    ), owner_global_default AS (
      SELECT 'default_acl'::text AS object_kind,
             pg_catalog.format('%I:*:%s', owner_role.rolname,
                               default_kind.catalog_object_type::text) AS object_name,
             privilege.privilege_type,
             privilege.is_grantable,
             pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE %s ON %s FROM PUBLIC',
                               owner_role.rolname, privilege.privilege_type, default_kind.sql_kind) AS remediation
      FROM owner_role
      CROSS JOIN default_kind
      LEFT JOIN pg_catalog.pg_default_acl AS default_acl
       ON default_acl.defaclrole = owner_role.oid
       AND default_acl.defaclnamespace = 0
       AND default_acl.defaclobjtype = default_kind.catalog_object_type
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(
          default_acl.defaclacl,
          pg_catalog.acldefault(default_kind.acl_default_object_type, owner_role.oid)
        )
      ) AS privilege
      WHERE privilege.grantee = 0
    ), owner_schema_default AS (
      SELECT 'default_acl'::text AS object_kind,
             pg_catalog.format('%I:%I:%s', owner_role.rolname, namespace.nspname,
                               default_acl.defaclobjtype::text) AS object_name,
             privilege.privilege_type,
             privilege.is_grantable,
             pg_catalog.format(
               'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE %s ON %s FROM PUBLIC',
               owner_role.rolname, namespace.nspname, privilege.privilege_type,
               CASE default_acl.defaclobjtype
                 WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES'
                 WHEN 'f' THEN 'ROUTINES' WHEN 'T' THEN 'TYPES' END)
      FROM pg_catalog.pg_default_acl AS default_acl
      JOIN owner_role ON owner_role.oid = default_acl.defaclrole
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
      WHERE namespace.nspname IN (${valuesList(PRODUCTION_MANAGED_SCHEMAS)})
        AND default_acl.defaclobjtype IN ('r', 'S', 'f', 'T')
        AND privilege.grantee = 0
    )
    SELECT * FROM public_acl
    UNION ALL SELECT * FROM owner_global_default
    UNION ALL SELECT * FROM owner_schema_default
    ORDER BY object_kind, object_name, privilege_type, is_grantable
  `);

  for (const publicAcl of publicAclRows) {
    const boundaryKey = `${publicAcl.object_kind}|${publicAcl.object_name}|${publicAcl.privilege_type}`;
    if (ALLOWED_PUBLIC_BOUNDARY_KEYS.has(boundaryKey) && !publicAcl.is_grantable) continue;
    differences.push(
      `cluster prerequisite PUBLIC|${boundaryKey}|grantable=${publicAcl.is_grantable}; reviewed remediation: ${publicAcl.remediation}`,
    );
  }
  return differences;
}

async function collectRoleRows(sqlClient) {
  return sqlClient.unsafe(`
    SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
           rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil::text AS valid_until,
           rolpassword LIKE 'SCRAM-SHA-256$%' AS has_scram_password
    FROM pg_catalog.pg_authid WHERE rolname IN (${roleNameListSql()}) ORDER BY rolname
  `);
}

async function collectSettingKeys(sqlClient) {
  const rows = await sqlClient.unsafe(`
    SELECT role_row.rolname AS role_name, coalesce(database.datname, '*') AS database_name,
           setting.setting
    FROM pg_catalog.pg_db_role_setting AS role_setting
    JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = role_setting.setrole
    LEFT JOIN pg_catalog.pg_database AS database ON database.oid = role_setting.setdatabase
    CROSS JOIN LATERAL unnest(role_setting.setconfig) AS setting(setting)
    WHERE role_row.rolname IN (${roleNameListSql()})
    ORDER BY role_name, database_name, setting.setting
  `);
  return new Set(
    rows.map(
      ({ role_name: roleName, database_name: databaseName, setting }) => `${roleName}|${databaseName}|${setting}`,
    ),
  );
}

async function collectMembershipKeys(sqlClient) {
  const rows = await sqlClient.unsafe(`
    SELECT member_role.rolname AS member_role, granted_role.rolname AS granted_role,
           membership.admin_option, membership.inherit_option, membership.set_option
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
    JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
    WHERE member_role.rolname IN (${roleNameListSql()}) OR granted_role.rolname IN (${roleNameListSql()})
    ORDER BY member_role, granted_role
  `);
  return new Set(
    rows.map(
      (membership) =>
        `${membership.member_role}|${membership.granted_role}|admin=${membership.admin_option}|inherit=${membership.inherit_option}|set=${membership.set_option}`,
    ),
  );
}

async function collectOwnershipRows(sqlClient) {
  return sqlClient.unsafe(`
    SELECT role_row.rolname AS role_name, dependency.classid::pg_catalog.regclass::text AS class_name,
           dependency.dbid::text AS database_oid, dependency.objid::text AS object_oid
    FROM pg_catalog.pg_shdepend AS dependency
    JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = dependency.refobjid
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.deptype = 'o'
      AND role_row.rolname IN (${roleNameListSql()})
    ORDER BY role_name, class_name, database_oid, object_oid
  `);
}

async function collectPolicyReferenceRows(sqlClient) {
  return sqlClient.unsafe(`
    WITH managed AS (
      SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname IN (${roleNameListSql()})
    )
    SELECT managed.rolname AS role_name,
           pg_catalog.format('%I.%I', namespace.nspname, relation.relname) AS relation_name,
           policy.polname AS policy_name
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL unnest(policy.polroles) AS policy_role(role_oid)
    JOIN managed ON managed.oid = policy_role.role_oid
    ORDER BY role_name, relation_name, policy_name
  `);
}

async function collectOwnedDefaultAclRows(sqlClient) {
  return sqlClient.unsafe(`
    SELECT role_row.rolname AS role_name,
           coalesce(namespace.nspname, '*') AS schema_name,
           default_acl.defaclobjtype::text AS object_type
    FROM pg_catalog.pg_default_acl AS default_acl
    JOIN pg_catalog.pg_roles AS role_row ON role_row.oid = default_acl.defaclrole
    LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
    WHERE role_row.rolname IN (${roleNameListSql()})
    ORDER BY role_name, schema_name, object_type
  `);
}

function expectedDirectAclKeys(sequenceKeys) {
  const expectedKeys = new Set(sequenceKeys);
  for (const roleContract of PRODUCTION_TASK_ROLES) {
    for (const privilege of roleContract.databasePrivileges) {
      expectedKeys.add(`${roleContract.name}|database|${PRODUCTION_DATABASE_NAME}|${privilege}`);
    }
    for (const privilege of roleContract.schemaPrivileges) {
      expectedKeys.add(`${roleContract.name}|schema|${PRODUCTION_SCHEMA_NAME}|${privilege}`);
    }
  }
  for (const grantContract of PRODUCTION_TASK_RELATION_GRANTS) {
    for (const privilege of grantContract.privileges) {
      expectedKeys.add(
        `${grantContract.role}|relation|${PRODUCTION_SCHEMA_NAME}.${grantContract.relation}|${privilege}`,
      );
    }
  }
  return expectedKeys;
}

async function auditContract(sqlClient) {
  const differences = [];
  differences.push(...(await collectClusterWideBoundaryDifferences(sqlClient)));
  const relationGaps = await missingRelations(sqlClient);
  differences.push(...relationGaps.map((relationName) => `missing object ${PRODUCTION_SCHEMA_NAME}.${relationName}`));

  const roleRows = await collectRoleRows(sqlClient);
  const actualRoleByName = new Map(roleRows.map((roleRow) => [roleRow.rolname, roleRow]));
  for (const roleContract of PRODUCTION_TASK_ROLES) {
    const roleRow = actualRoleByName.get(roleContract.name);
    if (!roleRow) {
      differences.push(`missing role ${roleContract.name}`);
      continue;
    }
    const attributesMatch =
      roleRow.rolcanlogin &&
      !roleRow.rolsuper &&
      !roleRow.rolcreatedb &&
      !roleRow.rolcreaterole &&
      roleRow.rolinherit &&
      !roleRow.rolreplication &&
      !roleRow.rolbypassrls &&
      roleRow.rolconnlimit === roleContract.connectionLimit &&
      (roleRow.valid_until === null || roleRow.valid_until === 'infinity') &&
      roleRow.has_scram_password;
    if (!attributesMatch) differences.push(`role attributes differ for ${roleContract.name}`);
  }

  const expectedSettings = new Set();
  for (const roleContract of PRODUCTION_TASK_ROLES) {
    expectedSettings.add(
      `${roleContract.name}|${PRODUCTION_DATABASE_NAME}|application_name=${roleContract.applicationName}`,
    );
    if (roleContract.readOnly) {
      expectedSettings.add(`${roleContract.name}|${PRODUCTION_DATABASE_NAME}|default_transaction_read_only=on`);
    }
  }
  const actualSettings = await collectSettingKeys(sqlClient);
  for (const expectedSetting of expectedSettings) {
    if (!actualSettings.has(expectedSetting)) differences.push(`missing setting ${expectedSetting}`);
  }
  for (const actualSetting of actualSettings) {
    if (!expectedSettings.has(actualSetting)) differences.push(`unexpected setting ${actualSetting}`);
  }

  const expectedMemberships = new Set([
    `boardsesh_migrator|${MIGRATION_OWNER_ROLE}|admin=false|inherit=false|set=true`,
  ]);
  const actualMemberships = await collectMembershipKeys(sqlClient);
  for (const expectedMembership of expectedMemberships) {
    if (!actualMemberships.has(expectedMembership)) differences.push(`missing membership ${expectedMembership}`);
  }
  for (const actualMembership of actualMemberships) {
    if (!expectedMemberships.has(actualMembership)) differences.push(`unexpected membership ${actualMembership}`);
  }

  const ownershipRows = await collectOwnershipRows(sqlClient);
  for (const ownershipRow of ownershipRows) {
    differences.push(
      `unexpected ownership ${ownershipRow.role_name}|${ownershipRow.class_name}|db=${ownershipRow.database_oid}|oid=${ownershipRow.object_oid}`,
    );
  }

  const policyReferenceRows = await collectPolicyReferenceRows(sqlClient);
  for (const policyReference of policyReferenceRows) {
    differences.push(
      `unexpected RLS policy ${policyReference.role_name}|${policyReference.relation_name}|${policyReference.policy_name}`,
    );
  }

  const ownedDefaultAclRows = await collectOwnedDefaultAclRows(sqlClient);
  for (const defaultAcl of ownedDefaultAclRows) {
    differences.push(
      `unexpected owned default ACL ${defaultAcl.role_name}|${defaultAcl.schema_name}|${defaultAcl.object_type}`,
    );
  }

  const sequenceKeys = await expectedSequenceAclKeys(sqlClient);
  const expectedAclKeys = expectedDirectAclKeys(sequenceKeys);
  const actualAcl = await collectDirectAclKeys(sqlClient);
  for (const expectedAclKey of expectedAclKeys) {
    if (!actualAcl.keys.has(expectedAclKey)) differences.push(`missing grant ${expectedAclKey}`);
  }
  for (const actualAclKey of actualAcl.keys) {
    if (!expectedAclKeys.has(actualAclKey)) differences.push(`unexpected grant ${actualAclKey}`);
  }
  for (const grantableKey of actualAcl.grantableKeys) differences.push(`grant option forbidden ${grantableKey}`);
  return differences.sort((left, right) => left.localeCompare(right));
}

function printDifferences(differences) {
  if (differences.length === 0) {
    console.info('Exact six-role contract matches; grant diff is empty.');
    return;
  }
  console.info(`Grant/role diff (${differences.length}):`);
  for (const difference of differences) console.info(`[task-role-diff] ${difference}`);
}

async function formattedStatements(sqlClient, selectSql) {
  const rows = await sqlClient.unsafe(selectSql);
  return rows.map(({ statement }) => statement);
}

async function executeStatements(sqlClient, statements) {
  for (const statement of statements) await sqlClient.unsafe(statement);
}

async function assertNoUnsafeExistingRoleState(sqlClient) {
  const ownershipRows = await collectOwnershipRows(sqlClient);
  if (ownershipRows.length > 0) fail('managed role owns objects; refusing to reconcile it');

  if ((await collectPolicyReferenceRows(sqlClient)).length > 0) {
    fail('managed role is named in an RLS policy; manual policy review is required');
  }
  if ((await collectOwnedDefaultAclRows(sqlClient)).length > 0) {
    fail('managed role owns a default ACL; manual grantor review is required');
  }

  const existingMemberships = await collectMembershipKeys(sqlClient);
  const allowedMembership = `boardsesh_migrator|${MIGRATION_OWNER_ROLE}|admin=false|inherit=false|set=true`;
  for (const membership of existingMemberships) {
    if (membership !== allowedMembership) fail(`unexpected role membership requires manual review: ${membership}`);
  }

  const directAcl = await collectDirectAclKeys(sqlClient);
  if ([...directAcl.keys].some((aclKey) => aclKey.includes('|default|'))) {
    fail('managed role appears in a default ACL; manual grantor review is required');
  }
  if (directAcl.grantableKeys.length > 0) {
    fail('managed role has a grant option; downstream grants require manual review');
  }
}

async function revokeManagedDirectPrivileges(sqlClient) {
  const roleNamesSql = roleNameListSql();
  const statements = await formattedStatements(
    sqlClient,
    `WITH managed AS (
       SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname IN (${roleNamesSql})
     )
     SELECT DISTINCT pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', database.datname, managed.rolname) AS statement
       FROM pg_catalog.pg_database AS database
       CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     UNION ALL
     SELECT DISTINCT pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', namespace.nspname, managed.rolname)
       FROM pg_catalog.pg_namespace AS namespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     UNION ALL
     SELECT DISTINCT pg_catalog.format(
              CASE WHEN relation.relkind = 'S'
                THEN 'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I'
                ELSE 'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I' END,
              namespace.nspname, relation.relname, managed.rolname)
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     UNION ALL
     SELECT DISTINCT pg_catalog.format('REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM %I',
              attribute.attname, namespace.nspname, relation.relname, managed.rolname)
       FROM pg_catalog.pg_attribute AS attribute
       JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
     UNION ALL
     SELECT DISTINCT pg_catalog.format('REVOKE ALL PRIVILEGES ON ROUTINE %s FROM %I',
              procedure.oid::pg_catalog.regprocedure, managed.rolname)
       FROM pg_catalog.pg_proc AS procedure
       CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     UNION ALL
     SELECT DISTINCT pg_catalog.format('REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM %I',
              namespace.nspname, type_row.typname, managed.rolname)
       FROM pg_catalog.pg_type AS type_row
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     UNION ALL
     SELECT DISTINCT pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON LARGE OBJECT %s FROM %I', large_object.oid, managed.rolname)
       FROM pg_catalog.pg_largeobject_metadata AS large_object
       CROSS JOIN LATERAL pg_catalog.aclexplode(large_object.lomacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     UNION ALL
     SELECT DISTINCT pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON PARAMETER %I FROM %I', parameter.parname, managed.rolname)
       FROM pg_catalog.pg_parameter_acl AS parameter
       CROSS JOIN LATERAL pg_catalog.aclexplode(parameter.paracl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     UNION ALL
     SELECT DISTINCT pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON LANGUAGE %I FROM %I', language.lanname, managed.rolname)
       FROM pg_catalog.pg_language AS language
       CROSS JOIN LATERAL pg_catalog.aclexplode(language.lanacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     UNION ALL
     SELECT DISTINCT pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON FOREIGN DATA WRAPPER %I FROM %I', wrapper.fdwname, managed.rolname)
       FROM pg_catalog.pg_foreign_data_wrapper AS wrapper
       CROSS JOIN LATERAL pg_catalog.aclexplode(wrapper.fdwacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     UNION ALL
     SELECT DISTINCT pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON FOREIGN SERVER %I FROM %I', server.srvname, managed.rolname)
       FROM pg_catalog.pg_foreign_server AS server
       CROSS JOIN LATERAL pg_catalog.aclexplode(server.srvacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     UNION ALL
     SELECT DISTINCT pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON TABLESPACE %I FROM %I', tablespace.spcname, managed.rolname)
       FROM pg_catalog.pg_tablespace AS tablespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(tablespace.spcacl) AS privilege
       JOIN managed ON managed.oid = privilege.grantee
     ORDER BY statement`,
  );
  await executeStatements(sqlClient, statements);
}

function scramVerifier(password) {
  if (!PASSWORD_PATTERN.test(password)) fail('task password does not meet the generated credential contract');
  const iterations = 4096;
  const salt = randomBytes(16);
  const saltedPassword = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  const verifier = `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
  if (!/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) {
    fail('failed to build a safe SCRAM verifier');
  }
  return verifier;
}

async function applyContract(sqlClient, protectedCredentials) {
  const preflightDifferences = await auditContract(sqlClient);
  console.info('Pre-apply evidence:');
  printDifferences(preflightDifferences);
  const clusterBoundaryDifferences = await collectClusterWideBoundaryDifferences(sqlClient);
  if (clusterBoundaryDifferences.length > 0) {
    fail(
      'cluster-wide PUBLIC/default ACL prerequisites require separate reviewed remediation; apply never changes them',
    );
  }

  await sqlClient.begin(async (transaction) => {
    await transaction.unsafe(
      `SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended('boardsesh:production-task-roles:v1', 0))`,
    );
    await assertAdminBoundary(transaction);
    if ((await collectClusterWideBoundaryDifferences(transaction)).length > 0) {
      fail('cluster-wide PUBLIC/default ACL prerequisites changed after preflight; refusing apply');
    }
    const relationGaps = await missingRelations(transaction);
    if (relationGaps.length > 0) fail(`required relations are missing: ${relationGaps.join(', ')}`);
    await assertNoUnsafeExistingRoleState(transaction);

    for (const roleContract of PRODUCTION_TASK_ROLES) {
      const roleIdentifier = quoteIdentifier(roleContract.name);
      const [existingRole] = await transaction.unsafe(
        `SELECT true AS present FROM pg_catalog.pg_roles WHERE rolname = ${quoteLiteral(roleContract.name)}`,
      );
      if (!existingRole) await transaction.unsafe(`CREATE ROLE ${roleIdentifier}`);
      await transaction.unsafe(
        `ALTER ROLE ${roleIdentifier} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${roleContract.connectionLimit}`,
      );
      await transaction.unsafe(`ALTER ROLE ${roleIdentifier} RESET ALL`);
      await transaction.unsafe(
        `ALTER ROLE ${roleIdentifier} IN DATABASE ${quoteIdentifier(PRODUCTION_DATABASE_NAME)} RESET ALL`,
      );
      await transaction.unsafe(
        `ALTER ROLE ${roleIdentifier} IN DATABASE ${quoteIdentifier(PRODUCTION_DATABASE_NAME)} SET application_name TO ${quoteLiteral(roleContract.applicationName)}`,
      );
      if (roleContract.readOnly) {
        await transaction.unsafe(
          `ALTER ROLE ${roleIdentifier} IN DATABASE ${quoteIdentifier(PRODUCTION_DATABASE_NAME)} SET default_transaction_read_only TO on`,
        );
      }
      const verifier = scramVerifier(protectedCredentials.roles[roleContract.name].password);
      await transaction.unsafe(`ALTER ROLE ${roleIdentifier} PASSWORD ${quoteLiteral(verifier)}`);
    }

    await revokeManagedDirectPrivileges(transaction);
    await transaction.unsafe(
      `GRANT ${quoteIdentifier(MIGRATION_OWNER_ROLE)} TO ${quoteIdentifier('boardsesh_migrator')} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
    );

    for (const roleContract of PRODUCTION_TASK_ROLES) {
      if (roleContract.databasePrivileges.length > 0) {
        await transaction.unsafe(
          `GRANT ${roleContract.databasePrivileges.join(', ')} ON DATABASE ${quoteIdentifier(PRODUCTION_DATABASE_NAME)} TO ${quoteIdentifier(roleContract.name)}`,
        );
      }
      if (roleContract.schemaPrivileges.length > 0) {
        await transaction.unsafe(
          `GRANT ${roleContract.schemaPrivileges.join(', ')} ON SCHEMA ${quoteIdentifier(PRODUCTION_SCHEMA_NAME)} TO ${quoteIdentifier(roleContract.name)}`,
        );
      }
    }
    for (const grantContract of PRODUCTION_TASK_RELATION_GRANTS) {
      await transaction.unsafe(
        `GRANT ${grantContract.privileges.join(', ')} ON TABLE ${quoteIdentifier(PRODUCTION_SCHEMA_NAME)}.${quoteIdentifier(grantContract.relation)} TO ${quoteIdentifier(grantContract.role)}`,
      );
    }

    const sequenceKeys = await expectedSequenceAclKeys(transaction);
    for (const sequenceKey of sequenceKeys) {
      const [roleName, , qualifiedSequence] = sequenceKey.split('|');
      const [schemaName, sequenceName] = qualifiedSequence.split('.');
      await transaction.unsafe(
        `GRANT USAGE ON SEQUENCE ${quoteIdentifier(schemaName)}.${quoteIdentifier(sequenceName)} TO ${quoteIdentifier(roleName)}`,
      );
    }
  });

  const differences = await auditContract(sqlClient);
  printDifferences(differences);
  if (differences.length > 0) fail('post-apply role audit failed');
}

async function allManagedRolesAbsent(sqlClient) {
  const [result] = await sqlClient.unsafe(
    `SELECT count(*) = 0 AS absent FROM pg_catalog.pg_roles WHERE rolname IN (${roleNameListSql()})`,
  );
  return Boolean(result?.absent);
}

async function rollbackContract(sqlClient) {
  if (await allManagedRolesAbsent(sqlClient)) {
    console.info('All six managed task roles are already absent; rollback is idempotently complete.');
    return;
  }
  const preflightDifferences = await auditContract(sqlClient);
  printDifferences(preflightDifferences);
  if (preflightDifferences.length > 0) fail('rollback refuses a partial or drifted role contract');

  const activeSessions = await sqlClient.unsafe(`
    SELECT usename, count(*)::integer AS session_count
    FROM pg_catalog.pg_stat_activity
    WHERE usename IN (${roleNameListSql()}) AND pid <> pg_catalog.pg_backend_pid()
    GROUP BY usename ORDER BY usename
  `);
  if (activeSessions.length > 0) fail('rollback refuses managed roles with active database sessions');

  await sqlClient.begin(async (transaction) => {
    await transaction.unsafe(
      `SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended('boardsesh:production-task-roles:v1', 0))`,
    );
    await transaction.unsafe(
      `REVOKE ${quoteIdentifier(MIGRATION_OWNER_ROLE)} FROM ${quoteIdentifier('boardsesh_migrator')}`,
    );
    await revokeManagedDirectPrivileges(transaction);
    for (const roleContract of PRODUCTION_TASK_ROLES) {
      const roleIdentifier = quoteIdentifier(roleContract.name);
      await transaction.unsafe(`ALTER ROLE ${roleIdentifier} NOLOGIN`);
      await transaction.unsafe(`ALTER ROLE ${roleIdentifier} RESET ALL`);
      await transaction.unsafe(
        `ALTER ROLE ${roleIdentifier} IN DATABASE ${quoteIdentifier(PRODUCTION_DATABASE_NAME)} RESET ALL`,
      );
    }
    for (const roleContract of [...PRODUCTION_TASK_ROLES].reverse()) {
      await transaction.unsafe(`DROP ROLE ${quoteIdentifier(roleContract.name)}`);
    }
  });
  if (!(await allManagedRolesAbsent(sqlClient))) fail('rollback did not remove all managed task roles');
  console.info('Rolled back exactly six ownership-free task roles; application data and owner roles were untouched.');
}

async function withAdminClient(run) {
  const rawDatabaseUrl = adminDatabaseUrl();
  const sqlClient = createAdminClient(rawDatabaseUrl);
  try {
    await assertAdminBoundary(sqlClient);
    await run(sqlClient);
  } finally {
    await sqlClient.end({ timeout: 5 }).catch(() => {});
  }
}

function usage() {
  console.info(`Usage: node scripts/production-db-task-roles.mjs COMMAND

Commands:
  generate  Write six random credentials and exact forwarder URLs to a new 0600 file.
  plan      Print the read-only role/grant diff and exit successfully.
  audit     Require an empty read-only role/grant diff.
  apply     Reconcile the exact contract and rotate all six passwords atomically.
  rollback  Drop only an exact, inactive, ownership-free managed contract.

Environment:
  ROLE_CREDENTIALS_FILE       Absolute protected JSON path (generate/apply).
  POSTGRES_FORWARDER_HOST     Full MagicDNS hostname (generate and remote database commands).
  ADMIN_DATABASE_URL          Canonical railway admin URL (plan/audit/apply/rollback).
  APPLY_TASK_ROLE_CHANGES     Must equal ${APPLY_CONFIRMATION} for apply.
  ROLLBACK_TASK_ROLES         Must equal ${ROLLBACK_CONFIRMATION} for rollback.
  ALLOW_DISPOSABLE_TASK_ROLE_SMOKE
                              Test-only; exact ${DISPOSABLE_LOCAL_CONFIRMATION} enables loopback.

Passwords and generated URLs are never accepted on argv or printed.`);
}

assertStaticContract();
const command = process.argv[2];
if (process.argv.length > 3) fail('only the non-secret command is accepted on argv');

try {
  switch (command) {
    case 'generate':
      generateCredentials();
      break;
    case 'plan':
      await withAdminClient(async (sqlClient) => printDifferences(await auditContract(sqlClient)));
      break;
    case 'audit':
      await withAdminClient(async (sqlClient) => {
        const differences = await auditContract(sqlClient);
        printDifferences(differences);
        if (differences.length > 0) fail('task-role audit found drift');
      });
      break;
    case 'apply': {
      if (process.env.APPLY_TASK_ROLE_CHANGES !== APPLY_CONFIRMATION) {
        fail(`APPLY_TASK_ROLE_CHANGES must equal ${APPLY_CONFIRMATION}`);
      }
      delete process.env.APPLY_TASK_ROLE_CHANGES;
      const protectedCredentials = readProtectedCredentials();
      await withAdminClient((sqlClient) => applyContract(sqlClient, protectedCredentials));
      break;
    }
    case 'rollback':
      if (process.env.ROLLBACK_TASK_ROLES !== ROLLBACK_CONFIRMATION) {
        fail(`ROLLBACK_TASK_ROLES must equal ${ROLLBACK_CONFIRMATION}`);
      }
      delete process.env.ROLLBACK_TASK_ROLES;
      await withAdminClient(rollbackContract);
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      usage();
      process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown task-role provisioning error';
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'guard';
  console.error(`error [${code}]: ${message}`);
  process.exitCode = 1;
}
