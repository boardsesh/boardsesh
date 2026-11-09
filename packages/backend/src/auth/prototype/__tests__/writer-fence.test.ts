import { randomBytes, randomUUID } from 'node:crypto';
import { eq, getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it } from 'vite-plus/test';
import * as schema from '@boardsesh/db/auth-prototype';
import { createPrototypeEnvironment } from '../environment';

const tableNames = Object.values(schema)
  .filter((entry) => is(entry, PgTable))
  .map((table) => getTableName(table))
  .sort();
const quotedTables = tableNames.map((name) => `public."${name}"`).join(', ');

function barrier<Result>() {
  let release: (result: Result) => void = () => {};
  const promise = new Promise<Result>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function bounded<Result>(promise: Promise<Result>, message: string, milliseconds = 5000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return 'cause' in error ? errorCode(error.cause) : undefined;
}

async function outcome<Result>(operation: PromiseLike<Result>) {
  try {
    return { ok: true as const, result: await operation };
  } catch (error) {
    // Never copy SQL, connection URLs or generated role passwords into assertions.
    return { ok: false as const, code: errorCode(error) };
  }
}

async function waitForLock(owner: postgres.Sql, pid: number, mode: 'AccessExclusiveLock' | 'RowExclusiveLock') {
  const deadline = performance.now() + 5000;
  do {
    const [waiting] = await owner<{ blockers: number[]; wait_event_type: string }[]>`
      select pg_blocking_pids(activity.pid) as blockers, activity.wait_event_type
      from pg_stat_activity activity
      join pg_locks waiting on waiting.pid = activity.pid
      where activity.pid = ${pid} and waiting.relation = 'public."user"'::regclass
        and waiting.locktype = 'relation' and waiting.mode = ${mode} and not waiting.granted
    `;
    if (waiting?.wait_event_type === 'Lock' && waiting.blockers.length > 0) return waiting;
    // Polling merely schedules another catalog observation; elapsed time alone
    // is never accepted as evidence that a statement reached a database lock.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw new Error(`The owned writer did not reach its expected ${mode} wait.`);
}

function preparingDriver(pool: postgres.Sql): postgres.Sql {
  // Drizzle's postgres-js .prepare() still uses unsafe(), whose default is
  // prepare:false. Opt in at this test-only driver boundary; Drizzle continues
  // generating every table write and binding its parameters. Catalog assertions
  // below prove actual PostgreSQL preparation rather than trusting its label.
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'unsafe') return Reflect.get(target, property, receiver);
      return (...arguments_: Parameters<postgres.Sql['unsafe']>) => {
        const [statement, parameters, options] = arguments_;
        return target.unsafe(statement, parameters, { ...options, prepare: true });
      };
    },
  });
}

