import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  authCommandReplySchema,
  registerReplySchema,
  passwordReplySchema,
  verifyEmailReplySchema,
  type AuthCommand,
  type RegisterCommand,
  type VerifyEmailCommand,
  type ResendVerificationCommand,
} from '@boardsesh/auth-protocol';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authEmailVerificationTokens,
  authEmailVerificationState,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { db } from '../../../db/client';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { normalizeAccountEmail } from '../../normalize-email';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, lockAuthorityGateExclusively } from '../foundation-context';
import { consumeEmailVerification, resendEmailVerification } from '../email-verification';
import { recordSecurityMutation } from '../security-mutations';
import { registerWebPassword, type WebPasswordAuthority } from '../web-password';

const salt = randomUUID().replaceAll('-', '');
const legacyRole = `ba03_ev_old_${salt}`;
const writerRole = `ba03_ev_new_${salt}`;
const rolePassword = randomBytes(32).toString('hex');
const rpcSecret = randomBytes(32).toString('base64url');
const trackedRoles: string[] = [];
const sockets = new Set<Socket>();
const password = 'owned-verification-password';
let writerPool: ReturnType<typeof postgres> | undefined;
let writer: DbInstance;
let server: Server | undefined;
let origin: string;
let authority: WebPasswordAuthority;
const digest = (token: string) => createHash('sha256').update(`email-verification-v1\0${token}`).digest('hex');

function registerCommand(email = `Mixed.${randomUUID()}+Tag@Example.TEST`): RegisterCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'register',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email, password },
  };
}
function verifyCommand(token: string, email?: string): VerifyEmailCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'verify-email',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { token, ...(email === undefined ? {} : { email }) },
  };
}
function resendCommand(email: string): ResendVerificationCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'resend-verification',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email },
  };
}
async function registered(email?: string) {
  const reply = await registerWebPassword(writer, authority, registerCommand(email));
  if (reply.outcome !== 'created' || !reply.requiresVerification)
    throw new Error('Owned registration did not issue its UID receipt');
  const [user] = await db.select().from(users).where(eq(users.id, reply.userId));
  if (!user) throw new Error('Owned registration has no user');
  return { user, mailPlan: reply.mailPlan };
}
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
    return transaction.execute(statement);
  });
}
async function rpc(command: AuthCommand | Record<string, unknown>, path?: string) {
  const operation = command.operation as keyof typeof AUTH_COMMAND_PATHS;
  return fetch(`${origin}${path ?? AUTH_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${rpcSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
}
async function receipt(token: string) {
  const [stored] = await db
    .select()
    .from(authEmailVerificationTokens)
    .where(eq(authEmailVerificationTokens.tokenHash, digest(token)));
  if (!stored) throw new Error('Missing owned verification receipt');
  return stored;
}
async function state(userId: string) {
  const [stored] = await db
    .select()
    .from(authEmailVerificationState)
    .where(eq(authEmailVerificationState.userId, userId));
  if (!stored) throw new Error('Missing owned verification purpose state');
  return stored;
}
async function verified(userId: string) {
  const [user] = await db.select({ emailVerified: users.emailVerified }).from(users).where(eq(users.id, userId));
  return user?.emailVerified ?? null;
}
function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function bounded(signal: Promise<unknown>, active?: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned verification wait deadline')), 3500);
      }),
      ...(active
        ? [
            active.then(() => {
              throw new Error('Owned command ended before its lock barrier');
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function poll(check: () => Promise<boolean>, active: Promise<unknown>) {
  let stopped = false;
  const pending = (async () => {
    while (!stopped) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  })();
  try {
    await bounded(pending, active);
  } finally {
    stopped = true;
    await Promise.allSettled([pending]);
  }
}
async function waitForWriterLock(active: Promise<unknown>) {
  await poll(async () => {
    const records = await admin(
      sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = ${writerRole} AND wait_event_type = 'Lock') AS waiting`,
    );
    return records[0]?.waiting === true;
  }, active);
}

