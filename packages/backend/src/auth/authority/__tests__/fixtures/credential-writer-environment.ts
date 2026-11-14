import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@boardsesh/db/schema';
import { readHistoricalCredentialWriterMigrations } from './credential-writer-historical-fixture';
import {
  PRIVATE_WEB_CREDENTIAL_CAPABILITIES,
  PRIVATE_BROWSER_CREDENTIAL_CAPABILITIES,
  PRIVATE_PROVIDER_CREDENTIAL_CAPABILITIES,
  PRIVATE_FIRST_PASSWORD_CREDENTIAL_CAPABILITIES,
  PRIVATE_NATIVE_HANDOFF_CREDENTIAL_CAPABILITIES,
  PRIVATE_BROWSER_RENEWAL_CREDENTIAL_CAPABILITIES,
  PRIVATE_BROWSER_RENEWAL_CREDENTIAL_COLUMN_CAPABILITIES,
  PRIVATE_WEB_CREDENTIAL_COLUMN_CAPABILITIES,
  PRIVATE_PROVIDER_CREDENTIAL_COLUMN_CAPABILITIES,
  type CredentialWriterContract,
} from '@boardsesh/db/credential-writer-acl';

const writerPassword = 'epic6975-owned-credential-writer-only';
const legacyPassword = 'epic6975-owned-retired-runtime-only';
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Refuses every shared development/production target before connecting. */
export function ownedCredentialProofUrl(connectionString = process.env.CREDENTIAL_WRITER_PROOF_DATABASE_URL): URL {
  if (!connectionString) throw new Error('CREDENTIAL_WRITER_PROOF_DATABASE_URL_REQUIRED');
  const parsed = new URL(connectionString);
  const local = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  const development = parsed.port === '55480' && /^\/epic6975_credential_\d{8}$/.test(parsed.pathname);
  const ci =
    ['1', 'true'].includes(process.env.CI ?? '') &&
    process.env.GITHUB_ACTIONS === 'true' &&
    parsed.port === '5432' &&
    ['/epic6975_credential_ci', '/epic6975_credential_historical_ci'].includes(parsed.pathname);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !local ||
    (!development && !ci) ||
    parsed.username !== 'postgres' ||
    !parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('OWNED_CREDENTIAL_PROOF_DATABASE_REQUIRED');
  return parsed;
}

