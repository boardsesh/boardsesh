import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  WEB_OAUTH_COMMAND_PATHS,
  WEB_OAUTH_PROTOCOL_VERSION,
  authCommandReplySchema,
  webOAuthReplySchema,
  type AuthCommand,
  type WebCredentialProof,
} from '@boardsesh/auth-protocol';
import { executeFirstRow } from '@boardsesh/db/client';
import { sql } from 'drizzle-orm';
import { authAccount, authEmailProjection, userCredentials, users } from '@boardsesh/db/schema/auth';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { handleCurrentStoreWebOAuth } from '../../../handlers/current-store-web-oauth';
import { handleCurrentStoreWebSignOut } from '../../../handlers/current-store-web-signout';
import * as passwordCommands from '../../current-store/web-password';
import { assertWebSessionWriterConfiguration } from '../../current-store/web-session-configuration';

// Production defaults must obtain the qualified pool, never an imported shared handle.
vi.mock('../../../db/client', () => {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_CREDENTIAL_DATABASE');
      },
    },
  );
  return { db: forbidden, dbRead: forbidden };
});

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
};
const rpcSecret = 'owned-default-credential-rpc-secret-6975';
const sessionSecret = 'owned-default-credential-cookie-secret-6975';
const originalPassword = ' owned original password ';
const nextPassword = ' owned replacement password ';
const selectedHttpContract = process.env.AUTH_CREDENTIAL_HTTP_CONTRACT;
if (
  selectedHttpContract &&
  selectedHttpContract !== 'private-provider-v1' &&
  selectedHttpContract !== 'private-first-password-v1' &&
  selectedHttpContract !== 'private-native-handoff-v1' &&
  selectedHttpContract !== 'private-browser-renewal-v1'
)
  throw new Error('OWNED_CREDENTIAL_HTTP_CONTRACT_REQUIRED');
const httpContract =
  selectedHttpContract === 'private-browser-renewal-v1'
    ? 'private-browser-renewal-v1'
    : selectedHttpContract === 'private-native-handoff-v1'
      ? 'private-native-handoff-v1'
      : selectedHttpContract === 'private-first-password-v1'
        ? 'private-first-password-v1'
        : selectedHttpContract === 'private-provider-v1'
          ? 'private-provider-v1'
          : 'private-web-v1';
let projectionId: string = randomUUID();
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
let registrationFailure: string | undefined;

function safeFixtureFailure(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== 'object') break;
    if ('code' in current && typeof current.code === 'string') {
      return current.code === '42501' && 'message' in current && typeof current.message === 'string'
        ? `${current.code}: ${current.message}`
        : current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return 'OWNED_REGISTRATION_REFUSED';
}

async function selectAuthority(to: IdentityAuthorityName) {
  await environment.ownerDatabase.transaction(async (transaction) => {
    const [manifest] = await transaction
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.isCurrent, true));
    if (!manifest) throw new Error('Missing owned projection');
    if (manifest.writerAuthority !== to)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: manifest.writerEpoch,
        from: manifest.writerAuthority,
        to,
      });
  });
}

async function authCommand(operation: AuthCommand['operation'], payload: unknown) {
  const response = await fetch(`${origin}${AUTH_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation,
      requestId: randomUUID(),
      issuedAt: Date.now(),
      credentialProofVersion: operation === 'password' ? 1 : undefined,
      payload,
    }),
  });
  const reply: unknown = await response.json();
  if (reply && typeof reply === 'object' && 'error' in reply && typeof reply.error === 'string')
    throw new Error(`OWNED_HTTP_${operation}_${response.status}_${reply.error}`);
  return { status: response.status, reply: authCommandReplySchema.parse(reply) };
}

async function providerCommand(operation: 'intent' | 'resolve', payload: Record<string, unknown>) {
  const response = await fetch(`${origin}${WEB_OAUTH_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
      operation,
      requestId: randomUUID(),
      issuedAt: new Date().toISOString(),
      credentialProofVersion: operation === 'resolve' ? 1 : undefined,
      payload,
    }),
  });
  return { status: response.status, reply: webOAuthReplySchema.parse(await response.json()) };
}

