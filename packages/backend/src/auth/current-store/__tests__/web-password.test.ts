import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { compare, getRounds, hash } from 'bcryptjs';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_MAX_AGE_MS,
  AUTH_PROTOCOL_VERSION,
  AUTH_COMMAND_PATHS,
  passwordReplySchema,
  registerReplySchema,
  type PasswordCommand,
  type RegisterCommand,
} from '@boardsesh/auth-protocol';
import {
  authEmailProjection,
  authEmailVerificationTokens,
  authEmailVerificationState,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { eq, lt, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../../../db/client';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import { checkRateLimit } from '../../../utils/rate-limiter';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { currentStoreWebAuthConfiguration, handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../foundation-context';
import { recordSecurityMutation } from '../security-mutations';
import { deleteExpiredCommandClaims } from '../command-context';
import { clearExpiredAuthRecords } from '../../../services/background-job-maintenance';
import { authenticateWebPassword, registerWebPassword, type WebPasswordAuthority } from '../web-password';

const comparison = vi.hoisted(() => ({ afterRealCompare: undefined as (() => Promise<void>) | undefined }));
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return {
    ...actual,
    compare: async (password: string, passwordHash: string) => {
      const matched = await actual.compare(password, passwordHash);
      await comparison.afterRealCompare?.();
      return matched;
    },
  };
});

const roleSalt = randomUUID().replaceAll('-', '');
const legacyRole = `ba03_web_old_${roleSalt}`;
const writerRole = `ba03_web_new_${roleSalt}`;
const rolePassword = randomBytes(32).toString('hex');
const rpcSecret = randomBytes(32).toString('base64url');
const trackedRoles: string[] = [];
const sockets = new Set<Socket>();
let server: Server | undefined;
let writerPool: ReturnType<typeof postgres> | undefined;
let writer: DbInstance;
let origin: string;
let authority: WebPasswordAuthority;
let originalHash: string;

function registerCommand(
  email = `${randomUUID()}@example.test`,
  password = 'web-registration-password',
  name?: string,
): RegisterCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'register',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email, password, ...(name !== undefined ? { name } : {}) },
  };
}
function passwordCommand(email: string, password = 'original-password'): PasswordCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email, password },
  };
}
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
    return transaction.execute(statement);
  });
}
async function seed(
  email = `${randomUUID()}@example.test`,
  passwordHash: string | null = originalHash,
  verified = true,
) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email,
    name: 'Owned synthetic user',
    emailVerified: verified ? new Date('2025-01-02T03:04:05Z') : null,
  });
  if (passwordHash) await db.insert(userCredentials).values({ userId: id, passwordHash });
  return { id, email };
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { resolve, promise };
}
async function bounded(signal: Promise<unknown>, active?: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned password barrier deadline')), 4000);
      }),
      ...(active
        ? [
            active.then(() => {
              throw new Error('Password command ended before barrier');
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function duringComparison(command: PasswordCommand, mutation: () => Promise<void>) {
  const entered = deferred();
  const release = deferred();
  comparison.afterRealCompare = async () => {
    entered.resolve();
    await release.promise;
  };
  const active = authenticateWebPassword(writer, authority, command);
  try {
    await bounded(entered.promise, active);
    await bounded(mutation());
    release.resolve();
    return await active;
  } finally {
    release.resolve();
    comparison.afterRealCompare = undefined;
    await Promise.allSettled([active]);
  }
}
async function rpc(
  command: RegisterCommand | PasswordCommand,
  headers: Record<string, string> = {},
  path = AUTH_COMMAND_PATHS[command.operation],
) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
}
async function nonceCount() {
  const rows = await db.select().from(verificationTokens);
  return rows.filter((record) => record.identifier.startsWith('ba03-web-auth:')).length;
}

async function actualWebClientProbe(email: string, password: string): Promise<unknown> {
  const require = createRequire(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      '--conditions=react-server',
      '--import',
      require.resolve('tsx'),
      fileURLToPath(new URL('./fixtures/web-password-client-probe.ts', import.meta.url)),
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../web/tsconfig.json', import.meta.url)),
      },
    },
  );
  let result: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Owned web client child failed to start')));
    child.on('message', (message: unknown) => {
      result = message;
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else {
        const phase =
          result &&
          typeof result === 'object' &&
          'phase' in result &&
          typeof result.phase === 'string' &&
          ['input', 'load', 'register', 'password', 'mail', 'public-verify'].includes(result.phase)
            ? result.phase
            : 'unknown';
        reject(new Error(`Owned web client probe failed during ${phase}`));
      }
    });
  });
  try {
    child.send({ origin, secret: rpcSecret, email, password });
    await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned web client probe deadline')), 18_000);
      }),
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled([completion]);
  }
}

