import { encodeLegacyTestCredential } from './provider-security-fixture';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  WEB_SESSION_COMMAND_PATHS,
  WEB_SESSION_PROTOCOL_VERSION,
  passwordReplySchema,
  setPasswordReplySchema,
  webSessionAccessReplySchema,
  webSessionBridgeReplySchema,
  webSessionReadReplySchema,
  webSessionSignOutReplySchema,
  type PresentedWebSession,
} from '@boardsesh/auth-protocol';
import { authEmailProjection, authSession, userCredentials, userProfiles, users } from '@boardsesh/db/schema';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { closeCredentialDatabase } from '../../credential-database';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { handleCurrentStoreWebSession } from '../../../handlers/current-store-web-session';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';
import { switchIdentityAuthority } from '../router';

// #7596 B7: every web-session command over real HTTP on the qualified
// credential LOGIN, the way production runs them. The integration proofs inject
// the owner's connection, which is how the session read's SELECT on
// user_profiles (a table the LOGIN may not read) reached the browser
// acceptance run: every session read answered 503. A statement on a table or
// column the reviewed contract does not grant fails here as a 503.
// Provider security and first password are covered the same way by
// provider-security-http.proof.ts and first-password-http.proof.ts.
recordFunctionLevelIdentityMirrorForTests();

// The application connection is unreachable here, as when it is down: the
// session read must still answer, with the account's own name.
vi.mock('../../../db/client', () => {
  const unreachable = new Proxy(
    {},
    {
      get() {
        throw new Error('APPLICATION_DATABASE_UNREACHABLE');
      },
    },
  );
  return { db: unreachable, dbRead: unreachable };
});

const configuredContract = process.env.AUTH_CREDENTIAL_HTTP_CONTRACT ?? 'private-first-password-v1';
if (
  configuredContract !== 'private-provider-v1' &&
  configuredContract !== 'private-first-password-v1' &&
  configuredContract !== 'private-native-handoff-v1' &&
  configuredContract !== 'private-browser-renewal-v1'
)
  throw new Error('OWNED_WEB_SESSION_CONTRACT_REQUIRED');
const contract = configuredContract;
const rpcSecret = 'owned-web-session-writer-rpc-secret-7596-b7';
const nextAuthSecret = 'owned-web-session-writer-nextauth-secret-7596-b7';
const PASSWORD = 'owned web session writer password';
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin = '';
let projectionId: string = randomUUID();
/** The manifest's writer epoch: the suites before this one in its run may have moved it. */
let writerEpoch = 1;
/** The authority the suites before this one left selected; restored afterwards, as they expect it. */
let foundAuthority: 'current-store' | 'better-auth' = 'current-store';

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  // www owns the cookie: no private reply may set one.
  expect(response.headers.get('set-cookie')).toBeNull();
  return { status: response.status, body: (await response.json()) as unknown };
}

/** Each command and the credential shape it was sent with, so the last test can name what was never sent. */
const sentCommands = new Set<string>();

function sessionCommand(operation: keyof typeof WEB_SESSION_COMMAND_PATHS, payload: Record<string, unknown>) {
  const presented = payload.presented as PresentedWebSession | undefined;
  sentCommands.add(presented ? `${operation}:${presented.kind}` : operation);
  return post(WEB_SESSION_COMMAND_PATHS[operation], {
    webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload,
  });
}

function authCommand(operation: 'password' | 'set-password', payload: Record<string, unknown>, extra = {}) {
  return post(AUTH_COMMAND_PATHS[operation], {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    ...extra,
    payload,
  });
}

async function climber(name: string) {
  const id = randomUUID();
  const email = `web-session-writer-${id}@example.test`;
  await environment.ownerDatabase.insert(users).values({ id, email, name, emailVerified: new Date() });
  await environment.ownerDatabase.insert(userCredentials).values({ userId: id, passwordHash: await hash(PASSWORD, 4) });
  // A sign-in within 60 s of a password write is held back.
  await environment.ownerDatabase
    .update(userCredentials)
    .set({ updatedAt: sql`now() - interval '10 minutes'` })
    .where(eq(userCredentials.userId, id));
  return { id, email, name };
}

