import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { authSession, userCredentials, users } from '@boardsesh/db/schema/auth';
import { boardseshTicks, playlistOwnership, playlists, syncDeletions } from '@boardsesh/db/schema/app';
import { qualifyCredentialWriter } from '@boardsesh/db/credential-writer-acl';
import { runAuthFence } from '../../auth-fence';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  BACKEND_ONLY_PARTNER_TABLES,
  fencePlan,
  protectedIdentityTable,
  readFenceCatalog,
  verifyFence,
  WEB_FENCE_LOCK_SQL,
} from '../catalog';
import { reconcileWebRuntimeAcl, quoteIdentifier } from '@boardsesh/db/auth-web-acl';
import { runAuthAuthority } from '../../auth-authority';
import { grantOwnedCredentialWriterCapabilities } from '../../../auth/authority/__tests__/fixtures/credential-writer-environment';

const WRITER_ROLE = 'boardsesh_identity_writer';
// The current canonical journal's reviewed credential profile (CI's provider proofs use it too).
const WRITER_CONTRACT = 'private-browser-renewal-v1';

// Explicit local schema-only fixture; never copies data or uses DATABASE_URL.
const schemaFile = process.env.AUTH_FENCE_TEST_SCHEMA_FILE;
describe.skipIf(!schemaFile)('full migrated local schema authority fence', () => {
  const address = new URL(
    process.env.AUTH_FENCE_TEST_DATABASE_URL ?? 'postgres://postgres:password@127.0.0.1:5432/postgres',
  );
  if (!['127.0.0.1', 'localhost'].includes(address.hostname) || address.pathname !== '/postgres' || address.search)
    throw new Error('LOCAL_TEST_ADMIN_REQUIRED');
  const databaseName = `boardsesh_ba04_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(address.toString(), { max: 1, onnotice: () => {} });
  address.pathname = `/${databaseName}`;
  const owner = postgres(address.toString(), { max: 1, onnotice: () => {} });
  const environment = { AUTH_OPERATOR_DATABASE_URL: address.toString() };
  const secret = randomUUID().replaceAll('-', '');
  const web = postgres(address.toString(), {
    username: 'boardsesh_web',
    password: () => secret,
    max: 1,
    onnotice: () => {},
  });
  const writerSecret = randomUUID().replaceAll('-', '');
  const writer = postgres(address.toString(), {
    username: WRITER_ROLE,
    password: () => writerSecret,
    max: 1,
    onnotice: () => {},
  });
  let createdDatabase = false;
  let createdRole = false;
  let createdWriterRole = false;
  beforeAll(async () => {
    const [role] = await admin<{ present: boolean; writer: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'boardsesh_web') AS present,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${WRITER_ROLE}) AS writer`;
    if (role.present) throw new Error('TEST_REQUIRES_ABSENT_WEB_ROLE');
    if (role.writer) throw new Error('TEST_REQUIRES_ABSENT_WRITER_ROLE');
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    createdDatabase = true;
    const schema = readFileSync(schemaFile!, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('\\'))
      .join('\n');
    await owner.unsafe(schema);
    await owner.unsafe('SET search_path = public');
    const [resolutionLog] = await owner<
      { present: boolean }[]
    >`SELECT to_regclass('public.auth_email_resolution_log') IS NOT NULL AS present`;
    if (!resolutionLog.present) {
      // The local image is at 0303; apply the actual stacked PR4 migration.
      await owner.unsafe(
        readFileSync(new URL('../../../../../db/drizzle/0305_auth_email_resolution_log.sql', import.meta.url), 'utf8'),
      );
    }
    const [authorityTables] = await owner<
      { present: boolean }[]
    >`SELECT to_regclass('public.auth_session_denials') IS NOT NULL AS present`;
    if (!authorityTables.present) {
      await owner.unsafe(
        readFileSync(new URL('../../../../../db/drizzle/0306_yielding_scrambler.sql', import.meta.url), 'utf8'),
      );
    }
    const [gymReporting] = await owner<{ sink: boolean; routine: boolean }[]>`SELECT
      to_regclass('public.gym_reporting_board_aliases') IS NOT NULL AS sink,
      to_regprocedure('public.revoke_gym_reporting_aliases_on_board_move()') IS NOT NULL AS routine`;
    // Developers may load a historical schema dump. Exercise the actual new
    // migration there as well. CI's canonical dump already contains it.
    if (!gymReporting.sink) {
      await owner.unsafe(
        readFileSync(new URL('../../../../../db/drizzle/0338_gym_reporting_foundation.sql', import.meta.url), 'utf8'),
      );
    }
    if (!gymReporting.routine) {
      await owner.unsafe(
        readFileSync(
          new URL('../../../../../db/drizzle/0340_gym_reporting_alias_venue_guard.sql', import.meta.url),
          'utf8',
        ),
      );
    }
    const [exposure] = await owner<{ present: boolean }[]>`SELECT
      EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (
        'gym_board_grade_collections','spray_exposure_invalidations','spray_exposure_observations',
        'spray_exposure_checkpoints','spray_exposure_event_seq'))
      OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (
        'spray_exposure_board_change','spray_exposure_wall_change','spray_exposure_version_change',
        'spray_exposure_policy_change','spray_exposure_climb_change','spray_exposure_invalidate',
        'spray_exposure_policy_invalidate','spray_exposure_climb_key','spray_exposure_fence_key')) AS present`;
    if (!exposure.present) {
      const tables = readFileSync(
        new URL('../../../../../db/drizzle/0343_gym_grade_inventory.sql', import.meta.url),
        'utf8',
      );
      const triggers = readFileSync(
        new URL('../../../../../db/drizzle/0344_observe_spray_inventory.sql', import.meta.url),
        'utf8',
      );
      await owner.unsafe(`${tables}
${triggers}`);
    }
    // A partial fixture is left intact so verifyFence rejects it.
    const plan = await runAuthFence(['plan', '--confirm-host', address.hostname], environment);
    if (plan.mode !== 'plan') throw new Error('PLAN_EXPECTED');
    expect(plan.sql).toContain('CREATE ROLE "boardsesh_web" LOGIN');
    createdRole = true;
    expect(
      await runAuthFence(['apply', '--confirm-host', address.hostname, '--plan-sha256', plan.planSha256], environment),
    ).toMatchObject({ mode: 'applied' });
    await admin.unsafe(`ALTER ROLE boardsesh_web PASSWORD '${secret}'`);
  });
  afterAll(async () => {
    await web.end({ timeout: 3 });
    await writer.end({ timeout: 3 });
    await owner.end({ timeout: 3 });
    try {
      if (createdDatabase) await admin.unsafe(`DROP DATABASE "${databaseName}"`);
    } finally {
      try {
        if (createdRole) await admin.unsafe('DROP ROLE IF EXISTS boardsesh_web');
      } finally {
        try {
          if (createdWriterRole) await admin.unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(WRITER_ROLE)}`);
        } finally {
          await admin.end({ timeout: 3 });
        }
      }
    }
  });
  /** Runs one statement as the web LOGIN and never lets it commit. */
  async function webStatement(statement: string) {
    await web.begin(async (transaction) => {
      await transaction.unsafe(statement);
      throw new Error('ROLLBACK_FIXTURE');
    });
  }
  it('verifies the complete migrated schema and preserves nonauth web writes and cutoff reads', async () => {
    expect(await verifyFence(owner)).toMatchObject({ verified: true, role: 'boardsesh_web' });
    const [access] = await owner<{ cutoff: boolean; gyms: boolean; sessions: boolean }[]>`
      SELECT has_table_privilege('boardsesh_web','auth_subject_cutoffs','SELECT') AS cutoff,
        has_table_privilege('boardsesh_web','gyms','INSERT,UPDATE,DELETE') AS gyms,
        has_table_privilege('boardsesh_web','auth_session','SELECT') AS sessions`.catch(async () => {
      // PR6 has not created auth_session yet; introduce that future table.
      await owner.unsafe('CREATE TABLE auth_session (token text)');
      await owner.unsafe(fencePlan(await readFenceCatalog(owner)).sql);
      return owner<
        { cutoff: boolean; gyms: boolean; sessions: boolean }[]
      >`SELECT has_table_privilege('boardsesh_web','auth_subject_cutoffs','SELECT') AS cutoff, has_table_privilege('boardsesh_web','gyms','INSERT,UPDATE,DELETE') AS gyms, has_table_privilege('boardsesh_web','auth_session','SELECT') AS sessions`;
    });
    expect(access).toEqual({ cutoff: true, gyms: true, sessions: false });
  });
  it('refuses a web role unable to read primary login denials', async () => {
    await owner
      .begin(async (transaction) => {
        await transaction.unsafe('REVOKE SELECT ON auth_session_denials FROM boardsesh_web');
        await expect(verifyFence(transaction)).rejects.toThrow('SESSION_DENIAL_READ_REQUIRED');
        throw new Error('ROLLBACK_FIXTURE');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'ROLLBACK_FIXTURE') throw error;
      });
    expect(await verifyFence(owner)).toMatchObject({ verified: true });
  });
  it('closes identity sequences and refuses TRIGGER, REFERENCES, TRUNCATE and setval grants', async () => {
    const [sequences] = await owner<{ identity: string; product: string }[]>`
      SELECT pg_get_serial_sequence('public.aurora_credentials','id') AS identity,
        pg_get_serial_sequence('public.playlists','id') AS product`;
    const [usage] = await owner<{ identity: boolean; product: boolean }[]>`
      SELECT has_sequence_privilege('boardsesh_web',${sequences.identity},'USAGE,UPDATE') AS identity,
        has_sequence_privilege('boardsesh_web',${sequences.product},'USAGE') AS product`;
    expect(usage).toEqual({ identity: false, product: true });
    for (const [mutation, code] of [
      [`GRANT USAGE ON SEQUENCE ${sequences.identity} TO boardsesh_web`, 'IDENTITY_SEQUENCE_PATH'],
      [`GRANT UPDATE ON SEQUENCE ${sequences.identity} TO boardsesh_web`, 'IDENTITY_SEQUENCE_PATH'],
      [`GRANT UPDATE ON SEQUENCE ${sequences.product} TO boardsesh_web`, 'UNREVIEWED_SEQUENCE_PRIVILEGE'],
      ['GRANT TRIGGER ON users TO boardsesh_web', 'IDENTITY_WRITE_PATH'],
      ['GRANT REFERENCES ON user_credentials TO boardsesh_web', 'IDENTITY_WRITE_PATH'],
      ['GRANT TRIGGER ON gyms TO boardsesh_web', 'UNREVIEWED_TABLE_PRIVILEGE'],
      ['GRANT REFERENCES (name) ON gyms TO boardsesh_web', 'UNREVIEWED_TABLE_PRIVILEGE'],
      ['GRANT TRUNCATE ON gyms TO boardsesh_web', 'UNREVIEWED_TABLE_PRIVILEGE'],
      ['GRANT INSERT ON aurora_credentials TO boardsesh_web', 'IDENTITY_WRITE_PATH'],
      ['GRANT DELETE ON user_board_mappings TO boardsesh_web', 'IDENTITY_WRITE_PATH'],
    ] as const) {
      await owner
        .begin(async (transaction) => {
          await transaction.unsafe(mutation);
          await expect(verifyFence(transaction), mutation).rejects.toThrow(code);
          throw new Error('ROLLBACK_FIXTURE');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'ROLLBACK_FIXTURE') throw error;
        });
    }
    expect(await verifyFence(owner)).toMatchObject({ verified: true });
  });
  it('detects PUBLIC and column grants and owner/membership counterexamples', async () => {
    for (const mutation of [
      'GRANT UPDATE ON users TO PUBLIC',
      'GRANT UPDATE (email) ON users TO boardsesh_web',
      'GRANT postgres TO boardsesh_web',
      'ALTER TABLE auth_subject_cutoffs OWNER TO boardsesh_web',
    ]) {
      await owner
        .begin(async (transaction) => {
          await transaction.unsafe(mutation);
          await expect(verifyFence(transaction)).rejects.toThrow();
          throw new Error('ROLLBACK_FIXTURE');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'ROLLBACK_FIXTURE') throw error;
        });
    }
    expect(await verifyFence(owner)).toMatchObject({ verified: true });
  });
  it('detects default grants, SECURITY DEFINER routines, writable views and trigger paths', async () => {
    for (const mutation of [
      'ALTER DEFAULT PRIVILEGES GRANT INSERT ON TABLES TO boardsesh_web',
      "CREATE FUNCTION fence_attack() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'UPDATE users SET email = email'; GRANT EXECUTE ON FUNCTION fence_attack() TO boardsesh_web",
      'CREATE VIEW fence_users AS SELECT * FROM users; GRANT UPDATE ON fence_users TO boardsesh_web',
      "CREATE FUNCTION fence_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN UPDATE users SET email = email; RETURN NEW; END'; CREATE TRIGGER fence_trigger BEFORE UPDATE ON gyms FOR EACH ROW EXECUTE FUNCTION fence_trigger()",
    ]) {
      await owner
        .begin(async (transaction) => {
          await transaction.unsafe(mutation);
          await expect(verifyFence(transaction)).rejects.toThrow();
          throw new Error('ROLLBACK_FIXTURE');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'ROLLBACK_FIXTURE') throw error;
        });
    }
  });
  it('verifies the reviewed alias path and preserves revocation through a restricted board update', async () => {
    const userId = randomUUID();
    const gymUuid = randomUUID();
    const boardUuid = randomUUID();
    const rootUuid = randomUUID();
    await owner`INSERT INTO public.users (id, email) VALUES (${userId}, ${`${userId}@example.invalid`})`;
    const [gym] = await owner<{ id: string }[]>`INSERT INTO public.gyms (uuid, name, owner_id)
      VALUES (${gymUuid}, 'Fence gym', ${userId}) RETURNING id`;
    const [board, root] = await owner<{ id: string }[]>`INSERT INTO public.user_boards
      (uuid, slug, name, owner_id, board_type, layout_id, size_id, set_ids, gym_id)
      VALUES (${boardUuid}, ${boardUuid}, 'Fence board', ${userId}, 'kilter', 1, 1, '1', ${gym.id}),
        (${rootUuid}, ${rootUuid}, 'Fence root board', ${userId}, 'kilter', 1, 2, '1', ${gym.id}) RETURNING id`;
    await owner`INSERT INTO public.gym_reporting_board_aliases (gym_id, board_id, root_board_id, verified_by)
      VALUES (${gym.id}, ${board.id}, ${root.id}, ${userId})`;
    const [routine] = await owner<{ executable: boolean }[]>`SELECT
      has_function_privilege('boardsesh_web','public.revoke_gym_reporting_aliases_on_board_move()','EXECUTE') AS executable`;
    expect(routine.executable).toBe(false);
    await expect(verifyFence(owner)).resolves.toMatchObject({ verified: true });
    await web`UPDATE public.user_boards SET gym_id = NULL WHERE id = ${board.id}`;
    const [alias] = await owner<{ revoked: boolean }[]>`SELECT revoked_at IS NOT NULL AS revoked
      FROM public.gym_reporting_board_aliases WHERE board_id = ${board.id}`;
    expect(alias.revoked).toBe(true);
  });

  it('refuses unreviewed executable dependencies in the reporting alias sink', async () => {
    for (const mutation of [
      `CREATE FUNCTION public.alias_fence_noop() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog
        AS $$ BEGIN RETURN NEW; END; $$;
        CREATE TRIGGER alias_fence_noop BEFORE UPDATE ON public.gym_reporting_board_aliases
          FOR EACH ROW EXECUTE FUNCTION public.alias_fence_noop();
        REVOKE ALL ON FUNCTION public.alias_fence_noop() FROM PUBLIC, boardsesh_web`,
      `ALTER TABLE public.gym_reporting_board_aliases ADD CONSTRAINT alias_fence_builtin_probe
        CHECK (pg_catalog.length(verified_by) >= 0) NOT VALID`,
    ]) {
      await owner
        .begin(async (transaction) => {
          await transaction.unsafe(mutation);
          await expect(verifyFence(transaction)).rejects.toThrow('UNREVIEWED_GYM_REPORTING_ALIAS_CLOSURE');
          throw new Error('ROLLBACK_FIXTURE');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'ROLLBACK_FIXTURE') throw error;
        });
    }
    await expect(verifyFence(owner)).resolves.toMatchObject({ verified: true });
  });

  it('refuses an unreviewed gym partial index even when its key is not read', async () => {
    const [spatial] = await owner<{ present: boolean }[]>`SELECT
      to_regclass('public.gyms_location_idx') IS NOT NULL AS present`;
    expect(spatial.present).toBe(true);
    await expect(verifyFence(owner)).resolves.toMatchObject({ verified: true });
    await owner
      .begin(async (transaction) => {
        // A harmless alternate catalog object using only the built-in text
        // operations. Its unread slug key would not have hit the old check.
        await transaction.unsafe(`CREATE OPERATOR CLASS public.gym_fence_text_ops FOR TYPE text USING btree AS
        OPERATOR 1 pg_catalog.< (text, text), OPERATOR 2 pg_catalog.<= (text, text),
        OPERATOR 3 pg_catalog.= (text, text), OPERATOR 4 pg_catalog.>= (text, text),
        OPERATOR 5 pg_catalog.> (text, text), FUNCTION 1 pg_catalog.bttextcmp(text, text);
        CREATE INDEX gym_fence_partial_slug_idx ON public.gyms (slug public.gym_fence_text_ops) WHERE id IS NOT NULL`);
        await expect(verifyFence(transaction)).rejects.toThrow('UNREVIEWED_GYM_REPORTING_ALIAS_CLOSURE');
        throw new Error('ROLLBACK_FIXTURE');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'ROLLBACK_FIXTURE') throw error;
      });
    await expect(verifyFence(owner)).resolves.toMatchObject({ verified: true });
  });

  it('lets restricted web source writers invalidate spray exposure without direct access to its tables, sequence or routines', async () => {
    const userId = randomUUID();
    const boardUuid = randomUUID();
    await owner`INSERT INTO public.users (id, email) VALUES (${userId}, ${`${userId}@example.invalid`})`;
    await owner`INSERT INTO public.user_boards (uuid, slug, name, owner_id, board_type, layout_id, size_id, set_ids)
      VALUES (${boardUuid}, ${boardUuid}, 'Spray fence board', ${userId}, 'spray', 9001, 9001, '1')`;
    await expect(verifyFence(owner)).resolves.toMatchObject({ verified: true });
    const [before] = await owner<{ count: number }[]>`SELECT count(*)::int AS count
      FROM public.spray_exposure_invalidations WHERE kind='board' AND key=${boardUuid}`;
    await web`UPDATE public.user_boards SET angle = 45 WHERE uuid = ${boardUuid}`;
    const [after] = await owner<{ count: number }[]>`SELECT count(*)::int AS count
      FROM public.spray_exposure_invalidations WHERE kind='board' AND key=${boardUuid}`;
    expect(after.count).toBe(before.count + 1);

    for (const statement of [
      'SELECT * FROM public.gym_board_grade_collections',
      'SELECT * FROM public.spray_exposure_invalidations',
      'SELECT * FROM public.spray_exposure_observations',
      'SELECT * FROM public.spray_exposure_checkpoints',
      "SELECT nextval('public.spray_exposure_event_seq')",
      "SELECT public.spray_exposure_invalidate('board', 'fixture', NULL)",
      "SELECT public.spray_exposure_policy_invalidate('fixture')",
      'DELETE FROM public.users WHERE false',
    ]) {
      await expect(webStatement(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
    const executable = await owner<{ name: string }[]>`
      SELECT proname AS name FROM pg_proc routine WHERE routine.pronamespace = 'public'::regnamespace
        AND proname IN ('spray_exposure_board_change','spray_exposure_wall_change','spray_exposure_version_change',
          'spray_exposure_policy_change','spray_exposure_climb_change')
        AND has_function_privilege('boardsesh_web', routine.oid, 'EXECUTE')`;
    expect(executable).toEqual([]);
  });

  it('refuses substitute spray routines, attachment drift and executable sink changes', async () => {
    const mutations = [
      [
        `CREATE OR REPLACE FUNCTION public.spray_exposure_fence_key(dependency text, source_key text)
          RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
          AS $$ SELECT 1::bigint $$`,
        'UNREVIEWED_SPRAY_EXPOSURE_ROUTINE',
      ],
      [
        `CREATE FUNCTION public.spray_exposure_policy_invalidate(board_uuid text, extra text DEFAULT NULL)
          RETURNS void LANGUAGE sql SET search_path = pg_catalog AS $$ SELECT NULL::void $$`,
        'UNREVIEWED_SPRAY_EXPOSURE_ROUTINE',
      ],
      [
        'DROP TRIGGER spray_exposure_version_update ON public.spray_wall_versions',
        'UNREVIEWED_SPRAY_EXPOSURE_ATTACHMENT',
      ],
      [
        `DROP TRIGGER spray_exposure_board_insert ON public.user_boards;
          CREATE TRIGGER spray_exposure_board_insert AFTER INSERT ON public.user_boards
          FOR EACH ROW WHEN (NEW.board_type = 'kilter') EXECUTE FUNCTION public.spray_exposure_board_change()`,
        'UNREVIEWED_SPRAY_EXPOSURE_ATTACHMENT',
      ],
      [
        `CREATE FUNCTION public.exposure_fence_noop() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
          AS $$ BEGIN RETURN NEW; END; $$;
          CREATE TRIGGER exposure_fence_noop BEFORE INSERT ON public.spray_exposure_invalidations
          FOR EACH ROW EXECUTE FUNCTION public.exposure_fence_noop()`,
        'UNREVIEWED_SPRAY_EXPOSURE_CLOSURE',
      ],
      ['ALTER SEQUENCE public.spray_exposure_event_seq CACHE 10', 'UNREVIEWED_SPRAY_EXPOSURE_CLOSURE'],
      ['GRANT SELECT ON public.spray_exposure_checkpoints TO boardsesh_web', 'UNREVIEWED_GYM_INVENTORY_PRIVILEGE'],
    ] as const;
    for (const [mutation, result] of mutations) {
      await owner
        .begin(async (transaction) => {
          await transaction.unsafe(mutation);
          await expect(verifyFence(transaction)).rejects.toThrow(result);
          throw new Error('ROLLBACK_FIXTURE');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'ROLLBACK_FIXTURE') throw error;
        });
    }
    await expect(verifyFence(owner)).resolves.toMatchObject({ verified: true });
  });

  it('keeps new tables denied by default and explicitly reconciles auth versus nonauth', async () => {
    await owner.unsafe('CREATE TABLE auth_future_identity (id text); CREATE TABLE fence_product (id text)');
    const [before] = await owner<
      { writes: boolean }[]
    >`SELECT has_table_privilege('boardsesh_web','auth_future_identity','INSERT') AS writes`;
    expect(before.writes).toBe(false);
    await owner.unsafe(fencePlan(await readFenceCatalog(owner)).sql);
    const [after] = await owner<
      { identity: boolean; product: boolean }[]
    >`SELECT has_table_privilege('boardsesh_web','auth_future_identity','INSERT') AS identity, has_table_privilege('boardsesh_web','fence_product','INSERT') AS product`;
    expect(after).toEqual({ identity: false, product: true });
    expect(await verifyFence(owner)).toMatchObject({ verified: true });
  });
  it('prepares only, and activation cannot bypass open code gates', async () => {
    expect(
      await runAuthAuthority(
        ['prepare', '--confirm-host', address.hostname, '--projection-id', 'synthetic-test-projection'],
        environment,
      ),
    ).toMatchObject({ mode: 'prepared' });
    await expect(runAuthAuthority(['activate', '--confirm-host', address.hostname], environment)).rejects.toThrow(
      'ACTIVATION_CODE_GATES_OPEN',
    );
    expect(await runAuthAuthority(['status', '--confirm-host', address.hostname], environment)).toMatchObject({
      manifest: { phase: 'prepared' },
      fence: { verified: true },
    });
  });
  it('applies the same reviewed CLI plan with operator parser settings', async () => {
    const plan = await runAuthFence(['plan', '--confirm-host', address.hostname], environment);
    if (plan.mode !== 'plan') throw new Error('PLAN_EXPECTED');
    expect(plan.sql).toContain('REVOKE');
    await expect(
      runAuthFence(['apply', '--confirm-host', address.hostname, '--plan-sha256', 'wrong'], environment),
    ).rejects.toThrow('PLAN_CHANGED');
    expect(
      await runAuthFence(['apply', '--confirm-host', address.hostname, '--plan-sha256', plan.planSha256], environment),
    ).toMatchObject({ mode: 'applied', evidence: { verified: true } });
  });
  it('apply waits for the fence lock a migration reconcile holds, then gives up at 2 seconds', async () => {
    const plan = await runAuthFence(['plan', '--confirm-host', address.hostname], environment);
    if (plan.mode !== 'plan') throw new Error('PLAN_EXPECTED');
    await owner.begin(async (transaction) => {
      await transaction.unsafe(WEB_FENCE_LOCK_SQL);
      await expect(
        runAuthFence(['apply', '--confirm-host', address.hostname, '--plan-sha256', plan.planSha256], environment),
      ).rejects.toMatchObject({ code: '55P03' });
    });
  });
  it('a migration reconcile gives up on a held fence lock within 2 seconds and names the apply', async () => {
    // A second owner session plays the migration; the first holds the lock like an idle apply.
    const migration = postgres(address.toString(), { max: 1, onnotice: () => {} });
    try {
      await owner.begin(async (holder) => {
        await holder.unsafe(WEB_FENCE_LOCK_SQL);
        const started = Date.now();
        await expect(
          migration.begin(async (transaction) => {
            await transaction`SET LOCAL lock_timeout = 0`;
            return reconcileWebRuntimeAcl(transaction, 'postgres');
          }),
        ).rejects.toMatchObject({ code: '55P03', message: expect.stringContaining('auth:fence apply') });
        expect(Date.now() - started).toBeLessThan(5000);
      });
      // Free lock: the session's own lock_timeout comes back for the grants.
      const [setting] = await migration.begin(async (transaction) => {
        await transaction`SET LOCAL lock_timeout = '7s'`;
        await reconcileWebRuntimeAcl(transaction, 'postgres');
        return transaction<{ value: string }[]>`SELECT current_setting('lock_timeout') AS value`;
      });
      expect(setting.value).toBe('7s');
    } finally {
      await migration.end({ timeout: 3 });
    }
  });
  it('verifies read-only from the CLI and refuses a reopened identity write path', async () => {
    expect(await runAuthFence(['verify', '--confirm-host', address.hostname], environment)).toMatchObject({
      mode: 'verify',
      role: 'boardsesh_web',
      verified: true,
    });
    await owner.unsafe('GRANT INSERT ON public.users TO boardsesh_web');
    try {
      await expect(runAuthFence(['verify', '--confirm-host', address.hostname], environment)).rejects.toThrow(
        'IDENTITY_WRITE_PATH',
      );
    } finally {
      await owner.unsafe('REVOKE INSERT ON public.users FROM boardsesh_web');
    }
    expect(await runAuthFence(['verify', '--confirm-host', address.hostname], environment)).toMatchObject({
      verified: true,
    });
  });
  it('rejects domain defaults and shadow comparison operators in reviewed definer paths', async () => {
    for (const mutation of [
      "CREATE FUNCTION sink_attack(text) RETURNS boolean LANGUAGE plpgsql AS 'BEGIN UPDATE users SET email=email; RETURN true; END'; CREATE DOMAIN sink_domain AS text CHECK (sink_attack(VALUE)); ALTER TABLE logbook_changes ADD COLUMN attack sink_domain DEFAULT 'x'; REVOKE EXECUTE ON FUNCTION sink_attack(text) FROM PUBLIC,boardsesh_web",
      "CREATE FUNCTION comparison_attack(tick_origin,tick_origin) RETURNS boolean LANGUAGE plpgsql AS 'BEGIN UPDATE users SET email=email; RETURN true; END'; CREATE OPERATOR public.= (LEFTARG=tick_origin,RIGHTARG=tick_origin,FUNCTION=comparison_attack); REVOKE EXECUTE ON FUNCTION comparison_attack(tick_origin,tick_origin) FROM PUBLIC,boardsesh_web",
    ]) {
      await owner
        .begin(async (transaction) => {
          await transaction.unsafe(mutation);
          await expect(verifyFence(transaction)).rejects.toThrow();
          throw new Error('ROLLBACK_FIXTURE');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'ROLLBACK_FIXTURE') throw error;
        });
    }
  });
  it('keeps identity writes denied for a separately authenticated web role and tick logging working', async () => {
    const identityId = randomUUID();
    const tickId = randomUUID();
    await drizzle(owner).insert(users).values({ id: identityId, email: 'synthetic-fence@example.invalid' });
    const database = drizzle(web);
    for (const operation of [
      () => database.insert(users).values({ id: randomUUID(), email: 'denied@example.invalid' }),
      () => database.update(users).set({ name: 'denied' }).where(eq(users.id, identityId)),
      () => database.delete(users).where(eq(users.id, identityId)),
    ])
      await expect(operation()).rejects.toMatchObject({ cause: { code: '42501' } });
    const [before] = await owner<{ count: number }[]>`SELECT count(*)::int AS count FROM logbook_changes`;
    await database.insert(boardseshTicks).values({
      uuid: tickId,
      userId: identityId,
      boardType: 'kilter',
      climbUuid: randomUUID(),
      angle: 40,
      status: 'send',
      climbedAt: new Date().toISOString(),
    });
    await database.update(boardseshTicks).set({ comment: 'synthetic edit' }).where(eq(boardseshTicks.uuid, tickId));
    await database.delete(boardseshTicks).where(eq(boardseshTicks.uuid, tickId));
    const [after] = await owner<{ count: number }[]>`SELECT count(*)::int AS count FROM logbook_changes`;
    expect(after.count).toBe(before.count + 3);
    await expect(web.unsafe('SELECT * FROM auth_session')).rejects.toMatchObject({ code: '42501' });
    await web.unsafe('SELECT * FROM auth_subject_cutoffs');
    await web.unsafe('SELECT * FROM auth_session_denials');
  });
  it('refuses INSERT, UPDATE, DELETE and TRUNCATE on every identity table with 42501', async () => {
    const relations = await owner<{ name: string; firstColumn: string }[]>`
      SELECT relation.relname AS name,
        (SELECT attname FROM pg_attribute WHERE attrelid = relation.oid AND attnum > 0 AND NOT attisdropped ORDER BY attnum LIMIT 1) AS "firstColumn"
      FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relkind IN ('r','p') ORDER BY 1`;
    const identityTables = relations.filter(({ name }) => protectedIdentityTable(name));
    // Positive control: an empty or renamed catalogue must not pass as "every table refused".
    expect(identityTables.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'users',
        'accounts',
        'sessions',
        'verificationTokens',
        'user_credentials',
        'mobile_refresh_tokens',
        'integration_credentials',
        'auth_account',
        'auth_session',
        'auth_subject_cutoffs',
        'auth_session_denials',
        'oauth_access_token',
        'oauth_refresh_token',
        'oauth_connections',
      ]),
    );
    const allowed: string[] = [];
    for (const { name, firstColumn } of identityTables) {
      const table = `public.${quoteIdentifier(name)}`;
      for (const statement of [
        `INSERT INTO ${table} DEFAULT VALUES`,
        `UPDATE ${table} SET ${quoteIdentifier(firstColumn)} = ${quoteIdentifier(firstColumn)}`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table}`,
      ]) {
        // webStatement always throws: its own sentinel means the statement ran.
        const code = await webStatement(statement).then(
          () => 'ALLOWED',
          (error: unknown) =>
            error instanceof Error && error.message === 'ROLLBACK_FIXTURE'
              ? 'ALLOWED'
              : ((error as { code?: string }).code ?? 'NO_SQLSTATE'),
        );
        if (code !== '42501') allowed.push(`${statement}: ${code}`);
      }
    }
    expect(allowed).toEqual([]);
  });
  it('refuses SELECT on every backend-owned partner table', async () => {
    for (const table of BACKEND_ONLY_PARTNER_TABLES) {
      await expect(web.unsafe(`SELECT * FROM public.${quoteIdentifier(table)}`)).rejects.toMatchObject({
        code: '42501',
      });
    }
  });
  it('keeps an ordinary playlist write working for the web role', async () => {
    const ownerId = randomUUID();
    const playlistUuid = randomUUID();
    await drizzle(owner)
      .insert(users)
      .values({ id: ownerId, email: `playlist-${ownerId}@example.invalid` });
    const database = drizzle(web);
    const [created] = await database
      .insert(playlists)
      .values({ uuid: playlistUuid, boardType: 'kilter', name: 'Fence check' })
      .returning({ id: playlists.id });
    await database.insert(playlistOwnership).values({ playlistId: created.id, userId: ownerId, role: 'owner' });
    await database.update(playlists).set({ name: 'Fence check, renamed' }).where(eq(playlists.id, created.id));
    await database.delete(playlists).where(eq(playlists.id, created.id));
    // The delete trigger runs as the web role and records the tombstone the sync pull reads.
    const tombstones = await drizzle(owner)
      .select({ userId: syncDeletions.userId })
      .from(syncDeletions)
      .where(eq(syncDeletions.recordId, playlistUuid));
    expect(tombstones).toEqual([{ userId: ownerId }]);
  });
  it('prepare and activate both wait on the exclusive gate and fail at the 2-second deadline', async () => {
    await owner.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock_shared(6975,2)`;
      for (const command of ['prepare', 'activate']) {
        await expect(
          runAuthAuthority([command, '--confirm-host', address.hostname], environment),
        ).rejects.toMatchObject({ cause: { code: '55P03' } });
      }
    });
  });
  it('activation rechecks users changed after preparation rather than trusting old counts', async () => {
    const identityIds = [randomUUID(), randomUUID()];
    await drizzle(owner)
      .insert(users)
      .values(identityIds.map((id) => ({ id, email: 'collision-fence@example.invalid' })));
    try {
      await expect(runAuthAuthority(['activate', '--confirm-host', address.hostname], environment)).rejects.toThrow(
        'EMAIL_COLLISIONS_REMAIN',
      );
      expect(await runAuthAuthority(['status', '--confirm-host', address.hostname], environment)).toMatchObject({
        manifest: { phase: 'prepared' },
      });
    } finally {
      for (const id of identityIds) await drizzle(owner).delete(users).where(eq(users.id, id));
    }
  });
  it('reconciles as a restricted DDL owner without impersonating a separate helper owner', async () => {
    const ddlOwner = `ba04_ddl_${randomUUID().replaceAll('-', '')}`;
    const helperOwner = `ba04_helper_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(
      `CREATE ROLE ${quoteIdentifier(ddlOwner)} NOLOGIN; CREATE ROLE ${quoteIdentifier(helperOwner)} NOLOGIN`,
    );
    try {
      await owner
        .begin(async (transaction) => {
          const transfers = await transaction<
            { statement: string }[]
          >`SELECT format('ALTER %s %I.%I OWNER TO %I',CASE relation.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,namespace.nspname,relation.relname,${ddlOwner}::text) AS statement
          FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema' AND relation.relkind IN ('r','p','v','m','S')
            AND NOT EXISTS (SELECT 1 FROM pg_depend WHERE classid='pg_class'::regclass AND objid=relation.oid AND deptype='e')
          ORDER BY CASE WHEN relation.relkind='S' THEN 1 ELSE 0 END`;
          for (const { statement } of transfers) await transaction.unsafe(statement);
          const schemas = await transaction<
            { statement: string }[]
          >`SELECT format('ALTER SCHEMA %I OWNER TO %I',nspname,${ddlOwner}::text) AS statement FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'`;
          for (const { statement } of schemas) await transaction.unsafe(statement);
          // Keep each reviewed routine under the same owner as its sink.
          for (const signature of [
            'public.spray_exposure_fence_key(text, text)',
            'public.spray_exposure_climb_key(integer, text)',
            'public.spray_exposure_invalidate(text, text, text)',
            'public.spray_exposure_policy_invalidate(text)',
            'public.spray_exposure_board_change()',
            'public.spray_exposure_wall_change()',
            'public.spray_exposure_version_change()',
            'public.spray_exposure_policy_change()',
            'public.spray_exposure_climb_change()',
          ]) {
            await transaction.unsafe(`ALTER FUNCTION ${signature} OWNER TO ${quoteIdentifier(ddlOwner)}`);
          }
          await transaction.unsafe(
            `CREATE FUNCTION public.ba04_separate_helper() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'SELECT'; ALTER FUNCTION public.ba04_separate_helper() OWNER TO ${quoteIdentifier(helperOwner)}`,
          );
          await transaction.unsafe(fencePlan(await readFenceCatalog(transaction)).sql);
          await transaction.unsafe(`SET LOCAL ROLE ${quoteIdentifier(ddlOwner)}`);
          expect(await reconcileWebRuntimeAcl(transaction, ddlOwner)).toMatchObject({ verified: true });
          await transaction.unsafe('RESET ROLE');
          await transaction.unsafe(
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(helperOwner)} GRANT EXECUTE ON ROUTINES TO PUBLIC`,
          );
          await transaction.unsafe(`SET LOCAL ROLE ${quoteIdentifier(ddlOwner)}`);
          await expect(reconcileWebRuntimeAcl(transaction, ddlOwner)).rejects.toThrow('UNREVIEWED_DEFAULTS_PATH');
          throw new Error('ROLLBACK_FIXTURE');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'ROLLBACK_FIXTURE') throw error;
        });
    } finally {
      await admin.unsafe(`DROP ROLE ${quoteIdentifier(helperOwner)}; DROP ROLE ${quoteIdentifier(ddlOwner)}`);
    }
  });
  // Last on purpose: the test-only writer grants also strip PUBLIC rights the earlier cases do not expect.
  it('lets the separately authenticated identity writer change credentials while the web fence holds', async () => {
    await admin.unsafe(
      `CREATE ROLE ${quoteIdentifier(WRITER_ROLE)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${writerSecret}'`,
    );
    createdWriterRole = true;
    await admin.unsafe(`ALTER ROLE ${quoteIdentifier(WRITER_ROLE)} SET search_path = pg_catalog, public`);
    await grantOwnedCredentialWriterCapabilities(owner, WRITER_CONTRACT);
    await expect(
      qualifyCredentialWriter(writer, {
        expectedRole: WRITER_ROLE,
        expectedDatabase: databaseName,
        contract: WRITER_CONTRACT,
      }),
    ).resolves.toMatchObject({ role: WRITER_ROLE, sessionRole: WRITER_ROLE });
    const userId = randomUUID();
    const sessionId = randomUUID();
    const database = drizzle(writer);
    await database.insert(users).values({ id: userId, email: `writer-${userId}@example.invalid` });
    await database.insert(userCredentials).values({ userId, passwordHash: 'synthetic-before' });
    // Exercise the actual new indirect path, not only a credential write for
    // an account with no partner connection or attached workout.
    const partnerClientId = randomUUID();
    const connectionId = randomUUID();
    const boardSessionId = randomUUID();
    const workoutId = randomUUID();
    await owner`INSERT INTO public.oauth_client(id,client_id,redirect_uris)
      VALUES(${partnerClientId},${partnerClientId},ARRAY['https://owned.example.invalid/callback'])`;
    await owner`INSERT INTO public.oauth_connections(id,user_id,client_id,generation)
      VALUES(${connectionId},${userId},${partnerClientId},0)`;
    const [boardSession] = await owner<
      { exportId: string }[]
    >`INSERT INTO public.board_sessions(id,board_path,created_by_user_id)
      VALUES(${boardSessionId},'kilter/1/1/1/40',${userId}) RETURNING export_id AS "exportId"`;
    await owner`INSERT INTO public.app_workouts(id,client_id,user_id,connection_id,connection_generation,external_ref,title,spec,status,session_id,expires_at)
      VALUES(${workoutId},${partnerClientId},${userId},${connectionId},0,'owned-revoke','Owned workout','{}'::jsonb,'started',${boardSessionId},now()+interval '1 day')`;
    await owner`DELETE FROM public.logbook_session_changes WHERE user_id=${userId}`;
    const [capabilities] = await writer<{ source: boolean; sink: boolean; sequence: boolean }[]>`SELECT
      has_table_privilege(current_user,'public.board_sessions','SELECT') AS source,
      has_table_privilege(current_user,'public.logbook_session_changes','INSERT') AS sink,
      has_sequence_privilege(current_user,'public.logbook_changes_seq_seq','USAGE') AS sequence`;
    expect(capabilities).toEqual({ source: false, sink: false, sequence: false });

    await database
      .update(userCredentials)
      .set({ passwordHash: 'synthetic-after' })
      .where(eq(userCredentials.userId, userId));
    const [revokedWorkout] = await owner<
      { status: string }[]
    >`SELECT status FROM public.app_workouts WHERE id=${workoutId}`;
    expect(revokedWorkout.status).toBe('revoked');
    const hints = await owner<
      { sessionId: string }[]
    >`SELECT session_export_id AS "sessionId" FROM public.logbook_session_changes WHERE user_id=${userId}`;
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.every((hint) => hint.sessionId === boardSession.exportId)).toBe(true);
    await database.update(users).set({ name: 'Writer renamed' }).where(eq(users.id, userId));
    await database.insert(authSession).values({
      id: sessionId,
      token: randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
    });
    await database.delete(authSession).where(eq(authSession.id, sessionId));
    const [stored] = await drizzle(owner)
      .select({ passwordHash: userCredentials.passwordHash })
      .from(userCredentials)
      .where(eq(userCredentials.userId, userId));
    expect(stored).toEqual({ passwordHash: 'synthetic-after' });
    // The writer's grants leave the web fence intact.
    expect(await runAuthFence(['verify', '--confirm-host', address.hostname], environment)).toMatchObject({
      verified: true,
    });
    await expect(
      webStatement(`UPDATE public.user_credentials SET password_hash = 'web' WHERE user_id = '${userId}'`),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('rejects drift throughout the credential writer’s session-sync side-effect closure', async () => {
    const qualify = () =>
      qualifyCredentialWriter(writer, {
        expectedRole: WRITER_ROLE,
        expectedDatabase: databaseName,
        contract: WRITER_CONTRACT,
      });
    async function drift(apply: string, restore: string, code: string) {
      await owner.unsafe(apply);
      try {
        await expect(qualify(), apply).rejects.toMatchObject({ code });
      } finally {
        await owner.unsafe(restore);
      }
      await expect(qualify()).resolves.toMatchObject({ role: WRITER_ROLE });
    }
    const [original] = await owner<
      { definition: string; owner: string }[]
    >`SELECT pg_get_functiondef(oid) AS definition,
      pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='public.log_partner_session_from_workout()'::regprocedure`;
    await drift(
      "CREATE OR REPLACE FUNCTION public.log_partner_session_from_workout() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS 'BEGIN RETURN NULL; END'",
      original.definition,
      'CREDENTIAL_WRITER_UNREVIEWED_PARTNER_REVOKE',
    );
    await drift(
      'ALTER FUNCTION public.log_partner_session_from_workout() SET search_path=pg_catalog',
      original.definition,
      'CREDENTIAL_WRITER_UNREVIEWED_PARTNER_REVOKE',
    );
    await drift(
      'ALTER FUNCTION public.log_partner_session_from_workout() OWNER TO boardsesh_sync_cutoff_owner',
      `ALTER FUNCTION public.log_partner_session_from_workout() OWNER TO ${quoteIdentifier(original.owner)}`,
      'CREDENTIAL_WRITER_UNREVIEWED_PARTNER_REVOKE',
    );
    await drift(
      'ALTER TABLE public.app_workouts DISABLE TRIGGER trg_partner_session_app_workout',
      'ALTER TABLE public.app_workouts ENABLE TRIGGER trg_partner_session_app_workout',
      'CREDENTIAL_WRITER_UNREVIEWED_TRIGGER_PATH',
    );
    await drift(
      'ALTER TABLE public.board_sessions ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.board_sessions DISABLE ROW LEVEL SECURITY',
      'CREDENTIAL_WRITER_UNREVIEWED_SHAPE_PATH',
    );
    await drift(
      'ALTER TABLE public.logbook_session_changes ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.logbook_session_changes DISABLE ROW LEVEL SECURITY',
      'CREDENTIAL_WRITER_UNREVIEWED_SHAPE_PATH',
    );
    await drift(
      'ALTER TABLE public.logbook_session_changes ALTER COLUMN created_at SET DEFAULT clock_timestamp()',
      'ALTER TABLE public.logbook_session_changes ALTER COLUMN created_at SET DEFAULT now()',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
    await drift(
      "ALTER TABLE public.logbook_session_changes ADD CONSTRAINT credential_session_check CHECK (current_setting('session_replication_role')='origin')",
      'ALTER TABLE public.logbook_session_changes DROP CONSTRAINT credential_session_check',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
    await drift(
      'CREATE TRIGGER credential_session_sink_probe BEFORE INSERT ON public.logbook_session_changes FOR EACH ROW EXECUTE FUNCTION public.log_partner_session_from_workout()',
      'DROP TRIGGER credential_session_sink_probe ON public.logbook_session_changes',
      'CREDENTIAL_WRITER_UNREVIEWED_TRIGGER_PATH',
    );
    await drift(
      "CREATE FUNCTION public.credential_session_index_probe(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT $1'; CREATE INDEX credential_session_index_probe ON public.board_sessions(public.credential_session_index_probe(id))",
      'DROP INDEX public.credential_session_index_probe; DROP FUNCTION public.credential_session_index_probe(text)',
      'CREDENTIAL_WRITER_UNREVIEWED_EXPRESSION_PATH',
    );
    await drift(
      'ALTER SEQUENCE public.logbook_changes_seq_seq CACHE 2',
      'ALTER SEQUENCE public.logbook_changes_seq_seq CACHE 1',
      'CREDENTIAL_WRITER_UNREVIEWED_SESSION_SYNC_SEQUENCE',
    );
    await drift(
      'GRANT SELECT ON public.board_sessions TO boardsesh_identity_writer',
      'REVOKE SELECT ON public.board_sessions FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT INSERT ON public.logbook_session_changes TO boardsesh_identity_writer',
      'REVOKE INSERT ON public.logbook_session_changes FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT USAGE ON SEQUENCE public.logbook_changes_seq_seq TO boardsesh_identity_writer',
      'REVOKE USAGE ON SEQUENCE public.logbook_changes_seq_seq FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_UNREVIEWED_SEQUENCE_PATH',
    );
  });
});
