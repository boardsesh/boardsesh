import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { qualifyCredentialWriter } from '@boardsesh/db/credential-writer-acl';
import { fencePlan, readFenceCatalog, verifyFence } from '@boardsesh/db/auth-web-acl';
import { createCredentialWriterEnvironment, ownedCredentialProofUrl } from './fixtures/credential-writer-environment';

let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
const qualify = () =>
  qualifyCredentialWriter(environment.writer, {
    expectedRole: 'boardsesh_identity_writer',
    expectedDatabase: environment.databaseName,
    contract: 'private-web-v1',
  });
async function drift(apply: string, restore: string, code: string) {
  await environment.owner.unsafe(apply);
  try {
    await expect(qualify()).rejects.toMatchObject({ code });
  } finally {
    await environment.owner.unsafe(restore);
  }
  await expect(qualify()).resolves.toMatchObject({ role: 'boardsesh_identity_writer' });
}

describe('owned full-schema dedicated credential LOGIN qualification', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment();
  });
  afterAll(async () => environment?.close());
  it('qualifies real authenticated LOGIN and transaction connections without SET ROLE', async () => {
    const receipt = await qualify();
    expect(receipt).toMatchObject({
      role: 'boardsesh_identity_writer',
      sessionRole: 'boardsesh_identity_writer',
      database: environment.databaseName,
    });
    expect(receipt.databaseOid).toBeGreaterThan(0);
    expect(receipt.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
    await environment.writer.begin(async (transaction) => {
      await expect(
        qualifyCredentialWriter(transaction, {
          expectedRole: 'boardsesh_identity_writer',
          expectedDatabase: environment.databaseName,
          contract: 'private-web-v1',
        }),
      ).resolves.toEqual(receipt);
    });
  });
  it('refuses wrong database and privileged/wrong authenticated principals', async () => {
    await expect(
      qualifyCredentialWriter(environment.owner, {
        expectedRole: 'boardsesh_identity_writer',
        expectedDatabase: environment.databaseName,
        contract: 'private-web-v1',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_CONNECTION_MISMATCH' });
    await expect(
      qualifyCredentialWriter(environment.writer, {
        expectedRole: 'boardsesh_identity_writer',
        expectedDatabase: 'other_owned_database',
        contract: 'private-web-v1',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_CONNECTION_MISMATCH' });
  });
  it('refuses using SET ROLE to impersonate the writer', async () => {
    await environment.owner.begin(async (transaction) => {
      await transaction`SET LOCAL ROLE boardsesh_identity_writer`;
      await expect(
        qualifyCredentialWriter(transaction, {
          expectedRole: 'boardsesh_identity_writer',
          expectedDatabase: environment.databaseName,
          contract: 'private-web-v1',
        }),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_CONNECTION_MISMATCH' });
    });
  });
  for (const attribute of ['CREATEDB', 'CREATEROLE', 'BYPASSRLS', 'REPLICATION', 'SUPERUSER']) {
    it(`refuses ${attribute} role drift`, async () =>
      drift(
        `ALTER ROLE boardsesh_identity_writer ${attribute}`,
        `ALTER ROLE boardsesh_identity_writer NO${attribute}`,
        'UNSAFE_CREDENTIAL_WRITER_ROLE',
      ));
  }
  for (const membership of [
    [
      'GRANT boardsesh_retired_runtime TO boardsesh_identity_writer',
      'REVOKE boardsesh_retired_runtime FROM boardsesh_identity_writer',
    ],
    [
      'GRANT boardsesh_identity_writer TO boardsesh_retired_runtime',
      'REVOKE boardsesh_identity_writer FROM boardsesh_retired_runtime',
    ],
  ])
    it(`refuses membership in either direction: ${membership[0]}`, async () =>
      drift(membership[0]!, membership[1]!, 'UNSAFE_CREDENTIAL_WRITER_ROLE'));
  it('refuses database TEMP and schema CREATE privilege', async () => {
    await drift(
      `GRANT TEMP ON DATABASE "${environment.databaseName}" TO boardsesh_identity_writer`,
      `REVOKE TEMP ON DATABASE "${environment.databaseName}" FROM boardsesh_identity_writer`,
      'UNSAFE_CREDENTIAL_WRITER_ROLE',
    );
    await drift(
      'GRANT CREATE ON SCHEMA public TO boardsesh_identity_writer',
      'REVOKE CREATE ON SCHEMA public FROM boardsesh_identity_writer',
      'UNSAFE_CREDENTIAL_WRITER_ROLE',
    );
  });
  it('refuses owned objects even when no table grant is present', async () =>
    drift(
      'CREATE TABLE public.credential_owned_probe(id text); ALTER TABLE public.credential_owned_probe OWNER TO boardsesh_identity_writer',
      'DROP TABLE public.credential_owned_probe',
      'UNSAFE_CREDENTIAL_WRITER_ROLE',
    ));
  it('requires the reviewed grants, including row-lock UPDATE permission', async () =>
    drift(
      'REVOKE UPDATE ON public.auth_subject_cutoffs FROM boardsesh_identity_writer',
      'GRANT UPDATE ON public.auth_subject_cutoffs TO boardsesh_identity_writer',
      'CREDENTIAL_WRITER_REQUIRED_GRANT_MISSING',
    ));
  it('requires the member observation column lock grant without whole-table UPDATE', async () => {
    const [capability] = await environment.writer<
      {
        tableUpdate: boolean;
        observationUpdate: boolean;
        observationRead: boolean;
        ownerUpdate: boolean;
        emailUpdate: boolean;
      }[]
    >`
      SELECT has_table_privilege(current_user,'public.auth_email_reservation_members','UPDATE') AS "tableUpdate",
        has_column_privilege(current_user,'public.auth_email_reservation_members','observed_at','UPDATE') AS "observationUpdate",
        has_column_privilege(current_user,'public.auth_email_reservation_members','observed_at','SELECT') AS "observationRead",
        has_column_privilege(current_user,'public.auth_email_reservation_members','user_id','UPDATE') AS "ownerUpdate",
        has_column_privilege(current_user,'public.auth_email_reservation_members','normalized_email','UPDATE') AS "emailUpdate"`;
    expect(capability).toEqual({
      tableUpdate: false,
      observationUpdate: true,
      observationRead: true,
      ownerUpdate: false,
      emailUpdate: false,
    });
    await environment.writer.begin(async (transaction) => {
      await transaction`SELECT * FROM public.auth_email_reservation_members FOR UPDATE`;
    });
    await drift(
      'REVOKE UPDATE (observed_at) ON public.auth_email_reservation_members FROM boardsesh_identity_writer',
      'GRANT UPDATE (observed_at) ON public.auth_email_reservation_members TO boardsesh_identity_writer',
      'CREDENTIAL_WRITER_REQUIRED_COLUMN_GRANT_MISSING',
    );
  });
  it('refuses broad member UPDATE even when the required lock column is granted', async () =>
    drift(
      'GRANT UPDATE ON public.auth_email_reservation_members TO boardsesh_identity_writer',
      'REVOKE UPDATE ON public.auth_email_reservation_members FROM boardsesh_identity_writer; GRANT UPDATE (observed_at) ON public.auth_email_reservation_members TO boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    ));
  it.each(['user_id', 'normalized_email'])('refuses member identity-column UPDATE on %s', async (column) =>
    drift(
      `GRANT UPDATE (${column}) ON public.auth_email_reservation_members TO boardsesh_identity_writer`,
      `REVOKE UPDATE (${column}) ON public.auth_email_reservation_members FROM boardsesh_identity_writer`,
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    ),
  );
  it('refuses direct raw partner DML, users DELETE, and broad profile reads', async () => {
    await drift(
      'GRANT UPDATE ON public.oauth_connections TO boardsesh_identity_writer',
      'REVOKE UPDATE ON public.oauth_connections FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT DELETE ON public.users TO boardsesh_identity_writer',
      'REVOKE DELETE ON public.users FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT SELECT ON public.user_profiles TO boardsesh_identity_writer',
      'REVOKE SELECT ON public.user_profiles FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
  });
  it('refuses column grants, PUBLIC grants and GRANT OPTION', async () => {
    await drift(
      'GRANT UPDATE (generation) ON public.oauth_connections TO boardsesh_identity_writer',
      'REVOKE UPDATE (generation) ON public.oauth_connections FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT SELECT ON public.oauth_access_token TO PUBLIC',
      'REVOKE SELECT ON public.oauth_access_token FROM PUBLIC',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT UPDATE ON public.users TO boardsesh_identity_writer WITH GRANT OPTION',
      'REVOKE GRANT OPTION FOR UPDATE ON public.users FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
  });
  it('refuses PUBLIC table grants that preserve existing writer SELECT', async () => {
    const [effective] = await environment.writer<{ allowed: boolean }[]>`
      SELECT has_table_privilege(current_user,'public.auth_session','SELECT') AS allowed`;
    expect(effective.allowed).toBe(true);
    await drift(
      'GRANT SELECT ON public.auth_session TO PUBLIC',
      'REVOKE SELECT ON public.auth_session FROM PUBLIC',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
  });
  it('refuses PUBLIC column grants that preserve existing writer SELECT', async () => {
    const [effective] = await environment.writer<{ allowed: boolean }[]>`
      SELECT has_column_privilege(current_user,'public.auth_session','token','SELECT') AS allowed`;
    expect(effective.allowed).toBe(true);
    await drift(
      'GRANT SELECT (token) ON public.auth_session TO PUBLIC',
      'REVOKE SELECT (token) ON public.auth_session FROM PUBLIC',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
  });
  it('refuses executable routines and future implicit/PUBLIC/writer grants', async () => {
    await drift(
      'GRANT EXECUTE ON FUNCTION public.partner_revoke_on_credential_change() TO boardsesh_identity_writer',
      'REVOKE EXECUTE ON FUNCTION public.partner_revoke_on_credential_change() FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH',
    );
    await drift(
      'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO boardsesh_identity_writer',
      'ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_UNREVIEWED_DEFAULTS_PATH',
    );
    await drift(
      'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
      'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
      'CREDENTIAL_WRITER_UNREVIEWED_DEFAULTS_PATH',
    );
  });
  it('refuses system table/routine and replication-parameter grant drift', async () => {
    await drift(
      'GRANT SELECT ON pg_catalog.pg_authid TO boardsesh_identity_writer',
      'REVOKE SELECT ON pg_catalog.pg_authid FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_UNREVIEWED_SYSTEM_PATH',
    );
    await drift(
      'GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO PUBLIC',
      'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM PUBLIC',
      'CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH',
    );
    await drift(
      'GRANT SET ON PARAMETER session_replication_role TO boardsesh_identity_writer',
      'REVOKE SET ON PARAMETER session_replication_role FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_UNREVIEWED_SYSTEM_PATH',
    );
  });
  it('refuses RLS, rules, extra triggers and partner trigger body drift', async () => {
    await drift(
      'ALTER TABLE public.auth_session ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.auth_session DISABLE ROW LEVEL SECURITY',
      'CREDENTIAL_WRITER_UNREVIEWED_SHAPE_PATH',
    );
    await drift(
      'CREATE RULE credential_session_probe AS ON UPDATE TO public.auth_session DO ALSO NOTIFY credential_probe',
      'DROP RULE credential_session_probe ON public.auth_session',
      'CREDENTIAL_WRITER_UNREVIEWED_SHAPE_PATH',
    );
    await drift(
      'CREATE TRIGGER credential_extra_probe BEFORE UPDATE ON public.user_credentials FOR EACH ROW EXECUTE FUNCTION public.partner_revoke_on_credential_change()',
      'DROP TRIGGER credential_extra_probe ON public.user_credentials',
      'CREDENTIAL_WRITER_UNREVIEWED_TRIGGER_PATH',
    );
    const [original] = await environment.owner<
      { definition: string }[]
    >`SELECT pg_get_functiondef('public.partner_revoke_on_credential_change()'::regprocedure) AS definition`;
    await drift(
      "CREATE OR REPLACE FUNCTION public.partner_revoke_on_credential_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS 'BEGIN RETURN NEW; END'",
      original!.definition,
      'CREDENTIAL_WRITER_UNREVIEWED_PARTNER_REVOKE',
    );
  });
  it('refuses unreviewed defaults and cascades from actually deletable relations', async () => {
    await environment.owner`CREATE FUNCTION public.credential_default_probe() RETURNS text LANGUAGE sql AS 'SELECT NULL::text'`;
    try {
      await drift(
        'ALTER TABLE public.auth_session ALTER COLUMN ip_address SET DEFAULT public.credential_default_probe()',
        'ALTER TABLE public.auth_session ALTER COLUMN ip_address DROP DEFAULT',
        'CREDENTIAL_WRITER_UNREVIEWED_EXPRESSION_PATH',
      );
    } finally {
      await environment.owner`DROP FUNCTION public.credential_default_probe()`;
    }
    await drift(
      'CREATE TABLE public.credential_cascade_probe(session_id text REFERENCES public.auth_session(id) ON DELETE CASCADE)',
      'DROP TABLE public.credential_cascade_probe',
      'CREDENTIAL_WRITER_UNREVIEWED_CASCADE_PATH',
    );
  });
  it('refuses builtin expression side effects that pg_depend does not record', async () => {
    await drift(
      // Existing HTTP fixtures may already have sessions. Keep the hostile
      // CHECK active for future writes without evaluating existing rows.
      "ALTER TABLE public.auth_session ADD CONSTRAINT credential_builtin_probe CHECK (pg_notify('owned_credential_probe',token) IS NULL) NOT VALID",
      'ALTER TABLE public.auth_session DROP CONSTRAINT credential_builtin_probe',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
  });
  it('preserves transactional password-trigger partner revocation without direct partner grants', async () => {
    const userId = randomUUID();
    const connectionId = randomUUID();
    await environment.owner`INSERT INTO public.users(id,email) VALUES(${userId},${`role-${userId}@example.test`})`;
    await environment.owner`INSERT INTO public.user_credentials(user_id,password_hash) VALUES(${userId},'before')`;
    await environment.owner`INSERT INTO public.oauth_client(id,client_id,redirect_uris) VALUES(${connectionId},${connectionId},ARRAY['https://owned.example.test/callback'])`;
    await environment.owner`INSERT INTO public.oauth_connections(id,user_id,client_id,generation) VALUES(${connectionId},${userId},${connectionId},0)`;
    await expect(
      environment.writer`UPDATE public.oauth_connections SET generation=99 WHERE id=${connectionId}`,
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      environment.writer.begin(async (transaction) => {
        await transaction`UPDATE public.user_credentials SET password_hash='rollback' WHERE user_id=${userId}`;
        throw new Error('owned rollback');
      }),
    ).rejects.toThrow('owned rollback');
    const [rolledBack] = await environment.owner<
      { generation: number; revoked: boolean }[]
    >`SELECT generation,revoked_at IS NOT NULL AS revoked FROM public.oauth_connections WHERE id=${connectionId}`;
    expect(rolledBack).toEqual({ generation: 0, revoked: false });
    await environment.writer`UPDATE public.user_credentials SET password_hash='after' WHERE user_id=${userId}`;
    const [committed] = await environment.owner<
      { generation: number; revoked: boolean }[]
    >`SELECT generation,revoked_at IS NOT NULL AS revoked FROM public.oauth_connections WHERE id=${connectionId}`;
    expect(committed).toEqual({ generation: 1, revoked: true });
  });
  it('characterizes shared retired runtime credentials bypassing a web-only fence', async () => {
    await environment.owner.unsafe(fencePlan(await readFenceCatalog(environment.owner)).sql);
    await expect(verifyFence(environment.owner)).resolves.toMatchObject({ verified: true });
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`GRANT INSERT,UPDATE,DELETE,SELECT ON public.users TO boardsesh_retired_runtime`;
    const userId = randomUUID();
    await environment.legacy`INSERT INTO public.users(id,email) VALUES(${userId},${`retired-${userId}@example.test`})`;
    await environment.legacy`UPDATE public.users SET name='old process still writes' WHERE id=${userId}`;
    const [inserted] = await environment.owner<{ name: string }[]>`SELECT name FROM public.users WHERE id=${userId}`;
    expect(inserted?.name).toBe('old process still writes');
    await expect(
      qualifyCredentialWriter(environment.legacy, {
        expectedRole: 'boardsesh_identity_writer',
        expectedDatabase: environment.databaseName,
        contract: 'private-web-v1',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_CONNECTION_MISMATCH' });
  });
  it('detects MAINTAIN-only materialized-view owner execution on PostgreSQL17+', async () => {
    const [version] = await environment.owner<
      { version: number }[]
    >`SELECT current_setting('server_version_num')::integer AS version`;
    if (version!.version < 170000) return;
    await environment.owner.unsafe(fencePlan(await readFenceCatalog(environment.owner)).sql);
    await environment.owner`GRANT MAINTAIN ON public.user_profiles TO boardsesh_web`;
    try {
      await expect(verifyFence(environment.owner)).rejects.toThrow('UNREVIEWED_MAINTAIN_PATH');
    } finally {
      await environment.owner`REVOKE MAINTAIN ON public.user_profiles FROM boardsesh_web`;
    }
    const userId = randomUUID();
    await environment.owner.unsafe(
      `CREATE FUNCTION public.credential_materialize_probe() RETURNS integer LANGUAGE plpgsql AS $$BEGIN INSERT INTO public.users(id,email) VALUES ('${userId}','maintain-${userId}@example.test'); RETURN 1; END$$`,
    );
    await environment.owner`CREATE MATERIALIZED VIEW public.credential_materialize_probe_view AS SELECT public.credential_materialize_probe() AS result WITH NO DATA`;
    try {
      await environment.owner`GRANT MAINTAIN ON public.credential_materialize_probe_view TO boardsesh_identity_writer,boardsesh_web`;
      await expect(qualify()).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT' });
      await expect(verifyFence(environment.owner)).rejects.toThrow('IDENTITY_WRITE_PATH');
      await environment.writer`REFRESH MATERIALIZED VIEW public.credential_materialize_probe_view`;
      const [written] = await environment.owner<
        { present: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM public.users WHERE id=${userId}) AS present`;
      expect(written?.present).toBe(true);
    } finally {
      await environment.owner`DROP MATERIALIZED VIEW public.credential_materialize_probe_view`;
      await environment.owner`DROP FUNCTION public.credential_materialize_probe()`;
    }
    await expect(qualify()).resolves.toMatchObject({ role: 'boardsesh_identity_writer' });
  });
  it('refuses unsafe fixture targets before any database connection', () => {
    for (const target of [
      '',
      'postgresql://postgres:password@127.0.0.1:5432/boardsesh_dev',
      'postgresql://postgres:password@remote.example:55480/epic6975_credential_20261113',
      `${process.env.CREDENTIAL_WRITER_PROOF_DATABASE_URL}?options=-crole=postgres`,
    ])
      expect(() => ownedCredentialProofUrl(target)).toThrow();
  });
});