async function createFixture() {
  const environment = await createPrototypeEnvironment();
  const owner = postgres(environment.databaseUrl, {
    max: 4,
    connect_timeout: 3,
    connection: { statement_timeout: 10000, lock_timeout: 8000 },
    onnotice: () => {},
  });
  const adminUrl = new URL(environment.databaseUrl);
  adminUrl.pathname = '/postgres';
  const administrator = postgres(adminUrl.toString(), {
    max: 1,
    connect_timeout: 3,
    connection: { statement_timeout: 10000, lock_timeout: 8000 },
    onnotice: () => {},
  });
  const createdRoles: string[] = [];
  const pools: postgres.Sql[] = [];
  const gates: Array<() => void> = [];
  const pending: Promise<unknown>[] = [];
  let closing: Promise<void> | undefined;

  function close(pendingWaitMilliseconds = 12000): Promise<void> {
    closing ??= closeResources(pendingWaitMilliseconds);
    return closing;
  }

  async function closeResources(pendingWaitMilliseconds: number) {
    for (const release of gates) release();
    const failures: string[] = [];
    await bounded(
      Promise.allSettled(pending),
      'Owned writer operations did not settle during cleanup.',
      pendingWaitMilliseconds,
    ).catch(() => failures.push('pending writer timeout'));
    const closedPools = await Promise.allSettled([...pools, owner].map((pool) => pool.end({ timeout: 2 })));
    if (closedPools.some((result) => result.status === 'rejected')) failures.push('owned pool close');
    try {
      // Remove table grants and test-only ownership by dropping only this
      // environment's database, before dropping our successfully created roles.
      let databaseRemoved = false;
      try {
        await environment.close();
        databaseRemoved = true;
      } catch {
        failures.push('owned database removal');
      }
      if (databaseRemoved) {
        for (const role of [...createdRoles].reverse()) {
          try {
            await administrator.unsafe(`DROP ROLE IF EXISTS "${role}"`);
          } catch {
            failures.push('owned role removal');
          }
        }
      }
    } finally {
      await administrator.end({ timeout: 2 }).catch(() => failures.push('administrator pool close'));
    }
    if (failures.length) throw new Error(`Writer-fence fixture cleanup failed: ${failures.join(', ')}.`);
  }

  function gate() {
    const held = barrier<void>();
    gates.push(() => held.release());
    return held;
  }

  function track<Result>(operation: PromiseLike<Result>) {
    const settled = outcome(operation);
    pending.push(settled);
    return settled;
  }

  async function role(
    label: string,
    login = true,
    hooks: { beforeCommit?: (name: string) => void; afterCommit?: (name: string) => void } = {},
  ) {
    if (!/^[a-z]+$/.test(label)) throw new Error('Invalid owned fixture role label.');
    const name = `ba01_fence_${label}_${randomUUID().replaceAll('-', '')}`;
    const password = randomBytes(24).toString('hex');
    try {
      await owner.begin(async (transaction) => {
        await transaction.unsafe(
          `CREATE ROLE "${name}" ${login ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'} ` +
            'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        );
        // Track successful CREATE before COMMIT can lose its reply. A lost
        // CREATE reply rolls this transaction back; an uncertain COMMIT still
        // leaves a known owned name for cleanup. Rolled-back names use IF EXISTS.
        createdRoles.push(name);
        await transaction.unsafe(`GRANT USAGE ON SCHEMA public TO "${name}"`);
        await transaction.unsafe(
          `GRANT CONNECT ON DATABASE "${new URL(environment.databaseUrl).pathname.slice(1)}" TO "${name}"`,
        );
        hooks.beforeCommit?.(name);
      });
      hooks.afterCommit?.(name);
    } catch {
      // CREATE ROLE contains a synthetic password, so its driver error is private.
      throw new Error('Could not create an isolated writer-fence fixture role.');
    }

    function connect() {
      const databaseUrl = new URL(environment.databaseUrl);
      databaseUrl.username = name;
      databaseUrl.password = password;
      const pool = postgres(databaseUrl.toString(), {
        max: 1,
        prepare: true,
        connect_timeout: 3,
        connection: { application_name: name, statement_timeout: 10000, lock_timeout: 8000 },
        onnotice: () => {},
      });
      pools.push(pool);
      return { pool, database: drizzle(preparingDriver(pool), { schema }) };
    }
    return { name, connect };
  }

  try {
    const [administratorRole] = await owner<{ rolsuper: boolean }[]>`
      select rolsuper from pg_roles where rolname = current_user
    `;
    // This local administrator creates/cleans cluster roles and demonstrates
    // privileged bypasses. Application LOGIN roles below have none of its rights.
    expect(administratorRole.rolsuper).toBe(true);
    await owner.unsafe('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC');
    await owner.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await owner.unsafe(
      `REVOKE CREATE, TEMPORARY ON DATABASE "${new URL(environment.databaseUrl).pathname.slice(1)}" FROM PUBLIC`,
    );
    const oldRole = await role('old');
    const newRole = await role('new');
    for (const login of [oldRole, newRole]) {
      await owner.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${login.name}"`);
    }
    await owner.unsafe(`GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${oldRole.name}"`);
    const old = oldRole.connect();
    const replacement = newRole.connect();

    async function fence(
      whileLocked?: (transaction: postgres.TransactionSql) => Promise<void>,
      beforeLock?: (transaction: postgres.TransactionSql) => Promise<void>,
    ) {
      return owner.begin(async (transaction) => {
        await beforeLock?.(transaction);
        await transaction.unsafe(`LOCK TABLE ${quotedTables} IN ACCESS EXCLUSIVE MODE`);
        await transaction.unsafe(`REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM "${oldRole.name}"`);
        await transaction.unsafe(`GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${newRole.name}"`);
        await whileLocked?.(transaction);
      });
    }
    return { environment, owner, oldRole, newRole, old, replacement, role, gate, track, fence, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function fixtureTest(operation: (fixture: Fixture) => Promise<void>) {
  const fixture = await createFixture();
  try {
    await operation(fixture);
  } finally {
    await fixture.close();
  }
}

function userRecord() {
  const id = randomUUID();
  return { id, email: `${id}@example.test`, name: 'Disposable writer-fence fixture' };
}

function preparedInsert(database: Fixture['old']['database']) {
  const query = database.insert(schema.user).values({
    id: sql.placeholder('id'),
    email: sql.placeholder('email'),
    name: 'Prepared writer-fence fixture',
  });
  const prepared = query.prepare('writer_fence_insert');
  return { statement: query.toSQL().sql, execute: (record: { id: string; email: string }) => prepared.execute(record) };
}

describe('candidate database writer capability fence over authenticated PostgreSQL pools', () => {
  it('denies the stale connected prepared writer after commit while preserving reads and admitting the replacement', () =>
    fixtureTest(async ({ owner, oldRole, newRole, old, replacement, fence }) => {
      const [oldIdentity] = await old.pool<{ current_user: string; session_user: string; pid: number }[]>`
        select current_user, session_user, pg_backend_pid() as pid
      `;
      const [newIdentity] = await replacement.pool<{ current_user: string; session_user: string }[]>`
        select current_user, session_user
      `;
      expect(oldIdentity).toMatchObject({ current_user: oldRole.name, session_user: oldRole.name });
      expect(newIdentity).toEqual({ current_user: newRole.name, session_user: newRole.name });
      const roles = await owner<
        {
          rolname: string;
          rolsuper: boolean;
          rolcreaterole: boolean;
          rolcreatedb: boolean;
          rolinherit: boolean;
          rolreplication: boolean;
          rolbypassrls: boolean;
          rolcanlogin: boolean;
        }[]
      >`select rolname, rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolreplication, rolbypassrls, rolcanlogin
        from pg_roles where rolname in (${oldRole.name}, ${newRole.name})`;
      expect(roles).toHaveLength(2);
      for (const login of roles)
        expect(login).toMatchObject({
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolinherit: false,
          rolreplication: false,
          rolbypassrls: false,
          rolcanlogin: true,
        });
      const [unsafeCapabilities] = await owner<{ membership: number; ownership: number; grant_options: number }[]>`
        select
          (select count(*)::int from pg_auth_members membership join pg_roles principal on principal.oid = membership.member
            where principal.rolname in (${oldRole.name}, ${newRole.name})) as membership,
          ((select count(*) from pg_class relation join pg_roles principal on principal.oid = relation.relowner
            where principal.rolname in (${oldRole.name}, ${newRole.name})) +
            (select count(*) from pg_namespace namespace join pg_roles principal on principal.oid = namespace.nspowner
              where principal.rolname in (${oldRole.name}, ${newRole.name})) +
            (select count(*) from pg_database database join pg_roles principal on principal.oid = database.datdba
              where principal.rolname in (${oldRole.name}, ${newRole.name})))::int as ownership,
          (select count(*)::int from information_schema.role_table_grants
            where grantee in (${oldRole.name}, ${newRole.name}) and is_grantable = 'YES') as grant_options
      `;
      expect(unsafeCapabilities).toEqual({ membership: 0, ownership: 0, grant_options: 0 });
      const prepared = preparedInsert(old.database);
      const initial = userRecord();
      await prepared.execute(initial);
      const cached = await old.pool<{ name: string }[]>`
        select name from pg_prepared_statements where statement = ${prepared.statement}
      `;
      expect(cached).toHaveLength(1);
      expect(cached[0].name).toBeTruthy();
      expect(await outcome(replacement.database.insert(schema.user).values(userRecord()))).toMatchObject({
        ok: false,
        code: '42501',
      });

      await fence();
      expect(await outcome(prepared.execute(userRecord()))).toMatchObject({ ok: false, code: '42501' });
      expect(
        await outcome(
          old.database.update(schema.user).set({ name: 'Forbidden old update' }).where(eq(schema.user.id, initial.id)),
        ),
      ).toMatchObject({ ok: false, code: '42501' });
      expect(await outcome(old.database.delete(schema.user).where(eq(schema.user.id, initial.id)))).toMatchObject({
        ok: false,
        code: '42501',
      });
      expect(
        await old.database.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, initial.id)),
      ).toEqual([{ id: initial.id }]);
      const [stillConnected] = await old.pool<{ pid: number }[]>`select pg_backend_pid() as pid`;
      expect(stillConnected.pid).toBe(oldIdentity.pid);
      expect(
        await old.pool<{ name: string }[]>`
        select name from pg_prepared_statements where statement = ${prepared.statement}
      `,
      ).toEqual(cached);
      const permissions = await owner<{ old_write: boolean; new_write: boolean; old_read: boolean }[]>`
        select has_table_privilege(${oldRole.name}, relation.oid, 'INSERT,UPDATE,DELETE') as old_write,
          (has_table_privilege(${newRole.name}, relation.oid, 'INSERT') and
            has_table_privilege(${newRole.name}, relation.oid, 'UPDATE') and
            has_table_privilege(${newRole.name}, relation.oid, 'DELETE')) as new_write,
          has_table_privilege(${oldRole.name}, relation.oid, 'SELECT') as old_read
        from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public' and relation.relkind = 'r'
      `;
      expect(permissions).toHaveLength(tableNames.length);
      expect(
        permissions.every((permission) => !permission.old_write && permission.new_write && permission.old_read),
      ).toBe(true);
      const admitted = userRecord();
      await replacement.database.insert(schema.user).values(admitted);
      await replacement.database
        .update(schema.user)
        .set({ name: 'Current writer' })
        .where(eq(schema.user.id, admitted.id));
      await replacement.database.delete(schema.user).where(eq(schema.user.id, admitted.id));
    }));

  it('drains an old write transaction and rejects a prepared statement already queued behind the exclusive fence', () =>
    fixtureTest(async ({ owner, oldRole, old, replacement, gate, track, fence }) => {
      const queued = oldRole.connect();
      const prepared = preparedInsert(queued.database);
      await prepared.execute(userRecord());
      const [queuedIdentity] = await queued.pool<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const writerInserted = barrier<void>();
      const drainWriter = gate();
      const oldRow = userRecord();
      const oldWrite = track(
        old.database.transaction(async (transaction) => {
          await transaction.insert(schema.user).values(oldRow);
          writerInserted.release();
          await bounded(drainWriter.promise, 'The old write transaction was not released.');
        }),
      );
      await bounded(writerInserted.promise, 'The old transaction never wrote its row.');
      const fenceStarted = barrier<number>();
      const holdFence = gate();
      let fenceCommitted = false;
      const cutover = track(
        fence(
          async () => {
            await bounded(holdFence.promise, 'The exclusive fence was not released.');
          },
          async (transaction) => {
            const [identity] = await transaction<{ pid: number }[]>`select pg_backend_pid() as pid`;
            fenceStarted.release(identity.pid);
          },
        ).then(() => {
          fenceCommitted = true;
        }),
      );
      const fencePid = await bounded(fenceStarted.promise, 'The fence transaction did not start.');
      await waitForLock(owner, fencePid, 'AccessExclusiveLock');
      expect(fenceCommitted).toBe(false);
      const deniedRow = userRecord();
      const queuedWrite = track(prepared.execute(deniedRow));
      const waiting = await waitForLock(owner, queuedIdentity.pid, 'RowExclusiveLock');
      expect(waiting.blockers).toContain(fencePid);
      drainWriter.release();
      expect(await oldWrite).toMatchObject({ ok: true });
      holdFence.release();
      expect(await cutover).toMatchObject({ ok: true });
      expect(fenceCommitted).toBe(true);
      expect(await queuedWrite).toMatchObject({ ok: false, code: '42501' });
      expect(
        await replacement.database
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.id, oldRow.id)),
      ).toEqual([{ id: oldRow.id }]);
      expect(
        await replacement.database
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.id, deniedRow.id)),
      ).toEqual([]);
      expect(await outcome(old.database.insert(schema.user).values(userRecord()))).toMatchObject({
        ok: false,
        code: '42501',
      });
      // The common fixture fence has the same policy; it remains repeatable.
      await fence();
    }));

  it('rolls back both privilege changes when the owner transaction fails', () =>
    fixtureTest(async ({ old, replacement, fence }) => {
      const aborted = await outcome(
        fence(async () => {
          throw new Error('Injected pre-commit fence failure');
        }),
      );
      expect(aborted.ok).toBe(false);
      await old.database.insert(schema.user).values(userRecord());
      expect(await outcome(replacement.database.insert(schema.user).values(userRecord()))).toMatchObject({
        ok: false,
        code: '42501',
      });
      await fence();
      await replacement.database.insert(schema.user).values(userRecord());
      expect(await outcome(old.database.insert(schema.user).values(userRecord()))).toMatchObject({
        ok: false,
        code: '42501',
      });
    }));

  it('does not let a restricted old login assume the new role or regrant its own write privilege', () =>
    fixtureTest(async ({ owner, oldRole, newRole, old, fence }) => {
      await fence();
      expect(await outcome(old.pool.unsafe(`SET ROLE "${newRole.name}"`))).toMatchObject({ ok: false, code: '42501' });
      // PostgreSQL may report a no-op GRANT as a warning rather than an error.
      await old.pool.unsafe(`GRANT INSERT ON public."user" TO "${oldRole.name}"`);
      const [effective] = await owner<{ insert: boolean }[]>`
        select has_table_privilege(${oldRole.name}, 'public."user"', 'INSERT') as insert
      `;
      expect(effective.insert).toBe(false);
      expect(await outcome(old.database.insert(schema.user).values(userRecord()))).toMatchObject({
        ok: false,
        code: '42501',
      });
    }));

  it('characterizes an additive PUBLIC grant that defeats revocation of only the old named role', () =>
    fixtureTest(async ({ owner, old, fence }) => {
      await fence();
      await owner.unsafe('GRANT INSERT ON public."user" TO PUBLIC');
      await old.database.insert(schema.user).values(userRecord());
      await owner.unsafe('REVOKE INSERT ON public."user" FROM PUBLIC');
      expect(await outcome(old.database.insert(schema.user).values(userRecord()))).toMatchObject({
        ok: false,
        code: '42501',
      });
    }));

  it('characterizes inherited and SET ROLE membership paths that must be absent from a real fence', () =>
    fixtureTest(async ({ owner, oldRole, old, role, fence }) => {
      const inherited = await role('group', false);
      await owner.unsafe(`GRANT INSERT ON public."user" TO "${inherited.name}"`);
      await owner.unsafe(`ALTER ROLE "${oldRole.name}" INHERIT`);
      await owner.unsafe(`GRANT "${inherited.name}" TO "${oldRole.name}"`);
      await fence();
      await old.database.insert(schema.user).values(userRecord());
      await owner.unsafe(`REVOKE "${inherited.name}" FROM "${oldRole.name}"`);
      await owner.unsafe(`ALTER ROLE "${oldRole.name}" NOINHERIT`);
      // PostgreSQL 16+ stores inheritance on each membership. Regrant after
      // changing the default; ALTER ROLE alone does not update an old grant.
      await owner.unsafe(`GRANT "${inherited.name}" TO "${oldRole.name}"`);
      expect(await outcome(old.database.insert(schema.user).values(userRecord()))).toMatchObject({
        ok: false,
        code: '42501',
      });
      try {
        await old.pool.unsafe(`SET ROLE "${inherited.name}"`);
        const [identity] = await old.pool<
          { current_user: string; session_user: string }[]
        >`select current_user, session_user`;
        expect(identity).toEqual({ current_user: inherited.name, session_user: oldRole.name });
        await old.database.insert(schema.user).values(userRecord());
      } finally {
        await old.pool.unsafe('RESET ROLE');
      }
      await owner.unsafe(`REVOKE "${inherited.name}" FROM "${oldRole.name}"`);
      expect(await outcome(old.pool.unsafe(`SET ROLE "${inherited.name}"`))).toMatchObject({
        ok: false,
        code: '42501',
      });
    }));

  it('characterizes table-owner self-regrant and superuser bypass instead of treating them as restricted writers', () =>
    fixtureTest(async ({ owner, role, fence }) => {
      const owningRole = await role('owner');
      await owner.unsafe(`ALTER TABLE public."verification" OWNER TO "${owningRole.name}"`);
      const owning = owningRole.connect();
      await fence();
      await owner.unsafe(`REVOKE ALL PRIVILEGES ON public."verification" FROM "${owningRole.name}"`);
      const record = {
        id: randomUUID(),
        identifier: 'writer-fence-owner-proof',
        value: 'synthetic',
        expiresAt: new Date(Date.now() + 60_000),
      };
      expect(await outcome(owning.database.insert(schema.verification).values(record))).toMatchObject({
        ok: false,
        code: '42501',
      });
      await owning.pool.unsafe(`GRANT INSERT ON public."verification" TO "${owningRole.name}"`);
      await owning.database.insert(schema.verification).values(record);
      await owner.unsafe('REVOKE ALL PRIVILEGES ON public."user" FROM CURRENT_USER');
      await drizzle(owner, { schema }).insert(schema.user).values(userRecord());
    }));

  it('still removes owned pools, database and roles when a pending operation exceeds its cleanup deadline', async () => {
    const fixture = await createFixture();
    const adminUrl = new URL(fixture.environment.databaseUrl);
    const ownedDatabase = adminUrl.pathname.slice(1);
    adminUrl.pathname = '/postgres';
    const observer = postgres(adminUrl.toString(), {
      max: 1,
      connect_timeout: 3,
      connection: { statement_timeout: 10000, lock_timeout: 8000 },
      onnotice: () => {},
    });
    try {
      await Promise.all([fixture.old.pool`select current_user`, fixture.replacement.pool`select current_user`]);
      // A deliberately unresolved in-memory operation has no database effects.
      // Its deadline must report failure without skipping resource cleanup.
      void fixture.track(new Promise<void>(() => {}));
      await expect(fixture.close(25)).rejects.toThrow('pending writer timeout');
      const [remaining] = await observer<{ databases: number; roles: number }[]>`
        select (select count(*)::int from pg_database where datname = ${ownedDatabase}) as databases,
          (select count(*)::int from pg_roles where rolname in (${fixture.oldRole.name}, ${fixture.newRole.name})) as roles
      `;
      expect(remaining).toEqual({ databases: 0, roles: 0 });
    } finally {
      // Re-await the same idempotent close: its expected private timeout was
      // asserted above, and the observer must close even if an assertion fails.
      await fixture.close(25).catch(() => {});
      await observer.end({ timeout: 2 });
    }
  });

  for (const phase of ['beforeCommit', 'afterCommit'] as const) {
    it(`tracks owned role creation through a simulated ${phase} failure and removes only its resources`, async () => {
      const fixture = await createFixture();
      const adminUrl = new URL(fixture.environment.databaseUrl);
      const ownedDatabase = adminUrl.pathname.slice(1);
      adminUrl.pathname = '/postgres';
      const observer = postgres(adminUrl.toString(), {
        max: 1,
        connect_timeout: 3,
        connection: { statement_timeout: 10000, lock_timeout: 8000 },
        onnotice: () => {},
      });
      let uncertainRole = '';
      try {
        await expect(
          fixture.role('uncertain', true, {
            [phase](name: string) {
              uncertainRole = name;
              throw new Error('Simulated fixture role acknowledgement failure');
            },
          }),
        ).rejects.toThrow('Could not create an isolated writer-fence fixture role.');
        expect(uncertainRole).toMatch(/^ba01_fence_uncertain_[0-9a-f]{32}$/);
        const [beforeCleanup] = await observer<{ roles: number }[]>`
          select count(*)::int as roles from pg_roles where rolname = ${uncertainRole}
        `;
        expect(beforeCleanup.roles).toBe(phase === 'afterCommit' ? 1 : 0);
        await fixture.close();
        const [remaining] = await observer<{ databases: number; roles: number }[]>`
          select (select count(*)::int from pg_database where datname = ${ownedDatabase}) as databases,
            (select count(*)::int from pg_roles where rolname in
              (${fixture.oldRole.name}, ${fixture.newRole.name}, ${uncertainRole})) as roles
        `;
        expect(remaining).toEqual({ databases: 0, roles: 0 });
      } finally {
        try {
          await fixture.close();
        } finally {
          await observer.end({ timeout: 2 });
        }
      }
    });
  }
});
