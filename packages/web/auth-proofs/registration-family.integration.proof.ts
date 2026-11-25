import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { NextRequest } from 'next/server';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { getRounds } from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, REGISTRATION_COMMAND_PATHS, type RegisterReply } from '@boardsesh/auth-protocol';
import { qualifyCredentialWriter } from '@boardsesh/db/credential-writer-acl';
import {
  authEmailProjection,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authSubjectCutoffs,
  mobileRefreshTokens,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import {
  createCredentialWriterEnvironment,
  ownedCredentialProofUrl,
} from '../../backend/src/auth/authority/__tests__/fixtures/credential-writer-environment';
import { closeCredentialDatabase } from '../../backend/src/auth/credential-database';
import { prepareProjectionUnderUsersTableLock } from '../../backend/src/auth/current-store/email-reservations';
import {
  captureRegistrationContext,
  insertPreEnforcementPasswordIdentity,
} from '../../backend/src/auth/current-store/registration-context';
import { lockAuthorityGateExclusively } from '../../backend/src/auth/current-store/foundation-context';
import { emailVerificationTokenHash } from '../../backend/src/auth/current-store/verification-receipts';
import { handleCurrentStoreRegistration } from '../../backend/src/handlers/current-store-registration';
import { handleCurrentStoreWebAuth } from '../../backend/src/handlers/current-store-web-auth';
import { handleNativeAuthRegister, __resetNativeAuthStateForTests } from '../../backend/src/handlers/native-auth';
import { resetAllRateLimits } from '../../backend/src/utils/rate-limiter';

const effects = vi.hoisted(() => ({
  mail: vi.fn(),
  sql: vi.fn(),
  afterHash: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('server-only', () => ({}));
vi.mock('@boardsesh/email', () => ({ sendVerificationEmail: effects.mail }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => {
    effects.sql();
    throw new Error('WEB_IDENTITY_DATABASE_UNAVAILABLE');
  },
}));
vi.mock('../../backend/src/db/client', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('CONTENT_DATABASE_UNAVAILABLE');
      },
    },
  ),
}));
vi.mock('bcryptjs', async (original) => {
  const actual = await original<typeof import('bcryptjs')>();
  return {
    ...actual,
    hash: async (password: string, cost: number) => {
      const passwordHash = await actual.hash(password, cost);
      await effects.afterHash?.();
      return passwordHash;
    },
  };
});

import { POST as registerPublic } from '../app/api/auth/register/route';
import { POST as resendPublic } from '../app/api/auth/resend-verification/route';
import { GET as verifyPublic } from '../app/api/auth/verify-email/route';
import { GET as oldVerifyPublic } from './fixtures/registration-old-reader';

