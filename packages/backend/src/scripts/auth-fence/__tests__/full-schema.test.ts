import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { users } from '@boardsesh/db/schema/auth';
import { boardseshTicks } from '@boardsesh/db/schema/app';
import { runAuthFence } from '../../auth-fence';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { fencePlan, readFenceCatalog, verifyFence } from '../catalog';
import { reconcileWebRuntimeAcl, quoteIdentifier } from '@boardsesh/db/auth-web-acl';
import { runAuthAuthority } from '../../auth-authority';

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
  let createdDatabase = false;
  let createdRole = false;
  beforeAll(async () => {
    const [role] = await admin<
      { present: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'boardsesh_web') AS present`;
    if (role.present) throw new Error('TEST_REQUIRES_ABSENT_WEB_ROLE');
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
    const plan = await runAuthFence(['plan', '--confirm-host', address.hostname], environment);
    expect('sql' in plan && plan.sql).toContain('CREATE ROLE "boardsesh_web" LOGIN');
    createdRole = true;
    expect(
      await runAuthFence(['apply', '--confirm-host', address.hostname, '--plan-sha256', plan.sha256], environment),
    ).toMatchObject({ mode: 'applied' });
    await admin.unsafe(`ALTER ROLE boardsesh_web PASSWORD '${secret}'`);
  });
  afterAll(async () => {
    await web.end({ timeout: 3 });
    await owner.end({ timeout: 3 });
    try {
      if (createdDatabase) await admin.unsafe(`DROP DATABASE "${databaseName}"`);
    } finally {
      try {
        if (createdRole) await admin.unsafe('DROP ROLE IF EXISTS boardsesh_web');
      } finally {
        await admin.end({ timeout: 3 });
      }
    }
  });
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
    expect('sql' in plan).toBe(true);
    await expect(
      runAuthFence(['apply', '--confirm-host', address.hostname, '--plan-sha256', 'wrong'], environment),
    ).rejects.toThrow('PLAN_CHANGED');
    expect(
      await runAuthFence(['apply', '--confirm-host', address.hostname, '--plan-sha256', plan.sha256], environment),
    ).toMatchObject({ mode: 'applied', evidence: { verified: true } });
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
});