describe('UID-bound email verification in the current PostgreSQL store', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    const ownedUrl = new URL(process.env.DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(ownedUrl.hostname) ||
      !ownedUrl.pathname.startsWith('/boardsesh_backend_test_w')
    ) {
      throw new Error('Verification fixture requires its owned local worker database');
    }
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(legacyRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      trackedRoles.push(legacyRole);
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(writerRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
      );
      trackedRoles.push(writerRole);
    });
    ownedUrl.username = writerRole;
    ownedUrl.password = rolePassword;
    writerPool = postgres(ownedUrl.toString(), {
      max: 3,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 5000, lock_timeout: 4000 },
    });
    writer = drizzle(writerPool);
    server = createServer((request, response) => {
      void handleCurrentStoreWebAuth(request, response, writer).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.requestTimeout = 9000;
    server.headersTimeout = 9000;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned verification HTTP failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await db.delete(authEmailVerificationTokens);
    await db.delete(authEmailVerificationState);
    await db.delete(verificationTokens);
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
      emailVerificationEnabled: true,
    };
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
      await transaction.execute(
        sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(legacyRole)}, ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${users}, ${userCredentials}, ${userProfiles}, ${verificationTokens} TO ${sql.identifier(legacyRole)}`,
      );
      await transaction.execute(
        sql`LOCK TABLE ${users}, ${userCredentials}, ${userProfiles}, ${verificationTokens} IN ACCESS EXCLUSIVE MODE`,
      );
      await transaction.execute(
        sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${userCredentials}, ${userProfiles}, ${verificationTokens} FROM ${sql.identifier(legacyRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${users}, ${userCredentials}, ${userProfiles}, ${verificationTokens}, ${authEmailVerificationTokens}, ${authEmailVerificationState}, ${authEmailProjection}, ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT ON TABLE ${authSecurityMutationEvents} TO ${sql.identifier(writerRole)}`,
      );
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'true');
    vi.stubEnv('DEBUG_SQL', 'false');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      if (server)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            for (const socket of sockets) socket.destroy();
            reject(new Error('Owned HTTP close deadline'));
          }, 3000);
          server!.close((error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          });
          server!.closeIdleConnections();
        });
    } catch {
      failures.push(new Error('Owned HTTP cleanup failed'));
    }
    try {
      if (writerPool) await writerPool.end({ timeout: 3 });
    } catch {
      failures.push(new Error('Owned writer cleanup failed'));
    }
    for (const role of trackedRoles) {
      try {
        const records = await admin(sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS present`);
        if (records[0]?.present === false) continue;
      } catch {
        failures.push(new Error('Owned role lookup cleanup failed'));
      }
      try {
        await admin(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${userCredentials}, ${userProfiles}, ${verificationTokens}, ${authEmailVerificationTokens}, ${authEmailVerificationState}, ${authEmailProjection}, ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs}, ${authSecurityMutationEvents} FROM ${sql.identifier(role)}`,
        );
      } catch {
        failures.push(new Error('Owned table grants cleanup failed'));
      }
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned schema grants cleanup failed'));
      }
      try {
        await admin(sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned verification fixture cleanup failed');
  });

  it('uses a real LOGIN role and private HTTP registration→UID verification→password verdict', async () => {
    const [actor] = await writer.execute(
      sql`SELECT current_user AS actor, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
    );
    expect(actor).toMatchObject({ actor: writerRole, superuser: false });
    const command = registerCommand();
    const registeredResponse = await rpc(command);
    expect(registeredResponse.status).toBe(201);
    const created = registerReplySchema.parse(await registeredResponse.json());
    if (created.outcome !== 'created' || !created.requiresVerification)
      throw new Error('Missing owned UID registration');
    const before = await rpc({
      protocolVersion: 2,
      operation: 'password',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { email: created.mailPlan.recipient, password },
    });
    const unverified = passwordReplySchema.parse(await before.json());
    expect(unverified.outcome).toBe('authenticated');
    if (unverified.outcome !== 'authenticated') throw new Error('Owned password did not authenticate');
    expect(unverified.verification).toEqual({ userId: created.userId, required: true, verified: false });
    const stored = await receipt(created.mailPlan.token);
    expect(stored.userId).toBe(created.userId);
    expect(stored.tokenHash).not.toBe(created.mailPlan.token);
    expect(stored.expiresAt.getTime() - stored.issuedAt.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(
      (await db.select().from(verificationTokens)).every((record) => record.token !== created.mailPlan.token),
    ).toBe(true);
    const verification = await rpc(verifyCommand(created.mailPlan.token, 'Other@example.test'));
    expect(verification.status).toBe(200);
    expect(verifyEmailReplySchema.parse(await verification.json()).outcome).toBe('verified');
    const after = await rpc({
      protocolVersion: 2,
      operation: 'password',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { email: created.mailPlan.recipient, password },
    });
    const authenticated = passwordReplySchema.parse(await after.json());
    if (authenticated.outcome !== 'authenticated') throw new Error('Owned verified password did not authenticate');
    expect(authenticated.verification).toEqual({ userId: created.userId, required: true, verified: true });
    expect(verification.headers.has('Set-Cookie')).toBe(false);
    expect(await db.select().from(authSubjectCutoffs)).toEqual([]);
    expect(await db.select().from(authSecurityMutationEvents)).toEqual([]);
  });

  it('allows exactly one concurrent consume and keeps the terminal purpose generation', async () => {
    const issued = await registered();
    const replies = await Promise.all([
      consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token)),
      consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token)),
    ]);
    expect(replies.map((reply) => reply.outcome).sort()).toEqual(['invalid_token', 'verified']);
    expect((await receipt(issued.mailPlan.token)).consumedAt).not.toBeNull();
    expect((await state(issued.user.id)).generation).toBe(2);
    expect(await verified(issued.user.id)).not.toBeNull();
  });
  it('supersedes the old receipt when resend commits before verification', async () => {
    const issued = await registered();
    const resent = await resendEmailVerification(writer, authority, resendCommand(issued.user.email));
    if (resent.outcome !== 'accepted' || !resent.mailPlan) throw new Error('Missing owned resend receipt');
    expect((await receipt(issued.mailPlan.token)).supersededAt).not.toBeNull();
    expect((await consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token))).outcome).toBe(
      'invalid_token',
    );
    expect((await consumeEmailVerification(writer, authority, verifyCommand(resent.mailPlan.token))).outcome).toBe(
      'verified',
    );
  });
  it('returns a generic no-mail resend when verification commits first', async () => {
    const issued = await registered();
    expect((await consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token))).outcome).toBe(
      'verified',
    );
    const originalGeneration = (await state(issued.user.id)).generation;
    const resent = await resendEmailVerification(writer, authority, resendCommand(issued.user.email));
    expect(resent.outcome).toBe('accepted');
    expect(resent).not.toHaveProperty('mailPlan');
    expect((await state(issued.user.id)).generation).toBe(originalGeneration);
  });
  it('serializes a real resend/consume race to one valid ordering', async () => {
    const issued = await registered();
    const [resent, consumed] = await Promise.all([
      resendEmailVerification(writer, authority, resendCommand(issued.user.email)),
      consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token)),
    ]);
    expect(resent.outcome).toBe('accepted');
    if (resent.outcome !== 'accepted') throw new Error('Resend did not reach an authoritative outcome');
    if (consumed.outcome === 'verified') {
      expect(resent).not.toHaveProperty('mailPlan');
    } else {
      expect(consumed.outcome).toBe('invalid_token');
      if (!resent.mailPlan) throw new Error('Winning resend has no receipt');
      expect((await consumeEmailVerification(writer, authority, verifyCommand(resent.mailPlan.token))).outcome).toBe(
        'verified',
      );
    }
    expect(await verified(issued.user.id)).not.toBeNull();
  });
  it('keeps absent, ambiguous and disabled-policy resend outcomes generic without issuance', async () => {
    const absent = await resendEmailVerification(writer, authority, resendCommand('absent@example.test'));
    expect(absent.outcome).toBe('accepted');
    expect(absent).not.toHaveProperty('mailPlan');
    const issued = await registered();
    const other = await registered();
    const original = await receipt(issued.mailPlan.token);
    const originalState = await state(issued.user.id);
    await db
      .insert(authEmailReservationMembers)
      .values({ normalizedEmail: original.normalizedEmail, userId: other.user.id });
    const ambiguous = await resendEmailVerification(writer, authority, resendCommand(issued.user.email));
    expect(ambiguous.outcome).toBe('accepted');
    expect(ambiguous).not.toHaveProperty('mailPlan');
    const disabled = await resendEmailVerification(
      writer,
      { ...authority, emailVerificationEnabled: false },
      resendCommand(other.user.email),
    );
    expect(disabled.outcome).toBe('accepted');
    expect(disabled).not.toHaveProperty('mailPlan');
    expect(await receipt(issued.mailPlan.token)).toEqual(original);
    expect(await state(issued.user.id)).toEqual(originalState);
  });
  it('supersedes even an expired active row before inserting its successor', async () => {
    const issued = await registered();
    const now = Date.now();
    await db
      .update(authEmailVerificationTokens)
      .set({ issuedAt: new Date(now - 48 * 3600_000), expiresAt: new Date(now - 24 * 3600_000) })
      .where(eq(authEmailVerificationTokens.tokenHash, digest(issued.mailPlan.token)));
    const resent = await resendEmailVerification(writer, authority, resendCommand(issued.user.email));
    if (resent.outcome !== 'accepted' || !resent.mailPlan)
      throw new Error('Expired active receipt blocked its successor');
    expect((await receipt(issued.mailPlan.token)).supersededAt).not.toBeNull();
    expect((await receipt(resent.mailPlan.token)).supersededAt).toBeNull();
    expect((await consumeEmailVerification(writer, authority, verifyCommand(resent.mailPlan.token))).outcome).toBe(
      'verified',
    );
  });
  it('rejects an unconsumed old snapshot after terminal receipt cleanup and reinsertion', async () => {
    const issued = await registered();
    const oldSnapshot = await receipt(issued.mailPlan.token);
    expect((await consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token))).outcome).toBe(
      'verified',
    );
    await db
      .delete(authEmailVerificationTokens)
      .where(eq(authEmailVerificationTokens.tokenHash, oldSnapshot.tokenHash));
    expect((await state(issued.user.id)).generation).toBe(2);
    await db.update(users).set({ emailVerified: null }).where(eq(users.id, issued.user.id));
    await db.insert(authEmailVerificationTokens).values(oldSnapshot);
    expect((await consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token))).outcome).toBe(
      'invalid_token',
    );
    expect(await verified(issued.user.id)).toBeNull();
    expect((await state(issued.user.id)).generation).toBe(2);
  });
  it('accepts the same UID and normalized key after a stored case/trim change without changing original delivery', async () => {
    const issued = await registered();
    await db
      .update(users)
      .set({ email: ` \t${issued.user.email.toUpperCase()}\u00a0` })
      .where(eq(users.id, issued.user.id));
    const response = await consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token));
    expect(response.outcome).toBe('verified');
    expect((await receipt(issued.mailPlan.token)).deliveredEmail).toBe(issued.mailPlan.recipient);
    expect((await receipt(issued.mailPlan.token)).normalizedEmail).toBe(normalizeAccountEmail(issued.user.email));
  });
  it.each(['email-key', 'reservation-owner', 'ambiguous-members', 'security-generation', 'deleted'] as const)(
    'rejects changed lifecycle binding %s without verifying another user',
    async (change) => {
      const issued = await registered();
      const other = await registered();
      const key = normalizeAccountEmail(issued.user.email);
      if (change === 'email-key')
        await db
          .update(users)
          .set({ email: `changed.${randomUUID()}@example.test` })
          .where(eq(users.id, issued.user.id));
      if (change === 'reservation-owner')
        await db
          .update(authEmailReservations)
          .set({ ownerUserId: other.user.id })
          .where(eq(authEmailReservations.normalizedEmail, key));
      if (change === 'ambiguous-members')
        await db.insert(authEmailReservationMembers).values({ normalizedEmail: key, userId: other.user.id });
      if (change === 'security-generation' || change === 'deleted')
        await db.transaction(async (transaction) => {
          await recordSecurityMutation(transaction, {
            ...authority,
            operationId: randomUUID(),
            userId: issued.user.id,
            expectedGeneration: 0,
            kind: change === 'deleted' ? 'account-deletion' : 'password-reset',
            domains: ['first-party', 'partner'],
          });
          if (change === 'deleted') await transaction.delete(users).where(eq(users.id, issued.user.id));
        });
      const generation = (await state(issued.user.id)).generation;
      expect((await consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token))).outcome).toBe(
        'invalid_token',
      );
      expect(await verified(issued.user.id)).toBeNull();
      expect(await verified(other.user.id)).toBeNull();
      expect((await receipt(issued.mailPlan.token)).consumedAt).toBeNull();
      expect((await state(issued.user.id)).generation).toBe(generation);
      if (change === 'deleted')
        expect(
          (await db.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, issued.user.id)))[0]
            .deletedAt,
        ).not.toBeNull();
    },
  );
  it('preserves an existing verification timestamp without issuing security events', async () => {
    const issued = await registered();
    const existing = new Date('2020-01-02T03:04:05.000Z');
    await db.update(users).set({ emailVerified: existing }).where(eq(users.id, issued.user.id));
    expect((await consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token))).outcome).toBe(
      'verified',
    );
    expect(await verified(issued.user.id)).toEqual(existing);
    expect(await db.select().from(authSecurityMutationEvents)).toEqual([]);
  });
  it('rolls back receipt consumption, generation and nonce after the final user CHECK rejects verification', async () => {
    const issued = await registered();
    const beforeReceipt = await receipt(issued.mailPlan.token);
    const beforeState = await state(issued.user.id);
    const noncesBefore = await db.select().from(verificationTokens);
    const constraint = `ba03_ev_reject_verify_${salt}`;
    try {
      // A permission revoke would fail SELECT FOR UPDATE before consumption.
      // This owned fixture CHECK instead rejects the final actual user write.
      await admin(
        sql`ALTER TABLE ${users} ADD CONSTRAINT ${sql.identifier(constraint)} CHECK ("emailVerified" IS NULL)`,
      );
      await expect(
        consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token)),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint_name: constraint },
      });
      const response = await rpc(verifyCommand(issued.mailPlan.token));
      expect(response.status).toBe(503);
      expect(authCommandReplySchema.parse(await response.json())).toMatchObject({
        outcome: 'error',
        code: 'unavailable',
      });
    } finally {
      await admin(sql`ALTER TABLE ${users} DROP CONSTRAINT IF EXISTS ${sql.identifier(constraint)}`);
    }
    expect(await receipt(issued.mailPlan.token)).toEqual(beforeReceipt);
    expect(await state(issued.user.id)).toEqual(beforeState);
    expect(await db.select().from(verificationTokens)).toEqual(noncesBefore);
    expect(await verified(issued.user.id)).toBeNull();
    const retry = await rpc(verifyCommand(issued.mailPlan.token));
    expect(retry.status).toBe(200);
    expect(verifyEmailReplySchema.parse(await retry.json()).outcome).toBe('verified');
  });
  it('uses the PostgreSQL clock again after a verified manifest lock wait', async () => {
    const issued = await registered();
    const deadline = new Date(Date.now() + 2000);
    await db
      .update(authEmailVerificationTokens)
      .set({ issuedAt: new Date(deadline.getTime() - 24 * 3600_000), expiresAt: deadline })
      .where(eq(authEmailVerificationTokens.tokenHash, digest(issued.mailPlan.token)));
    const acquired = barrier();
    const release = barrier();
    const holding = db.transaction(async (transaction) => {
      await lockAuthorityGateExclusively(transaction);
      acquired.resolve();
      await release.promise;
    });
    let consuming: ReturnType<typeof consumeEmailVerification> | undefined;
    try {
      await bounded(acquired.promise, holding);
      consuming = consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token));
      await waitForWriterLock(consuming);
      const beforeDeadline = await admin(
        sql`SELECT clock_timestamp() < ${deadline.toISOString()}::timestamptz AS before_expiry`,
      );
      expect(beforeDeadline[0]?.before_expiry).toBe(true);
      await poll(async () => {
        const records = await admin(sql`SELECT clock_timestamp() >= ${deadline.toISOString()}::timestamptz AS expired`);
        return records[0]?.expired === true;
      }, consuming);
      release.resolve();
      await holding;
      expect((await consuming).outcome).toBe('expired');
      expect((await receipt(issued.mailPlan.token)).consumedAt).toBeNull();
      expect(await verified(issued.user.id)).toBeNull();
    } finally {
      release.resolve();
      await Promise.allSettled([holding, ...(consuming ? [consuming] : [])]);
    }
  });
  it('rejects an immutable subject binding changed after its initial lookup and before the gate opens', async () => {
    const issued = await registered();
    const other = await registered();
    const acquired = barrier();
    const release = barrier();
    const holding = db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
      await lockAuthorityGateExclusively(transaction);
      acquired.resolve();
      await release.promise;
    });
    let consuming: ReturnType<typeof consumeEmailVerification> | undefined;
    try {
      await bounded(acquired.promise, holding);
      consuming = consumeEmailVerification(writer, authority, verifyCommand(issued.mailPlan.token));
      await waitForWriterLock(consuming);
      // Fixture-only administrative corruption: normal issuance never edits
      // immutable binding columns. The original subject snapshot must win.
      await db
        .delete(authEmailVerificationTokens)
        .where(eq(authEmailVerificationTokens.tokenHash, digest(other.mailPlan.token)));
      await db
        .update(authEmailVerificationTokens)
        .set({ userId: other.user.id })
        .where(eq(authEmailVerificationTokens.tokenHash, digest(issued.mailPlan.token)));
      release.resolve();
      await holding;
      expect((await consuming).outcome).toBe('invalid_token');
      expect(await verified(issued.user.id)).toBeNull();
      expect(await verified(other.user.id)).toBeNull();
      expect((await state(issued.user.id)).generation).toBe(1);
      expect((await state(other.user.id)).generation).toBe(1);
      expect((await receipt(issued.mailPlan.token)).consumedAt).toBeNull();
    } finally {
      release.resolve();
      await Promise.allSettled([holding, ...(consuming ? [consuming] : [])]);
    }
  });
  it('captures authority and token input before waiting and cannot be retargeted to another owner', async () => {
    const issued = await registered();
    const other = await registered();
    const acquired = barrier();
    const release = barrier();
    const holding = db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
      await lockAuthorityGateExclusively(transaction);
      acquired.resolve();
      await release.promise;
    });
    const mutableAuthority = { ...authority };
    const command = verifyCommand(issued.mailPlan.token);
    const originalRequestId = command.requestId;
    let consuming: ReturnType<typeof consumeEmailVerification> | undefined;
    try {
      await bounded(acquired.promise, holding);
      consuming = consumeEmailVerification(writer, mutableAuthority, command);
      await waitForWriterLock(consuming);
      command.payload.token = other.mailPlan.token;
      command.payload.email = other.user.email;
      command.requestId = randomUUID();
      mutableAuthority.expectedProjectionId = randomUUID();
      mutableAuthority.expectedWriterEpoch = 99;
      release.resolve();
      await holding;
      expect(await consuming).toMatchObject({ outcome: 'verified', requestId: originalRequestId });
      expect(await verified(issued.user.id)).not.toBeNull();
      expect(await verified(other.user.id)).toBeNull();
      expect((await receipt(issued.mailPlan.token)).consumedAt).not.toBeNull();
      expect((await receipt(other.mailPlan.token)).consumedAt).toBeNull();
    } finally {
      release.resolve();
      await Promise.allSettled([holding, ...(consuming ? [consuming] : [])]);
    }
  });
  it.each(['3bd21fcb-89b4-4d9d-a4ad-ec9fdad684c7', 'old/arbitrary+secret=opaque?syntax'])(
    'classifies a seven-day legacy row without inventing a24h deadline or owner: %s',
    async (token) => {
      const email = `Legacy.${randomUUID()}@example.test`;
      const expires = new Date(Date.now() + 7 * 24 * 3600_000);
      await db.insert(verificationTokens).values({ identifier: email, token, expires });
      const original = (await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, email)))[0];
      let response = await rpc(verifyCommand(token, email));
      expect(response.status).toBe(503);
      expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe('legacy_unbound');
      // PostgreSQL remains the time authority. This is deliberately only an
      // application-clock jump, proving no inferred24h application deadline.
      const advanced = Date.now() + 25 * 3600_000;
      vi.spyOn(Date, 'now').mockReturnValue(advanced);
      response = await rpc(verifyCommand(token, email));
      expect(response.status).toBe(503);
      expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe('legacy_unbound');
      expect((await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, email)))[0]).toEqual(
        original,
      );
      expect(await db.select().from(authEmailVerificationTokens)).toEqual([]);
      expect(await db.select().from(users)).toEqual([]);
    },
  );
  it('classifies an expired old row read-only without resolving a current user', async () => {
    const email = `legacy.${randomUUID()}@example.test`;
    const token = 'legacy-expired-arbitrary';
    await db.insert(verificationTokens).values({ identifier: email, token, expires: new Date(Date.now() - 60_000) });
    const before = (await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, email)))[0];
    const response = await rpc(verifyCommand(token, email));
    expect(response.status).toBe(200);
    expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe('expired');
    expect((await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, email)))[0]).toEqual(
      before,
    );
  });
  it('classifies an unbound historical link with only SELECT and INSERT on the shared token table', async () => {
    const email = `select-only.${randomUUID()}@example.test`;
    const token = 'historical-select-only';
    await db
      .insert(verificationTokens)
      .values({ identifier: email, token, expires: new Date(Date.now() + 7 * 24 * 3600_000) });
    await admin(sql`REVOKE UPDATE, DELETE ON TABLE ${verificationTokens} FROM ${sql.identifier(writerRole)}`);
    try {
      const response = await rpc(verifyCommand(token, email));
      expect(response.status).toBe(503);
      expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe('legacy_unbound');
    } finally {
      await admin(sql`GRANT UPDATE, DELETE ON TABLE ${verificationTokens} TO ${sql.identifier(writerRole)}`);
    }
  });
  it('does not choose among current duplicate owners for an unbound historical link', async () => {
    const email = `duplicate.${randomUUID()}@example.test`;
    const token = 'historical-unbound-opaque';
    const owners = [randomUUID(), randomUUID()];
    await db.insert(users).values(owners.map((id) => ({ id, email, emailVerified: null })));
    await db
      .insert(verificationTokens)
      .values({ identifier: email, token, expires: new Date(Date.now() + 7 * 24 * 3600_000) });
    const response = await rpc(verifyCommand(token, email));
    expect(response.status).toBe(503);
    expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe('legacy_unbound');
    expect(await verified(owners[0])).toBeNull();
    expect(await verified(owners[1])).toBeNull();
    expect((await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, email)))[0].token).toBe(
      token,
    );
  });
  it('claims rejected reserved-purpose commands once without changing any submitted record or retargeting its ID', async () => {
    const issued = await registered();
    await db.insert(verificationTokens).values(
      ['password-reset:', 'ba03-flow:', 'ba03-lineage:'].map((prefix) => ({
        identifier: `${prefix}${issued.user.email}`,
        token: `protected-${prefix}opaque`,
        expires: new Date(Date.now() + 3600_000),
      })),
    );
    const before = await db.select().from(verificationTokens);
    let claimed = 0;
    for (const record of before) {
      const command = verifyCommand(record.token, record.identifier);
      const response = await rpc(command);
      expect(response.status).toBe(200);
      expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe('invalid_token');
      for (const repeated of [command, { ...command, payload: { token: issued.mailPlan.token } }]) {
        const replay = await rpc(repeated);
        expect(replay.status).toBe(409);
        expect(verifyEmailReplySchema.parse(await replay.json())).toMatchObject({
          outcome: 'error',
          code: 'replayed',
        });
      }
      const after = await db.select().from(verificationTokens);
      claimed += 1;
      expect(after).toHaveLength(before.length + claimed);
      for (const protectedRecord of before)
        expect(
          after.find(
            (candidate) =>
              candidate.identifier === protectedRecord.identifier && candidate.token === protectedRecord.token,
          ),
        ).toEqual(protectedRecord);
    }
    expect((await receipt(issued.mailPlan.token)).consumedAt).toBeNull();
    expect((await state(issued.user.id)).generation).toBe(1);
    expect(await verified(issued.user.id)).toBeNull();
  });
  it.each([
    ['ev1_short', 'invalid_token', 200],
    [`ev1_${'Z'.repeat(43)}`, 'invalid_token', 200],
    ['ev2_future', 'error', 503],
  ] as const)('never sends reserved token namespace %s through legacy lookup', async (token, outcome, status) => {
    const email = `namespace.${randomUUID()}@example.test`;
    await db.insert(verificationTokens).values({ identifier: email, token, expires: new Date(Date.now() + 3600_000) });
    const response = await rpc(verifyCommand(token, email));
    expect(response.status).toBe(status);
    expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe(outcome);
    expect((await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, email)))[0].token).toBe(
      token,
    );
    expect(await db.select().from(authEmailVerificationTokens)).toEqual([]);
  });
  it('retains an issued receipt when the backend consumer is disabled and consumes it after re-enabling', async () => {
    const issued = await registered();
    const before = await receipt(issued.mailPlan.token);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    const disabled = await rpc(verifyCommand(issued.mailPlan.token));
    expect(disabled.status).toBe(404);
    expect(await receipt(issued.mailPlan.token)).toEqual(before);
    expect(await verified(issued.user.id)).toBeNull();
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    const response = await rpc(verifyCommand(issued.mailPlan.token));
    expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe('verified');
  });
  it.each(['register', 'password', 'verify-email', 'resend-verification'] as const)(
    'rejects missing/v1 JSON versions and mismatched paths for %s before all command writes',
    async (operation) => {
      const payload =
        operation === 'password'
          ? { email: 'candidate@example.test', password }
          : operation === 'verify-email'
            ? { token: `ev1_${'A'.repeat(43)}` }
            : { email: 'candidate@example.test', password };
      for (const protocolVersion of [undefined, 1]) {
        const command = {
          operation,
          requestId: randomUUID(),
          issuedAt: Date.now(),
          payload,
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
        };
        const response = await rpc(command, AUTH_COMMAND_PATHS[operation]);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_request' });
      }
      const mismatched = { protocolVersion: 2, operation, requestId: randomUUID(), issuedAt: Date.now(), payload };
      const otherPath = operation === 'register' ? AUTH_COMMAND_PATHS.password : AUTH_COMMAND_PATHS.register;
      const response = await rpc(mismatched, otherPath);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
      expect(await db.select().from(users)).toEqual([]);
      expect(await db.select().from(verificationTokens)).toEqual([]);
      expect(await db.select().from(authEmailVerificationTokens)).toEqual([]);
      expect(await db.select().from(authEmailVerificationState)).toEqual([]);
      expect(await db.select().from(authEmailReservations)).toEqual([]);
    },
  );

  /** A link the old web route sent: the exact stored address and the raw secret. */
  async function legacyVerificationLink(email: string, remainingMs = 23 * 3600_000) {
    const row = { identifier: email, token: randomUUID(), expires: new Date(Date.now() + remainingMs) };
    await db.insert(verificationTokens).values(row);
    return row;
  }
  const legacyOutcome = async (token: string, email: string) =>
    (await consumeEmailVerification(writer, authority, verifyCommand(token, email))).outcome;

  it('leaves a live pre-switch link to one account unbound until BA-02 makes addresses unique', async () => {
    const { user } = await registered();
    const link = await legacyVerificationLink(user.email);
    const response = await rpc(verifyCommand(link.token, user.email));
    expect(response.status).toBe(503);
    expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe('legacy_unbound');
    expect(await verified(user.id)).toBeNull();
  });

  describe('a pre-switch link once BA-02 makes addresses unique', () => {
    beforeEach(async () => {
      await admin(sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON ${users} (lower(email))`);
    });
    afterEach(async () => {
      await admin(sql`DROP INDEX IF EXISTS users_email_lower_key`);
    });

    it('verifies the one account holding its exact address once, with only SELECT and INSERT on old links', async () => {
      const { user } = await registered();
      const link = await legacyVerificationLink(user.email);
      await admin(sql`REVOKE UPDATE, DELETE ON TABLE ${verificationTokens} FROM ${sql.identifier(writerRole)}`);
      try {
        const response = await rpc(verifyCommand(link.token, user.email));
        expect(response.status).toBe(200);
        expect(verifyEmailReplySchema.parse(await response.json()).outcome).toBe('verified');
        expect(await verified(user.id)).toBeInstanceOf(Date);
        expect(await legacyOutcome(link.token, user.email)).toBe('invalid_token');
      } finally {
        await admin(sql`GRANT UPDATE, DELETE ON TABLE ${verificationTokens} TO ${sql.identifier(writerRole)}`);
      }
      expect(
        await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, link.identifier)),
      ).toEqual([link]);
    });

    it('rejects the link with any other address, even its own in another case', async () => {
      const { user: owner } = await registered();
      const { user: other } = await registered();
      const link = await legacyVerificationLink(owner.email);
      for (const email of [other.email, owner.email.toLowerCase(), owner.email.toUpperCase()])
        expect(await legacyOutcome(link.token, email)).toBe('invalid_token');
      expect(await verified(owner.id)).toBeNull();
      expect(await verified(other.id)).toBeNull();
    });

    it('refuses a deadline longer than the 24 hours the old route gave', async () => {
      const { user } = await registered();
      const link = await legacyVerificationLink(user.email, 7 * 24 * 3600_000);
      expect(await legacyOutcome(link.token, user.email)).toBe('invalid_token');
      expect(await verified(user.id)).toBeNull();
    });

    it('ends at its original deadline', async () => {
      const { user } = await registered();
      const link = await legacyVerificationLink(user.email, -1000);
      expect(await legacyOutcome(link.token, user.email)).toBe('expired');
      expect(await verified(user.id)).toBeNull();
    });

    it('dies once a later security change has moved the account on', async () => {
      const { user } = await registered();
      const link = await legacyVerificationLink(user.email);
      await db.transaction((transaction) =>
        recordSecurityMutation(transaction, {
          ...authority,
          operationId: randomUUID(),
          userId: user.id,
          expectedGeneration: 0,
          kind: 'password-change',
          domains: ['first-party', 'partner'],
        }),
      );
      expect(await legacyOutcome(link.token, user.email)).toBe('invalid_token');
      expect(await verified(user.id)).toBeNull();
    });
  });
});