async function login(email: string, presented?: PresentedWebSession) {
  const { status, body } = await authCommand(
    'password',
    { email, password: PASSWORD },
    { webSession: presented ? { presented } : {}, credentialProofVersion: 1 },
  );
  expect(status).toBe(200);
  const reply = passwordReplySchema.parse(body);
  if (reply.outcome !== 'authenticated' || !reply.webSession)
    throw new Error(`No web session issued: ${JSON.stringify({ ...reply, credentialProof: undefined })}`);
  return reply.webSession;
}

const canonical = (token: string): PresentedWebSession => ({ kind: 'canonical-token', token });

describe('web-session commands on the qualified credential LOGIN over real HTTP', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment(contract);
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [manifest] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (manifest) {
        if (manifest.phase !== 'enforced') throw new Error('Owned web session proof requires an enforced projection');
        projectionId = manifest.projectionId;
        // Passwords are on user_credentials, the current store's: select it if a suite before moved it.
        foundAuthority = manifest.writerAuthority;
        if (manifest.writerAuthority !== 'current-store')
          await switchIdentityAuthority(transaction, {
            projectionId,
            epoch: manifest.writerEpoch,
            from: manifest.writerAuthority,
            to: 'current-store',
          });
        const [current] = await transaction
          .select()
          .from(authEmailProjection)
          .where(eq(authEmailProjection.isCurrent, true));
        writerEpoch = current.writerEpoch;
      } else {
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction.update(authEmailProjection).set({ phase: 'enforced' });
      }
    });
    // The generic content LOGIN keeps the admission reads it has in production.
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`GRANT SELECT ON public.users, public.auth_subject_cutoffs, public.auth_session_denials TO boardsesh_retired_runtime`;
    server = createServer((request, response) => {
      const handler = request.url?.startsWith('/api/internal/auth/current-store/web-session/v1/')
        ? handleCurrentStoreWebSession
        : handleCurrentStoreWebAuth;
      void handler(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned web session server failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: contract,
      CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
      CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
      CURRENT_STORE_SET_PASSWORD_MODE: 'backend-staging',
      CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: String(writerEpoch),
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-web-session-writer-deleted-email-key-7596',
      NEXTAUTH_SECRET: nextAuthSecret,
      AUTH_BRIDGE_TOKEN_SECRET: 'owned-web-session-writer-bridge-token-secret-7596',
      AUTH_BROWSER_ACCESS_TOKEN_SECRET: 'owned-web-session-writer-access-token-secret-7596',
      AUTH_LEGACY_BRIDGE_UNTIL: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_IDENTITY_MIRROR: 'on',
      EMAIL_VERIFICATION_ENABLED: 'false',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, content);
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await closeCredentialDatabase();
    if (environment && foundAuthority !== 'current-store')
      await environment.ownerDatabase.transaction(async (transaction) => {
        const [manifest] = await transaction
          .select()
          .from(authEmailProjection)
          .where(eq(authEmailProjection.isCurrent, true));
        await switchIdentityAuthority(transaction, {
          projectionId,
          epoch: manifest.writerEpoch,
          from: manifest.writerAuthority,
          to: foundAuthority,
        });
      });
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await environment?.close();
  });

  it('login, session, access with a roll, set-password and sign-out all answer on the LOGIN', async () => {
    const account = await climber('Account Name');
    // A profile exists, but the application connection is down: the account's own name answers.
    await environment.ownerDatabase.insert(userProfiles).values({ userId: account.id, displayName: 'Profile Name' });
    const issued = await login(account.email);

    const read = await sessionCommand('session', { presented: canonical(issued.token) });
    expect(read.status).toBe(200);
    expect(webSessionReadReplySchema.parse(read.body)).toMatchObject({
      outcome: 'active',
      userId: account.id,
      authSessionId: issued.sessionId,
      source: 'login',
      user: { id: account.id, email: account.email, name: 'Account Name' },
    });

    // Under 29 days left: access rolls the row on the LOGIN and mints a token.
    await environment.ownerDatabase
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() + 28 * 86_400_000) })
      .where(eq(authSession.id, issued.sessionId));
    const access = await sessionCommand('access', { presented: canonical(issued.token) });
    expect(access.status).toBe(200);
    expect(webSessionAccessReplySchema.parse(access.body)).toMatchObject({ outcome: 'active', rolled: true });

    // Set-password on a fresh login of an account without a password keeps the session.
    await environment.ownerDatabase.delete(userCredentials).where(eq(userCredentials.userId, account.id));
    const set = await authCommand('set-password', {
      presented: canonical(issued.token),
      expectedUserId: account.id,
      expectedAuthSessionId: issued.sessionId,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });
    expect(set.status).toBe(200);
    expect(setPasswordReplySchema.parse(set.body)).toMatchObject({ outcome: 'set' });
    expect((await sessionCommand('session', { presented: canonical(issued.token) })).status).toBe(200);

    const signOut = await sessionCommand('signout', {
      presented: canonical(issued.token),
      expectedUserId: account.id,
      expectedAuthSessionId: issued.sessionId,
    });
    expect(signOut.status).toBe(200);
    expect(webSessionSignOutReplySchema.parse(signOut.body)).toMatchObject({ outcome: 'signed_out' });
    const after = await sessionCommand('session', { presented: canonical(issued.token) });
    expect(after.status).toBe(401);
  });

  it('a pre-cutover cookie bridges, reads and gets a token on the LOGIN, and a login presenting it ends it', async () => {
    const account = await climber('Bridged Account');
    const authSessionId = randomUUID();
    const credential = await encodeLegacyTestCredential({
      secret: nextAuthSecret,
      maxAge: 3600,
      token: { sub: account.id, authSessionId, gen: 0, auth_time: Math.floor(Date.now() / 1000) - 600 },
    });
    const bridged = await sessionCommand('bridge', { credential });
    expect(bridged.status).toBe(200);
    const reply = webSessionBridgeReplySchema.parse(bridged.body);
    if (reply.outcome !== 'bridged') throw new Error('Not bridged');
    expect(reply.sessionId).toBe(authSessionId);

    const read = await sessionCommand('session', { presented: canonical(reply.token) });
    expect(read.status).toBe(200);
    expect(webSessionReadReplySchema.parse(read.body)).toMatchObject({ outcome: 'active', source: 'bridge' });
    expect((await sessionCommand('access', { presented: canonical(reply.token) })).status).toBe(200);
    // The legacy cookie itself is read on the LOGIN too, and is told to bridge.
    const legacyAccess = await sessionCommand('access', { presented: { kind: 'legacy-jwe', credential } });
    expect(legacyAccess.status).toBe(401);

    // A login presenting the bridged session revokes it, on the LOGIN.
    await login(account.email, canonical(reply.token));
    expect((await sessionCommand('session', { presented: canonical(reply.token) })).status).toBe(401);
  });

  it('a pre-cutover cookie presented as itself is read and signed out on the LOGIN, and never bridges after', async () => {
    const account = await climber('Legacy Account');
    const authSessionId = randomUUID();
    const credential = await encodeLegacyTestCredential({
      secret: nextAuthSecret,
      maxAge: 3600,
      token: { sub: account.id, authSessionId, gen: 0, auth_time: Math.floor(Date.now() / 1000) - 600 },
    });
    const legacy: PresentedWebSession = { kind: 'legacy-jwe', credential };

    const read = await sessionCommand('session', { presented: legacy });
    expect(read.status).toBe(200);
    expect(webSessionReadReplySchema.parse(read.body)).toMatchObject({
      outcome: 'active',
      userId: account.id,
      authSessionId,
      user: { id: account.id, name: 'Legacy Account' },
    });

    const signOut = await sessionCommand('signout', {
      presented: legacy,
      expectedUserId: account.id,
      expectedAuthSessionId: authSessionId,
    });
    expect(signOut.status).toBe(200);
    expect(webSessionSignOutReplySchema.parse(signOut.body)).toMatchObject({ outcome: 'signed_out' });
    expect((await sessionCommand('session', { presented: legacy })).status).toBe(401);
    // The denial of its id is written on the LOGIN: the cookie is never bridged afterwards.
    const bridged = await sessionCommand('bridge', { credential });
    expect(webSessionBridgeReplySchema.parse(bridged.body)).toMatchObject({ outcome: 'denied' });
  });

  it('sent every web-session command, and each read and sign-out with both credential shapes', () => {
    const expected = Object.keys(WEB_SESSION_COMMAND_PATHS).flatMap((operation) =>
      operation === 'bridge' ? [operation] : [`${operation}:canonical-token`, `${operation}:legacy-jwe`],
    );
    expect(expected.filter((command) => !sentCommands.has(command))).toEqual([]);
  });
});
