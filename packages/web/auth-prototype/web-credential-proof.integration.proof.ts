// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { encode, decode, type JWT } from 'next-auth/jwt';
import type { NextAuthOptions } from 'next-auth';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { users, accounts, userCredentials, authEmailProjection } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { prepareProjectionUnderUsersTableLock } from '../../backend/src/auth/current-store/email-reservations';
import { handleCurrentStoreWebSignOut } from '../../backend/src/handlers/current-store-web-signout';
import { handleCurrentStoreWebAuth } from '../../backend/src/handlers/current-store-web-auth';
import { recordSecurityMutation } from '../../backend/src/auth/current-store/security-mutations';
import { lockEnforcedProjection } from '../../backend/src/auth/current-store/foundation-context';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';

const holder = vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'synthetic-web-backend-proof-secret';
  process.env.NEXTAUTH_URL = 'http://localhost:3000';
  return { database: undefined as unknown, beforeEncode: undefined as (() => void) | undefined };
});
vi.mock('next-auth/jwt', async (original) => {
  const actual = await original<typeof import('next-auth/jwt')>();
  return {
    ...actual,
    encode: async (parameters: Parameters<typeof actual.encode>[0]) => {
      holder.beforeEncode?.();
      return actual.encode(parameters);
    },
  };
});
vi.mock('server-only', () => ({}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
vi.mock('@/app/lib/db/db', () => ({ getDb: () => holder.database }));
vi.mock('../../backend/src/db/client', () => ({
  get db() {
    return holder.database;
  },
}));
let environment: Awaited<ReturnType<typeof createEnvironment>>;
vi.mock('../../backend/src/auth/admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));
import { authOptions } from '../app/lib/auth/auth-options';
import {
  createPasswordCommandClient,
  AuthBackendUnavailableError,
} from '../app/lib/auth/password-command-client.server';
import { createPasswordCommandAuthRequest } from '../app/lib/auth/password-command-auth.server';
import { forwardWebSignOut } from '../app/lib/auth/web-signout-command.server';
import { delegateSetPassword } from '../app/lib/auth/set-password-command.server';
vi.mock('../app/lib/auth/credential-admission.server', async (original) => ({
  ...(await original<typeof import('../app/lib/auth/credential-admission.server')>()),
  admitPresentedWebCredential: async (credential: string) => {
    const result = await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret });
    if (result.status === 'unavailable') throw new Error('Owned authority unavailable');
    return result.status === 'admitted' ? result.session.userId : null;
  },
}));

let server: Server;
let origin: string;
const secret = 'synthetic-web-backend-proof-secret';
const rpcSecret = 'synthetic-web-private-proof-rpc-secret-6975';
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: 'js-trim-lower-v1',
  expectedWriterEpoch: 1,
};
type JwtParameters = Parameters<NonNullable<NonNullable<NextAuthOptions['callbacks']>['jwt']>>[0];
function callback(parameters: Partial<JwtParameters>) {
  const jwt = authOptions.callbacks?.jwt;
  if (!jwt) throw new Error('Missing real JWT callback');
  return jwt(parameters as JwtParameters);
}
function credentialsProvider(options: NextAuthOptions) {
  const configured = options.providers.find((entry) => (entry.options?.id ?? entry.id) === 'credentials');
  if (!configured || configured.type !== 'credentials') throw new Error('Missing credentials provider');
  return { ...configured, ...configured.options };
}
async function signIn() {
  const id = randomUUID();
  const email = `web-race-${id}@example.com`;
  await environment.database.insert(users).values({ id, email, name: 'Climber' });
  await environment.database
    .insert(userCredentials)
    .values({ userId: id, passwordHash: await hash(' exact-password ', 4) });
  const client = createPasswordCommandClient({
    environment: {
      NODE_ENV: 'test',
      CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
      CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
      CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin,
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    },
  });
  const request = createPasswordCommandAuthRequest(authOptions, () => client);
  const user = await credentialsProvider(request.options).authorize(
    { email, password: ' exact-password ' },
    { headers: {} },
  );
  if (!user?.webCredentialProof) throw new Error('Missing real backend proof');
  return { id, user, proof: user.webCredentialProof };
}

