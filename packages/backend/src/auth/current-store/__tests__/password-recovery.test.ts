import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  forgotPasswordReplySchema,
  resetPasswordReplySchema,
  type AuthCommand,
  type ForgotPasswordCommand,
  type ResetPasswordCommand,
  type ResetPasswordReply,
  AUTH_COMMAND_MAX_AGE_MS,
} from '@boardsesh/auth-protocol';
import {
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authPasswordRecoveryState,
  authPasswordRecoveryTokens,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  users,
  userCredentials,
  mobileRefreshTokens,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { db } from '../../../db/client';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { __resetNativeAuthStateForTests, handleNativeAuthRefresh } from '../../../handlers/native-auth';
import { logger } from '../../../utils/logger';
import { normalizeAccountEmail } from '../../normalize-email';
import {
  CURRENT_EMAIL_NORMALIZER_VERSION,
  lockAuthorityGateExclusively,
  lockEnforcedProjection,
} from '../foundation-context';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import { consumePasswordRecovery, requestPasswordRecovery } from '../password-recovery';
import { issueEmailVerification, consumeEmailVerification } from '../email-verification';
import type { WebPasswordAuthority } from '../command-context';
import {
  attachPartnerState,
  countsOf,
  createApp,
  createUser,
  INTACT_COUNTS,
  readPartnerState,
  REVOKED_COUNTS,
} from '../../partner/__tests__/revocation-fixtures';

const role = `ba03_recovery_${randomUUID().replaceAll('-', '')}`;
const rolePassword = randomBytes(32).toString('hex');
const secret = randomBytes(32).toString('base64url');
const trackedRoles: string[] = [];
const pools: ReturnType<typeof postgres>[] = [];
const writers: DbInstance[] = [];
const servers: Server[] = [];
const origins: string[] = [];
const sockets = new Set<Socket>();
const activeHandlers = new Set<Promise<void>>();
let acceptingRequests = false;
let failedCleanup = false;
let authority: WebPasswordAuthority;
let originalHash: string;
const originalPassword = 'original-owned-password';
const nextPassword = 'new-owned-password';
const digest = (token: string) => createHash('sha256').update(`password-recovery-v1\0${token}`).digest('hex');
const mutableTables = [
  users,
  userCredentials,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  mobileRefreshTokens,
];
const insertTables = [authSubjectCutoffs, authPasswordRecoveryState, authPasswordRecoveryTokens];
const appendTables = [verificationTokens, authSecurityMutationEvents];
const allTables = [...mutableTables, ...insertTables, ...appendTables];

function forgot(email: string): ForgotPasswordCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'forgot-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email },
  };
}
function reset(
  token: string,
  email: unknown = 'untrusted-hint@example.test',
  password = nextPassword,
): ResetPasswordCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'reset-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { token, email, password, confirmPassword: password },
  };
}
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
async function seed(email = `Mixed.${randomUUID()}+Tag@Example.TEST`, credential = true) {
  const id = randomUUID();
  await db.insert(users).values({ id, email, name: 'Owned recovery fixture' });
  if (credential) await db.insert(userCredentials).values({ userId: id, passwordHash: originalHash });
  await db.transaction((transaction) =>
    reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: id }),
  );
  return { id, email };
}
async function issued(email?: string) {
  const user = await seed(email);
  const reply = await requestPasswordRecovery(writers[0], authority, forgot(user.email));
  if (reply.outcome !== 'accepted' || !reply.mailPlan) throw new Error('Owned fixture issuance failed');
  return { user, plan: reply.mailPlan };
}
async function receipt(token: string) {
  const [stored] = await db
    .select()
    .from(authPasswordRecoveryTokens)
    .where(eq(authPasswordRecoveryTokens.tokenHash, digest(token)));
  if (!stored) throw new Error('Owned recovery receipt missing');
  return stored;
}
async function credential(userId: string) {
  const [stored] = await db.select().from(userCredentials).where(eq(userCredentials.userId, userId));
  return stored;
}
async function rpc(
  command: AuthCommand | Record<string, unknown>,
  index = 0,
  path?: string,
  headers: Record<string, string> = {},
) {
  return fetch(`${origins[index]}${path ?? AUTH_COMMAND_PATHS[command.operation as keyof typeof AUTH_COMMAND_PATHS]}`, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(9000),
  });
}
function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function bounded<T>(pending: Promise<T>, ms = 4500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned recovery wait deadline')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function poll(check: () => Promise<boolean>, pending: Promise<unknown>, milliseconds = 4500) {
  let stopped = false;
  const polling = (async () => {
    while (!stopped) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  })();
  try {
    await bounded(
      Promise.race([
        polling,
        pending.then(() => {
          throw new Error('Owned command ended before barrier');
        }),
      ]),
      milliseconds,
    );
  } finally {
    stopped = true;
    await Promise.allSettled([polling]);
  }
}
async function waiting(pending: Promise<unknown>) {
  await poll(
    async () =>
      (
        await admin(
          sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=${role} AND wait_event_type='Lock') AS waiting`,
        )
      )[0]?.waiting === true,
    pending,
  );
}
async function duringHash(
  command: ResetPasswordCommand,
  change: (pending: Promise<ResetPasswordReply>, resume: () => void) => Promise<void>,
  context = authority,
) {
  const arrived = barrier();
  const release = barrier();
  const actualHash = bcrypt.hash.bind(bcrypt);
  vi.spyOn(bcrypt, 'hash').mockImplementationOnce((async (password: string, rounds: number) => {
    const hashed = await actualHash(password, rounds);
    arrived.resolve();
    await release.promise;
    return hashed;
  }) as typeof bcrypt.hash);
  const pending = consumePasswordRecovery(writers[0], context, command);
  try {
    await bounded(arrived.promise);
    await change(pending, release.resolve);
  } catch (error) {
    release.resolve();
    try {
      await bounded(Promise.allSettled([pending]), 10000);
    } catch {
      failedCleanup = true;
      throw new Error('Owned direct command did not settle; environment retained');
    }
    throw error;
  } finally {
    release.resolve();
  }
  return pending;
}
async function snapshot(userId: string, token: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const [state] = await db.select().from(authPasswordRecoveryState).where(eq(authPasswordRecoveryState.userId, userId));
  return {
    user,
    state,
    credential: await credential(userId),
    receipt: await receipt(token),
    cutoffs: await db.select().from(authSubjectCutoffs),
    events: await db.select().from(authSecurityMutationEvents),
    refresh: await db.select().from(mobileRefreshTokens),
    nonces: await db.select().from(verificationTokens),
  };
}
/** Drives the shipped refresh handler, so these races exercise its real statements. */
async function refreshOverHandler(refreshToken: string) {
  const request = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/auth/native/refresh',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    destroy: () => undefined,
  });
  const response = {
    statusCode: 0,
    writeHead(status: number) {
      this.statusCode = status;
    },
    end() {},
    setHeader() {},
  };
  setImmediate(() => {
    request.emit('data', Buffer.from(JSON.stringify({ refreshToken }), 'utf8'));
    request.emit('end');
  });
  await handleNativeAuthRefresh(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  return response.statusCode;
}
async function seedRefreshToken(userId: string) {
  const refreshToken = randomBytes(32).toString('hex');
  await db.insert(mobileRefreshTokens).values({
    userId,
    tokenHash: createHash('sha256').update(refreshToken).digest('hex'),
    expiresAt: new Date(Date.now() + 86400000),
  });
  return refreshToken;
}
async function liveRefreshRows(userId: string) {
  const rows = await db.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId));
  return { total: rows.length, live: rows.filter((row) => row.revokedAt === null).length };
}
/** The refresh handler connects as the owner role, unlike the restricted recovery writer. */
async function refreshWaitingOnUsersKeyShare(pending: Promise<unknown>) {
  await poll(
    async () =>
      (
        await admin(
          sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename<>${role} AND wait_event_type='Lock' AND query ILIKE 'select%from "users"%for key share of "users"%') AS waiting`,
        )
      )[0]?.waiting === true,
    pending,
  );
}
function failureDetails(error: unknown): { code?: string; constraint?: string } {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as { code?: string; constraint_name?: string; cause?: unknown };
  return candidate.code
    ? { code: candidate.code, constraint: candidate.constraint_name }
    : failureDetails(candidate.cause);
}