function encodeCredential(proof: WebCredentialProof) {
  return jwt.encode({
    secret: sessionSecret,
    maxAge: 3600,
    token: {
      sub: proof.userId,
      authSessionId: proof.authSessionId,
      gen: proof.generation,
      auth_time: proof.authenticatedAt ? Math.floor(new Date(proof.authenticatedAt).getTime() / 1000) : undefined,
      link_guarded: proof.linkGuarded,
      ...(proof.requiresAccountCutoff ? { legacy_no_sid: true } : {}),
    },
  });
}

describe('mounted private commands on the actual qualified credential LOGIN', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment(httpContract);
    // The generic content LOGIN supplies admission reads, never credential writes.
    await environment.owner`REVOKE INSERT,UPDATE,DELETE ON public.users FROM boardsesh_retired_runtime`;
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`GRANT SELECT ON public.users, public.auth_subject_cutoffs, public.auth_session_denials TO boardsesh_retired_runtime`;
    await expect(environment.legacy`UPDATE public.users SET name=name WHERE false`).rejects.toMatchObject({
      code: '42501',
    });
    const register = passwordCommands.registerWebPassword;
    vi.spyOn(passwordCommands, 'registerWebPassword').mockImplementation(async (...parameters) => {
      try {
        return await register(...parameters);
      } catch (error) {
        registrationFailure = safeFixtureFailure(error);
        throw error;
      }
    });
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (existing) {
        if (existing.phase !== 'enforced') throw new Error('Owned HTTP proof requires its enforced projection');
        projectionId = existing.projectionId;
      } else {
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction
          .update(authEmailProjection)
          .set({ phase: 'enforced' })
          .where(eq(authEmailProjection.projectionId, projectionId));
      }
    });
    server = createServer((request, response) => {
      const handler = request.url?.startsWith(WEB_OAUTH_COMMAND_PATHS.intent.replace('/intent', ''))
        ? handleCurrentStoreWebOAuth
        : request.url === AUTH_COMMAND_PATHS.signout
          ? handleCurrentStoreWebSignOut
          : handleCurrentStoreWebAuth;
      void handler(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned private server failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    registrationFailure = undefined;
    vi.stubEnv('DATABASE_URL', environment.legacyUrl);
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', environment.writerUrl);
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', httpContract);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_WEB_SIGNOUT_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
    vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'owned-default-credential-deleted-email-key-6975');
    vi.stubEnv('NEXTAUTH_SECRET', sessionSecret);
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'enforce');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'true');
    assertWebSessionWriterConfiguration();
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await closeCredentialDatabase();
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await environment?.close();
  });

  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected}: registers, verifies, signs in, resets and signs out through default HTTP handlers`, async () => {
      await selectAuthority(selected);
      const email = `owned-default-${randomUUID()}@example.test`;
      const registration = await authCommand('register', { email, password: originalPassword, name: 'Owned climber' });
      expect(registration.status, registrationFailure).toBe(201);
      expect(registration.reply.outcome).toBe('created');
      if (
        registration.reply.operation !== 'register' ||
        registration.reply.outcome !== 'created' ||
        !registration.reply.requiresVerification
      )
        throw new Error('Owned registration did not produce its verification plan');
      const userId = registration.reply.userId;
      const principal = await executeFirstRow<{ role: string; sessionRole: string }>(
        await getCredentialDatabase(),
        sql`SELECT current_user AS role,session_user AS "sessionRole"`,
      );
      expect(principal).toEqual({ role: 'boardsesh_identity_writer', sessionRole: 'boardsesh_identity_writer' });
      const resend = await authCommand('resend-verification', { email });
      if (
        resend.reply.operation !== 'resend-verification' ||
        resend.reply.outcome !== 'accepted' ||
        !resend.reply.mailPlan
      )
        throw new Error('Owned resend command did not produce its private plan');
      expect(resend.reply.mailPlan.token).not.toBe(registration.reply.mailPlan.token);
      expect((await authCommand('verify-email', { token: registration.reply.mailPlan.token })).reply.outcome).toBe(
        'invalid_token',
      );
      expect((await authCommand('verify-email', { token: resend.reply.mailPlan.token })).reply.outcome).toBe(
        'verified',
      );
      const authenticated = await authCommand('password', { email: email.toUpperCase(), password: originalPassword });
      expect(authenticated.reply.outcome).toBe('authenticated');
      if (
        authenticated.reply.operation !== 'password' ||
        authenticated.reply.outcome !== 'authenticated' ||
        !authenticated.reply.credentialProof
      )
        throw new Error('Owned password command did not return its proof');
      expect(authenticated.reply.user.id).toBe(userId);
      const forgot = await authCommand('forgot-password', { email });
      if (forgot.reply.operation !== 'forgot-password' || forgot.reply.outcome !== 'accepted' || !forgot.reply.mailPlan)
        throw new Error('Owned recovery command did not produce a private plan');
      expect(
        (
          await authCommand('reset-password', {
            token: forgot.reply.mailPlan.token,
            password: nextPassword,
            confirmPassword: nextPassword,
          })
        ).reply.outcome,
      ).toBe('reset');
      expect((await authCommand('password', { email, password: originalPassword })).reply.outcome).toBe(
        'invalid_credentials',
      );
      const fresh = await authCommand('password', { email, password: nextPassword });
      if (
        fresh.reply.operation !== 'password' ||
        fresh.reply.outcome !== 'authenticated' ||
        !fresh.reply.credentialProof
      )
        throw new Error('Owned fresh password proof unavailable');
      const proof = fresh.reply.credentialProof;
      const credential = await encodeCredential(proof);
      expect((await authCommand('signout', { credential })).reply.outcome).toBe('signed_out');
      const [legacy] = await environment.ownerDatabase
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, userId));
      const [canonical] = await environment.ownerDatabase
        .select()
        .from(authAccount)
        .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')));
      expect(canonical.password).toBe(legacy.passwordHash);
      expect(
        (await environment.ownerDatabase.select().from(users).where(eq(users.id, userId)))[0].emailVerified,
      ).toBeInstanceOf(Date);
    });

    it(`${selected}: resolves a provider and sets its first password through the qualified connection`, async () => {
      await selectAuthority(selected);
      const flow = randomBytes(32).toString('hex');
      const payload = { provider: 'google', flow, actorCookie: null };
      expect((await providerCommand('intent', payload)).reply.outcome).toBe('recorded');
      const resolved = await providerCommand('resolve', {
        ...payload,
        subject: randomUUID(),
        email: `owned-provider-${randomUUID()}@example.test`,
        name: 'Owned provider climber',
        image: null,
      });
      expect(resolved.reply.outcome).toBe('resolved');
      if (
        resolved.reply.operation !== 'resolve' ||
        resolved.reply.outcome !== 'resolved' ||
        !resolved.reply.credentialProof
      )
        throw new Error('Owned provider command did not return its proof');
      const proof = resolved.reply.credentialProof;
      const set = await authCommand('set-password', {
        credential: await encodeCredential(proof),
        expectedUserId: proof.userId,
        expectedAuthSessionId: proof.authSessionId,
        password: nextPassword,
        confirmPassword: nextPassword,
      });
      expect(set.reply.outcome).toBe('set');
      if (set.reply.operation !== 'set-password' || set.reply.outcome !== 'set')
        throw new Error('Owned first-password command did not return its continuation');
      expect(set.reply.credentialProof).toMatchObject({
        userId: proof.userId,
        authSessionId: proof.authSessionId,
        generation: proof.generation + 1,
        authenticatedAt: new Date(Math.floor(new Date(proof.authenticatedAt!).getTime() / 1000) * 1000).toISOString(),
        linkGuarded: proof.linkGuarded,
      });
      expect(
        (await authCommand('password', { email: resolved.reply.user.email, password: nextPassword })).reply.outcome,
      ).toBe('authenticated');
      const [legacy] = await environment.ownerDatabase
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, proof.userId));
      const [canonical] = await environment.ownerDatabase
        .select()
        .from(authAccount)
        .where(and(eq(authAccount.userId, proof.userId), eq(authAccount.providerId, 'credential')));
      expect(canonical.password).toBe(legacy.passwordHash);
    });
  }
});