describe('real backend RPC → real web JWT callback → encrypted cookie admission', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    holder.database = environment.database;
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    server = createServer((request, response) => {
      void (
        request.url?.endsWith('/signout')
          ? handleCurrentStoreWebSignOut(request, response, environment.database)
          : handleCurrentStoreWebAuth(request, response, environment.database)
      ).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing owned server address');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', secret);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', origin);
    vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'synthetic-web-proof-deleted-address-key');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await environment?.close();
  });

  it('cannot acquire a newer generation when reset commits after backend reply but before cookie creation', async () => {
    const accepted = await signIn();
    await environment.database.transaction(async (transaction) => {
      await lockEnforcedProjection(transaction, authority);
      await transaction.select().from(users).where(eq(users.id, accepted.id)).for('update');
      await transaction
        .update(userCredentials)
        .set({ passwordHash: 'synthetic-replacement-after-real-proof' })
        .where(eq(userCredentials.userId, accepted.id));
      await recordSecurityMutation(transaction, {
        ...authority,
        userId: accepted.id,
        operationId: randomUUID(),
        expectedGeneration: 0,
        kind: 'password-reset',
        domains: ['first-party', 'partner'],
      });
    });
    // The web DB now truly contains gen1. Reading it here would resurrect the proof.
    const claims = await callback({
      token: { sub: accepted.id },
      user: accepted.user,
      account: { provider: 'credentials', type: 'credentials', providerAccountId: accepted.id },
    });
    expect(claims.gen).toBe(0);
    expect(claims.authSessionId).toBe(accepted.proof.authSessionId);
    const cookie = await encode({ token: claims, secret, maxAge: 3600 });
    expect(
      await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential: cookie, secret }),
    ).toEqual({ status: 'denied' });
  });

  it('a genuine login is guarded even with partner mode off, and renewal keeps SID/gen/age', async () => {
    const accepted = await signIn();
    const claims = await callback({
      token: { sub: accepted.id },
      user: accepted.user,
      account: { provider: 'credentials', type: 'credentials', providerAccountId: accepted.id },
    });
    expect(claims.link_guarded).toBe(true);
    expect(claims.auth_time).toBe(Math.floor(Date.parse(accepted.proof.authenticatedAt!) / 1000));
    const rotated = await callback({ token: { ...claims } as JWT });
    expect(rotated).toMatchObject({
      gen: claims.gen,
      auth_time: claims.auth_time,
      authSessionId: claims.authSessionId,
      link_guarded: true,
    });
  });

  it('required mode refuses a user object without a backend proof, with no generation-zero fallback', async () => {
    await expect(
      callback({
        token: {},
        user: { id: randomUUID() },
        account: { provider: 'credentials', type: 'credentials', providerAccountId: 'synthetic' },
      }),
    ).rejects.toThrow('Backend web credential proof required');
  });
  it('delegates set-password over real HTTP and emits a replacement with identical age/SID and bounded expiry', async () => {
    const id = randomUUID();
    const sid = randomUUID();
    await environment.database.insert(users).values({ id, email: `web-set-${id}@example.com`, emailVerified: null });
    await environment.database
      .insert(accounts)
      .values({ userId: id, provider: 'google', providerAccountId: randomUUID(), type: 'oauth' });
    const authTime = Math.floor(Date.now() / 1000) - 30;
    const source = await encode({
      token: { sub: id, authSessionId: sid, gen: 0, auth_time: authTime, link_guarded: true },
      secret,
      maxAge: 3600,
    });
    const request = new NextRequest('http://localhost:3000/api/internal/set-password', {
      method: 'POST',
      headers: { cookie: `next-auth.session-token=${source}` },
    });
    const response = await delegateSetPassword(request, ' next-password ', ' next-password ', {
      userId: id,
      authSessionId: sid,
    });
    expect(response?.status).toBe(200);
    const replacement = response?.cookies.get('next-auth.session-token')?.value;
    expect(replacement).toBeTruthy();
    const claims = await decode({ token: replacement!, secret });
    const original = await decode({ token: source, secret });
    expect(claims).toMatchObject({ sub: id, authSessionId: sid, gen: 1, auth_time: authTime, link_guarded: true });
    const sourceExpiry = original?.exp;
    const replacementExpiry = claims?.exp;
    if (typeof sourceExpiry !== 'number' || typeof replacementExpiry !== 'number')
      throw new Error('Missing signed expiry');
    expect(replacementExpiry).toBeLessThanOrEqual(sourceExpiry);
    expect((await environment.database.select().from(users).where(eq(users.id, id)))[0].emailVerified).toBeNull();
  });

  it('refuses a replacement whose delayed encoder would extend the original signed expiry', async () => {
    const id = randomUUID();
    const sid = randomUUID();
    await environment.database.insert(users).values({ id, email: `synthetic-encoding-delay-${id}@example.test` });
    const source = await encode({
      token: { sub: id, authSessionId: sid, gen: 0, auth_time: Math.floor(Date.now() / 1000) - 15, link_guarded: true },
      secret,
      maxAge: 3600,
    });
    const milliseconds = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(milliseconds);
    holder.beforeEncode = () => {
      clock.mockReturnValue(milliseconds + 3500);
    };
    let refused = false;
    try {
      await delegateSetPassword(
        new NextRequest('http://localhost:3000/api/internal/set-password', {
          method: 'POST',
          headers: { cookie: `next-auth.session-token=${source}` },
        }),
        ' delayed-password ',
        ' delayed-password ',
        { userId: id, authSessionId: sid },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(AuthBackendUnavailableError);
      refused = true;
    } finally {
      holder.beforeEncode = undefined;
      clock.mockRestore();
    }
    expect(refused).toBe(true);
  });

  it('refuses to publish a replacement if a second reset commits after the set-password reply', async () => {
    const id = randomUUID();
    const sid = randomUUID();
    await environment.database.insert(users).values({ id, email: `web-second-reset-${id}@example.com` });
    const source = await encode({
      token: { sub: id, authSessionId: sid, gen: 0, auth_time: Math.floor(Date.now() / 1000) - 15, link_guarded: true },
      secret,
      maxAge: 3600,
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (...parameters: Parameters<typeof fetch>) => {
      const response = await originalFetch(...parameters);
      const destination =
        typeof parameters[0] === 'string'
          ? parameters[0]
          : parameters[0] instanceof URL
            ? parameters[0].href
            : parameters[0].url;
      if (destination.endsWith('/set-password') && response.ok) {
        await environment.database.transaction(async (transaction) => {
          await lockEnforcedProjection(transaction, authority);
          await transaction.select().from(users).where(eq(users.id, id)).for('update');
          await recordSecurityMutation(transaction, {
            ...authority,
            userId: id,
            operationId: randomUUID(),
            expectedGeneration: 1,
            kind: 'password-reset',
            domains: ['first-party', 'partner'],
          });
        });
      }
      return response;
    });
    const response = await delegateSetPassword(
      new NextRequest('http://localhost:3000/api/internal/set-password', {
        method: 'POST',
        headers: { cookie: `next-auth.session-token=${source}` },
      }),
      ' next-password ',
      ' next-password ',
      { userId: id, authSessionId: sid },
    );
    expect(response?.status).toBe(403);
    expect(response?.headers.get('set-cookie')).toBeNull();
  });

  it('keeps the independent sign-out writer active after bridge/web-writer rollback, with idempotent SID denial', async () => {
    const id = randomUUID();
    const sid = randomUUID();
    await environment.database.insert(users).values({ id, email: `signout-${id}@example.com` });
    const credential = await encode({ token: { sub: id, authSessionId: sid, gen: 0 }, secret, maxAge: 3600 });
    vi.stubEnv('CURRENT_STORE_WEB_SIGNOUT_MODE', 'backend-staging');
    vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'off');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    await forwardWebSignOut(credential);
    await forwardWebSignOut(credential);
    expect((await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret })).status).toBe(
      'denied',
    );
  });

  it('does not acknowledge revocation of an unrecoverable no-SID credential', async () => {
    const id = randomUUID();
    await environment.database.insert(users).values({ id, email: `no-sid-${id}@example.com` });
    const credential = await encode({ token: { sub: id, gen: 0 }, secret, maxAge: 3600 });
    vi.stubEnv('CURRENT_STORE_WEB_SIGNOUT_MODE', 'backend-staging');
    await expect(forwardWebSignOut(credential)).rejects.toThrow();
    expect((await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret })).status).toBe(
      'admitted',
    );
  });
});