/** Test-only grants. Never called by production startup or migration reconciliation. */
export async function grantOwnedCredentialWriterCapabilities(
  owner: postgres.Sql,
  contract: CredentialWriterContract = 'private-web-v1',
) {
  if (
    ![
      'private-web-v1',
      'private-browser-v1',
      'private-provider-v1',
      'private-first-password-v1',
      'private-native-handoff-v1',
      'private-browser-renewal-v1',
    ].includes(contract)
  )
    throw new Error('OWNED_CREDENTIAL_PROOF_CONTRACT_REQUIRED');
  const capabilities =
    contract === 'private-browser-renewal-v1'
      ? PRIVATE_BROWSER_RENEWAL_CREDENTIAL_CAPABILITIES
      : contract === 'private-native-handoff-v1'
        ? PRIVATE_NATIVE_HANDOFF_CREDENTIAL_CAPABILITIES
        : contract === 'private-first-password-v1'
          ? PRIVATE_FIRST_PASSWORD_CREDENTIAL_CAPABILITIES
          : contract === 'private-provider-v1'
            ? PRIVATE_PROVIDER_CREDENTIAL_CAPABILITIES
            : contract === 'private-browser-v1'
              ? PRIVATE_BROWSER_CREDENTIAL_CAPABILITIES
              : PRIVATE_WEB_CREDENTIAL_CAPABILITIES;
  const columnCapabilities =
    contract === 'private-browser-renewal-v1'
      ? PRIVATE_BROWSER_RENEWAL_CREDENTIAL_COLUMN_CAPABILITIES
      : contract === 'private-provider-v1' ||
          contract === 'private-first-password-v1' ||
          contract === 'private-native-handoff-v1'
        ? PRIVATE_PROVIDER_CREDENTIAL_COLUMN_CAPABILITIES
        : PRIVATE_WEB_CREDENTIAL_COLUMN_CAPABILITIES;
  const relations = await owner<{ schema: string; name: string; kind: string; columns: string[] }[]>`
    SELECT namespace.nspname AS schema, relation.relname AS name, relation.relkind AS kind,
      ARRAY(SELECT attname FROM pg_attribute WHERE attrelid=relation.oid AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS columns
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema' AND relation.relkind IN ('r','p','v','m','f','S')`;
  await owner.unsafe(
    `REVOKE CREATE,TEMP ON DATABASE ${identifier((await owner<{ name: string }[]>`SELECT current_database() AS name`)[0]!.name)} FROM PUBLIC,boardsesh_identity_writer`,
  );
  const namespaces = await owner<
    { name: string }[]
  >`SELECT nspname AS name FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'`;
  for (const namespace of namespaces)
    await owner.unsafe(`REVOKE ALL ON SCHEMA ${identifier(namespace.name)} FROM PUBLIC,boardsesh_identity_writer`);
  await owner`GRANT USAGE ON SCHEMA public TO boardsesh_identity_writer`;
  for (const relation of relations) {
    const target = `${identifier(relation.schema)}.${identifier(relation.name)}`;
    if (relation.kind === 'S') {
      await owner.unsafe(`REVOKE ALL ON SEQUENCE ${target} FROM PUBLIC,boardsesh_identity_writer`);
      continue;
    }
    await owner.unsafe(`REVOKE ALL ON TABLE ${target} FROM PUBLIC,boardsesh_identity_writer`);
    for (const column of relation.columns)
      await owner.unsafe(`REVOKE ALL (${identifier(column)}) ON TABLE ${target} FROM PUBLIC,boardsesh_identity_writer`);
  }
  for (const [table, privileges] of Object.entries(capabilities))
    await owner.unsafe(
      `GRANT ${privileges.join(',')} ON TABLE public.${identifier(table)} TO boardsesh_identity_writer`,
    );
  for (const [table, columns] of Object.entries(columnCapabilities))
    for (const [column, privileges] of Object.entries(columns))
      await owner.unsafe(
        `GRANT ${privileges.map((privilege) => `${privilege} (${identifier(column)})`).join(',')} ON TABLE public.${identifier(table)} TO boardsesh_identity_writer`,
      );
  const routines = await owner<{ signature: string }[]>`
    SELECT routine.oid::regprocedure::text AS signature FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema'`;
  for (const routine of routines)
    await owner.unsafe(`REVOKE ALL ON ROUTINE ${routine.signature} FROM PUBLIC,boardsesh_identity_writer`);
  if (
    contract === 'private-provider-v1' ||
    contract === 'private-first-password-v1' ||
    contract === 'private-native-handoff-v1' ||
    contract === 'private-browser-renewal-v1'
  )
    await owner`GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO boardsesh_identity_writer`;
  const owners = await owner<{ name: string }[]>`
    SELECT DISTINCT pg_get_userbyid(owner) AS name FROM (
      SELECT relation.relowner AS owner FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema'
      UNION SELECT routine.proowner FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname<>'information_schema'
      UNION SELECT defaclrole FROM pg_default_acl) owners`;
  for (const ownerRole of owners)
    for (const scope of ['', ...namespaces.map((namespace) => ` IN SCHEMA ${identifier(namespace.name)}`)])
      for (const kind of ['TABLES', 'SEQUENCES', 'ROUTINES'])
        await owner.unsafe(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(ownerRole.name)}${scope} REVOKE ALL ON ${kind} FROM PUBLIC,boardsesh_identity_writer`,
        );
}

export async function createCredentialWriterEnvironment(contract: CredentialWriterContract = 'private-web-v1') {
  if (
    ![
      'private-web-v1',
      'private-browser-v1',
      'private-provider-v1',
      'private-first-password-v1',
      'private-native-handoff-v1',
      'private-browser-renewal-v1',
    ].includes(contract)
  )
    throw new Error('OWNED_CREDENTIAL_PROOF_CONTRACT_REQUIRED');
  const target = ownedCredentialProofUrl();
  if (
    target.port === '5432' &&
    target.pathname !==
      (contract === 'private-provider-v1' ||
      contract === 'private-first-password-v1' ||
      contract === 'private-native-handoff-v1' ||
      contract === 'private-browser-renewal-v1'
        ? '/epic6975_credential_ci'
        : '/epic6975_credential_historical_ci')
  )
    throw new Error('OWNED_CREDENTIAL_PROOF_PROFILE_DATABASE_MISMATCH');
  const databaseName = target.pathname.slice(1);
  const owner = postgres(target.toString(), { max: 2, onnotice: () => undefined });
  try {
    const [identity] = await owner<
      { database: string; role: string }[]
    >`SELECT current_database() AS database,current_user AS role`;
    if (identity?.database !== databaseName || identity.role !== 'postgres')
      throw new Error('OWNED_CREDENTIAL_PROOF_IDENTITY_MISMATCH');
    const journal = JSON.parse(
      await readFile(new URL('../../../../../../db/drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { tag: string; when: number }[] };
    const canonical = await Promise.all(
      journal.entries.map(async (entry) => ({
        hash: createHash('sha256')
          .update(await readFile(new URL(`../../../../../../db/drizzle/${entry.tag}.sql`, import.meta.url)))
          .digest('hex'),
        created_at: String(entry.when),
      })),
    );
    const expected =
      contract === 'private-provider-v1' ||
      contract === 'private-first-password-v1' ||
      contract === 'private-native-handoff-v1' ||
      contract === 'private-browser-renewal-v1'
        ? canonical
        : (await readHistoricalCredentialWriterMigrations()).ledger;
    for (const ledger of ['public', 'drizzle']) {
      const observed = await owner.unsafe<{ hash: string; created_at: string }[]>(
        `SELECT hash,created_at::text FROM ${ledger}.__drizzle_migrations ORDER BY id`,
      );
      if (JSON.stringify([...observed]) !== JSON.stringify(expected))
        throw new Error('OWNED_CREDENTIAL_PROOF_MIGRATION_HISTORY_MISMATCH');
    }
    for (const [role, password] of [
      ['boardsesh_identity_writer', writerPassword],
      ['boardsesh_retired_runtime', legacyPassword],
    ] as const) {
      const existing = await owner<
        { present: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role}) AS present`;
      if (!existing[0]?.present)
        await owner.unsafe(
          `CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
        );
      await owner.unsafe(`ALTER ROLE ${identifier(role)} SET search_path=pg_catalog,public`);
    }
    await grantOwnedCredentialWriterCapabilities(owner, contract);
    const writerTarget = new URL(target);
    writerTarget.username = 'boardsesh_identity_writer';
    writerTarget.password = writerPassword;
    const legacyTarget = new URL(target);
    legacyTarget.username = 'boardsesh_retired_runtime';
    legacyTarget.password = legacyPassword;
    const writer = postgres(writerTarget.toString(), { max: 2, onnotice: () => undefined });
    const legacy = postgres(legacyTarget.toString(), { max: 2, onnotice: () => undefined });
    return {
      owner,
      writer,
      legacy,
      writerUrl: writerTarget.toString(),
      legacyUrl: legacyTarget.toString(),
      databaseName,
      database: drizzle(writer, { schema, logger: false }),
      ownerDatabase: drizzle(owner, { schema, logger: false }),
      resetGrants: () => grantOwnedCredentialWriterCapabilities(owner, contract),
      close: async () => {
        await Promise.all([writer.end(), legacy.end()]);
        await owner.end();
      },
    };
  } catch (error) {
    await owner.end();
    throw error;
  }
}