describe('default-off staged web password commands against the current PostgreSQL store', () => {
  beforeAll(async () => {
    // SKIP_TEST_INFRA's shared setup logs and swallows initialization failures.
    // Never create cluster roles against a partially initialized fixture.
    await setupWorkerDatabase();
    const ownedUrl = new URL(process.env.DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(ownedUrl.hostname) ||
      !ownedUrl.pathname.startsWith('/boardsesh_backend_test_w')
    )
      throw new Error('Password fixture requires its owned local worker database');
    originalHash = await hash('original-password', 4);
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(legacyRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      trackedRoles.push(legacyRole);
      // Only generated hex enters this fixture-only role DDL (PostgreSQL role
      // PASSWORD utility syntax cannot bind a parameter). Never print it.
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
    if (!address || typeof address === 'string') throw new Error('Owned auth server failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    comparison.afterRealCompare = undefined;
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
      emailVerificationEnabled: false,
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
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
    vi.stubEnv('DEBUG_SQL', 'false');
  });
  afterAll(async () => {
    comparison.afterRealCompare = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    const failures: Error[] = [];
    try {
      if (server)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            for (const socket of sockets) socket.destroy();
            reject(new Error('Owned auth HTTP close deadline'));
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
      failures.push(new Error('Owned writer pool cleanup failed'));
    }
    for (const role of trackedRoles) {
      try {
        const records = await admin(sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS present`);
        if (records[0]?.present === false) continue;
      } catch {
        failures.push(new Error('Owned role catalog cleanup failed'));
      }
      try {
        await admin(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${userCredentials}, ${userProfiles}, ${verificationTokens}, ${authEmailVerificationTokens}, ${authEmailVerificationState}, ${authEmailProjection}, ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs} FROM ${sql.identifier(role)}`,
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
    if (failures.length) throw new AggregateError(failures, 'Owned staged web password cleanup failed');
  });

  it('creates raw web identity/profile with native bcrypt12 and normalized reservation over real authenticated HTTP', async () => {
    const email = `Web.Mixed.${randomUUID()}+Tag@Example.TEST`;
    const password = '  café 山🧗\u0000 password  ';
    const command = registerCommand(email, password, '  Raw Web Name  ');
    const response = await rpc(command);
    const reply = registerReplySchema.parse(await response.json());
    expect(response.status).toBe(201);
    expect(reply.outcome).toBe('created');
    if (reply.outcome !== 'created') throw new Error('Registration fixture failed');
    expect(reply.requiresVerification).toBe(false);
    expect('mailPlan' in reply).toBe(false);
    const [user] = await db.select().from(users);
    const [credential] = await db.select().from(userCredentials);
    const [profile] = await db.select().from(userProfiles);
    const [reservation] = await db.select().from(authEmailReservations);
    expect(user).toMatchObject({ id: reply.userId, email, name: '  Raw Web Name  ' });
    expect(user.emailVerified).toBeInstanceOf(Date);
    expect(profile.userId).toBe(reply.userId);
    expect(reservation).toMatchObject({ normalizedEmail: email.toLowerCase(), ownerUserId: reply.userId });
    expect(getRounds(credential.passwordHash)).toBe(12);
    expect(await compare(password, credential.passwordHash)).toBe(true);
    expect(await compare(password.trim(), credential.passwordHash)).toBe(false);
    const authentication = passwordReplySchema.parse(await (await rpc(passwordCommand(email, password))).json());
    expect(authentication).toMatchObject({
      outcome: 'authenticated',
      user: { id: reply.userId },
      verification: { userId: reply.userId, required: false, verified: true },
    });
    // BA-02: the same address in other capitals reaches the one account holding it.
    expect(
      await authenticateWebPassword(writer, authority, passwordCommand(email.toLowerCase(), password)),
    ).toMatchObject({ outcome: 'authenticated', user: { id: reply.userId } });
    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(legacyRole)}`);
        await transaction.insert(users).values({ id: randomUUID(), email: 'old-writer@example.test' });
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('binds a private24h mail plan to exact committed mixed-case email and leaves verification-required verdict UID-bound', async () => {
    authority = { ...authority, emailVerificationEnabled: true };
    const email = `Mail.Mixed.${randomUUID()}@Example.TEST`;
    const command = registerCommand(email);
    const before = Date.now();
    const reply = await registerWebPassword(writer, authority, command);
    expect(reply.outcome).toBe('created');
    if (reply.outcome !== 'created' || !reply.requiresVerification) throw new Error('Missing private mail fixture');
    expect(reply.mailPlan).toMatchObject({ kind: 'uid-email-verification-v1', recipient: email });
    const [receipt] = await db.select().from(authEmailVerificationTokens);
    expect(receipt.deliveredEmail).toBe(email);
    expect(receipt.expiresAt.toISOString()).toBe(reply.mailPlan.expiresAt);
    expect(receipt.expiresAt.getTime() - receipt.issuedAt.getTime()).toBe(86_400_000);
    expect(receipt.expiresAt.getTime() - before).toBeGreaterThan(86_395_000);
    expect(JSON.stringify(receipt).includes(reply.mailPlan.token)).toBe(false);
    const verdict = await authenticateWebPassword(
      writer,
      authority,
      passwordCommand(email, 'web-registration-password'),
    );
    expect(verdict).toMatchObject({
      outcome: 'authenticated',
      user: { id: reply.userId },
      verification: { userId: reply.userId, required: true, verified: false },
    });
    expect(receipt.userId).toBe(reply.userId);
  });

  it.each([
    [{ email: ' space@example.test ', password: 'long-enough' }, 'Invalid email address'],
    [{ email: 'valid@example.test', password: 'short' }, 'Password must be at least 8 characters'],
    [{ email: 'valid@example.test', password: 'x'.repeat(129) }, 'Password must be less than 128 characters'],
    [{ email: 'valid@example.test', password: 'long-enough', name: '' }, 'Name is required'],
    [
      { email: 'valid@example.test', password: 'long-enough', name: 'x'.repeat(101) },
      'Name must be less than 100 characters',
    ],
  ])(
    'preserves web registration validation and commits only its nonsecret replay outcome: %j',
    async (payload, message) => {
      const command = { ...registerCommand(), payload };
      expect(await registerWebPassword(writer, authority, command)).toMatchObject({
        outcome: 'error',
        code: 'validation_error',
        message,
      });
      expect(await db.select().from(users)).toEqual([]);
      expect(await nonceCount()).toBe(1);
      expect(await registerWebPassword(writer, authority, command)).toMatchObject({
        outcome: 'error',
        code: 'replayed',
      });
    },
  );

  it('allows whitespace-only supplied web names without native trimming', async () => {
    const reply = await registerWebPassword(writer, authority, registerCommand(undefined, undefined, '   '));
    expect(reply.outcome).toBe('created');
    const [user] = await db.select().from(users);
    expect(user.name).toBe('   ');
  });

  it('captures trusted authority and raw registration inputs before the first await', async () => {
    const payload = {
      email: `Captured.${randomUUID()}@Example.test`,
      password: 'original-registration-password',
      name: ' Original name ',
    };
    const originalEmail = payload.email;
    const context = { ...authority };
    const pending = registerWebPassword(writer, context, { ...registerCommand(), payload });
    payload.email = 'changed-after-await@example.test';
    payload.password = 'changed-after-await';
    payload.name = 'Changed';
    context.expectedProjectionId = randomUUID();
    context.emailVerificationEnabled = true;
    const reply = await pending;
    expect(reply).toMatchObject({ outcome: 'created', requiresVerification: false });
    const [user] = await db.select().from(users);
    const [credential] = await db.select().from(userCredentials);
    expect(user).toMatchObject({ email: originalEmail, name: ' Original name ' });
    expect(await compare('original-registration-password', credential.passwordHash)).toBe(true);
    expect(await compare(payload.password, credential.passwordHash)).toBe(false);
  });

  it('never accepts body-selected owner, verification policy or verification token', async () => {
    const victim = await seed();
    const context = { ...authority, emailVerificationEnabled: true };
    const payload = {
      email: `${randomUUID()}@example.test`,
      password: 'new-account-password',
      userId: victim.id,
      emailVerified: new Date().toISOString(),
      requiresVerification: false,
      token: 'caller-selected-token',
    };
    const reply = await registerWebPassword(writer, context, { ...registerCommand(), payload });
    expect(reply.outcome).toBe('created');
    if (reply.outcome !== 'created' || !reply.requiresVerification) throw new Error('Missing verification fixture');
    expect(reply.userId === victim.id).toBe(false);
    expect(reply.mailPlan.token === payload.token).toBe(false);
    const [original] = await db.select().from(userCredentials).where(eq(userCredentials.userId, victim.id));
    expect(original.passwordHash === originalHash).toBe(true);
    const [created] = await db.select().from(users).where(eq(users.id, reply.userId));
    expect(created.emailVerified).toBeNull();
  });

  it('serializes concurrent normalized-key registrations without choosing an existing owner', async () => {
    const email = `Race.${randomUUID()}@Example.TEST`;
    const outcomes = await Promise.all([
      registerWebPassword(writer, authority, registerCommand(email)),
      registerWebPassword(writer, authority, registerCommand(email.toLowerCase())),
    ]);
    expect(outcomes.filter((reply) => reply.outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((reply) => reply.outcome === 'error' && reply.code === 'exists')).toHaveLength(1);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(authEmailReservations)).toHaveLength(1);
    expect(await nonceCount()).toBe(2);
  });

  it.each([false, true])(
    'connects the ACTUAL web strict client to private HTTP and PostgreSQL with verification %s',
    async (required) => {
      vi.stubEnv('EMAIL_VERIFICATION_ENABLED', required ? 'true' : 'false');
      const result = await actualWebClientProbe(
        `Client.Mixed.${randomUUID()}+Tag@Example.TEST`,
        'actual-client-password',
      );
      expect(result).toEqual({
        ok: true,
        ownerMatches: true,
        requiresVerification: required,
        verified: !required,
        mailIdentityMatches: required ? true : null,
        templateRoundTrip: required ? true : null,
        publicVerified: required ? true : null,
        publicPrivacy: required ? true : null,
        publicCookieUnchanged: required ? true : null,
        verifiedAfterLink: required ? true : null,
      });
      expect(await db.select().from(users)).toHaveLength(1);
      expect(await nonceCount()).toBe(required ? 4 : 2);
    },
    25_000,
  );

  it('rejects same-request replay and never acknowledges success for changed registration input', async () => {
    const first = registerCommand();
    expect((await registerWebPassword(writer, authority, first)).outcome).toBe('created');
    expect(
      await registerWebPassword(writer, authority, {
        ...first,
        payload: { email: 'different@example.test', password: 'changed-password' },
      }),
    ).toMatchObject({ outcome: 'error', code: 'replayed' });
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await nonceCount()).toBe(1);
    const [nonce] = (await db.select().from(verificationTokens)).filter((token) =>
      token.identifier.startsWith('ba03-web-auth:'),
    );
    expect(nonce.identifier).toMatch(/^ba03-web-auth:[a-f0-9]{64}$/);
    expect(nonce.token).toMatch(/^[a-f0-9]{64}$/);
    expect(nonce.expires.getTime()).toBeGreaterThanOrEqual(first.issuedAt + AUTH_COMMAND_MAX_AGE_MS + 5000);
  });

  it('treats the same request ID in another case as a replay', async () => {
    const first = registerCommand();
    expect((await registerWebPassword(writer, authority, first)).outcome).toBe('created');
    expect(
      await registerWebPassword(writer, authority, {
        ...first,
        requestId: first.requestId.toUpperCase(),
        payload: { email: `${randomUUID()}@example.test`, password: 'changed-password' },
      }),
    ).toMatchObject({ outcome: 'error', code: 'replayed' });
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await nonceCount()).toBe(1);
  });

  it('refuses to create an account over an unreserved row for the same mailbox in another case', async () => {
    const existing = await seed(`case.variant.${randomUUID()}@example.test`);
    const command = registerCommand(existing.email.toUpperCase());
    await expect(registerWebPassword(writer, authority, command)).rejects.toMatchObject({
      code: 'RESERVATION_INCONSISTENT',
    });
    expect(await db.select({ id: users.id }).from(users)).toEqual([{ id: existing.id }]);
    expect(await db.select().from(authEmailReservations)).toEqual([]);
    expect(await nonceCount()).toBe(0);
  });

  describe('expired replay-record cleanup', () => {
    const past = () => new Date(Date.now() - 1000);
    const future = () => new Date(Date.now() + 60_000);
    const claimRow = (expires: Date) => {
      const token = randomBytes(32).toString('hex');
      return { identifier: `ba03-web-auth:${token}`, token, expires };
    };

    it('deletes only expired web-auth records, at most one batch per run', async () => {
      const live = claimRow(future());
      const legacyReset = { identifier: `password-reset:${randomUUID()}`, token: 'legacy-hash', expires: past() };
      const batchUser = {
        identifier: `ba03-batch-system-user:v1:${randomUUID()}`,
        token: 'batch-hash',
        expires: past(),
      };
      await db
        .insert(verificationTokens)
        .values([claimRow(past()), claimRow(past()), claimRow(past()), live, legacyReset, batchUser]);

      expect(await deleteExpiredCommandClaims(db, 2)).toBe(2);
      expect(await nonceCount()).toBe(2);
      expect(await deleteExpiredCommandClaims(db, 2)).toBe(1);
      expect(await deleteExpiredCommandClaims(db, 2)).toBe(0);

      const remaining = await db.select().from(verificationTokens);
      expect(remaining.map((row) => row.identifier).sort()).toEqual(
        [live.identifier, legacyReset.identifier, batchUser.identifier].sort(),
      );
    });

    it('skips a record another transaction holds instead of waiting for it', async () => {
      const held = claimRow(past());
      await db.insert(verificationTokens).values([held, claimRow(past())]);
      await db.transaction(async (transaction) => {
        await transaction
          .select()
          .from(verificationTokens)
          .where(eq(verificationTokens.identifier, held.identifier))
          .for('update');
        expect(await deleteExpiredCommandClaims(writer, 10)).toBe(1);
      });
      expect(await nonceCount()).toBe(1);
    });

    it('still clears records a staged mode left behind after the mode is switched off', async () => {
      const live = claimRow(future());
      await db.insert(verificationTokens).values([claimRow(past()), live]);
      for (const mode of ['legacy', 'misconfigured']) {
        vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', mode);
        await clearExpiredAuthRecords(db);
      }
      expect(await nonceCount()).toBe(1);
      expect(
        await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, live.identifier)),
      ).toHaveLength(1);
    });
  });

  it('rolls back identity, hashes, reservations and nonce on a real SQL failure after identity writes', async () => {
    const constraint = `web_password_fault_${roleSalt}`;
    await admin(
      sql`ALTER TABLE ${userProfiles} ADD CONSTRAINT ${sql.identifier(constraint)} CHECK (display_name IS NOT NULL)`,
    );
    try {
      await expect(registerWebPassword(writer, authority, registerCommand())).rejects.toMatchObject({
        cause: { code: '23514' },
      });
    } finally {
      await admin(sql`ALTER TABLE ${userProfiles} DROP CONSTRAINT ${sql.identifier(constraint)}`);
    }
    for (const table of [
      users,
      userCredentials,
      userProfiles,
      authEmailReservations,
      authEmailReservationMembers,
      verificationTokens,
    ])
      expect(await db.select().from(table)).toEqual([]);
  });

  it('rejects original issuedAt after expired replay-history cleanup without claiming unbounded idempotency', async () => {
    const command = registerCommand();
    expect((await registerWebPassword(writer, authority, command)).outcome).toBe('created');
    const [nonce] = (await db.select().from(verificationTokens)).filter((record) =>
      record.identifier.startsWith('ba03-web-auth:'),
    );
    vi.spyOn(Date, 'now').mockReturnValue(nonce.expires.getTime() + 1);
    try {
      await db.delete(verificationTokens).where(lt(verificationTokens.expires, new Date(Date.now())));
      expect(await nonceCount()).toBe(0);
      expect((await rpc(command)).status).toBe(400);
      expect(await db.select().from(users)).toHaveLength(1);
      expect(await nonceCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('selects the exact password owner and that UID verification state among exact-email duplicates', async () => {
    const first = await seed(undefined, originalHash, true);
    const second = await seed(first.email, await hash('second-owner-password', 4), false);
    const required = { ...authority, emailVerificationEnabled: true };
    expect(
      await authenticateWebPassword(writer, required, passwordCommand(first.email, 'second-owner-password')),
    ).toMatchObject({
      outcome: 'authenticated',
      user: { id: second.id },
      verification: { userId: second.id, required: true, verified: false },
    });
    expect(await authenticateWebPassword(writer, required, passwordCommand(first.email))).toMatchObject({
      outcome: 'authenticated',
      user: { id: first.id },
      verification: { userId: first.id, verified: true },
    });
    await db.update(userCredentials).set({ passwordHash: originalHash }).where(eq(userCredentials.userId, second.id));
    expect((await authenticateWebPassword(writer, required, passwordCommand(first.email))).outcome).toBe(
      'invalid_credentials',
    );
  });

  describe('any capitalisation (BA-02)', () => {
    it('signs in a mixed-case stored address typed exactly as stored and typed in lowercase', async () => {
      const stored = await seed(`Mixed.Case.${randomUUID()}@Example.TEST`);
      for (const typed of [stored.email, stored.email.toLowerCase(), stored.email.toUpperCase()])
        expect(await authenticateWebPassword(writer, authority, passwordCommand(typed))).toMatchObject({
          outcome: 'authenticated',
          user: { id: stored.id, email: stored.email },
        });
    });

    it('signs in the group member typed exactly and refuses a form no member stores', async () => {
      const upper = await seed(`Shared.${randomUUID()}@example.test`);
      const lower = await seed(upper.email.toLowerCase());
      expect(await authenticateWebPassword(writer, authority, passwordCommand(upper.email))).toMatchObject({
        outcome: 'authenticated',
        user: { id: upper.id },
      });
      expect(await authenticateWebPassword(writer, authority, passwordCommand(lower.email))).toMatchObject({
        outcome: 'authenticated',
        user: { id: lower.id },
      });
      // Both rows hold the same password here; even a password unique to one of
      // them must not pick it from a form neither stores.
      expect(
        (await authenticateWebPassword(writer, authority, passwordCommand(upper.email.toUpperCase()))).outcome,
      ).toBe('invalid_credentials');
      await db
        .update(userCredentials)
        .set({ passwordHash: await hash('only-lower', 4) })
        .where(eq(userCredentials.userId, lower.id));
      expect(
        (await authenticateWebPassword(writer, authority, passwordCommand(upper.email.toUpperCase(), 'only-lower')))
          .outcome,
      ).toBe('invalid_credentials');
    });

    it('refuses when another capitalisation of the typed address is committed during bcrypt', async () => {
      const stored = await seed(`During.${randomUUID()}@example.test`);
      const reply = await duringComparison(passwordCommand(stored.email.toUpperCase()), async () => {
        await seed(stored.email.replace('During', 'DURING'), null);
      });
      expect(reply.outcome).toBe('invalid_credentials');
    });
  });

  it('keeps short legacy password bytes while rejecting unknown, OAuth-only and oversized cohorts', async () => {
    const short = await seed(undefined, await hash('test', 4));
    expect((await authenticateWebPassword(writer, authority, passwordCommand(short.email, 'test'))).outcome).toBe(
      'authenticated',
    );
    expect((await authenticateWebPassword(writer, authority, passwordCommand('absent@example.test'))).outcome).toBe(
      'invalid_credentials',
    );
    const oauth = await seed(undefined, null);
    expect((await authenticateWebPassword(writer, authority, passwordCommand(oauth.email))).outcome).toBe(
      'invalid_credentials',
    );
    for (let index = 0; index < 8; index += 1) await seed(short.email, null);
    expect((await authenticateWebPassword(writer, authority, passwordCommand(short.email, 'test'))).outcome).toBe(
      'invalid_credentials',
    );
  });

  it('detects a real legacy password reset completed while bcrypt is awaiting', async () => {
    const user = await seed();
    const replacement = await hash('replacement-password', 4);
    const reply = await duringComparison(passwordCommand(user.email), async () => {
      await db.update(userCredentials).set({ passwordHash: replacement }).where(eq(userCredentials.userId, user.id));
    });
    expect(reply.outcome).toBe('invalid_credentials');
    expect(
      (await authenticateWebPassword(writer, authority, passwordCommand(user.email, 'replacement-password'))).outcome,
    ).toBe('authenticated');
  });

  it('detects an OAuth-only cohort member gaining the same password during bcrypt', async () => {
    const user = await seed();
    const oauth = await seed(user.email, null);
    const reply = await duringComparison(passwordCommand(user.email), async () => {
      await db.insert(userCredentials).values({ userId: oauth.id, passwordHash: originalHash });
    });
    expect(reply.outcome).toBe('invalid_credentials');
  });

  it('detects a new no-password cohort member and deletion during bcrypt', async () => {
    const first = await seed();
    expect(
      (
        await duringComparison(passwordCommand(first.email), async () => {
          await seed(first.email, null);
        })
      ).outcome,
    ).toBe('invalid_credentials');
    expect(
      (
        await duringComparison(passwordCommand(first.email), async () => {
          await db.delete(users).where(eq(users.id, first.id));
        })
      ).outcome,
    ).toBe('invalid_credentials');
  });

  it('releases the global manifest during bcrypt and rejects a newly committed cutoff generation', async () => {
    const user = await seed();
    const reply = await duringComparison(passwordCommand(user.email), async () => {
      await db.transaction((transaction) =>
        recordSecurityMutation(transaction, {
          ...authority,
          operationId: randomUUID(),
          userId: user.id,
          expectedGeneration: 0,
          kind: 'password-reset',
          domains: ['first-party', 'partner'],
        }),
      );
    });
    expect(reply.outcome).toBe('invalid_credentials');
    const [cutoff] = await db.select().from(authSubjectCutoffs);
    expect(cutoff.generation).toBe(1);
  });

  it('uses the selected UID current verification bit after an awaited comparison', async () => {
    const user = await seed(undefined, originalHash, false);
    authority = { ...authority, emailVerificationEnabled: true };
    const reply = await duringComparison(passwordCommand(user.email), async () => {
      await db.update(users).set({ emailVerified: new Date() }).where(eq(users.id, user.id));
    });
    expect(reply).toMatchObject({
      outcome: 'authenticated',
      verification: { userId: user.id, required: true, verified: true },
    });
  });

  it('captures password inputs and verification policy before the first await', async () => {
    const user = await seed(undefined, originalHash, false);
    const command = passwordCommand(user.email);
    const context = { ...authority, emailVerificationEnabled: true };
    const pending = authenticateWebPassword(writer, context, command);
    command.payload.email = 'changed-after-await@example.test';
    command.payload.password = 'changed-after-await';
    context.emailVerificationEnabled = false;
    context.expectedProjectionId = randomUUID();
    expect(await pending).toMatchObject({
      outcome: 'authenticated',
      user: { id: user.id },
      verification: { userId: user.id, required: true, verified: false },
    });
  });

  it('rechecks command expiry after bcrypt and rolls the nonce back', async () => {
    const user = await seed();
    const command = passwordCommand(user.email);
    comparison.afterRealCompare = async () => {
      vi.spyOn(Date, 'now').mockReturnValue(command.issuedAt + AUTH_COMMAND_MAX_AGE_MS + 1);
    };
    try {
      await expect(authenticateWebPassword(writer, authority, command)).rejects.toMatchObject({
        code: 'expired_request',
      });
    } finally {
      comparison.afterRealCompare = undefined;
      vi.restoreAllMocks();
    }
    expect(await nonceCount()).toBe(0);
  });

  it('fails closed on unenforced/stale authority and configuration without exposing mail or SQL values', async () => {
    await db.update(authEmailProjection).set({ phase: 'prepared' });
    expect((await rpc(registerCommand())).status).toBe(503);
    expect(await db.select().from(users)).toEqual([]);
    expect(await nonceCount()).toBe(0);
    expect(currentStoreWebAuthConfiguration({ CURRENT_STORE_WEB_AUTH_MODE: 'legacy', DEBUG_SQL: 'true' })).toEqual({
      mode: 'legacy',
    });
    vi.stubEnv('DEBUG_SQL', 'true');
    expect((await rpc(registerCommand())).status).toBe(503);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    expect((await rpc(registerCommand())).status).toBe(404);
    expect(await db.select().from(users)).toEqual([]);
  });

  it('rechecks freshness after a real PostgreSQL row-lock wait, rolling back the claimed nonce', async () => {
    const user = await seed();
    const command = passwordCommand(user.email);
    const locked = deferred();
    const release = deferred();
    const holding = db.transaction(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, user.id)).for('update');
      locked.resolve();
      await release.promise;
    });
    let active: Promise<unknown> | undefined;
    let lockWait: Promise<void> | undefined;
    try {
      await bounded(locked.promise, holding);
      active = authenticateWebPassword(writer, authority, command);
      lockWait = (async () => {
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
          const waiting = await db.execute(
            sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = ${writerRole} AND wait_event_type = 'Lock') AS waiting`,
          );
          if (waiting[0]?.waiting === true) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('Owned writer did not enter a PostgreSQL lock wait');
      })();
      // A poll stalled past the 250 ms user-row limit sees the command end first; the
      // checks below still require a fail-closed code and an uncommitted nonce.
      await bounded(
        Promise.race([
          lockWait,
          active.then(
            () => undefined,
            () => undefined,
          ),
        ]),
      );
      vi.spyOn(Date, 'now').mockReturnValue(command.issuedAt + AUTH_COMMAND_MAX_AGE_MS + 1);
      release.resolve();
      const failure = await active.then(
        () => undefined,
        (error: unknown) => error,
      );
      // A runner stalled past the 250 ms user-row limit ends in 55P03; both roll back.
      expect(['expired_request', '55P03']).toContain(getPostgresErrorCode(failure));
    } finally {
      release.resolve();
      await Promise.allSettled([holding, ...(active ? [active] : []), ...(lockWait ? [lockWait] : [])]);
      vi.restoreAllMocks();
    }
    expect(await nonceCount()).toBe(0);
  });

  it('rejects wrong service authority, browser Origin, path-operation confusion and expired metadata before writes', async () => {
    const command = registerCommand();
    expect((await rpc(command, { authorization: 'Bearer unrelated' })).status).toBe(401);
    expect((await rpc(command, { origin: 'https://www.boardsesh.test' })).status).toBe(401);
    expect((await rpc(command, {}, AUTH_COMMAND_PATHS.password)).status).toBe(400);
    expect((await rpc({ ...command, issuedAt: Date.now() - AUTH_COMMAND_MAX_AGE_MS - 1 })).status).toBe(400);
    expect(await db.select().from(users)).toEqual([]);
    expect(await nonceCount()).toBe(0);
  });

  it('rejects DEBUG_SQL before otherwise valid enabled work, while default-off ignores all new configuration', async () => {
    vi.stubEnv('DEBUG_SQL', 'true');
    expect(() => currentStoreWebAuthConfiguration()).toThrow('Unsafe current-store auth SQL logging');
    expect((await rpc(registerCommand())).status).toBe(503);
    expect(await db.select().from(users)).toEqual([]);
    expect(await nonceCount()).toBe(0);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', '');
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', '');
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '');
    expect(currentStoreWebAuthConfiguration()).toEqual({ mode: 'legacy' });
    expect((await rpc(registerCommand())).status).toBe(404);
    expect(await db.select().from(users)).toEqual([]);
  });

  it('keeps exact-reset-boundary rate limits valid for the strict protocol and Retry-After header', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    for (let count = 0; count < 60; count += 1) checkRateLimit('current-store-web-auth:register', 60, 60_000);
    clock.mockReturnValue(now + 60_000);
    try {
      const response = await rpc(registerCommand());
      const reply = registerReplySchema.parse(await response.json());
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('1');
      expect(reply).toMatchObject({ outcome: 'error', code: 'rate_limited', retryAfterSeconds: 1 });
      expect(await db.select().from(users)).toEqual([]);
      expect(await nonceCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('maps SQL permission failure to retryable HTTP unavailability, never invalid credentials', async () => {
    const user = await seed();
    await admin(sql`REVOKE SELECT ON TABLE ${userCredentials} FROM ${sql.identifier(writerRole)}`);
    try {
      const response = await rpc(passwordCommand(user.email));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ outcome: 'error', code: 'unavailable' });
    } finally {
      await admin(sql`GRANT SELECT ON TABLE ${userCredentials} TO ${sql.identifier(writerRole)}`);
    }
  });
});