const rpcSecret = 'owned-registration-private-rpc-secret-6975';
const password = 'owned registration password';
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
let admin: postgres.Sql;
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let nativePool: postgres.Sql;
let nativeDatabase: ReturnType<typeof drizzle>;
let server: Server;
let origin = '';
let publicSequence = 0;
let dropReply = false;
const sockets = new Set<import('node:net').Socket>();

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned registration barrier deadline')), 4000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function waitForLock(application: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const [record] = await admin<{ waiting: boolean }[]>`SELECT EXISTS(
      SELECT 1 FROM pg_stat_activity WHERE datname=${copyName} AND application_name=${application} AND wait_event_type='Lock') AS waiting`;
    if (record?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Owned registration lock was not observed');
}
function publicRequest(path: string, payload?: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    ...(payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }),
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `192.0.2.${(++publicSequence % 250) + 1}`,
      Cookie: 'next-auth.session-token=untouched-login',
    },
  });
}
function registration(email = `Climber.${randomUUID()}@Example.test`) {
  return { email, password };
}
async function privateCommand(operation: keyof typeof REGISTRATION_COMMAND_PATHS, payload: unknown) {
  const command = {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload,
  };
  const response = await fetch(`${origin}${REGISTRATION_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rpcSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  return { response, body: (await response.json()) as RegisterReply };
}
async function registered(email?: string) {
  const result = await privateCommand('register', registration(email));
  expect(result.response.status).toBe(201);
  if (result.body.outcome !== 'created' || !result.body.requiresVerification)
    throw new Error('No owned verification proof');
  return result.body;
}
async function verify(token: string, hint = 'wrong-query@example.test') {
  return verifyPublic(publicRequest(`/api/auth/verify-email?token=${encodeURIComponent(token)}&email=${hint}`));
}
async function storedReceipt(token: string) {
  const [receipt] = await environment.ownerDatabase
    .select()
    .from(authEmailVerificationTokens)
    .where(eq(authEmailVerificationTokens.tokenHash, emailVerificationTokenHash(token)));
  if (!receipt) throw new Error('Owned verification receipt missing');
  return receipt;
}
async function nativeRegister(email: string) {
  return fetch(`${origin}/auth/native/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${(++publicSequence % 250) + 1}` },
    body: JSON.stringify(registration(email)),
  });
}
async function enforce(authority: 'current-store' | 'better-auth' = 'current-store') {
  await environment.ownerDatabase.transaction(async (transaction) => {
    await lockAuthorityGateExclusively(transaction);
    await transaction.update(authEmailProjection).set({ phase: 'enforced', writerAuthority: authority });
  });
}

