import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  WEB_OAUTH_COMMAND_PATHS,
  WEB_OAUTH_PROTOCOL_VERSION,
  webOAuthReplySchema,
  type WebOAuthResolveReply,
  type WebOAuthSessionRequest,
} from '@boardsesh/auth-protocol';
import { authEmailProjection, authSession, authWebOAuthIntents, users } from '@boardsesh/db/schema/auth';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { createProviderSecurityDriver } from './provider-security-fixture';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { switchIdentityAuthority } from '../router';
import { readFirstPartySession, requireFreshAuthentication, type FirstPartyCredential } from '../session-reader';
import { handleCurrentStoreWebOAuth } from '../../../handlers/current-store-web-oauth';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';

// #7596 B5a: Google and Apple web sign-in issue a first-party web session over
// the real private HTTP transport and the qualified restricted LOGIN. It
// replaces the browser-binding anonymous sign-in proof.
recordFunctionLevelIdentityMirrorForTests();

vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_WEB_OAUTH_DATABASE');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_WEB_OAUTH_DATABASE');
      },
    },
  ),
}));
const configuredContract = process.env.AUTH_CREDENTIAL_HTTP_CONTRACT ?? 'private-provider-v1';
if (
  configuredContract !== 'private-provider-v1' &&
  configuredContract !== 'private-first-password-v1' &&
  configuredContract !== 'private-native-handoff-v1' &&
  configuredContract !== 'private-browser-renewal-v1'
)
  throw new Error('OWNED_WEB_OAUTH_SESSION_CONTRACT_REQUIRED');
const contract = configuredContract;
const rpcSecret = 'owned-web-oauth-session-http-rpc-secret-7596';
const sourceSecret = 'owned-web-oauth-session-http-codec-secret-7596';
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
let projectionId: string = randomUUID();

