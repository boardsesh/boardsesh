import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { compare, getRounds } from 'bcryptjs';
import { jwtVerify } from 'jose';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import {
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authEmailVerificationTokens,
  authEmailVerificationState,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  users,
  userCredentials,
  userProfiles,
  mobileRefreshTokens,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { AUTH_COMMAND_PATHS, registerReplySchema } from '@boardsesh/auth-protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { handleNativeAuthRegister, __resetNativeAuthStateForTests } from '../../../handlers/native-auth';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { logger } from '../../../utils/logger';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../foundation-context';
import { normalizeAccountEmail } from '../../normalize-email';

const hashing = vi.hoisted(() => ({ afterRealHash: undefined as (() => Promise<void>) | undefined }));
vi.mock('bcryptjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('bcryptjs')>();
  return {
    ...original,
    hash: async (contents: string, cost: number | string) => {
      const hashed = await original.hash(contents, cost);
      await hashing.afterRealHash?.();
      return hashed;
    },
  };
});

const suffix = randomUUID().replaceAll('-', '');
const nativeRole = `ba03_native_${suffix}`;
const webRole = `ba03_nativeweb_${suffix}`;
const rolePassword = randomBytes(32).toString('hex');
const signingSecret = randomBytes(32).toString('base64url');
const rpcSecret = randomBytes(32).toString('base64url');
const ownedRoles: string[] = [];
const ownedPools: ReturnType<typeof postgres>[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const origins: string[] = [];
const password = '  café 山🧗 password  ';
let nativeWriter: DbInstance;
let secondNativeWriter: DbInstance;
let webWriter: DbInstance;
let projectionId: string;

interface NativeReply {
  jwt: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
  accountCreation: { userId: string; provider: string; accountCreated: boolean; createdAt: string };
}
async function administrator(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
    return transaction.execute(statement);
  });
}
async function post(payload: unknown, instance = 0) {
  return fetch(`${origins[instance]}/auth/native/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
}
async function webCommand(email: string, requestId = randomUUID()) {
  const command = {
    protocolVersion: 2,
    operation: 'register',
    requestId,
    issuedAt: Date.now(),
    payload: { email, password },
  };
  const response = await fetch(`${origins[0]}${AUTH_COMMAND_PATHS.register}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rpcSecret}` },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  return { response, reply: registerReplySchema.parse(await response.json()), command };
}
async function counts() {
  return {
    users: (await db.select().from(users)).length,
    credentials: (await db.select().from(userCredentials)).length,
    profiles: (await db.select().from(userProfiles)).length,
    refresh: (await db.select().from(mobileRefreshTokens)).length,
    reservations: (await db.select().from(authEmailReservations)).length,
    members: (await db.select().from(authEmailReservationMembers)).length,
    nonces: (await db.select().from(verificationTokens)).length,
  };
}
const empty = { users: 0, credentials: 0, profiles: 0, refresh: 0, reservations: 0, members: 0, nonces: 0 };

describe('independently opted-in native registration with reserved current-store identities', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname) ||
      !databaseUrl.pathname.startsWith('/boardsesh_backend_test_w')
    )
      throw new Error('Native registration fixture requires its owned local worker database');
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      for (const role of [nativeRole, webRole]) {
        await transaction.execute(
          sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
        );
        ownedRoles.push(role);
        await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
        await transaction.execute(sql`GRANT SELECT, INSERT ON TABLE ${users} TO ${sql.identifier(role)}`);
        await transaction.execute(
          sql`GRANT INSERT ON TABLE ${userCredentials}, ${userProfiles} TO ${sql.identifier(role)}`,
        );
        await transaction.execute(
          sql`GRANT SELECT, UPDATE ON TABLE ${authEmailProjection}, ${authSubjectCutoffs} TO ${sql.identifier(role)}`,
        );
        await transaction.execute(
          sql`GRANT SELECT, INSERT, UPDATE ON TABLE ${authEmailReservations} TO ${sql.identifier(role)}`,
        );
        await transaction.execute(
          sql`GRANT SELECT, INSERT ON TABLE ${authEmailReservationMembers} TO ${sql.identifier(role)}`,
        );
      }
      await transaction.execute(sql`GRANT INSERT ON TABLE ${mobileRefreshTokens} TO ${sql.identifier(nativeRole)}`);
      // PostgreSQL row locks require UPDATE on at least one column. The
      // issuer may lock users without gaining any identity-column mutation.
      await transaction.execute(sql`GRANT UPDATE (updated_at) ON TABLE ${users} TO ${sql.identifier(nativeRole)}`);
      await transaction.execute(sql`GRANT SELECT, INSERT ON TABLE ${verificationTokens} TO ${sql.identifier(webRole)}`);
    });
    for (const role of [nativeRole, webRole, nativeRole]) {
      const url = new URL(databaseUrl);
      url.username = role;
      url.password = rolePassword;
      const pool = postgres(url.toString(), {
        max: 3,
        connect_timeout: 3,
        onnotice: () => {},
        connection: { statement_timeout: 5000, lock_timeout: 4000 },
      });
      ownedPools.push(pool);
      if (role === nativeRole && nativeWriter) secondNativeWriter = drizzle(pool);
      else if (role === nativeRole) nativeWriter = drizzle(pool);
      else webWriter = drizzle(pool);
    }
    for (let instance = 0; instance < 2; instance += 1) {
      const server = createServer((request, response) => {
        void (
          request.url?.startsWith('/auth/native/register')
            ? handleNativeAuthRegister(request, response, instance === 0 ? nativeWriter : secondNativeWriter)
            : handleCurrentStoreWebAuth(request, response, webWriter)
        ).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      servers.push(server);
      server.requestTimeout = 11_000;
      server.headersTimeout = 11_000;
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Owned native HTTP failed to bind');
      origins.push(`http://127.0.0.1:${address.port}`);
    }
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __resetNativeAuthStateForTests();
    hashing.afterRealHash = undefined;
    await db.delete(authEmailVerificationTokens);
    await db.delete(authEmailVerificationState);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSubjectCutoffs);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authEmailProjection);
    await db.delete(verificationTokens);
    await db.delete(users);
    projectionId = randomUUID();
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    vi.stubEnv('NEXTAUTH_SECRET', signingSecret);
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'reserved-staging');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
    vi.stubEnv('DEBUG_SQL', 'false');
  });
  afterEach(() => {
    hashing.afterRealHash = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    const failures: Error[] = [];
    for (const server of servers) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            for (const socket of sockets) socket.destroy();
            reject(new Error('Owned HTTP close deadline'));
          }, 3000);
          server.close((error) => {
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve();
          });
          server.closeIdleConnections();
        });
      } catch {
        failures.push(new Error('Owned HTTP cleanup failed'));
      }
    }
    for (const pool of ownedPools) {
      try {
        await pool.end({ timeout: 3 });
      } catch {
        failures.push(new Error('Owned LOGIN pool cleanup failed'));
      }
    }
    for (const role of ownedRoles) {
      try {
        const records = await administrator(
          sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS present`,
        );
        if (records[0]?.present === false) continue;
      } catch {
        failures.push(new Error('Owned role lookup failed'));
      }
      try {
        await administrator(sql`REVOKE UPDATE (updated_at) ON TABLE ${users} FROM ${sql.identifier(role)}`);
        await administrator(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${userCredentials}, ${userProfiles}, ${mobileRefreshTokens}, ${authEmailProjection}, ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs}, ${verificationTokens} FROM ${sql.identifier(role)}`,
        );
      } catch {
        failures.push(new Error('Owned role grants cleanup failed'));
      }
      try {
        await administrator(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned schema cleanup failed'));
      }
      try {
        await administrator(sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned native fixture cleanup failed');
  });

  it('supports real user KEY SHARE with timestamp-only UPDATE and denies identity mutation or deletion', async () => {
    const probeId = randomUUID();
    const rollback = new Error('Owned row-lock probe rollback');
    await expect(
      nativeWriter.transaction(async (transaction) => {
        await transaction.insert(users).values({ id: probeId, email: `${probeId}@lock-probe.example.test` });
        const [subject] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, probeId))
          .for('key share', { of: users });
        expect(subject?.id).toBe(probeId);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, probeId))).toEqual([]);
    await expect(
      nativeWriter.update(users).set({ id: randomUUID() }).where(eq(users.id, probeId)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      nativeWriter.update(users).set({ email: 'forbidden@lock-probe.example.test' }).where(eq(users.id, probeId)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(nativeWriter.delete(users).where(eq(users.id, probeId))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it.each([false, true])(
    'preserves public token/receipt/password contracts with verification %s and minimal LOGIN grants',
    async (required) => {
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', String(required));
      const email = `  Native.Mixed.${randomUUID()}+Tag@Example.TEST  `;
      const requestedUserId = randomUUID();
      const startedAt = Date.now();
      const response = await post({
        email,
        password,
        name: '  Current Native Climber  ',
        requestedUserId,
        protocolVersion: 999,
        projectionId: 'hostile',
        writerEpoch: 999,
        emailVerified: true,
        passwordHash: 'hostile-not-a-password-hash',
      });
      expect(response.status).toBe(201);
      const reply = (await response.json()) as NativeReply;
      const completedAt = Date.now();
      expect(reply.userId).not.toBe(requestedUserId);
      expect(reply).not.toHaveProperty('mailPlan');
      expect(reply).not.toHaveProperty('tokenPair');
      expect(reply).not.toHaveProperty('protocolVersion');
      const { payload, protectedHeader } = await jwtVerify(reply.jwt, new TextEncoder().encode(signingSecret), {
        issuer: 'boardsesh',
        audience: 'boardsesh-mobile',
        algorithms: ['HS256'],
      });
      expect(protectedHeader).toMatchObject({ alg: 'HS256', typ: 'JWT' });
      expect(payload.sub).toBe(reply.userId);
      const lifetimeSeconds = 7 * 24 * 3600;
      expect(payload.iat).toBeGreaterThanOrEqual(Math.floor(startedAt / 1000));
      expect(payload.iat).toBeLessThanOrEqual(Math.floor(completedAt / 1000));
      expect(payload.exp).toBeGreaterThanOrEqual(Math.floor(startedAt / 1000) + lifetimeSeconds);
      expect(payload.exp).toBeLessThanOrEqual(Math.floor(completedAt / 1000) + lifetimeSeconds);
      expect(new Date(reply.expiresAt).getTime()).toBeGreaterThanOrEqual(startedAt + lifetimeSeconds * 1000);
      expect(new Date(reply.expiresAt).getTime()).toBeLessThanOrEqual(completedAt + lifetimeSeconds * 1000);
      expect(reply.accountCreation).toMatchObject({ userId: reply.userId, provider: 'email', accountCreated: true });
      const [user] = await db.select().from(users);
      const [credential] = await db.select().from(userCredentials);
      const [refresh] = await db.select().from(mobileRefreshTokens);
      expect(user.id).toBe(reply.userId);
      expect(user.email).toBe(normalizeAccountEmail(email));
      expect(user.name).toBe('Current Native Climber');
      expect(reply.accountCreation.createdAt).toBe(user.createdAt.toISOString());
      expect(user.emailVerified === null).toBe(required);
      expect(getRounds(credential.passwordHash)).toBe(12);
      expect(await compare(password, credential.passwordHash)).toBe(true);
      expect(await compare(password.trim(), credential.passwordHash)).toBe(false);
      expect(refresh.userId).toBe(reply.userId);
      expect(refresh.tokenHash).toBe(createHash('sha256').update(reply.refreshToken).digest('hex'));
      expect(refresh.expiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + 90 * 24 * 3600_000);
      expect(refresh.expiresAt.getTime()).toBeLessThanOrEqual(completedAt + 90 * 24 * 3600_000);
      expect(await counts()).toEqual({
        ...empty,
        users: 1,
        credentials: 1,
        profiles: 1,
        refresh: 1,
        reservations: 1,
        members: 1,
      });
      const [actor] = await nativeWriter.execute(
        sql`SELECT current_user AS actor, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`,
      );
      expect(actor).toMatchObject({ actor: nativeRole, superuser: false });
      await expect(nativeWriter.delete(users)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(nativeWriter.execute(sql`TRUNCATE TABLE ${users} CASCADE`)).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    },
  );
  it('allows only one native instance to reserve a case/whitespace key', async () => {
    const email = `Native.Race.${randomUUID()}@Example.TEST`;
    const replies = await Promise.all([
      post({ email, password }),
      post({ email: ` ${email.toLowerCase()} `, password }, 1),
    ]);
    expect(replies.map((reply) => reply.status).sort((first, second) => first - second)).toEqual([201, 409]);
    expect(await counts()).toEqual({
      ...empty,
      users: 1,
      credentials: 1,
      profiles: 1,
      refresh: 1,
      reservations: 1,
      members: 1,
    });
  });
  it('serializes web/native creation through the same key without changing web negative nonce semantics', async () => {
    const email = `Cross.Race.${randomUUID()}@Example.TEST`;
    const [native, web] = await Promise.all([post({ email, password }), webCommand(email)]);
    expect([native.status, web.response.status].sort((first, second) => first - second)).toEqual([201, 409]);
    const measured = await counts();
    expect(measured).toMatchObject({ users: 1, credentials: 1, profiles: 1, reservations: 1, members: 1, nonces: 1 });
    expect(measured.refresh).toBe(native.status === 201 ? 1 : 0);
    const duplicate = await webCommand(email, web.command.requestId);
    expect(duplicate.reply).toMatchObject({ outcome: 'error', code: 'replayed' });
    expect((await counts()).nonces).toBe(1);
  });
  it('commits a web exists nonce for an existing native identity', async () => {
    const email = `Existing.${randomUUID()}@Example.TEST`;
    expect((await post({ email, password })).status).toBe(201);
    const web = await webCommand(email.toLowerCase());
    expect(web.response.status).toBe(409);
    expect(web.reply).toMatchObject({ outcome: 'error', code: 'exists' });
    expect((await counts()).nonces).toBe(1);
  });
  it.each(['owned', 'blocked_ambiguous', 'blocked_deleted', 'blocked_invalid'] as const)(
    'never creates an owner for a current trusted %s key',
    async (state) => {
      const email = `Occupied.${randomUUID()}@example.test`;
      await db.insert(authEmailReservations).values({
        normalizedEmail: email.toLowerCase(),
        basisProjectionId: projectionId,
        state,
        ownerUserId: state === 'owned' ? randomUUID() : null,
      });
      const before = await counts();
      expect((await post({ email, password })).status).toBe(409);
      expect(await counts()).toEqual(before);
    },
  );
  it.each(['stale', 'missing'] as const)(
    'rejects an exact-email precheck with %s reservation evidence as unavailable in both callers',
    async (kind) => {
      const email = `${randomUUID()}@example.test`;
      await db.insert(users).values({ id: randomUUID(), email });
      if (kind === 'stale') {
        const oldBasis = randomUUID();
        await db.insert(authEmailProjection).values({
          projectionId: oldBasis,
          isCurrent: false,
          phase: 'prepared',
          normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
          writerEpoch: 1,
          preparedAt: new Date(),
        });
        await db
          .insert(authEmailReservations)
          .values({ normalizedEmail: email, basisProjectionId: oldBasis, state: 'owned', ownerUserId: randomUUID() });
      }
      const before = await counts();
      expect((await post({ email, password })).status).toBe(503);
      expect((await webCommand(email)).response.status).toBe(503);
      expect(await counts()).toEqual(before);
    },
  );
  it('preflights enforced authority before returning an exact-email conflict', async () => {
    const email = `${randomUUID()}@example.test`;
    await db.insert(users).values({ id: randomUUID(), email });
    await db.update(authEmailProjection).set({ phase: 'prepared' });
    expect((await post({ email, password })).status).toBe(503);
    expect((await counts()).users).toBe(1);
    expect((await counts()).refresh).toBe(0);
  });
  it('rechecks authority after real bcrypt without holding the global manifest during hashing', async () => {
    let enter = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    hashing.afterRealHash = async () => {
      hashing.afterRealHash = undefined;
      enter();
      await released;
    };
    const active = post({ email: `${randomUUID()}@example.test`, password });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered,
        active.then(() => {
          throw new Error('Native command ended before bcrypt barrier');
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Native bcrypt barrier deadline')), 3500);
        }),
      ]);
      // This must commit while hashing is paused. If the manifest were held,
      // the real PostgreSQL lock deadline rejects this fixture mutation.
      await db.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await transaction
          .update(authEmailProjection)
          .set({ writerEpoch: 2 })
          .where(eq(authEmailProjection.projectionId, projectionId));
      });
      release();
      expect((await active).status).toBe(503);
      expect(await counts()).toEqual(empty);
    } finally {
      if (timeout) clearTimeout(timeout);
      release();
      hashing.afterRealHash = undefined;
      await Promise.allSettled([active]);
    }
  });
  it('retains one committed identity after a discarded HTTP response and returns409 on a fresh retry', async () => {
    const email = `${randomUUID()}@example.test`;
    const firstStatus = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        `${origins[0]}/auth/native/register`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (incoming) => {
          // Drop the real response body rather than accepting/caching its tokens.
          const status = incoming.statusCode;
          incoming.destroy();
          resolve(status ?? 0);
        },
      );
      outgoing.once('error', reject);
      outgoing.setTimeout(8000, () => outgoing.destroy(new Error('Owned lost-response deadline')));
      outgoing.end(JSON.stringify({ email, password }));
    });
    expect(firstStatus).toBe(201);
    const committed = await counts();
    expect(committed).toEqual({
      ...empty,
      users: 1,
      credentials: 1,
      profiles: 1,
      refresh: 1,
      reservations: 1,
      members: 1,
    });
    const retry = await post({ email, password });
    expect(retry.status).toBe(409);
    expect(await retry.json()).not.toHaveProperty('jwt');
    expect(await counts()).toEqual(committed);
  });
  it('keeps native opt-in independent of web mode and RPC configuration', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', '');
    expect((await post({ email: `${randomUUID()}@example.test`, password })).status).toBe(201);
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', '');
    vi.stubEnv('DEBUG_SQL', 'true');
    expect((await post({ email: `${randomUUID()}@example.test`, password })).status).toBe(201);
    expect((await counts()).reservations).toBe(1);
  });
  it.each([
    ['CURRENT_STORE_AUTH_PROJECTION_ID', ''],
    ['CURRENT_STORE_AUTH_WRITER_EPOCH', '0'],
    ['CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'unexpected'],
    ['DEBUG_SQL', 'true'],
  ])('fails enabled configuration %s closed without writes', async (name, content) => {
    vi.stubEnv(name, content);
    const response = await post({ email: `${randomUUID()}@example.test`, password });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Service temporarily unavailable' });
    expect(await counts()).toEqual(empty);
  });
  it('rolls back every registration/reservation row when the actual issuer lacks its signing secret', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', '');
    const logging = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const response = await post({ email: `${randomUUID()}@example.test`, password });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Authentication is temporarily unavailable' });
    expect(await counts()).toEqual(empty);
    expect(logging).not.toHaveBeenCalled();
    expect(JSON.stringify(logging.mock.calls)).not.toContain(password);
  });
  it('returns safe unavailability on an actual reservation-read permission outage without reaching legacy logging', async () => {
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const failure = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      await administrator(sql`REVOKE SELECT ON TABLE ${authEmailReservations} FROM ${sql.identifier(nativeRole)}`);
      const response = await post({ email: `${randomUUID()}@example.test`, password });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Service temporarily unavailable' });
      expect(await counts()).toEqual(empty);
      expect(warning.mock.calls).toEqual([
        ['[NativeAuth] Reserved registration unavailable', { category: 'authority-or-database' }],
      ]);
      expect(failure).not.toHaveBeenCalled();
    } finally {
      await administrator(sql`GRANT SELECT ON TABLE ${authEmailReservations} TO ${sql.identifier(nativeRole)}`);
    }
  });
  it('rolls back identity and reservation on actual refresh INSERT failure without logging SQL or hashes', async () => {
    const constraint = `ba03_native_refresh_${suffix}`;
    const logging = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      await administrator(
        sql`ALTER TABLE ${mobileRefreshTokens} ADD CONSTRAINT ${sql.identifier(constraint)} CHECK (length(token_hash) = 1)`,
      );
      const response = await post({ email: `${randomUUID()}@example.test`, password });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Service temporarily unavailable' });
      expect(await counts()).toEqual(empty);
      expect(logging).toHaveBeenCalledWith('[NativeAuth] Reserved registration unavailable', {
        category: 'authority-or-database',
      });
      expect(JSON.stringify(logging.mock.calls)).not.toContain('insert into');
      expect(JSON.stringify(logging.mock.calls)).not.toContain(password);
    } finally {
      await administrator(
        sql`ALTER TABLE ${mobileRefreshTokens} DROP CONSTRAINT IF EXISTS ${sql.identifier(constraint)}`,
      );
    }
  });
});