describe('default registration family on the qualified credential LOGIN', () => {
  beforeAll(async () => {
    const target = ownedCredentialProofUrl();
    const templateName = target.pathname.slice(1);
    target.pathname = '/postgres';
    admin = postgres(target.toString(), { max: 3, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${templateName}"`);
    environment = await createCredentialWriterEnvironment('private-registration-v1', { copyDatabase: copyName });
    target.pathname = `/${copyName}`;
    nativePool = postgres(target.toString(), {
      max: 3,
      onnotice: () => {},
      connection: { application_name: 'owned-registration-native' },
    });
    nativeDatabase = drizzle(nativePool);
    server = createServer((request, response) => {
      if (dropReply) {
        dropReply = false;
        response.end = (() => {
          response.destroy();
          return response;
        }) as typeof response.end;
      }
      const pending =
        request.url === '/auth/native/register'
          ? handleNativeAuthRegister(request, response, nativeDatabase)
          : request.url?.startsWith('/api/internal/auth/current-store/registration/v1/')
            ? handleCurrentStoreRegistration(request, response)
            : handleCurrentStoreWebAuth(request, response);
      void pending.catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned registration HTTP binding failed');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await closeCredentialDatabase();
    await environment.owner`DELETE FROM public.users`;
    await environment.owner.unsafe(
      'TRUNCATE auth_email_projection, auth_email_verification_state, auth_subject_cutoffs, "verificationTokens" CASCADE',
    );
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-registration-v1',
      CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
      CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin,
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      NEXTAUTH_SECRET: 'owned-registration-native-jwt-secret',
      NEXTAUTH_URL: '',
      BASE_URL: '',
      NODE_ENV: 'test',
      DEBUG_SQL: 'false',
      EMAIL_VERIFICATION_ENABLED: 'true',
      AUTH_IDENTITY_MIRROR: 'off',
      CURRENT_STORE_NATIVE_REGISTRATION_MODE: 'legacy',
      AUTH_NATIVE_REVOCATION_MODE: 'legacy',
    }))
      vi.stubEnv(name, content);
    effects.mail.mockReset().mockResolvedValue(undefined);
    effects.sql.mockClear();
    effects.afterHash = undefined;
    dropReply = false;
    resetAllRateLimits();
    __resetNativeAuthStateForTests();
  });
  afterEach(async () => {
    effects.afterHash = undefined;
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await nativePool?.end();
    await environment?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${copyName}"`);
      await admin.end();
    }
  });

  it('qualifies current main exactly and refuses direct partner grants or users-shape drift', async () => {
    const qualify = () =>
      qualifyCredentialWriter(environment.writer, {
        expectedRole: 'boardsesh_identity_writer',
        expectedDatabase: copyName,
        contract: 'private-registration-v1',
      });
    expect((await qualify()).contract).toBe('private-registration-v1');
    await environment.owner`GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO boardsesh_identity_writer`;
    await expect(qualify()).rejects.toThrow('CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH');
    await environment.owner`REVOKE EXECUTE ON FUNCTION public.partner_revoke_user(text) FROM boardsesh_identity_writer`;
    await environment.owner`GRANT DELETE ON public.oauth_grants TO boardsesh_identity_writer`;
    await expect(qualify()).rejects.toThrow('CREDENTIAL_WRITER_EXCESS_RELATION_GRANT');
    await environment.resetGrants();
    await environment.owner`CREATE INDEX owned_registration_users_drift ON public.users(email)`;
    await expect(qualify()).rejects.toThrow('CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE');
    await environment.owner`DROP INDEX public.owned_registration_users_drift`;
    await expect(qualify()).resolves.toMatchObject({ contract: 'private-registration-v1' });
  });

  it('runs the actual default public routes with no web SQL and only private mailbox capability', async () => {
    const response = await registerPublic(publicRequest('/api/auth/register', registration('MiXeD+tag@Example.test')));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      message: 'Account created. Please check your email to verify your account.',
      requiresVerification: true,
      emailSent: true,
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    const [recipient, token] = effects.mail.mock.calls[0] as [string, string];
    expect(recipient).toBe('mixed+tag@example.test');
    const receipt = await storedReceipt(token);
    const [credential] = await environment.ownerDatabase
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, receipt.userId));
    expect(getRounds(credential.passwordHash)).toBe(12);
    const verified = await verify(token);
    expect(verified.headers.get('Location')).toContain('/auth/login?verified=true');
    expect(verified.headers.getSetCookie()).toEqual([]);
    expect((await storedReceipt(token)).consumedAt).not.toBeNull();
    expect(effects.sql).not.toHaveBeenCalled();
  });

  it('shows an old default reader retaining ev1 and the capable reader consuming the same proof', async () => {
    const created = await registered();
    const oldResponse = await oldVerifyPublic(publicRequest(`/api/auth/verify-email?token=${created.mailPlan.token}`));
    expect(oldResponse.status).toBe(503);
    expect((await storedReceipt(created.mailPlan.token)).consumedAt).toBeNull();
    expect((await verify(created.mailPlan.token)).headers.get('Location')).toContain('verified=true');
    expect(effects.sql).not.toHaveBeenCalled();
    expect(effects.mail).not.toHaveBeenCalled();
  });

  it.each([false, true])('serializes actual web/native creation, prepared=%s', async (prepared) => {
    if (prepared)
      await environment.ownerDatabase.transaction((transaction) =>
        prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
      );
    const email = `race.${randomUUID()}@example.test`;
    const responses = await Promise.all([
      registerPublic(publicRequest('/api/auth/register', registration(email.toUpperCase()))),
      nativeRegister(email),
    ]);
    expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([201, 409]);
    const accounts = await environment.ownerDatabase.select().from(users).where(eq(users.email, email));
    expect(accounts).toHaveLength(1);
    expect(await environment.ownerDatabase.select().from(userCredentials)).toHaveLength(1);
    expect(await environment.ownerDatabase.select().from(authEmailVerificationTokens)).toHaveLength(1);
    const refresh = await environment.ownerDatabase.select().from(mobileRefreshTokens);
    expect(refresh).toHaveLength(responses[1].status === 201 ? 1 : 0);
  });

  it.each([' ', '\u00a0', '\ufeff'])(
    'finds a live whitespace holder after preparation, whitespace=%j',
    async (padding) => {
      await environment.ownerDatabase.transaction((transaction) =>
        prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
      );
      await environment.ownerDatabase
        .insert(users)
        .values({ id: randomUUID(), email: `${padding}Stored@Example.test${padding}` });
      const response = await registerPublic(publicRequest('/api/auth/register', registration('stored@example.test')));
      expect(response.status).toBe(409);
      expect(await environment.ownerDatabase.select().from(users)).toHaveLength(1);
      expect(await environment.ownerDatabase.select().from(authEmailVerificationTokens)).toHaveLength(0);
    },
  );

  it.each(['current-store', 'better-auth'] as const)(
    'refuses enforcement during real bcrypt, authority=%s',
    async (authority) => {
      await environment.ownerDatabase.transaction((transaction) =>
        prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
      );
      const hashed = barrier();
      const release = barrier();
      effects.afterHash = async () => {
        hashed.resolve();
        await release.promise;
      };
      const pending = registerPublic(publicRequest('/api/auth/register', registration()));
      try {
        await bounded(hashed.promise);
        await enforce(authority);
      } finally {
        release.resolve();
      }
      expect((await pending).status).toBe(503);
      expect(await environment.ownerDatabase.select().from(users)).toHaveLength(0);
    },
  );

  it('revalidates native phase after a negative precheck, before answering conflict', async () => {
    const email = 'taken@example.test';
    await environment.ownerDatabase.insert(users).values({ id: randomUUID(), email });
    await environment.ownerDatabase.transaction((transaction) =>
      prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
    );
    const held = barrier();
    const release = barrier();
    const holder = environment.owner.begin(async (transaction) => {
      await transaction`LOCK TABLE users IN ACCESS EXCLUSIVE MODE`;
      held.resolve();
      await release.promise;
    });
    await bounded(held.promise);
    const pending = nativeRegister(email);
    try {
      await waitForLock('owned-registration-native');
      await enforce('better-auth');
    } finally {
      release.resolve();
      await holder;
    }
    expect((await pending).status).toBe(503);
  });

  it('keeps enforcement behind a participating writer until its commit', async () => {
    await environment.ownerDatabase.transaction((transaction) =>
      prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
    );
    const inserted = barrier();
    const release = barrier();
    const writing = nativeDatabase.transaction(async (transaction) => {
      const context = await captureRegistrationContext(transaction);
      await insertPreEnforcementPasswordIdentity(
        transaction,
        context,
        'held@example.test',
        { email: 'held@example.test', passwordHash: 'owned-not-an-issued-password' },
        false,
      );
      inserted.resolve();
      await release.promise;
    });
    await bounded(inserted.promise);
    let enforced = false;
    const switching = enforce().then(() => {
      enforced = true;
    });
    try {
      // The operator waits on the shared authority lock, not a user row.
      for (let attempt = 0; attempt < 150; attempt++) {
        const [record] = await admin<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=6975 AND objid=2) AS waiting`;
        if (record?.waiting) break;
        if (attempt === 149) throw new Error('Authority switch never waited');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(enforced).toBe(false);
    } finally {
      release.resolve();
      await writing;
      await switching;
    }
    expect((await privateCommand('register', registration())).response.status).toBe(503);
  });

  it('consumes once, supersedes on resend, and preserves an existing verification timestamp', async () => {
    const created = await registered('resend@example.test');
    const resend = await privateCommand('resend-verification', { email: 'RESEND@example.test' });
    const reply = resend.body as unknown as { mailPlan: { token: string } };
    expect((await storedReceipt(created.mailPlan.token)).supersededAt).not.toBeNull();
    expect((await verify(created.mailPlan.token)).headers.get('Location')).toContain('InvalidToken');
    const [first, second] = await Promise.all([verify(reply.mailPlan.token), verify(reply.mailPlan.token)]);
    expect(
      [first, second].filter((response) => response.headers.get('Location')?.includes('verified=true')),
    ).toHaveLength(1);
    const verifiedAt = new Date('2026-01-02T03:04:05Z');
    const another = await registered('timestamp@example.test');
    await environment.ownerDatabase
      .update(users)
      .set({ emailVerified: verifiedAt })
      .where(eq(users.id, another.userId));
    expect((await verify(another.mailPlan.token)).headers.get('Location')).toContain('verified=true');
    const [user] = await environment.ownerDatabase.select().from(users).where(eq(users.id, another.userId));
    expect(user.emailVerified).toEqual(verifiedAt);
  });

  it('rolls back user, receipt, purpose generation and transport nonce on final verification failure', async () => {
    const created = await registered();
    const before = await storedReceipt(created.mailPlan.token);
    const nonceCount = (await environment.ownerDatabase.select().from(verificationTokens)).length;
    await environment.owner`ALTER TABLE public.users ADD CONSTRAINT owned_registration_verify_failure CHECK ("emailVerified" IS NULL) NOT VALID`;
    try {
      expect((await verify(created.mailPlan.token)).status).toBe(503);
    } finally {
      await environment.owner`ALTER TABLE public.users DROP CONSTRAINT owned_registration_verify_failure`;
    }
    expect((await storedReceipt(created.mailPlan.token)).consumedAt).toBeNull();
    const [state] = await environment.ownerDatabase
      .select()
      .from(authEmailVerificationState)
      .where(eq(authEmailVerificationState.userId, created.userId));
    expect(state.generation).toBe(before.issuanceGeneration);
    expect((await environment.ownerDatabase.select().from(verificationTokens)).length).toBe(nonceCount);
    expect((await verify(created.mailPlan.token)).headers.get('Location')).toContain('verified=true');
  });

  it('rolls back native identity and UID receipt when refresh persistence fails', async () => {
    await environment.owner`ALTER TABLE public.mobile_refresh_tokens ADD CONSTRAINT owned_registration_refresh_failure CHECK (false) NOT VALID`;
    try {
      expect((await nativeRegister('native-failure@example.test')).status).toBe(503);
    } finally {
      await environment.owner`ALTER TABLE public.mobile_refresh_tokens DROP CONSTRAINT owned_registration_refresh_failure`;
    }
    expect(await environment.ownerDatabase.select().from(users)).toHaveLength(0);
    expect(await environment.ownerDatabase.select().from(userCredentials)).toHaveLength(0);
    expect(await environment.ownerDatabase.select().from(authEmailVerificationTokens)).toHaveLength(0);
    expect(await environment.ownerDatabase.select().from(authEmailVerificationState)).toHaveLength(0);
    expect(await environment.ownerDatabase.select().from(mobileRefreshTokens)).toHaveLength(0);
  });

  it('retains a committed account on SMTP failure and never retries an unknown reply', async () => {
    effects.mail.mockRejectedValueOnce(new Error('private synthetic mail failure'));
    const failure = await registerPublic(publicRequest('/api/auth/register', registration()));
    expect(failure.status).toBe(201);
    expect(await failure.json()).toMatchObject({ requiresVerification: true, emailSent: false });
    const email = 'lost-reply@example.test';
    dropReply = true;
    const lost = await registerPublic(publicRequest('/api/auth/register', registration(email)));
    expect(lost.status).toBe(503);
    expect(await environment.ownerDatabase.select().from(users).where(eq(users.email, email))).toHaveLength(1);
    expect(effects.mail).toHaveBeenCalledTimes(1);
    expect(effects.sql).not.toHaveBeenCalled();
  });

  it('retains default resend SMTP status and its 1500ms floor', async () => {
    await registered('smtp-resend@example.test');
    effects.mail.mockRejectedValueOnce(new Error('private synthetic SMTP failure'));
    const started = Date.now();
    const response = await resendPublic(
      publicRequest('/api/auth/resend-verification', { email: 'smtp-resend@example.test' }),
    );
    expect(response.status).toBe(500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1490);
    expect(await response.json()).toEqual({ error: 'Failed to send verification email' });
  });

  it('shows why an unfenced old writer remains a gate, then proves its restricted LOGIN fails', async () => {
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`GRANT INSERT ON public.users TO boardsesh_retired_runtime`;
    const inserted = barrier();
    const release = barrier();
    const writing = nativeDatabase.transaction(async (transaction) => {
      const context = await captureRegistrationContext(transaction);
      await insertPreEnforcementPasswordIdentity(
        transaction,
        context,
        'unfenced@example.test',
        { email: 'unfenced@example.test', passwordHash: 'owned-unissued-hash' },
        false,
      );
      inserted.resolve();
      await release.promise;
    });
    try {
      await bounded(inserted.promise);
      await environment.legacy`INSERT INTO public.users(id,email) VALUES (${randomUUID()},'UNFENCED@example.test')`;
    } finally {
      release.resolve();
      await writing;
    }
    expect(await environment.ownerDatabase.select().from(users)).toHaveLength(2);
    await environment.owner`REVOKE INSERT ON public.users FROM boardsesh_retired_runtime`;
    await expect(
      environment.legacy`INSERT INTO public.users(id,email) VALUES (${randomUUID()},'blocked@example.test')`,
    ).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['resend-first', 'consume-first'])('serializes resend/consume on the UID row, order=%s', async (order) => {
    const created = await registered('ordered@example.test');
    const held = barrier();
    const release = barrier();
    const holder = nativeDatabase.transaction(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, created.userId)).for('update');
      held.resolve();
      await release.promise;
    });
    await bounded(held.promise);
    const resend = () => privateCommand('resend-verification', { email: 'ordered@example.test' });
    const consume = () => verify(created.mailPlan.token);
    const first = order === 'resend-first' ? resend() : consume();
    let second: ReturnType<typeof resend> | ReturnType<typeof consume> | undefined;
    try {
      await waitForLock('boardsesh-credential-writer');
      second = order === 'resend-first' ? consume() : resend();
    } finally {
      release.resolve();
      await holder;
    }
    const results = await Promise.all([first, second!]);
    const consumeResponse = results[order === 'resend-first' ? 1 : 0] as Response;
    expect(consumeResponse.headers.get('Location')).toContain(
      order === 'resend-first' ? 'InvalidToken' : 'verified=true',
    );
    const resendResponse = results[order === 'resend-first' ? 0 : 1] as Awaited<ReturnType<typeof resend>>;
    expect(resendResponse.response.status).toBe(200);
    expect('mailPlan' in resendResponse.body).toBe(order === 'resend-first');
  });

  it('checks the actual clock after a UID-row wait crosses the exact deadline', async () => {
    const created = await registered();
    const deadline = new Date(Date.now() + 1000);
    await environment.ownerDatabase
      .update(authEmailVerificationTokens)
      .set({ issuedAt: new Date(deadline.getTime() - 60_000), expiresAt: deadline })
      .where(eq(authEmailVerificationTokens.userId, created.userId));
    const held = barrier();
    const release = barrier();
    const holder = nativeDatabase.transaction(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, created.userId)).for('update');
      held.resolve();
      await release.promise;
    });
    await bounded(held.promise);
    const pending = verify(created.mailPlan.token);
    try {
      await waitForLock('boardsesh-credential-writer');
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now() + 25)));
    } finally {
      release.resolve();
      await holder;
    }
    expect((await pending).headers.get('Location')).toContain('TokenExpired');
    expect((await storedReceipt(created.mailPlan.token)).consumedAt).toBeNull();
  });

  it.each(['generation', 'deleted-user'])('denies a receipt whose bound subject changed: %s', async (mutation) => {
    const created = await registered();
    if (mutation === 'generation') {
      await environment.ownerDatabase
        .insert(authSubjectCutoffs)
        .values({ userId: created.userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
    } else await environment.ownerDatabase.delete(users).where(eq(users.id, created.userId));
    expect((await verify(created.mailPlan.token)).headers.get('Location')).toContain('InvalidToken');
    expect((await storedReceipt(created.mailPlan.token)).consumedAt).toBeNull();
  });

  it.each([
    {
      name: 'exact mixed-case owner',
      emails: ['Stored+tag@Example.test'],
      linkEmail: 'Stored+tag@Example.test',
      expected: 'verified=true',
    },
    {
      name: 'exact member beside a case sibling',
      emails: ['Stored+tag@Example.test', 'stored+tag@example.test'],
      linkEmail: 'Stored+tag@Example.test',
      expected: 'verified=true',
    },
    {
      name: 'deleted exact owner does not become its sibling',
      emails: ['stored+tag@example.test'],
      linkEmail: 'Stored+tag@Example.test',
      expected: 'InvalidToken',
    },
    {
      name: 'duplicate exact rows',
      emails: ['Stored+tag@Example.test', 'Stored+tag@Example.test'],
      linkEmail: 'Stored+tag@Example.test',
      expected: 'InvalidToken',
    },
    {
      name: 'ambiguous differently capitalized rows',
      emails: ['Stored+tag@Example.test', 'STORED+tag@example.test'],
      linkEmail: 'stored+tag@example.test',
      expected: 'InvalidToken',
    },
    { name: 'orphan', emails: [], linkEmail: 'orphan@example.test', expected: 'InvalidToken' },
    {
      name: 'new account after old issuance',
      emails: ['new@example.test'],
      linkEmail: 'new@example.test',
      expected: 'InvalidToken',
      future: true,
    },
  ])('preserves explicit legacy compatibility: $name', async ({ emails, linkEmail, expected, future }) => {
    const token = randomUUID();
    for (const email of emails)
      await environment.ownerDatabase.insert(users).values({
        id: randomUUID(),
        email,
        createdAt: future ? new Date(Date.now() + 120_000) : new Date('2020-01-01T00:00:00Z'),
      });
    await environment.ownerDatabase
      .insert(verificationTokens)
      .values({ identifier: linkEmail, token, expires: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    const response = await verify(token, encodeURIComponent(linkEmail));
    expect(response.headers.get('Location')).toContain(expected);
    const verified = (await environment.ownerDatabase.select().from(users)).filter((user) => user.emailVerified);
    expect(verified).toHaveLength(expected === 'verified=true' ? 1 : 0);
    if (verified.length) expect(verified[0].email).toBe(linkEmail);
    if (emails.length === 0)
      expect(
        await environment.ownerDatabase.select().from(verificationTokens).where(eq(verificationTokens.token, token)),
      ).toHaveLength(0);
  });

  it('consumes one legacy row once without inventing UID provenance', async () => {
    const email = 'legacy-once@example.test';
    const token = randomUUID();
    const userId = randomUUID();
    await environment.ownerDatabase
      .insert(users)
      .values({ id: userId, email, createdAt: new Date('2020-01-01T00:00:00Z') });
    await environment.ownerDatabase
      .insert(verificationTokens)
      .values({ identifier: email, token, expires: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    const responses = await Promise.all([verify(token, email), verify(token, email)]);
    expect(responses.filter((response) => response.headers.get('Location')?.includes('verified=true'))).toHaveLength(1);
    expect(await environment.ownerDatabase.select().from(authEmailVerificationTokens)).toHaveLength(0);
    expect(await environment.ownerDatabase.select().from(authEmailVerificationState)).toHaveLength(0);
  });

  it('returns unavailable to the new web when an old backend has only the released routes', async () => {
    const old = createServer((request, response) => {
      void handleCurrentStoreWebAuth(request, response);
    });
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    const address = old.address();
    if (!address || typeof address === 'string') throw new Error('Owned old backend binding failed');
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', `http://127.0.0.1:${address.port}`);
    try {
      expect((await registerPublic(publicRequest('/api/auth/register', registration()))).status).toBe(503);
      expect(effects.sql).not.toHaveBeenCalled();
      expect(effects.mail).not.toHaveBeenCalled();
      expect(await environment.ownerDatabase.select().from(users)).toHaveLength(0);
    } finally {
      old.closeAllConnections();
      await new Promise<void>((resolve) => old.close(() => resolve()));
    }
  });
});