describe('UID-bound password recovery over the restricted current store', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    const url = new URL(process.env.DATABASE_URL!);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.startsWith('/boardsesh_backend_test_w')
    )
      throw new Error('Recovery fixture requires an owned local worker database');
    originalHash = await bcrypt.hash(originalPassword, 12);
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
      );
      trackedRoles.push(role);
      await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      await transaction.execute(
        sql`GRANT SELECT, UPDATE ON TABLE ${sql.join(mutableTables, sql`, `)} TO ${sql.identifier(role)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE ON TABLE ${sql.join(insertTables, sql`, `)} TO ${sql.identifier(role)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT ON TABLE ${sql.join(appendTables, sql`, `)} TO ${sql.identifier(role)}`,
      );
    });
    url.username = role;
    url.password = rolePassword;
    for (let index = 0; index < 2; index += 1) {
      const pool = postgres(url.toString(), {
        max: 2,
        connect_timeout: 3,
        onnotice: () => {},
        connection: { statement_timeout: 6000, lock_timeout: 4000 },
      });
      pools.push(pool);
      const writer = drizzle(pool);
      writers.push(writer);
      const server = createServer((request, response) => {
        if (!acceptingRequests) {
          response.destroy();
          return;
        }
        const pending = handleCurrentStoreWebAuth(request, response, writer).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
        activeHandlers.add(pending);
        void pending.finally(() => activeHandlers.delete(pending));
      });
      servers.push(server);
      server.requestTimeout = 10000;
      server.headersTimeout = 10000;
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Recovery HTTP fixture failed to bind');
      origins.push(`http://127.0.0.1:${address.port}`);
    }
  });
  beforeEach(async () => {
    if (failedCleanup || activeHandlers.size) throw new Error('Owned recovery fixture is not quiescent');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(authPasswordRecoveryTokens);
    await db.delete(authPasswordRecoveryState);
    await db.delete(authEmailVerificationTokens);
    await db.delete(authEmailVerificationState);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(verificationTokens);
    await db.delete(users);
    authority = {
      expectedProjectionId: randomUUID(),
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
      emailVerificationEnabled: true,
    };
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: authority.expectedProjectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, authority.expectedProjectionId));
    });
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', authority.expectedProjectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('DEBUG_SQL', 'false');
    acceptingRequests = true;
  });
  afterEach(async () => {
    acceptingRequests = false;
    try {
      await bounded(Promise.allSettled(activeHandlers), 11000);
      if (activeHandlers.size) throw new Error('Owned recovery handlers remain');
    } catch {
      failedCleanup = true;
      throw new Error('Owned recovery cleanup failed; environment retained');
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    acceptingRequests = false;
    const failures: Error[] = [];
    for (const server of servers)
      try {
        await bounded(
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeIdleConnections();
          }),
          3000,
        );
      } catch {
        for (const socket of sockets) socket.destroy();
        failures.push(new Error('Owned recovery HTTP cleanup failed'));
      }
    for (const pool of pools)
      try {
        await pool.end({ timeout: 3 });
      } catch {
        failures.push(new Error('Owned recovery pool cleanup failed'));
      }
    try {
      await bounded(Promise.allSettled(activeHandlers), 11000);
    } catch {
      failures.push(new Error('Owned recovery handler cleanup failed'));
    }
    for (const owned of trackedRoles) {
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(allTables, sql`, `)} FROM ${sql.identifier(owned)}`);
      } catch {
        failures.push(new Error('Owned recovery table grant cleanup failed'));
      }
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(owned)}`);
      } catch {
        failures.push(new Error('Owned recovery schema grant cleanup failed'));
      }
      try {
        await admin(sql`DROP ROLE IF EXISTS ${sql.identifier(owned)}`);
      } catch {
        failures.push(new Error('Owned recovery role cleanup failed'));
      }
    }
    if (!activeHandlers.size && servers.every((server) => !server.listening)) {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    } else failures.push(new Error('Owned recovery not quiescent; environment retained'));
    if (failures.length) throw new AggregateError(failures, 'Owned recovery cleanup failed');
  });

  it('uses a restricted LOGIN and rejects identity insert, event rewrite and truncation', async () => {
    const [actor] = await writers[0].execute(
      sql`SELECT current_user AS actor, rolsuper, rolcreaterole, rolinherit FROM pg_roles WHERE rolname=current_user`,
    );
    expect(actor).toMatchObject({ actor: role, rolsuper: false, rolcreaterole: false, rolinherit: false });
    for (const action of [
      () => writers[0].insert(users).values({ id: 'unowned-insert', email: 'unowned@example.test' }),
      () => writers[0].update(authSecurityMutationEvents).set({ kind: 'password-reset' }),
      () => writers[0].execute(sql`TRUNCATE ${authPasswordRecoveryTokens}`),
    ]) {
      let failure: unknown;
      try {
        await action();
      } catch (error) {
        failure = error;
      }
      expect(failureDetails(failure).code).toBe('42501');
    }
  });
  it('stores only purpose hash and immutable UID/key/one-hour deadline in issuance transaction', async () => {
    const user = await seed();
    const response = await rpc(forgot(user.email.toLowerCase()));
    expect(response.status).toBe(200);
    const reply = forgotPasswordReplySchema.parse(await response.json());
    if (reply.outcome !== 'accepted' || !reply.mailPlan) throw new Error('Missing HTTP mail plan');
    const plan = reply.mailPlan;
    const stored = await receipt(plan.token);
    expect(plan.recipient === user.email).toBe(true);
    expect(stored.userId === user.id).toBe(true);
    expect(stored.normalizedEmail === normalizeAccountEmail(user.email)).toBe(true);
    expect(stored.expiresAt.getTime() - stored.issuedAt.getTime()).toBe(3600000);
    expect(stored.expiresAt.toISOString() === plan.expiresAt).toBe(true);
    expect(JSON.stringify(stored).includes(plan.token)).toBe(false);
    expect(stored.subjectGeneration).toBe(0);
    expect(stored.issuanceGeneration).toBe(1);
  });
  it('resets only bound UID, preserves password bytes and commits both-domain intent plus current refresh revocation', async () => {
    const { user, plan } = await issued();
    const sibling = await seed();
    await db.insert(mobileRefreshTokens).values(
      [user.id, user.id, sibling.id].map((userId) => ({
        userId,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 86400000),
      })),
    );
    const reply = await consumePasswordRecovery(
      writers[0],
      authority,
      reset(plan.token, sibling.email, '  é原pass-word  '),
    );
    expect(reply.outcome).toBe('reset');
    const changed = await credential(user.id);
    expect(await bcrypt.compare('  é原pass-word  ', changed.passwordHash)).toBe(true);
    expect(await bcrypt.compare(originalPassword, changed.passwordHash)).toBe(false);
    expect(bcrypt.getRounds(changed.passwordHash)).toBe(12);
    expect((await credential(sibling.id)).passwordHash === originalHash).toBe(true);
    const snapshotAfter = await snapshot(user.id, plan.token);
    expect(snapshotAfter.receipt.consumedAt).not.toBeNull();
    expect(snapshotAfter.state.generation).toBe(2);
    expect(snapshotAfter.events).toHaveLength(1);
    expect(snapshotAfter.events[0]).toMatchObject({
      kind: 'password-reset',
      userId: user.id,
      generation: 1,
      previousGeneration: 0,
      domains: ['first-party', 'partner'],
    });
    expect(snapshotAfter.refresh.filter((row) => row.userId === user.id).every((row) => row.revokedAt)).toBe(true);
    expect(snapshotAfter.refresh.find((row) => row.userId === sibling.id)?.revokedAt).toBeNull();
  });
  it('ends partner connections through the user_credentials trigger when the staged reset commits', async () => {
    const { user, plan } = await issued();
    const developerId = await createUser('developer');
    const clientId = await createApp(developerId);
    const partnerRows = await attachPartnerState(user.id, clientId);
    const bystander = await attachPartnerState(developerId, clientId);

    const reply = await consumePasswordRecovery(writers[0], authority, reset(plan.token));

    expect(reply.outcome).toBe('reset');
    expect(await bcrypt.compare(nextPassword, (await credential(user.id)).passwordHash)).toBe(true);
    const state = await readPartnerState(partnerRows);
    expect(countsOf(state)).toEqual(REVOKED_COUNTS);
    expect(state.connection.generation).toBe(1);
    expect(state.connection.revokedAt).not.toBeNull();
    expect(countsOf(await readPartnerState(bystander))).toEqual(INTACT_COUNTS);
  });
  it('preserves existing email verification timestamp and does not issue any session or token pair', async () => {
    const { user, plan } = await issued();
    const verifiedAt = new Date('2024-01-02T03:04:05.000Z');
    await db.update(users).set({ emailVerified: verifiedAt }).where(eq(users.id, user.id));
    const response = await rpc(reset(plan.token));
    const body = resetPasswordReplySchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(body.outcome).toBe('reset');
    expect(Object.keys(body).sort()).toEqual(['operation', 'outcome', 'protocolVersion', 'requestId']);
    const [stored] = await db.select().from(users).where(eq(users.id, user.id));
    expect(stored.emailVerified).toEqual(verifiedAt);
    expect(await db.select().from(mobileRefreshTokens)).toHaveLength(0);
  });
  it('allows only one concurrent redemption through independent LOGIN pools', async () => {
    const { plan } = await issued();
    const replies = await Promise.all([
      consumePasswordRecovery(writers[0], authority, reset(plan.token)),
      consumePasswordRecovery(writers[1], authority, reset(plan.token)),
    ]);
    expect(replies.map((reply) => reply.outcome).sort()).toEqual(['invalid_or_expired', 'reset']);
    expect(await db.select().from(authSecurityMutationEvents)).toHaveLength(1);
  });
  it('supersedes only new receipts and rejects the earlier link after another forgot', async () => {
    const { user, plan } = await issued();
    const next = await requestPasswordRecovery(writers[1], authority, forgot(user.email));
    if (next.outcome !== 'accepted' || !next.mailPlan) throw new Error('Missing replacement');
    expect((await receipt(plan.token)).supersededAt).not.toBeNull();
    expect((await consumePasswordRecovery(writers[0], authority, reset(plan.token))).outcome).toBe(
      'invalid_or_expired',
    );
    expect((await consumePasswordRecovery(writers[0], authority, reset(next.mailPlan.token))).outcome).toBe('reset');
  });
  it('can issue after a completed reset but never revive the consumed receipt', async () => {
    const { user, plan } = await issued();
    expect((await consumePasswordRecovery(writers[0], authority, reset(plan.token))).outcome).toBe('reset');
    const next = await requestPasswordRecovery(writers[1], authority, forgot(user.email));
    if (next.outcome !== 'accepted' || !next.mailPlan) throw new Error('Missing next receipt');
    expect((await receipt(plan.token)).consumedAt).not.toBeNull();
    expect((await receipt(next.mailPlan.token)).subjectGeneration).toBe(1);
    expect(
      (await consumePasswordRecovery(writers[0], authority, reset(next.mailPlan.token, undefined, 'another-password')))
        .outcome,
    ).toBe('reset');
  });
  it('serializes concurrent forgot/reset without leaving the superseded generation usable', async () => {
    const { user, plan } = await issued();
    const [consumed, reissued] = await Promise.all([
      consumePasswordRecovery(writers[0], authority, reset(plan.token)),
      requestPasswordRecovery(writers[1], authority, forgot(user.email)),
    ]);
    expect(['reset', 'invalid_or_expired']).toContain(consumed.outcome);
    if (reissued.outcome !== 'accepted' || !reissued.mailPlan) throw new Error('Missing race issuance');
    const current = await receipt(reissued.mailPlan.token);
    const [cutoff] = await db.select().from(authSubjectCutoffs);
    expect(current.subjectGeneration).toBe(cutoff?.generation ?? 0);
    expect((await consumePasswordRecovery(writers[0], authority, reset(plan.token))).outcome).toBe(
      'invalid_or_expired',
    );
  });
  it('retains terminal generations across receipt cleanup and rejects an old reinserted snapshot', async () => {
    const { user, plan } = await issued();
    const original = await receipt(plan.token);
    await requestPasswordRecovery(writers[0], authority, forgot(user.email));
    await db.delete(authPasswordRecoveryTokens);
    await db.insert(authPasswordRecoveryTokens).values(original);
    expect((await consumePasswordRecovery(writers[0], authority, reset(plan.token))).outcome).toBe(
      'invalid_or_expired',
    );
    expect(
      (await db.select().from(authPasswordRecoveryState).where(eq(authPasswordRecoveryState.userId, user.id)))[0]
        .generation,
    ).toBe(2);
    expect(await db.select().from(authSubjectCutoffs)).toHaveLength(0);
  });
  it('accepts harmless same-UID case/trim normalization but not a true key change', async () => {
    const first = await issued();
    await db
      .update(users)
      .set({ email: `  ${first.user.email.toLowerCase()}  ` })
      .where(eq(users.id, first.user.id));
    expect((await consumePasswordRecovery(writers[0], authority, reset(first.plan.token))).outcome).toBe('reset');
    const second = await issued();
    await db
      .update(users)
      .set({ email: `different.${randomUUID()}@example.test` })
      .where(eq(users.id, second.user.id));
    expect((await consumePasswordRecovery(writers[0], authority, reset(second.plan.token))).outcome).toBe(
      'invalid_or_expired',
    );
  });
  it.each(['owner', 'ambiguous', 'member', 'deleted', 'credential'] as const)(
    'rejects changed %s without choosing or creating another owner',
    async (change) => {
      const { user, plan } = await issued();
      const sibling = await seed();
      if (change === 'owner')
        await db
          .update(authEmailReservations)
          .set({ ownerUserId: sibling.id })
          .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(user.email)));
      if (change === 'ambiguous')
        await db
          .update(authEmailReservations)
          .set({ state: 'blocked_ambiguous', ownerUserId: null })
          .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(user.email)));
      if (change === 'member')
        await db.delete(authEmailReservationMembers).where(eq(authEmailReservationMembers.userId, user.id));
      if (change === 'deleted') await db.delete(users).where(eq(users.id, user.id));
      if (change === 'credential') await db.delete(userCredentials).where(eq(userCredentials.userId, user.id));
      const reply = await consumePasswordRecovery(writers[0], authority, reset(plan.token)).catch(() => ({
        outcome: 'unavailable',
      }));
      expect(['invalid_or_expired', 'unavailable']).toContain(reply.outcome);
      expect((await receipt(plan.token)).consumedAt).toBeNull();
      expect((await credential(sibling.id)).passwordHash === originalHash).toBe(true);
      expect(await db.select().from(authSecurityMutationEvents)).toHaveLength(0);
    },
  );
  it.each(['hash', 'generation', 'purpose', 'binding'] as const)(
    'rechecks %s changes made during real bcrypt',
    async (change) => {
      const { user, plan } = await issued();
      const replacement = await bcrypt.hash('independently-changed-password', 4);
      const reply = await duringHash(reset(plan.token), async () => {
        if (change === 'hash')
          await db
            .update(userCredentials)
            .set({ passwordHash: replacement })
            .where(eq(userCredentials.userId, user.id));
        if (change === 'generation')
          await db
            .insert(authSubjectCutoffs)
            .values({ userId: user.id, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
        if (change === 'purpose')
          await db
            .update(authPasswordRecoveryState)
            .set({ generation: 2 })
            .where(eq(authPasswordRecoveryState.userId, user.id));
        if (change === 'binding')
          await db
            .update(authPasswordRecoveryTokens)
            .set({ expiresAt: new Date((await receipt(plan.token)).expiresAt.getTime() - 1) })
            .where(eq(authPasswordRecoveryTokens.tokenHash, digest(plan.token)));
      });
      expect(reply.outcome).toBe('invalid_or_expired');
      expect((await receipt(plan.token)).consumedAt).toBeNull();
      expect((await credential(user.id)).passwordHash === (change === 'hash' ? replacement : originalHash)).toBe(true);
    },
  );
  it('does not hold the global gate during bcrypt and captures input/authority before awaits', async () => {
    const { user, plan } = await issued();
    const command = reset(plan.token);
    const context = { ...authority };
    const reply = await duringHash(
      command,
      async () => {
        await db.transaction((transaction) => lockEnforcedProjection(transaction, authority));
        command.payload = {
          token: 'pr1_' + 'A'.repeat(43),
          password: 'hostile-change',
          confirmPassword: 'hostile-change',
        };
        context.expectedProjectionId = randomUUID();
      },
      context,
    );
    expect(reply.outcome).toBe('reset');
    expect(await bcrypt.compare(nextPassword, (await credential(user.id)).passwordHash)).toBe(true);
  });
  it('rechecks real DB expiry after an observed manifest lock wait', async () => {
    const { user, plan } = await issued();
    const [instant] = await admin(sql`SELECT floor(extract(epoch from clock_timestamp())*1000) AS milliseconds`);
    const deadline = Number(instant.milliseconds) + 2500;
    await db
      .update(authPasswordRecoveryTokens)
      .set({ issuedAt: new Date(deadline - 3600000), expiresAt: new Date(deadline) })
      .where(eq(authPasswordRecoveryTokens.tokenHash, digest(plan.token)));
    const locked = barrier();
    const release = barrier();
    const holder = db.transaction(async (transaction) => {
      await lockAuthorityGateExclusively(transaction);
      locked.resolve();
      await release.promise;
    });
    await bounded(locked.promise);
    const pending = consumePasswordRecovery(writers[0], authority, reset(plan.token));
    try {
      await waiting(pending);
      expect(
        (
          await admin(
            sql`SELECT clock_timestamp()<expires_at AS before FROM ${authPasswordRecoveryTokens} WHERE token_hash=${digest(plan.token)}`,
          )
        )[0]?.before,
      ).toBe(true);
      await poll(
        async () =>
          (
            await admin(
              sql`SELECT clock_timestamp()>=expires_at AS expired FROM ${authPasswordRecoveryTokens} WHERE token_hash=${digest(plan.token)}`,
            )
          )[0]?.expired === true,
        pending,
      );
    } catch (error) {
      release.resolve();
      await bounded(Promise.allSettled([holder, pending]), 10000);
      throw error;
    } finally {
      release.resolve();
      await holder;
    }
    expect((await pending).outcome).toBe('invalid_or_expired');
    expect((await credential(user.id)).passwordHash === originalHash).toBe(true);
    expect((await receipt(plan.token)).consumedAt).toBeNull();
  });
  it('rejects expiry at the final redemption gate after real bcrypt and an observed lock wait', async () => {
    const { user, plan } = await issued();
    const [instant] = await admin(sql`SELECT floor(extract(epoch from clock_timestamp())*1000) AS milliseconds`);
    const deadline = Number(instant.milliseconds) + 7000;
    await db
      .update(authPasswordRecoveryTokens)
      .set({ issuedAt: new Date(deadline - 3600000), expiresAt: new Date(deadline) })
      .where(eq(authPasswordRecoveryTokens.tokenHash, digest(plan.token)));
    const reply = await duringHash(reset(plan.token), async (pending, resume) => {
      // Real bcrypt ran first and slows under load. Spend what it left here, so the
      // lock-wait window below is the same 1.5 s on any machine.
      await poll(
        async () =>
          (
            await admin(
              sql`SELECT clock_timestamp()>=expires_at - interval '1500 milliseconds' AS near FROM ${authPasswordRecoveryTokens} WHERE token_hash=${digest(plan.token)}`,
            )
          )[0]?.near === true,
        pending,
        8000,
      );
      const locked = barrier();
      const release = barrier();
      const holder = db.transaction(async (transaction) => {
        await lockAuthorityGateExclusively(transaction);
        locked.resolve();
        await release.promise;
      });
      try {
        await bounded(locked.promise);
        resume();
        await waiting(pending);
        expect(
          (
            await admin(
              sql`SELECT clock_timestamp()<expires_at AS before FROM ${authPasswordRecoveryTokens} WHERE token_hash=${digest(plan.token)}`,
            )
          )[0]?.before,
        ).toBe(true);
        await poll(
          async () =>
            (
              await admin(
                sql`SELECT clock_timestamp()>=expires_at AS expired FROM ${authPasswordRecoveryTokens} WHERE token_hash=${digest(plan.token)}`,
              )
            )[0]?.expired === true,
          pending,
        );
      } finally {
        release.resolve();
        await holder;
      }
    });
    expect(reply.outcome).toBe('invalid_or_expired');
    expect((await credential(user.id)).passwordHash === originalHash).toBe(true);
    expect((await receipt(plan.token)).consumedAt).toBeNull();
    expect(await db.select().from(authSecurityMutationEvents)).toHaveLength(0);
  }, 20000);
  it('does not revive an expired active receipt when a new forgot replaces it', async () => {
    const { user, plan } = await issued();
    const deadline = Date.now() - 1000;
    await db
      .update(authPasswordRecoveryTokens)
      .set({ issuedAt: new Date(deadline - 3600000), expiresAt: new Date(deadline) })
      .where(eq(authPasswordRecoveryTokens.tokenHash, digest(plan.token)));
    const next = await requestPasswordRecovery(writers[0], authority, forgot(user.email));
    if (next.outcome !== 'accepted' || !next.mailPlan) throw new Error('Missing replacement after expiry');
    expect((await receipt(plan.token)).supersededAt).not.toBeNull();
    expect((await consumePasswordRecovery(writers[0], authority, reset(plan.token))).outcome).toBe(
      'invalid_or_expired',
    );
    expect((await consumePasswordRecovery(writers[0], authority, reset(next.mailPlan.token))).outcome).toBe('reset');
  });
  it('denies a durable deleted cutoff even while the old UID and credential still exist', async () => {
    const { user, plan } = await issued();
    await db.insert(authSubjectCutoffs).values({
      userId: user.id,
      generation: 0,
      revokedThrough: new Date(),
      deletedAt: new Date(),
      lastOperationId: randomUUID(),
    });
    expect((await consumePasswordRecovery(writers[0], authority, reset(plan.token))).outcome).toBe(
      'invalid_or_expired',
    );
    const next = await requestPasswordRecovery(writers[0], authority, forgot(user.email));
    expect(next).toMatchObject({ outcome: 'accepted' });
    expect('mailPlan' in next).toBe(false);
    expect((await credential(user.id)).passwordHash === originalHash).toBe(true);
    expect((await receipt(plan.token)).consumedAt).toBeNull();
  });
  it('retains the committed reset when a caller discards its reply, and never acknowledges it again', async () => {
    const { user, plan } = await issued();
    const command = reset(plan.token);
    const first = await rpc(command);
    expect(first.status).toBe(200);
    await first.body?.cancel();
    expect(await bcrypt.compare(nextPassword, (await credential(user.id)).passwordHash)).toBe(true);
    const replay = await rpc(command);
    expect(replay.status).toBe(409);
    expect(resetPasswordReplySchema.parse(await replay.json())).toMatchObject({ outcome: 'error', code: 'replayed' });
    expect((await consumePasswordRecovery(writers[0], authority, reset(plan.token))).outcome).toBe(
      'invalid_or_expired',
    );
    expect(await db.select().from(authSecurityMutationEvents)).toHaveLength(1);
  });
  it('rolls every write back after a real final refresh CHECK failure, then permits a fresh retry', async () => {
    const { user, plan } = await issued();
    await db.insert(mobileRefreshTokens).values({
      userId: user.id,
      tokenHash: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 86400000),
    });
    const before = await snapshot(user.id, plan.token);
    const command = reset(plan.token);
    const constraint = 'owned_recovery_refresh_failure';
    await admin(
      sql`ALTER TABLE ${mobileRefreshTokens} ADD CONSTRAINT ${sql.identifier(constraint)} CHECK(revoked_at IS NULL)`,
    );
    try {
      let failure: unknown;
      try {
        await consumePasswordRecovery(writers[0], authority, command);
      } catch (error) {
        failure = error;
      }
      expect(failureDetails(failure)).toEqual({ code: '23514', constraint });
      expect(await snapshot(user.id, plan.token)).toEqual(before);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      const response = await rpc(reset(plan.token));
      expect(response.status).toBe(503);
      expect(resetPasswordReplySchema.parse(await response.json())).toMatchObject({
        outcome: 'error',
        code: 'unavailable',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(plan.token);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(user.email);
      expect(error).not.toHaveBeenCalled();
      expect(await snapshot(user.id, plan.token)).toEqual(before);
    } finally {
      await admin(sql`ALTER TABLE ${mobileRefreshTokens} DROP CONSTRAINT ${sql.identifier(constraint)}`);
    }
    expect((await consumePasswordRecovery(writers[0], authority, command)).outcome).toBe('reset');
  });
  it('revokes a rotated refresh row whose insert is uncommitted when the reset starts', async () => {
    const { user, plan } = await issued();
    const refreshToken = await seedRefreshToken(user.id);
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    __resetNativeAuthStateForTests();
    const rotated = barrier();
    const commitRotation = barrier();
    const runTransaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(((work, config) =>
      runTransaction(async (transaction) => {
        const outcome = await work(transaction);
        rotated.resolve();
        await commitRotation.promise;
        return outcome;
      }, config)) as typeof db.transaction);
    const refresh = refreshOverHandler(refreshToken);
    let resetReply: ResetPasswordReply;
    try {
      await bounded(rotated.promise);
      expect(await liveRefreshRows(user.id)).toEqual({ total: 1, live: 1 });
      // The rotation's admission lock holds the users row with FOR KEY SHARE, so
      // the reset cannot reach its refresh revocation until the rotation commits.
      resetReply = await duringHash(reset(plan.token), async (pending, resume) => {
        resume();
        try {
          await waiting(pending);
        } finally {
          commitRotation.resolve();
        }
      });
    } finally {
      commitRotation.resolve();
    }
    expect(await bounded(refresh)).toBe(200);
    expect(resetReply.outcome).toBe('reset');
    expect(await liveRefreshRows(user.id)).toEqual({ total: 2, live: 0 });
  }, 15000);
  it('makes a rotation wait out the reset on the users row, then refuses its revoked refresh row', async () => {
    const { user, plan } = await issued();
    const refreshToken = await seedRefreshToken(user.id);
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    __resetNativeAuthStateForTests();
    // Parks the reset after it locks the users row and before it revokes.
    const stateLocked = barrier();
    const releaseState = barrier();
    const stateHolder = db.transaction(async (transaction) => {
      await transaction
        .select()
        .from(authPasswordRecoveryState)
        .where(eq(authPasswordRecoveryState.userId, user.id))
        .for('update');
      stateLocked.resolve();
      await releaseState.promise;
    });
    await bounded(stateLocked.promise);
    let refresh: Promise<number> | undefined;
    const resetReply = await bounded(
      duringHash(reset(plan.token), async (pending, resume) => {
        try {
          resume();
          await waiting(pending);
          refresh = refreshOverHandler(refreshToken);
          // The rotation blocks before it touches any refresh row.
          await refreshWaitingOnUsersKeyShare(refresh);
          expect(await liveRefreshRows(user.id)).toEqual({ total: 1, live: 1 });
        } finally {
          releaseState.resolve();
        }
      }),
      12000,
    );
    await stateHolder;
    expect(resetReply.outcome).toBe('reset');
    expect(await bounded(refresh!, 9000)).toBe(401);
    expect(await liveRefreshRows(user.id)).toEqual({ total: 1, live: 0 });
  }, 15000);
  it('invalidates an older UID verification receipt through the committed subject generation', async () => {
    const { user, plan } = await issued();
    const verification = await db.transaction((transaction) => issueEmailVerification(transaction, authority, user.id));
    if (!verification) throw new Error('Missing verification proof');
    await consumePasswordRecovery(writers[0], authority, reset(plan.token));
    const reply = await consumeEmailVerification(db, authority, {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'verify-email',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { token: verification.token },
    });
    expect(reply.outcome).toBe('invalid_token');
  });
  it('keeps absent, OAuth-only and ambiguous forgot outcomes generic and sends no plan', async () => {
    const oauth = await seed(undefined, false);
    const ambiguous = await seed();
    await db
      .update(authEmailReservations)
      .set({ state: 'blocked_ambiguous', ownerUserId: null })
      .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(ambiguous.email)));
    for (const email of ['absent@example.test', oauth.email, ambiguous.email]) {
      const reply = await requestPasswordRecovery(writers[0], authority, forgot(email));
      expect(reply.outcome).toBe('accepted');
      expect('mailPlan' in reply).toBe(false);
    }
    expect(await db.select().from(authPasswordRecoveryTokens)).toHaveLength(0);
  });
  it('preserves live arbitrary legacy secrets and original long deadlines across address reassignment and new issuance', async () => {
    const user = await seed();
    const token = 'historical-opaque-token';
    const legacy = {
      identifier: `password-reset:${user.email}`,
      token: createHash('sha256').update(token).digest('hex'),
      expires: new Date(Date.now() + 7 * 86400000),
    };
    await db.insert(verificationTokens).values(legacy);
    await db.delete(users).where(eq(users.id, user.id));
    await db.delete(authEmailReservationMembers).where(eq(authEmailReservationMembers.userId, user.id));
    await db
      .delete(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(user.email)));
    const replacement = await seed(user.email);
    await requestPasswordRecovery(writers[0], authority, forgot(replacement.email));
    const response = await rpc(reset(token, user.email));
    expect(response.status).toBe(503);
    expect(resetPasswordReplySchema.parse(await response.json()).outcome).toBe('legacy_unbound');
    expect(
      await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, legacy.identifier)),
    ).toEqual([legacy]);
    expect((await credential(replacement.id)).passwordHash === originalHash).toBe(true);
  });
  it('classifies expired legacy rows read-only and never consumes wrong-purpose records', async () => {
    const email = 'legacy@example.test';
    const token = randomUUID();
    const hash = createHash('sha256').update(token).digest('hex');
    const rows = [
      { identifier: `password-reset:${email}`, token: hash, expires: new Date(Date.now() - 1000) },
      { identifier: email, token: hash, expires: new Date(Date.now() + 86400000) },
    ];
    await db.insert(verificationTokens).values(rows);
    expect((await consumePasswordRecovery(writers[0], authority, reset(token, email))).outcome).toBe(
      'invalid_or_expired',
    );
    for (const row of rows)
      expect(
        await db
          .select()
          .from(verificationTokens)
          .where(and(eq(verificationTokens.identifier, row.identifier), eq(verificationTokens.token, row.token))),
      ).toEqual([row]);
  });
  it.each(['pr2_' + 'A'.repeat(300), 'pr2_' + 'A'.repeat(43), 'historical'.repeat(40)])(
    'returns unavailable for unsupported format without legacy lookup or mutations',
    async (token) => {
      const reply = await consumePasswordRecovery(writers[0], authority, reset(token));
      expect(reply).toMatchObject({ outcome: 'error', code: 'unavailable' });
      expect(await db.select().from(authPasswordRecoveryTokens)).toHaveLength(0);
    },
  );
  it('rejects same request ID and changed payload without a second mutation', async () => {
    const { plan } = await issued();
    const command = reset(plan.token);
    expect((await consumePasswordRecovery(writers[0], authority, command)).outcome).toBe('reset');
    expect(
      await consumePasswordRecovery(writers[1], authority, {
        ...command,
        payload: { token: 'pr1_' + 'B'.repeat(43), password: nextPassword, confirmPassword: nextPassword },
      }),
    ).toMatchObject({ outcome: 'error', code: 'replayed' });
    expect(await db.select().from(authSecurityMutationEvents)).toHaveLength(1);
  });
  it('rejects old or missing body version and operation/path mismatch before any nonce or recovery write', async () => {
    for (const protocolVersion of [undefined, 1])
      for (const operation of ['forgot-password', 'reset-password'] as const) {
        const command =
          operation === 'forgot-password' ? forgot('absent@example.test') : reset('pr1_' + 'A'.repeat(43));
        const response = await rpc({ ...command, protocolVersion });
        expect(response.status).toBe(400);
      }
    expect((await rpc(forgot('absent@example.test'), 0, AUTH_COMMAND_PATHS['reset-password'])).status).toBe(400);
    expect(await db.select().from(verificationTokens)).toHaveLength(0);
    expect(await db.select().from(authPasswordRecoveryState)).toHaveLength(0);
  });
  it('keeps disabled, unsafe logging and denied reads unavailable without fallback or private diagnostics', async () => {
    const { user, plan } = await issued();
    const before = await snapshot(user.id, plan.token);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    expect((await rpc(reset(plan.token))).status).toBe(404);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('DEBUG_SQL', 'true');
    expect((await rpc(reset(plan.token))).status).toBe(503);
    vi.stubEnv('DEBUG_SQL', 'false');
    await admin(sql`REVOKE SELECT ON TABLE ${authPasswordRecoveryTokens} FROM ${sql.identifier(role)}`);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      expect((await rpc(reset(plan.token))).status).toBe(503);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(plan.token);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(user.email);
      expect(error).not.toHaveBeenCalled();
      expect(await snapshot(user.id, plan.token)).toEqual(before);
    } finally {
      await admin(sql`GRANT SELECT ON TABLE ${authPasswordRecoveryTokens} TO ${sql.identifier(role)}`);
    }
  });
  it('rejects stale key basis as unavailable before any guessed occupied-owner success', async () => {
    const { user, plan } = await issued();
    const old = await db.select().from(authEmailProjection);
    const priorId = randomUUID();
    await db.insert(authEmailProjection).values({ ...old[0], projectionId: priorId, isCurrent: false });
    await db
      .update(authEmailReservations)
      .set({ basisProjectionId: priorId })
      .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(user.email)));
    expect((await rpc(forgot(user.email))).status).toBe(503);
    expect((await rpc(reset(plan.token))).status).toBe(503);
    expect((await receipt(plan.token)).consumedAt).toBeNull();
  });
  it('rolls back expired generic forgot outcomes after actual key and user lock waits', async () => {
    for (const branch of ['blocked-key', 'credential-less-user'] as const) {
      const user = await seed(undefined, false);
      if (branch === 'blocked-key')
        await db
          .update(authEmailReservations)
          .set({ state: 'blocked_ambiguous', ownerUserId: null })
          .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(user.email)));
      const locked = barrier();
      const release = barrier();
      const holder = db.transaction(async (transaction) => {
        if (branch === 'blocked-key')
          await transaction
            .select()
            .from(authEmailReservations)
            .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(user.email)))
            .for('update');
        else await transaction.select().from(users).where(eq(users.id, user.id)).for('update');
        locked.resolve();
        await release.promise;
      });
      await bounded(locked.promise);
      const command = forgot(user.email);
      const pending = requestPasswordRecovery(writers[0], authority, command).catch((error: unknown) => error);
      try {
        await waiting(pending);
        vi.spyOn(Date, 'now').mockReturnValue(command.issuedAt + AUTH_COMMAND_MAX_AGE_MS + 1);
      } catch (error) {
        release.resolve();
        await bounded(Promise.allSettled([holder, pending]), 10000);
        // A poll stalled past the 250 ms user-row limit sees the command end first; the
        // checks below still require a fail-closed code and no committed recovery state.
        if (branch === 'blocked-key' || getPostgresErrorCode(await pending) !== '55P03') throw error;
      } finally {
        release.resolve();
        await holder;
      }
      let outcome: unknown;
      try {
        outcome = await bounded(pending);
      } finally {
        vi.restoreAllMocks();
      }
      // Only the user-row wait is limited to 250 ms; a stalled runner can reach that first.
      expect(branch === 'blocked-key' ? ['expired_request'] : ['expired_request', '55P03']).toContain(
        getPostgresErrorCode(outcome),
      );
      expect(await db.select().from(verificationTokens)).toHaveLength(0);
      expect(await db.select().from(authPasswordRecoveryState)).toHaveLength(0);
      expect(await db.select().from(authPasswordRecoveryTokens)).toHaveLength(0);
    }
  });

  /** A link the old web route sent: `password-reset:<exact address>` and the SHA-256 of its secret. */
  async function legacyResetLink(email: string, remainingMs = 30 * 60_000) {
    const token = randomUUID();
    const row = {
      identifier: `password-reset:${email}`,
      token: createHash('sha256').update(token).digest('hex'),
      expires: new Date(Date.now() + remainingMs),
    };
    await db.insert(verificationTokens).values(row);
    return { token, row };
  }
  async function legacyRow(identifier: string) {
    return db.select().from(verificationTokens).where(eq(verificationTokens.identifier, identifier));
  }

  it('answers a known and an unknown address alike when the digest key is missing', async () => {
    const known = await seed();
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', '');
    vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const replies = [];
    for (const email of [known.email, `unknown.${randomUUID()}@example.test`]) {
      const response = await rpc(forgot(email));
      replies.push({ status: response.status, body: await response.json() });
    }
    expect(replies[0]).toEqual(replies[1]);
    expect(replies[0].status).toBe(503);
    expect(await db.select().from(authPasswordRecoveryTokens)).toEqual([]);
  });

  /** One index that is not BA-02's: each must leave a live link unbound. */
  const notUniqueness: readonly (readonly [string, SQL])[] = [
    [
      'a partial unique index',
      sql`CREATE UNIQUE INDEX users_email_lower_key ON ${users} (lower(email)) WHERE email <> ''`,
    ],
    ['a non-unique index', sql`CREATE INDEX users_email_lower_key ON ${users} (lower(email))`],
  ];
  it.each(notUniqueness)('leaves a live link unbound behind %s', async (_kind, create) => {
    const user = await seed();
    const link = await legacyResetLink(user.email);
    await admin(create);
    try {
      expect((await consumePasswordRecovery(writers[0], authority, reset(link.token, user.email))).outcome).toBe(
        'legacy_unbound',
      );
    } finally {
      await admin(sql`DROP INDEX IF EXISTS users_email_lower_key`);
    }
    expect((await credential(user.id)).passwordHash).toBe(originalHash);
  });
  it('leaves a live link unbound behind an invalid index a failed concurrent build left', async () => {
    const user = await seed();
    const link = await legacyResetLink(user.email);
    // BA-02 builds the index CONCURRENTLY; a duplicate makes that build fail and leave it invalid (and unready).
    const duplicate = randomUUID();
    await db.insert(users).values({ id: duplicate, email: normalizeAccountEmail(user.email), name: 'Owned duplicate' });
    await expect(
      db.execute(sql`CREATE UNIQUE INDEX CONCURRENTLY users_email_lower_key ON ${users} (lower(email))`),
    ).rejects.toThrow();
    await db.delete(users).where(eq(users.id, duplicate));
    try {
      const [state] = await admin(
        sql`SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.users_email_lower_key')`,
      );
      expect(state).toMatchObject({ indisvalid: false });
      expect((await consumePasswordRecovery(writers[0], authority, reset(link.token, user.email))).outcome).toBe(
        'legacy_unbound',
      );
    } finally {
      await admin(sql`DROP INDEX IF EXISTS users_email_lower_key`);
    }
    expect((await credential(user.id)).passwordHash).toBe(originalHash);
  });

  it('leaves a live link unbound behind a built but not yet validated index', async () => {
    const user = await seed();
    const link = await legacyResetLink(user.email);
    await admin(sql`CREATE UNIQUE INDEX users_email_lower_key ON ${users} (lower(email))`);
    try {
      // The state a concurrent build is in between its build and validation passes.
      await admin(
        sql`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('public.users_email_lower_key')`,
      );
      const [state] = await admin(
        sql`SELECT indisready, indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.users_email_lower_key')`,
      );
      expect(state).toMatchObject({ indisready: true, indisvalid: false });
      expect((await consumePasswordRecovery(writers[0], authority, reset(link.token, user.email))).outcome).toBe(
        'legacy_unbound',
      );
    } finally {
      await admin(sql`DROP INDEX IF EXISTS users_email_lower_key`);
    }
    expect((await credential(user.id)).passwordHash).toBe(originalHash);
  });

  it('leaves a live pre-switch link unbound until BA-02 makes addresses unique', async () => {
    const user = await seed();
    const link = await legacyResetLink(user.email);
    const response = await rpc(reset(link.token, user.email));
    expect(response.status).toBe(503);
    expect(resetPasswordReplySchema.parse(await response.json()).outcome).toBe('legacy_unbound');
    expect((await credential(user.id)).passwordHash).toBe(originalHash);
  });

  describe('a pre-switch link once BA-02 makes addresses unique', () => {
    beforeEach(async () => {
      await admin(sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON ${users} (lower(email))`);
    });
    afterEach(async () => {
      await admin(sql`DROP INDEX IF EXISTS users_email_lower_key`);
    });

    it('resets the one account holding its exact address, once, and leaves the old row alone', async () => {
      const user = await seed();
      await seedRefreshToken(user.id);
      const link = await legacyResetLink(user.email);
      const response = await rpc(reset(link.token, user.email));
      expect(response.status).toBe(200);
      expect(resetPasswordReplySchema.parse(await response.json()).outcome).toBe('reset');
      const changed = (await credential(user.id)).passwordHash;
      expect(await bcrypt.compare(nextPassword, changed)).toBe(true);
      expect((await db.select().from(authSecurityMutationEvents)).map((event) => [event.userId, event.kind])).toEqual([
        [user.id, 'password-reset'],
      ]);
      expect(await liveRefreshRows(user.id)).toEqual({ total: 1, live: 0 });
      expect(await legacyRow(link.row.identifier)).toEqual([link.row]);

      const replay = await consumePasswordRecovery(
        writers[0],
        authority,
        reset(link.token, user.email, 'another-owned-password'),
      );
      expect(replay.outcome).toBe('invalid_or_expired');
      expect((await credential(user.id)).passwordHash).toBe(changed);
    });

    it('rejects the link with any other address, even its own in another case', async () => {
      const owner = await seed();
      const other = await seed();
      const link = await legacyResetLink(owner.email);
      for (const email of [other.email, owner.email.toLowerCase(), owner.email.toUpperCase()])
        expect((await consumePasswordRecovery(writers[0], authority, reset(link.token, email))).outcome).toBe(
          'invalid_or_expired',
        );
      for (const id of [owner.id, other.id]) expect((await credential(id)).passwordHash).toBe(originalHash);
      expect(await db.select().from(authSecurityMutationEvents)).toEqual([]);
    });

    it('ends at its original deadline when that passes while the new password hashes', async () => {
      const user = await seed();
      const link = await legacyResetLink(user.email, 1500);
      const reply = await duringHash(reset(link.token, user.email), async (_pending, resume) => {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, link.row.expires.getTime() - Date.now() + 150)));
        resume();
      });
      expect(reply.outcome).toBe('invalid_or_expired');
      expect((await credential(user.id)).passwordHash).toBe(originalHash);
    });

    it('refuses a deadline longer than the hour the old route gave', async () => {
      const user = await seed();
      const link = await legacyResetLink(user.email, 2 * 3600_000);
      expect((await consumePasswordRecovery(writers[0], authority, reset(link.token, user.email))).outcome).toBe(
        'invalid_or_expired',
      );
      expect((await credential(user.id)).passwordHash).toBe(originalHash);
    });

    it('dies once a later reset has moved the account on', async () => {
      const { user, plan } = await issued();
      const link = await legacyResetLink(user.email);
      expect((await consumePasswordRecovery(writers[0], authority, reset(plan.token))).outcome).toBe('reset');
      const afterReset = (await credential(user.id)).passwordHash;
      expect(
        (await consumePasswordRecovery(writers[0], authority, reset(link.token, user.email, 'third-owned-password')))
          .outcome,
      ).toBe('invalid_or_expired');
      expect((await credential(user.id)).passwordHash).toBe(afterReset);
    });

    it.each([
      ['shared by a collision group', 'blocked_ambiguous', 'legacy_unbound'],
      ['retired by a deletion', 'blocked_deleted', 'invalid_or_expired'],
    ] as const)('binds nothing when the address is %s', async (_label, state, outcome) => {
      const user = await seed();
      const link = await legacyResetLink(user.email);
      await db
        .update(authEmailReservations)
        .set({ state, ownerUserId: null })
        .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(user.email)));
      expect((await consumePasswordRecovery(writers[0], authority, reset(link.token, user.email))).outcome).toBe(
        outcome,
      );
      expect((await credential(user.id)).passwordHash).toBe(originalHash);
    });
  });
});