async function post(operation: 'intent' | 'resolve', body: Record<string, unknown>) {
  const response = await fetch(`${origin}${WEB_OAUTH_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
      requestId: randomUUID(),
      issuedAt: new Date().toISOString(),
      operation,
      ...body,
    }),
  });
  expect(response.headers.get('set-cookie')).toBeNull();
  return { status: response.status, body: (await response.json()) as unknown };
}
async function signIn(input: {
  provider: 'google' | 'apple';
  subject: string;
  webSession?: WebOAuthSessionRequest;
}): Promise<{ status: number; body: unknown }> {
  const flow = randomBytes(32).toString('hex');
  const intent = await post('intent', { payload: { provider: input.provider, flow, actorCookie: null } });
  expect(intent.status).toBe(200);
  return post('resolve', {
    credentialProofVersion: 1,
    ...(input.webSession ? { webSession: input.webSession } : {}),
    payload: {
      provider: input.provider,
      flow,
      actorCookie: null,
      subject: input.subject,
      email: `web-oauth-session-${randomUUID()}@example.test`,
      name: null,
      image: null,
    },
  });
}
function resolved(body: unknown): Extract<WebOAuthResolveReply, { outcome: 'resolved' }> {
  const reply = webOAuthReplySchema.parse(body);
  if (reply.operation !== 'resolve' || reply.outcome !== 'resolved') throw new Error('Owned sign-in not resolved');
  return reply;
}
async function admit(credential: FirstPartyCredential) {
  return environment.ownerDatabase.transaction((transaction) =>
    readFirstPartySession(transaction, credential, new Date(), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    ),
  );
}
async function selectAuthority(selected: 'current-store' | 'better-auth') {
  await environment.ownerDatabase.transaction(async (transaction) => {
    const [manifest] = await transaction
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.isCurrent, true));
    if (manifest.writerAuthority !== selected)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: manifest.writerEpoch,
        from: manifest.writerAuthority,
        to: selected,
      });
  });
}
async function driver() {
  return createProviderSecurityDriver({
    database: await getCredentialDatabase('private-provider-v1'),
    runtime: {
      qualification: {
        expectedProjectionId: projectionId,
        expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      },
      legacySecret: sourceSecret,
      methods: { configuredProviders: ['google', 'apple'], googleAudience: null, googleReauthenticationEnabled: false },
    },
  });
}
/** An Apple account with its email reserved, as a sign-in finds it. */
async function appleOwner(selected: 'current-store' | 'better-auth') {
  const subject = randomUUID();
  const owner = await (await driver()).actor(selected, 'canonical-token', { provider: 'apple', subject });
  const [stored] = await environment.ownerDatabase.select().from(users).where(eq(users.id, owner.userId));
  const [manifest] = await environment.ownerDatabase
    .select()
    .from(authEmailProjection)
    .where(eq(authEmailProjection.isCurrent, true));
  await environment.ownerDatabase.transaction((transaction) =>
    reserveEnforcedEmail(transaction, {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: manifest.writerEpoch,
      rawEmail: stored.email,
      requestedUserId: stored.id,
    }),
  );
  return { ...owner, subject };
}

describe('web OAuth sign-in issues a web session through the qualified LOGIN and real HTTP', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment(contract);
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [manifest] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (manifest) {
        if (manifest.phase !== 'enforced') throw new Error('Owned web OAuth proof requires enforced projection');
        projectionId = manifest.projectionId;
      } else {
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction.update(authEmailProjection).set({ phase: 'enforced' });
      }
    });
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`GRANT SELECT ON public.users,public.auth_subject_cutoffs,public.auth_session_denials TO boardsesh_retired_runtime`;
    server = createServer((request, response) => {
      void handleCurrentStoreWebOAuth(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned HTTP address missing');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: contract,
      CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
      CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
      CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'compatible',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-web-oauth-session-retired-email-digest-secret-7596',
      NEXTAUTH_SECRET: sourceSecret,
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_IDENTITY_MIRROR: 'on',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, content);
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await closeCredentialDatabase();
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await environment?.close();
  });

  it('asks for its own mode: without the web session mode a session request is 404 and nothing runs', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    const owner = await appleOwner('better-auth');
    const before = await environment.ownerDatabase.select().from(authSession).orderBy(authSession.id);
    const refused = await signIn({ provider: 'apple', subject: owner.subject, webSession: {} });
    expect(refused).toEqual({ status: 404, body: { error: 'disabled' } });
    expect(await environment.ownerDatabase.select().from(authSession).orderBy(authSession.id)).toEqual(before);
    // Without a session request the reply is today's, with no session in it.
    const plain = await signIn({ provider: 'apple', subject: owner.subject });
    expect(plain.status).toBe(200);
    expect(resolved(plain.body)).not.toHaveProperty('webSession');
  });

  for (const selected of ['current-store', 'better-auth'] as const)
    it(`${selected}: an Apple sign-in issues a carried session under the proof's id and revokes the presented one`, async () => {
      await selectAuthority(selected);
      const principal = await executeFirstRow<{ role: string; sessionRole: string }>(
        await getCredentialDatabase('private-provider-v1'),
        sql`SELECT current_user AS role, session_user AS "sessionRole"`,
      );
      expect(principal).toEqual({ role: 'boardsesh_identity_writer', sessionRole: 'boardsesh_identity_writer' });
      const owner = await appleOwner(selected);
      const previous = await (await driver()).actor(selected, 'canonical-token');
      const response = await signIn({
        provider: 'apple',
        subject: owner.subject,
        webSession: { presented: previous.webActor.presented },
      });
      expect(response.status).toBe(200);
      const reply = resolved(response.body);
      expect(reply.user.id).toBe(owner.userId);
      expect(reply.credentialProof).toMatchObject({
        authSessionId: reply.webSession!.sessionId,
        generation: reply.webSession!.generation,
        authenticatedAt: null,
        linkGuarded: false,
      });
      const issued = await admit({ kind: 'canonical-token', token: reply.webSession!.token });
      if (issued.status !== 'admitted') throw new Error('Issued session not admitted');
      expect(issued.session).toMatchObject({ userId: owner.userId, source: 'bridge' });
      expect(requireFreshAuthentication(issued.session)).toBe(false);
      expect(await admit(previous.credential)).toEqual({ status: 'denied' });
    });

  it('a new Google account signs in with a carried session through the restricted LOGIN', async () => {
    await selectAuthority('better-auth');
    const response = await signIn({ provider: 'google', subject: randomUUID(), webSession: {} });
    expect(response.status).toBe(200);
    const reply = resolved(response.body);
    expect(reply.createdUser).toBe(true);
    const issued = await admit({ kind: 'canonical-token', token: reply.webSession!.token });
    expect(issued).toMatchObject({ status: 'admitted', session: { userId: reply.user.id, source: 'bridge' } });
  });

  it('a refused session write rolls the whole sign-in back: 503, intent unconsumed, presented session kept', async () => {
    await selectAuthority('better-auth');
    const owner = await appleOwner('better-auth');
    const previous = await (await driver()).actor('better-auth', 'canonical-token');
    const flow = randomBytes(32).toString('hex');
    expect((await post('intent', { payload: { provider: 'apple', flow, actorCookie: null } })).status).toBe(200);
    const sessionsBefore = await environment.ownerDatabase.select().from(authSession).orderBy(authSession.id);
    await environment.owner`REVOKE INSERT ON public.auth_session FROM boardsesh_identity_writer`;
    try {
      const refused = await post('resolve', {
        credentialProofVersion: 1,
        webSession: { presented: previous.webActor.presented },
        payload: {
          provider: 'apple',
          flow,
          actorCookie: null,
          subject: owner.subject,
          email: `web-oauth-session-${randomUUID()}@example.test`,
          name: null,
          image: null,
        },
      });
      expect(refused).toEqual({ status: 503, body: { error: 'unavailable' } });
    } finally {
      await environment.resetGrants();
    }
    expect(await environment.ownerDatabase.select().from(authSession).orderBy(authSession.id)).toEqual(sessionsBefore);
    const [intent] = await environment.ownerDatabase
      .select()
      .from(authWebOAuthIntents)
      .where(eq(authWebOAuthIntents.flowHash, flow));
    expect(intent.consumedAt).toBeNull();
    expect(await admit(previous.credential)).toMatchObject({ status: 'admitted' });
  });
});
