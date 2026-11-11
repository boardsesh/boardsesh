import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql, type SQL } from 'drizzle-orm';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import {
  accounts,
  users,
  userProfiles,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  authWebOAuthCommands,
  authWebOAuthIntents,
} from '@boardsesh/db/schema/auth';
import {
  WEB_OAUTH_COMMAND_PATHS,
  WEB_OAUTH_PROTOCOL_VERSION,
  webOAuthReplySchema,
  webOAuthProtocolRejectionSchema,
  type WebOAuthProvider,
  type WebOAuthIntentCommand,
  type WebOAuthResolveCommand,
} from '@boardsesh/auth-protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { handleCurrentStoreWebOAuth } from '../../../handlers/current-store-web-oauth';
import { logger } from '../../../utils/logger';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import {
  CURRENT_EMAIL_NORMALIZER_VERSION,
  lockAuthorityGateExclusively,
  type ExpectedCurrentStoreAuthority,
} from '../foundation-context';
import { resolveReservedNativeOAuthIdentity } from '../native-oauth-identity';
import { resolveWebOAuthIdentity } from '../web-oauth-identity';
import { readNegativeWebOAuthActor } from '../web-oauth-actor';
import { prepareCurrentStorePasswordRegistration } from '../password-identity';
import { insertReservedPasswordIdentity } from '../reserved-password-registration';

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const publicJwt = requireWeb('next-auth/jwt') as {
  encode(options: { token: Record<string, unknown>; secret: string; maxAge?: number }): Promise<string>;
};
const actorSecret = randomBytes(32).toString('base64url');
const rpcSecret = randomBytes(32).toString('base64url');
const role = `ba03_weboauth_${randomUUID().replaceAll('-', '')}`;
const rolePassword = randomBytes(32).toString('hex');
const allTables = [
  users,
  accounts,
  userProfiles,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  authWebOAuthCommands,
  authWebOAuthIntents,
];
const insertTables = [
  users,
  accounts,
  userProfiles,
  authEmailReservations,
  authEmailReservationMembers,
  authWebOAuthCommands,
  authWebOAuthIntents,
];
const updateTables = [
  users,
  accounts,
  authEmailProjection,
  authEmailReservations,
  authSubjectCutoffs,
  authWebOAuthIntents,
];
const pools: ReturnType<typeof postgres>[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const handlers = new Set<Promise<void>>();
const origins: string[] = [];
let accepting = true;
let trackedRole = false;
let writer: DbInstance;
let secondWriter: DbInstance;
let authority: ExpectedCurrentStoreAuthority;

function command<Operation extends 'intent' | 'resolve'>(
  operation: Operation,
  payload: Operation extends 'intent' ? WebOAuthIntentCommand['payload'] : WebOAuthResolveCommand['payload'],
) {
  return {
    webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: new Date().toISOString(),
    payload,
  } as const;
}
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
async function post(
  operation: 'intent' | 'resolve',
  body: unknown,
  options: {
    origin?: number;
    authorization?: string;
    extraHeaders?: Record<string, string>;
    path?: string;
    method?: string;
  } = {},
) {
  const origin = origins[options.origin ?? 0];
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Unowned web OAuth test origin');
  const response = await fetch(`${origin}${options.path ?? WEB_OAUTH_COMMAND_PATHS[operation]}`, {
    method: options.method ?? 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: options.authorization ?? `Bearer ${rpcSecret}`,
      'Content-Type': 'application/json',
      ...options.extraHeaders,
    },
    ...((options.method ?? 'POST') === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await response.json();
  const reply = webOAuthReplySchema.safeParse(parsed);
  return { status: response.status, body: reply.success ? reply.data : webOAuthProtocolRejectionSchema.parse(parsed) };
}
async function intent(
  provider: WebOAuthProvider = 'google',
  actorCookie: string | null = null,
  flow = randomBytes(32).toString('hex'),
) {
  const payload = { provider, flow, actorCookie };
  expect((await post('intent', command('intent', payload))).status).toBe(200);
  return payload;
}
function resolveCommand(
  binding: WebOAuthIntentCommand['payload'],
  changes: Partial<WebOAuthResolveCommand['payload']> = {},
): WebOAuthResolveCommand {
  return command('resolve', {
    ...binding,
    subject: randomUUID(),
    email: `${randomUUID()}@example.test`,
    name: 'New provider owner',
    image: 'https://images.example.test/avatar',
    ...changes,
  });
}
function resolved(reply: Awaited<ReturnType<typeof post>>) {
  if (!('outcome' in reply.body) || reply.body.outcome !== 'resolved')
    throw new Error('Expected resolved private identity reply');
  expect(reply.status).toBe(200);
  return reply.body;
}
const actorCookie = (userId: string, sid = randomUUID(), maxAge = 3600) =>
  publicJwt.encode({ secret: actorSecret, token: { sub: userId, authSessionId: sid }, maxAge });
async function seedLinked(
  provider: WebOAuthProvider,
  subject = randomUUID(),
  fields: Partial<typeof users.$inferInsert> = {},
) {
  const userId = randomUUID();
  const email = fields.email ?? `${userId}@example.test`;
  await db.transaction(async (transaction) => {
    await reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId });
    await transaction.insert(users).values({
      id: userId,
      email,
      name: 'Original owner',
      image: 'original-image',
      emailVerified: new Date('2020-01-02T03:04:05Z'),
      createdAt: new Date('2019-01-02T03:04:05Z'),
      ...fields,
    });
    await transaction.insert(userProfiles).values({ userId });
    await transaction
      .insert(accounts)
      .values({ userId, provider, providerAccountId: subject, type: 'oauth', access_token: 'existing-provider-token' });
  });
  return { userId, subject, email };
}
async function counts() {
  return {
    users: (await db.select().from(users)).length,
    profiles: (await db.select().from(userProfiles)).length,
    accounts: (await db.select().from(accounts)).length,
    reservations: (await db.select().from(authEmailReservations)).length,
    commands: (await db.select().from(authWebOAuthCommands)).length,
  };
}
function deferred() {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
async function databaseNow() {
  const row = await executeFirstRow<{ milliseconds: number | string }>(
    db,
    sql`SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS milliseconds`,
  );
  return Number(row?.milliseconds);
}
async function waitForWriterLock() {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const row = await executeFirstRow<{ waiting: boolean }>(
      db,
      sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=${role} AND state='active' AND wait_event_type='Lock') AS waiting`,
    );
    if (row?.waiting) return;
    await new Promise((accept) => setTimeout(accept, 10));
  }
  throw new Error('Owned web OAuth writer lock not observed');
}
async function waitForDatabaseDeadline(deadline: number) {
  const stopAt = Date.now() + 2500;
  while (Date.now() < stopAt) {
    if ((await databaseNow()) >= deadline) return;
    await new Promise((accept) => setTimeout(accept, 10));
  }
  throw new Error('Owned web OAuth database deadline not reached');
}

describe('backend-owned web OAuth identity over real private HTTP and nonowner PostgreSQL pools', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
      );
      trackedRole = true;
      await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      await transaction.execute(sql`GRANT SELECT ON TABLE ${sql.join(allTables, sql`, `)} TO ${sql.identifier(role)}`);
      await transaction.execute(
        sql`GRANT INSERT ON TABLE ${sql.join(insertTables, sql`, `)} TO ${sql.identifier(role)}`,
      );
      await transaction.execute(
        sql`GRANT UPDATE ON TABLE ${sql.join(updateTables, sql`, `)} TO ${sql.identifier(role)}`,
      );
    });
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
    databaseUrl.username = role;
    databaseUrl.password = rolePassword;
    for (let index = 0; index < 2; index += 1) {
      const pool = postgres(databaseUrl.href, {
        max: 2,
        connect_timeout: 3,
        onnotice: () => {},
        connection: { statement_timeout: 5000, lock_timeout: 4000 },
      });
      pools.push(pool);
      const database = drizzle(pool) as DbInstance;
      if (index === 0) writer = database;
      else secondWriter = database;
      const server = createServer((request, response) => {
        if (!accepting) {
          response.destroy();
          return;
        }
        const pending = handleCurrentStoreWebOAuth(request, response, database).catch(() => {
          if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'unavailable' }));
        });
        handlers.add(pending);
        void pending.finally(() => handlers.delete(pending));
      });
      server.requestTimeout = 5000;
      server.headersTimeout = 5000;
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      servers.push(server);
      await new Promise<void>((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', accept);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Owned identity server bind failed');
      origins.push(`http://127.0.0.1:${address.port}`);
    }
    vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    vi.stubEnv('NEXTAUTH_SECRET', actorSecret);
    vi.stubEnv('DEBUG_SQL', 'false');
  }, 30000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    await db.delete(authWebOAuthIntents);
    await db.delete(authWebOAuthCommands);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
    const projectionId = randomUUID();
    authority = {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    vi.stubEnv('DEBUG_SQL', 'false');
  });
  afterAll(async () => {
    const failures: Error[] = [];
    accepting = false;
    for (const server of servers) server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) {
      try {
        await new Promise<void>((accept) => server.close(() => accept()));
      } catch {
        failures.push(new Error('Owned web OAuth server cleanup failed'));
      }
    }
    await Promise.allSettled(handlers);
    for (const pool of pools) {
      try {
        await pool.end({ timeout: 3 });
      } catch {
        failures.push(new Error('Owned web OAuth pool cleanup failed'));
      }
    }
    if (trackedRole) {
      let roleMayExist = true;
      try {
        const exists = await admin(sql`SELECT 1 FROM pg_roles WHERE rolname=${role}`);
        roleMayExist = exists.length > 0;
      } catch {
        failures.push(new Error('Owned web OAuth role lookup failed'));
      }
      if (roleMayExist)
        for (const statement of [
          sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(allTables, sql`, `)} FROM ${sql.identifier(role)}`,
          sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`,
          sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`,
        ]) {
          try {
            await admin(statement);
          } catch {
            failures.push(new Error('Owned web OAuth role cleanup failed'));
          }
        }
    }
    if (!handlers.size && servers.every((server) => !server.listening)) vi.unstubAllEnvs();
    else failures.push(new Error('Owned web OAuth handlers did not quiesce'));
    vi.restoreAllMocks();
    if (failures.length) throw new AggregateError(failures, 'Owned web OAuth cleanup failed');
  }, 30000);

  it.each(['google', 'apple', 'facebook'] as const)(
    'creates %s user/profile/plain link atomically with raw email and NULL verification',
    async (provider) => {
      const binding = await intent(provider);
      const email = `Case+${randomUUID()}@EXAMPLE.test`;
      const result = resolved(await post('resolve', resolveCommand(binding, { email })));
      expect(result.createdUser).toBe(true);
      expect(result.user.email).toBe(email);
      expect(result.user.emailVerified).toBe(null);
      expect(result.user.image).toBe('https://images.example.test/avatar');
      const [link] = await db.select().from(accounts);
      expect(link.userId).toBe(result.user.id);
      expect(link.access_token).toBe(null);
      expect(link.id_token).toBe(null);
      expect(link.refresh_token).toBe(null);
      expect(await counts()).toMatchObject({ users: 1, profiles: 1, accounts: 1, reservations: 1, commands: 2 });
      expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).not.toBe(null);
    },
  );
  it.each(['google', 'apple', 'facebook'] as const)(
    'returns linked %s owner unchanged despite missing/changed upstream profile',
    async (provider) => {
      const owner = await seedLinked(provider);
      const [original] = await db.select().from(users);
      const binding = await intent(provider);
      const result = resolved(
        await post(
          'resolve',
          resolveCommand(binding, {
            subject: owner.subject,
            email: null,
            name: 'Foreign name',
            image: 'foreign-image',
          }),
        ),
      );
      expect(result.createdUser).toBe(false);
      expect(result.user.id).toBe(owner.userId);
      expect((await db.select().from(users))[0]).toEqual(original);
      expect((await db.select().from(accounts))[0].access_token).toBe('existing-provider-token');
    },
  );
  it('admits exact linked owner in an existing ambiguous group without choosing the other member', async () => {
    await db.delete(authEmailProjection);
    const first = randomUUID(),
      second = randomUUID();
    await db.insert(users).values([
      { id: first, email: 'Case@example.test' },
      { id: second, email: 'case@example.test' },
    ]);
    const projectionId = randomUUID();
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    authority = { ...authority, expectedProjectionId: projectionId };
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    const subject = randomUUID();
    await db.insert(accounts).values({ userId: second, provider: 'google', providerAccountId: subject, type: 'oauth' });
    const result = resolved(
      await post('resolve', resolveCommand(await intent(), { subject, email: 'OTHER@example.test' })),
    );
    expect(result.user.id).toBe(second);
    expect((await db.select().from(users)).length).toBe(2);
  });
  it('refuses to create a provider owner over an unreserved account in another case', async () => {
    await db.insert(users).values({ id: randomUUID(), email: 'Unreserved.Case@example.test' });
    const result = await post('resolve', resolveCommand(await intent(), { email: 'unreserved.case@example.test' }));
    expect(result.status).toBe(503);
    expect(await counts()).toMatchObject({ users: 1, accounts: 0 });
  });
  it.each(['owned', 'blocked_ambiguous', 'blocked_deleted', 'blocked_invalid'] as const)(
    'never links an unknown subject through occupied key %s',
    async (state) => {
      const owner = await seedLinked('google');
      if (state !== 'owned') await db.update(authEmailReservations).set({ state, ownerUserId: null });
      const result = await post('resolve', resolveCommand(await intent(), { email: owner.email.toUpperCase() }));
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ outcome: 'denied', code: 'email_conflict' });
      expect(await counts()).toMatchObject({ users: 1, accounts: 1 });
    },
  );
  it.each([null, 'not-an-address'])('asks a new subject for an email when the provider sent %j', async (email) => {
    const result = await post('resolve', resolveCommand(await intent(), { email }));
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ outcome: 'denied', code: 'email_required' });
    expect(await counts()).toMatchObject({ users: 0, accounts: 0 });
  });
  it('accepts same-owner actor after ordinary signed JWT rotation while preserving actor lineage', async () => {
    const owner = await seedLinked('google');
    const sid = randomUUID();
    const binding = await intent('google', await actorCookie(owner.userId, sid));
    const result = resolved(
      await post(
        'resolve',
        resolveCommand(binding, {
          subject: owner.subject,
          actorCookie: await actorCookie(owner.userId, sid),
          email: null,
        }),
      ),
    );
    expect(result.user.id).toBe(owner.userId);
    expect(result.createdUser).toBe(false);
  });
  it('rejects same-owner different-SID callback without consuming the original actor intent', async () => {
    const owner = await seedLinked('google');
    const original = await actorCookie(owner.userId);
    const binding = await intent('google', original);
    expect(
      (
        await post(
          'resolve',
          resolveCommand(binding, { subject: owner.subject, actorCookie: await actorCookie(owner.userId) }),
        )
      ).status,
    ).toBe(409);
    expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).toBe(null);
    expect(resolved(await post('resolve', resolveCommand(binding, { subject: owner.subject }))).user.id).toBe(
      owner.userId,
    );
  });
  it.each([false, true])('never changes guarded actor absence/presence (initialActor=%s)', async (initialActor) => {
    const owner = await seedLinked('google');
    const token = await actorCookie(owner.userId);
    const binding = await intent('google', initialActor ? token : null);
    expect(
      (
        await post(
          'resolve',
          resolveCommand(binding, { subject: owner.subject, actorCookie: initialActor ? null : token }),
        )
      ).status,
    ).toBe(409);
  });
  it('gates unlinked-provider mutation behind genuine recent authentication and consumes the old flow', async () => {
    const owner = await seedLinked('google');
    const binding = await intent('apple', await actorCookie(owner.userId));
    expect((await post('resolve', resolveCommand(binding))).status).toBe(503);
    expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).not.toBe(null);
    expect((await post('resolve', resolveCommand(binding))).status).toBe(409);
    expect(await counts()).toMatchObject({ users: 1, accounts: 1 });
  });
  it('rejects a different actor from the existing provider owner', async () => {
    const first = await seedLinked('google');
    const other = await seedLinked('apple');
    const result = await post(
      'resolve',
      resolveCommand(await intent('google', await actorCookie(other.userId)), { subject: first.subject }),
    );
    expect(result.status).toBe(409);
    expect(await counts()).toMatchObject({ users: 2, accounts: 2 });
  });
  it.each(['invalid', 'expired'] as const)('never converts %s actor into an anonymous intent', async (kind) => {
    const token = kind === 'invalid' ? 'not-a-cookie' : await actorCookie(randomUUID(), randomUUID(), -60);
    expect(
      (
        await post(
          'intent',
          command('intent', { provider: 'google', flow: randomBytes(32).toString('hex'), actorCookie: token }),
        )
      ).status,
    ).toBe(409);
    expect((await db.select().from(authWebOAuthIntents)).length).toBe(0);
  });
  it('rechecks actor cutoff consistency but does not pretend the old cookie carried current generation', async () => {
    const owner = await seedLinked('google');
    await db
      .insert(authSubjectCutoffs)
      .values({ userId: owner.userId, generation: 4, revokedThrough: new Date(), lastOperationId: randomUUID() });
    const binding = await intent('google', await actorCookie(owner.userId));
    expect((await db.select().from(authWebOAuthIntents))[0].actorObservedGeneration).toBe(4);
    await db.update(authSubjectCutoffs).set({ generation: 5 });
    expect((await post('resolve', resolveCommand(binding, { subject: owner.subject }))).status).toBe(409);
  });
  it('enforces one consumed flow across two independent LOGIN pools and subjects', async () => {
    const binding = await intent();
    const outcomes = await Promise.all([
      post('resolve', resolveCommand(binding), { origin: 0 }),
      post('resolve', resolveCommand(binding), { origin: 1 }),
    ]);
    expect(outcomes.map((reply) => reply.status).sort((first, second) => first - second)).toEqual([200, 409]);
    expect(await counts()).toMatchObject({ users: 1, accounts: 1, reservations: 1 });
  });
  it('does not deadlock a web sign-in carrying the owner actor cookie against a native sign-in for the same subject', async () => {
    // BA-04 PR 3 order: gate, provider subject, users. The web resolve once took
    // the actor's users row before the subject; a native sign-in takes the
    // subject, then the owner's row. Park the web resolve holding what it holds
    // just before it resolves the subject, start the native one, then release.
    const linked = await seedLinked('google');
    const binding = await intent('google', await actorCookie(linked.userId));
    const parkKey = 700_000_000 + Math.floor(Math.random() * 100_000_000);
    const parkName = `ba04_pr3_park_${randomUUID().replaceAll('-', '')}`;
    await admin(
      sql.raw(`CREATE FUNCTION ${parkName}() RETURNS trigger LANGUAGE plpgsql AS $park$
        BEGIN PERFORM pg_advisory_xact_lock(${parkKey}); RETURN NEW; END; $park$`),
    );
    await admin(
      sql.raw(
        `CREATE TRIGGER ${parkName} BEFORE UPDATE ON auth_web_oauth_intents FOR EACH ROW EXECUTE FUNCTION ${parkName}()`,
      ),
    );
    const parkPool = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
    const park = await parkPool.reserve();
    const pidWaitingOn = async (blocker: number | null) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const row = await executeFirstRow<{ pid: number | null }>(
          db,
          blocker === null
            ? sql`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${parkKey}::oid AND objsubid=1 AND NOT granted LIMIT 1`
            : sql`SELECT pid FROM pg_stat_activity WHERE ${blocker}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock' LIMIT 1`,
        );
        if (row?.pid) return Number(row.pid);
        await new Promise((accept) => setTimeout(accept, 10));
      }
      throw new Error('Owned web/native race never queued');
    };
    let web: ReturnType<typeof post> | undefined;
    let native: Promise<Awaited<ReturnType<typeof resolveReservedNativeOAuthIdentity>>> | undefined;
    try {
      await park`BEGIN`;
      await park`SELECT pg_advisory_xact_lock(${parkKey})`;
      web = post('resolve', resolveCommand(binding, { subject: linked.subject }));
      const webPid = await pidWaitingOn(null);
      native = secondWriter.transaction((transaction) =>
        resolveReservedNativeOAuthIdentity(transaction, authority, 'google', {
          sub: linked.subject,
          email: linked.email,
          emailVerified: true,
          name: 'Native owner',
        }),
      );
      void native.catch(() => undefined);
      await pidWaitingOn(webPid);
      await park`COMMIT`;
      const [webReply, nativeResult] = await Promise.allSettled([web, native]);
      for (const outcome of [webReply, nativeResult])
        if (outcome.status === 'rejected') expect(String(outcome.reason)).not.toContain('deadlock');
      expect(webReply.status === 'fulfilled' && resolved(webReply.value).user.id).toBe(linked.userId);
      expect(nativeResult).toMatchObject({ status: 'fulfilled', value: { outcome: 'linked' } });
    } finally {
      await park`ROLLBACK`.catch(() => undefined);
      park.release();
      await Promise.allSettled([web, native].filter((pending) => pending !== undefined));
      await parkPool.end({ timeout: 3 });
      await admin(sql.raw(`DROP TRIGGER IF EXISTS ${parkName} ON auth_web_oauth_intents`));
      await admin(sql.raw(`DROP FUNCTION IF EXISTS ${parkName}()`));
    }
  });
  it('serializes web/native OAuth case-key races with one owner and preserved native verification policy', async () => {
    const binding = await intent();
    const email = `Case+${randomUUID()}@EXAMPLE.test`;
    const native = secondWriter.transaction((transaction) =>
      resolveReservedNativeOAuthIdentity(transaction, authority, 'apple', {
        sub: randomUUID(),
        email: email.toLowerCase(),
        emailVerified: true,
        name: 'Native owner',
      }),
    );
    const [web, nativeResult] = await Promise.all([post('resolve', resolveCommand(binding, { email })), native]);
    expect([web.status === 200, nativeResult.outcome === 'created'].filter(Boolean).length).toBe(1);
    expect(await counts()).toMatchObject({ users: 1, accounts: 1, reservations: 1 });
    const [user] = await db.select().from(users);
    expect(user.emailVerified === null).toBe(web.status === 200);
  });
  it('serializes a participating native password insertion against the same normalized web OAuth key', async () => {
    const binding = await intent();
    const email = `Case+${randomUUID()}@EXAMPLE.test`;
    const prepared = await prepareCurrentStorePasswordRegistration(db, {
      email: email.toLowerCase(),
      password: 'Owned password 123!',
    });
    if (!prepared) throw new Error('Owned password fixture unexpectedly occupied');
    const native = db.transaction((transaction) =>
      insertReservedPasswordIdentity(transaction, authority, {
        email: prepared.email,
        prepared,
        emailVerificationEnabled: false,
      }),
    );
    const [web, password] = await Promise.all([post('resolve', resolveCommand(binding, { email })), native]);
    expect([web.status === 200, password.outcome === 'created'].filter(Boolean).length).toBe(1);
    expect(await counts()).toMatchObject({ users: 1, profiles: 1, reservations: 1 });
    // The competing password fixture uses its existing admin connection; both
    // actual identity service listeners themselves use restricted LOGIN pools.
  });
  it('checks the original flow deadline after an observed manifest wait, using database time', async () => {
    const binding = await intent();
    const expiresAt = (await databaseNow()) + 2000;
    await db
      .update(authWebOAuthIntents)
      .set({ issuedAt: new Date(expiresAt - 900000), expiresAt: new Date(expiresAt) });
    const held = deferred(),
      release = deferred();
    const blocker = db.transaction(async (transaction) => {
      await lockAuthorityGateExclusively(transaction);
      held.resolve();
      await release.promise;
    });
    void blocker.catch(() => held.reject(new Error('Owned manifest gate failed')));
    let pending: ReturnType<typeof post> | undefined;
    try {
      await held.promise;
      pending = post('resolve', resolveCommand(binding));
      void pending.catch(() => {});
      await waitForWriterLock();
      expect(await databaseNow()).toBeLessThan(expiresAt);
      await waitForDatabaseDeadline(expiresAt);
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, ...(pending ? [pending] : [])]);
    }
    await blocker;
    expect((await pending!).status).toBe(409);
    expect(await counts()).toMatchObject({ users: 0, accounts: 0 });
    expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).toBe(null);
  });
  it('rejects immutable intent retargeting across the manifest wait', async () => {
    const owner = await seedLinked('google'),
      other = await seedLinked('apple');
    const original = await actorCookie(owner.userId);
    const binding = await intent('google', original);
    const replacement = await readNegativeWebOAuthActor(await actorCookie(other.userId), actorSecret);
    const held = deferred(),
      release = deferred();
    const blocker = db.transaction(async (transaction) => {
      await lockAuthorityGateExclusively(transaction);
      held.resolve();
      await release.promise;
    });
    void blocker.catch(() => held.reject(new Error('Owned manifest gate failed')));
    let pending: ReturnType<typeof post> | undefined;
    try {
      await held.promise;
      pending = post('resolve', resolveCommand(binding, { subject: owner.subject }));
      void pending.catch(() => {});
      await waitForWriterLock();
      await db
        .update(authWebOAuthIntents)
        .set({ actorUserId: other.userId, actorLineageHash: replacement!.lineageHash, actorObservedGeneration: 0 });
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, ...(pending ? [pending] : [])]);
    }
    await blocker;
    expect((await pending!).status).toBe(409);
    expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).toBe(null);
    expect(await counts()).toMatchObject({ users: 2, accounts: 2 });
  });
  it('copies command and authority before asynchronous work rather than following caller mutations', async () => {
    const binding = await intent();
    const originalSubject = randomUUID(),
      originalEmail = `${randomUUID()}@example.test`;
    const payload = resolveCommand(binding, { subject: originalSubject, email: originalEmail });
    const originalRequestId = payload.requestId;
    const mutableAuthority = { ...authority };
    const held = deferred(),
      release = deferred();
    const blocker = db.transaction(async (transaction) => {
      await lockAuthorityGateExclusively(transaction);
      held.resolve();
      await release.promise;
    });
    void blocker.catch(() => held.reject(new Error('Owned manifest gate failed')));
    let pending: ReturnType<typeof resolveWebOAuthIdentity> | undefined;
    try {
      await held.promise;
      pending = resolveWebOAuthIdentity(writer, mutableAuthority, actorSecret, payload);
      void pending.catch(() => {});
      await waitForWriterLock();
      payload.payload.subject = randomUUID();
      payload.payload.email = 'replacement@example.test';
      payload.requestId = randomUUID();
      mutableAuthority.expectedWriterEpoch = 999;
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, ...(pending ? [pending] : [])]);
    }
    await blocker;
    const result = await pending!;
    expect(result.outcome).toBe('resolved');
    expect((await db.select().from(accounts))[0].providerAccountId).toBe(originalSubject);
    expect((await db.select().from(users))[0].email).toBe(originalEmail);
    const commandHash = createHash('sha256')
      .update(JSON.stringify(['web-oauth-command-v1', originalRequestId]))
      .digest('hex');
    expect((await db.select().from(authWebOAuthCommands)).some((row) => row.commandHash === commandHash)).toBe(true);
  });
  it.each(['intent', 'resolve'] as const)(
    'rejects expired transport after an actual %s row wait on every committing outcome',
    async (operation) => {
      const owner = await seedLinked('google');
      const original = await actorCookie(owner.userId);
      const binding = operation === 'resolve' ? await intent('google', original) : undefined;
      const flow = randomBytes(32).toString('hex');
      const candidate =
        operation === 'intent'
          ? command('intent', { provider: 'google', flow, actorCookie: null })
          : resolveCommand(binding!, { subject: owner.subject, actorCookie: await actorCookie(owner.userId) });
      const held = deferred(),
        release = deferred();
      const blocker = db.transaction(async (transaction) => {
        // An actor's user-row wait stops at 250 ms, too short to outlast a deadline, so
        // an anonymous intent queues on this uncommitted hash instead, after its claim.
        if (operation === 'intent')
          await transaction.insert(authWebOAuthIntents).values({
            intentHash: createHash('sha256')
              .update(JSON.stringify(['web-oauth-intent-v1', 'google', flow]))
              .digest('hex'),
            provider: 'google',
            flowHash: flow,
            issuedAt: new Date(),
            expiresAt: new Date(Date.now() + 60000),
          });
        else await transaction.select().from(authWebOAuthIntents).for('update');
        held.resolve();
        await release.promise;
      });
      void blocker.catch(() => held.reject(new Error('Owned freshness gate failed')));
      let pending: ReturnType<typeof post> | undefined;
      try {
        await held.promise;
        const body = { ...candidate, issuedAt: new Date(Date.now() - 119000).toISOString() };
        const expiresAt = Date.parse(body.issuedAt) + 120000;
        pending = post(operation, body);
        void pending.catch(() => {});
        await waitForWriterLock();
        expect(Date.now()).toBeLessThan(expiresAt);
        const stopAt = Date.now() + 2500;
        while (Date.now() <= expiresAt && Date.now() < stopAt) await new Promise((accept) => setTimeout(accept, 10));
        expect(Date.now()).toBeGreaterThan(expiresAt);
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, ...(pending ? [pending] : [])]);
      }
      await blocker;
      const result = await pending!;
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'expired_request' });
      expect((await db.select().from(authWebOAuthCommands)).length).toBe(operation === 'resolve' ? 1 : 0);
      const records = await db.select().from(authWebOAuthIntents);
      expect(records.length).toBe(1);
      expect(records.every((record) => record.consumedAt === null)).toBe(true);
    },
  );
  it('does not recreate a linked owner deleted by an unfenced writer while its actual row lock is pending', async () => {
    const owner = await seedLinked('google');
    const binding = await intent();
    const held = deferred(),
      release = deferred();
    const blocker = db.transaction(async (transaction) => {
      await transaction.update(users).set({ name: 'uncommitted lock' }).where(eq(users.id, owner.userId));
      held.resolve();
      await release.promise;
      await transaction.delete(users).where(eq(users.id, owner.userId));
    });
    void blocker.catch(() => held.reject(new Error('Owned user gate failed')));
    let pending: ReturnType<typeof post> | undefined;
    try {
      await held.promise;
      pending = post('resolve', resolveCommand(binding, { subject: owner.subject }));
      void pending.catch(() => {});
      await waitForWriterLock();
      expect((await db.select().from(users)).some((row) => row.id === owner.userId)).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, ...(pending ? [pending] : [])]);
    }
    await blocker;
    expect((await pending!).status).toBe(503);
    expect(await counts()).toMatchObject({ users: 0, profiles: 0, accounts: 0, commands: 1 });
    expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).toBe(null);
  });
  it('commits consumed flow after a real response is discarded and never reissues it', async () => {
    const binding = await intent();
    const payload = resolveCommand(binding);
    const response = await fetch(`${origins[0]}${WEB_OAUTH_COMMAND_PATHS.resolve}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rpcSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect((await post('resolve', resolveCommand(binding))).status).toBe(409);
    expect(await counts()).toMatchObject({ users: 1, accounts: 1 });
  });
  it('burns strict transport nonce even when changed payload or operation follows', async () => {
    const original = command('intent', {
      provider: 'google',
      flow: randomBytes(32).toString('hex'),
      actorCookie: null,
    });
    expect((await post('intent', original)).status).toBe(200);
    expect(
      (await post('intent', { ...original, payload: { ...original.payload, flow: randomBytes(32).toString('hex') } }))
        .status,
    ).toBe(409);
    const resolve = resolveCommand(original.payload);
    resolve.requestId = original.requestId;
    expect((await post('resolve', resolve)).status).toBe(409);
    expect((await db.select().from(authWebOAuthCommands)).length).toBe(1);
  });
  it('does not extend original intent deadline when the same flow is recorded again', async () => {
    const binding = await intent();
    const [first] = await db.select().from(authWebOAuthIntents);
    expect((await post('intent', command('intent', binding))).status).toBe(409);
    expect((await db.select().from(authWebOAuthIntents))[0].expiresAt.getTime()).toBe(first.expiresAt.getTime());
  });
  it.each([0, 2])('rejects unsupported protocol version %s before writes', async (version) => {
    const body = command('intent', { provider: 'google', flow: randomBytes(32).toString('hex'), actorCookie: null });
    expect((await post('intent', { ...body, webOAuthProtocolVersion: version })).status).toBe(400);
    expect((await db.select().from(authWebOAuthCommands)).length).toBe(0);
  });
  it('rejects hostile identity/token fields and stale transport envelopes before writes', async () => {
    const body = command('intent', { provider: 'google', flow: randomBytes(32).toString('hex'), actorCookie: null });
    expect(
      (
        await post('intent', {
          ...body,
          payload: { ...body.payload, userId: 'foreign', access_token: 'not-forwarded' },
        })
      ).status,
    ).toBe(400);
    expect((await post('intent', { ...body, issuedAt: new Date(Date.now() - 121000).toISOString() })).status).toBe(400);
    expect((await db.select().from(authWebOAuthCommands)).length).toBe(0);
  });
  it('requires private auth and rejects browser Origin/method/path before touching DB', async () => {
    const body = command('intent', { provider: 'google', flow: randomBytes(32).toString('hex'), actorCookie: null });
    expect((await post('intent', body, { authorization: 'Bearer invalid' })).status).toBe(401);
    expect((await post('intent', body, { extraHeaders: { Origin: 'https://www.example.test' } })).status).toBe(401);
    expect((await post('intent', body, { method: 'GET' })).status).toBe(400);
    expect((await post('intent', body, { path: `${WEB_OAUTH_COMMAND_PATHS.intent}?unexpected=true` })).status).toBe(
      404,
    );
    expect((await db.select().from(authWebOAuthCommands)).length).toBe(0);
  });
  it('rejects physically malformed UTF8 before JSON can replace a provider subject', async () => {
    const binding = await intent();
    const marker = 'owned-subject-marker';
    const text = JSON.stringify(resolveCommand(binding, { subject: marker }));
    const position = text.indexOf(marker);
    expect(position).toBeGreaterThan(0);
    const bytes = Buffer.concat([
      Buffer.from(text.slice(0, position)),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(text.slice(position + marker.length)),
    ]);
    const response = await fetch(`${origins[0]}${WEB_OAUTH_COMMAND_PATHS.resolve}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rpcSecret}`, 'Content-Type': 'application/json' },
      body: new Uint8Array(bytes).buffer,
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(await counts()).toMatchObject({ users: 0, accounts: 0, reservations: 0, commands: 1 });
    expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).toBe(null);
  });
  it('returns safe unavailable on an actual restricted-role SQL read failure without fallback', async () => {
    await admin(sql`REVOKE SELECT ON TABLE ${authEmailProjection} FROM ${sql.identifier(role)}`);
    try {
      const result = await post(
        'intent',
        command('intent', { provider: 'google', flow: randomBytes(32).toString('hex'), actorCookie: null }),
      );
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: 'unavailable' });
      expect((await db.select().from(authWebOAuthCommands)).length).toBe(0);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledExactlyOnceWith('Current-store web OAuth identity unavailable', {
        operation: 'intent',
      });
    } finally {
      await admin(sql`GRANT SELECT ON TABLE ${authEmailProjection} TO ${sql.identifier(role)}`);
    }
    expect(
      (
        await post(
          'intent',
          command('intent', { provider: 'google', flow: randomBytes(32).toString('hex'), actorCookie: null }),
        )
      ).status,
    ).toBe(200);
  });
  it('is independently default off and never falls back on active unsafe logging or stale authority', async () => {
    const body = command('intent', { provider: 'google', flow: randomBytes(32).toString('hex'), actorCookie: null });
    vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'invalid');
    expect((await post('intent', body)).status).toBe(404);
    vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    vi.stubEnv('DEBUG_SQL', 'true');
    expect((await post('intent', body)).status).toBe(503);
    vi.stubEnv('DEBUG_SQL', 'false');
    await db.update(authEmailProjection).set({ writerEpoch: 2 });
    expect((await post('intent', body)).status).toBe(503);
    expect((await db.select().from(authWebOAuthCommands)).length).toBe(0);
  });
  it.each([
    { actorUserId: 'actor', actorLineageHash: null, actorObservedGeneration: 0 },
    { actorUserId: 'actor', actorLineageHash: 'a'.repeat(64), actorObservedGeneration: null },
    { actorUserId: null, actorLineageHash: 'a'.repeat(64), actorObservedGeneration: 0 },
  ])('rejects partial actor tuples through real generated PostgreSQL CHECK', async (actor) => {
    const now = new Date();
    await expect(
      db.insert(authWebOAuthIntents).values({
        intentHash: randomBytes(32).toString('hex'),
        provider: 'google',
        flowHash: randomBytes(32).toString('hex'),
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 900000),
        ...actor,
      }),
    ).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'auth_web_oauth_intents_actor' } });
  });
  it('rolls back consumed intent/nonce/reservation/user/profile after real final provider-insert failure', async () => {
    const subject = randomUUID();
    const name = `weboauth_fault_${randomUUID().replaceAll('-', '')}`;
    const binding = await intent();
    const payload = resolveCommand(binding, { subject });
    await admin(
      sql`ALTER TABLE ${accounts} ADD CONSTRAINT ${sql.identifier(name)} CHECK (${accounts.providerAccountId} <> ${sql.raw(`'${subject}'`)})`,
    );
    try {
      await expect(resolveWebOAuthIdentity(writer, authority, actorSecret, payload)).rejects.toMatchObject({
        cause: { code: '23514', constraint_name: name },
      });
      expect((await post('resolve', { ...payload, requestId: randomUUID() })).status).toBe(503);
      expect(await counts()).toMatchObject({ users: 0, profiles: 0, accounts: 0, reservations: 0, commands: 1 });
      expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).toBe(null);
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls).includes(subject)).toBe(false);
    } finally {
      await admin(sql`ALTER TABLE ${accounts} DROP CONSTRAINT ${sql.identifier(name)}`);
    }
    expect(resolved(await post('resolve', resolveCommand(await intent(), { subject }))).createdUser).toBe(true);
  });
});
