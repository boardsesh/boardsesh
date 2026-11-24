import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_PROTOCOL_VERSION,
  REGISTRATION_COMMAND_PATHS,
  registerReplySchema,
  type AuthCommandReply,
} from '@boardsesh/auth-protocol';
import {
  authEmailProjection,
  authEmailVerificationTokens,
  mobileRefreshTokens,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { qualifyCredentialWriter } from '@boardsesh/db/credential-writer-acl';
import { createCredentialWriterEnvironment, ownedCredentialProofUrl } from './fixtures/credential-writer-environment';
import { closeCredentialDatabase } from '../../credential-database';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { handleCurrentStoreRegistration } from '../../../handlers/current-store-registration';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { handleNativeAuthRegister, __resetNativeAuthStateForTests } from '../../../handlers/native-auth';

vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('UNUSED_CONTENT_POOL');
      },
    },
  ),
}));
const secret = 'owned-backend-registration-command-secret-6975';
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
let admin: postgres.Sql;
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin = '';

async function post(payload: unknown, options: { path?: string; authorization?: string | null; origin?: string } = {}) {
  const response = await fetch(`${origin}${options.path ?? REGISTRATION_COMMAND_PATHS.register}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.authorization === null ? {} : { Authorization: options.authorization ?? `Bearer ${secret}` }),
      ...(options.origin ? { Origin: options.origin } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as AuthCommandReply };
}
function command(
  operation = 'register',
  payload: unknown = { email: `${randomUUID()}@example.test`, password: 'owned registration password' },
) {
  return { protocolVersion: AUTH_PROTOCOL_VERSION, operation, requestId: randomUUID(), issuedAt: Date.now(), payload };
}

describe('backend-first registration commands without future web adapters', () => {
  beforeAll(async () => {
    const target = ownedCredentialProofUrl();
    const template = target.pathname.slice(1);
    target.pathname = '/postgres';
    admin = postgres(target.toString(), { max: 2, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${template}"`);
    environment = await createCredentialWriterEnvironment('private-registration-v1', { copyDatabase: copyName });
    server = createServer((request, response) => {
      const pending =
        request.url === '/auth/native/register'
          ? handleNativeAuthRegister(request, response, environment.ownerDatabase)
          : request.url?.includes('/registration/v1/')
            ? handleCurrentStoreRegistration(request, response)
            : handleCurrentStoreWebAuth(request, response);
      void pending.catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned backend binding failed');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await closeCredentialDatabase();
    await environment.owner`DELETE FROM public.users`;
    await environment.owner.unsafe(
      'TRUNCATE auth_email_projection,auth_email_verification_state,auth_subject_cutoffs,"verificationTokens" CASCADE',
    );
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-registration-v1',
      CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
      CURRENT_STORE_NATIVE_REGISTRATION_MODE: 'legacy',
      CURRENT_STORE_AUTH_RPC_SECRET: secret,
      EMAIL_VERIFICATION_ENABLED: 'true',
      NEXTAUTH_SECRET: 'owned-backend-registration-jwt-secret',
      DEBUG_SQL: 'false',
      AUTH_IDENTITY_MIRROR_MODE: 'off',
    }))
      vi.stubEnv(name, content);
    __resetNativeAuthStateForTests();
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await environment?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${copyName}"`);
      await admin.end();
    }
  });

  it('qualifies the new exact current profile without relaxing the historical web receipt', async () => {
    expect(
      (
        await qualifyCredentialWriter(environment.writer, {
          expectedRole: 'boardsesh_identity_writer',
          expectedDatabase: copyName,
          contract: 'private-registration-v1',
        })
      ).contract,
    ).toBe('private-registration-v1');
    await expect(
      qualifyCredentialWriter(environment.writer, {
        expectedRole: 'boardsesh_identity_writer',
        expectedDatabase: copyName,
        contract: 'private-web-v1',
      }),
    ).rejects.toThrow();
  });
  it.each([false, true])(
    'registers, supersedes and consumes UID proofs before enforcement, prepared=%s',
    async (prepared) => {
      if (prepared)
        await environment.ownerDatabase.transaction((transaction) =>
          prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
        );
      const email = 'backend@example.test';
      const created = registerReplySchema.parse(
        (await post(command('register', { email, password: 'owned registration password' }))).body,
      );
      if (created.outcome !== 'created' || !created.requiresVerification)
        throw new Error('No owned registration proof');
      const resent = await post(command('resend-verification', { email }), {
        path: REGISTRATION_COMMAND_PATHS['resend-verification'],
      });
      if (resent.body.outcome !== 'accepted' || !('mailPlan' in resent.body) || !resent.body.mailPlan)
        throw new Error('No resend proof');
      const token = resent.body.mailPlan.token;
      const consumed = await post(command('verify-email', { token }), {
        path: REGISTRATION_COMMAND_PATHS['verify-email'],
      });
      expect(consumed.body.outcome).toBe('verified');
      expect(
        (await post(command('verify-email', { token }), { path: REGISTRATION_COMMAND_PATHS['verify-email'] })).body
          .outcome,
      ).toBe('invalid_token');
      expect((await environment.ownerDatabase.select().from(users))[0].emailVerified).not.toBeNull();
      expect(await environment.ownerDatabase.select().from(mobileRefreshTokens)).toHaveLength(0);
    },
  );
  it.each([false, true])('serializes private web and installed native creation, prepared=%s', async (prepared) => {
    if (prepared)
      await environment.ownerDatabase.transaction((transaction) =>
        prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
      );
    const email = 'backend-race@example.test';
    const responses = await Promise.all([
      post(command('register', { email, password: 'owned registration password' })),
      post(
        { email: email.toUpperCase(), password: 'owned registration password' },
        { path: '/auth/native/register', authorization: null },
      ),
    ]);
    expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([201, 409]);
    expect(await environment.ownerDatabase.select().from(users)).toHaveLength(1);
    expect(await environment.ownerDatabase.select().from(userCredentials)).toHaveLength(1);
    expect(await environment.ownerDatabase.select().from(authEmailVerificationTokens)).toHaveLength(1);
  });
  it.each(['current-store', 'better-auth'] as const)(
    'never falls back through enforced authority %s',
    async (writerAuthority) => {
      await environment.ownerDatabase.transaction((transaction) =>
        prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
      );
      await environment.ownerDatabase.update(authEmailProjection).set({ phase: 'enforced', writerAuthority });
      expect((await post(command())).status).toBe(503);
      expect(await environment.ownerDatabase.select().from(users)).toHaveLength(0);
      expect(await environment.ownerDatabase.select().from(verificationTokens)).toHaveLength(0);
    },
  );
  it.each([
    ['missing bearer', 401, { authorization: null }, {}],
    ['wrong bearer', 401, { authorization: 'Bearer wrong' }, {}],
    ['browser Origin', 401, { origin: 'https://www.boardsesh.test' }, {}],
    ['missing version', 400, {}, { protocolVersion: undefined }],
    ['wrong version', 400, {}, { protocolVersion: 1 }],
    ['operation/path mismatch', 400, {}, { operation: 'verify-email', payload: { token: 'invalid' } }],
    ['stale command', 400, {}, { issuedAt: 0 }],
  ] as const)('rejects private admission before any writes: %s', async (_name, status, options, mutation) => {
    expect((await post({ ...command(), ...mutation }, options)).status).toBe(status);
    expect(await environment.ownerDatabase.select().from(users)).toHaveLength(0);
    expect(await environment.ownerDatabase.select().from(verificationTokens)).toHaveLength(0);
    expect(await environment.ownerDatabase.select().from(authEmailVerificationTokens)).toHaveLength(0);
  });
});
