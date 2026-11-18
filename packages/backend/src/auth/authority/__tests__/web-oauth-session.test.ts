import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  WEB_OAUTH_GOOGLE_NONCE_DOMAIN,
  WEB_OAUTH_PROTOCOL_VERSION,
  type WebOAuthProvider,
  type WebOAuthSessionRequest,
  type PresentedWebSession,
} from '@boardsesh/auth-protocol';
import {
  accounts,
  authAccount,
  authEmailReservationMembers,
  authEmailReservations,
  authProviderReauthenticationReceipts,
  authSession,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import type { DbInstance } from '@boardsesh/db/client';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { recordWebOAuthIntent, resolveWebOAuthIdentity } from '../../current-store/web-oauth-identity';
import { readFirstPartySession, requireFreshAuthentication, type FirstPartyCredential } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { captureIdentityAuthority } from '../router';
import { createProviderSecurityIntent, bindProviderSecurityFlow } from '../provider-security-intents';
import { normalizeAccountEmail } from '../../normalize-email';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';

// #7596 B5a: a Google or Apple web sign-in issues a first-party web session in
// the transaction that resolved the identity, revoking the one it arrived with.
recordFunctionLevelIdentityMirrorForTests();

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
type Owner = Awaited<ReturnType<typeof environment.actor>>;
const keyId = 'web-oauth-session-google-key';
const audience = 'owned-google-client';

const flowFor = (nonce: string) =>
  createHash('sha256')
    .update(JSON.stringify([WEB_OAUTH_GOOGLE_NONCE_DOMAIN, nonce]))
    .digest('hex');
async function authority() {
  const receipt = await environment.database.transaction((transaction) =>
    captureIdentityAuthority(transaction, environment.qualification),
  );
  return { ...environment.qualification, expectedWriterEpoch: receipt.epoch };
}
async function admit(credential: FirstPartyCredential) {
  return environment.database.transaction((transaction) =>
    readFirstPartySession(transaction, credential, new Date(), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    ),
  );
}
async function reserve(userId: string) {
  const [user] = await environment.database.select().from(users).where(eq(users.id, userId));
  const normalizedEmail = normalizeAccountEmail(user.email);
  await environment.database.insert(authEmailReservations).values({
    normalizedEmail,
    basisProjectionId: environment.qualification.expectedProjectionId,
    state: 'owned',
    ownerUserId: userId,
  });
  await environment.database.insert(authEmailReservationMembers).values({ normalizedEmail, userId });
}
/** An account that signs in with `provider`/`subject`, its email reserved. */
async function providerOwner(provider: WebOAuthProvider) {
  const subject = randomUUID();
  const owner = await environment.actor('better-auth', 'canonical-token', { provider, subject });
  await reserve(owner.userId);
  return { ...owner, subject };
}
function presentedOf(owner: Owner): PresentedWebSession {
  return owner.webActor.presented;
}
/** One complete sign-in: intent, then resolve, as www sends them. */
type SignIn = {
  provider: WebOAuthProvider;
  subject: string;
  email?: string | null;
  webSession?: WebOAuthSessionRequest;
  actorCookie?: string | null;
  flow?: string;
  credentialProof?: boolean;
};
async function recordIntent(provider: WebOAuthProvider, flow: string, actorCookie: string | null = null) {
  return recordWebOAuthIntent(environment.database as unknown as DbInstance, await authority(), environment.secret, {
    webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
    operation: 'intent',
    requestId: randomUUID(),
    issuedAt: new Date().toISOString(),
    payload: { provider, flow, actorCookie },
  });
}
async function resolve(input: SignIn & { flow: string }) {
  return resolveWebOAuthIdentity(environment.database as unknown as DbInstance, await authority(), environment.secret, {
    webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
    operation: 'resolve',
    requestId: randomUUID(),
    issuedAt: new Date().toISOString(),
    ...(input.credentialProof === false ? {} : { credentialProofVersion: 1 as const }),
    ...(input.webSession ? { webSession: input.webSession } : {}),
    payload: {
      provider: input.provider,
      flow: input.flow,
      actorCookie: input.actorCookie ?? null,
      subject: input.subject,
      email: input.email === undefined ? `${randomUUID()}@example.test` : input.email,
      name: null,
      image: null,
    },
  });
}
/** One complete sign-in: intent, then resolve, as www sends them. */
async function signIn(input: SignIn) {
  const flow = input.flow ?? randomBytes(32).toString('hex');
  const intent = await recordIntent(input.provider, flow, input.actorCookie ?? null);
  if (intent.outcome !== 'recorded') throw new Error('Owned sign-in intent refused');
  return resolve({ ...input, flow });
}
function resolved(reply: Awaited<ReturnType<typeof signIn>>) {
  if (reply.outcome !== 'resolved') throw new Error(`Owned sign-in not resolved: ${JSON.stringify(reply)}`);
  return reply;
}
async function googleToken(subject: string, nonce: string, authenticatedAgoSeconds = 30) {
  const seconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: 'https://accounts.google.com',
    aud: audience,
    sub: subject,
    nonce,
    auth_time: seconds - authenticatedAgoSeconds,
    iat: seconds,
    exp: seconds + 600,
  })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .sign(pair.privateKey);
}
async function linkedTo(userId: string, subject: string) {
  const rows = [
    ...(await environment.database
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerAccountId, subject)))),
    ...(await environment.database
      .select()
      .from(authAccount)
      .where(and(eq(authAccount.userId, userId), eq(authAccount.accountId, subject)))),
  ];
  return rows.length > 0;
}

describe('web OAuth sign-in issues a first-party web session (#7596 B5a)', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    pair = await generateKeyPair('RS256');
    publicKey = await exportJWK(pair.publicKey);
  });
  beforeEach(() => {
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'compatible');
    vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'web-oauth-session-deleted-email-key-0123456789');
    vi.stubEnv('NEXTAUTH_SECRET', environment.secret);
    vi.stubEnv('GOOGLE_CLIENT_ID', audience);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'owned-google-secret');
    vi.stubEnv('CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE', 'auth-time-staging');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const address = input instanceof Request ? input.url : String(input);
      if (address !== 'https://www.googleapis.com/oauth2/v3/certs') throw new Error('Unexpected provider test URL');
      return Response.json({ keys: [{ ...publicKey, kid: keyId, alg: 'RS256', use: 'sig' }] });
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => environment?.close());

  it('without webSession the reply is unchanged: no session, the proof as before', async () => {
    const owner = await providerOwner('apple');
    const reply = resolved(await signIn({ provider: 'apple', subject: owner.subject }));
    expect(Object.keys(reply).sort()).toEqual([
      'account',
      'createdUser',
      'credentialProof',
      'operation',
      'outcome',
      'requestId',
      'user',
      'webOAuthProtocolVersion',
    ]);
    expect(reply.credentialProof).toMatchObject({ userId: owner.userId, linkGuarded: true });
    expect(reply.credentialProof?.authenticatedAt).toEqual(expect.any(String));
    expect(
      await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId)),
    ).toHaveLength(1);
  });

  it('Apple issues a carried session: never fresh, proof under the same id with no sign-in time', async () => {
    const owner = await providerOwner('apple');
    const reply = resolved(await signIn({ provider: 'apple', subject: owner.subject, webSession: {} }));
    const issued = reply.webSession!;
    expect(issued).toMatchObject({ generation: 0, sessionId: expect.any(String), token: expect.any(String) });
    expect(reply.credentialProof).toMatchObject({
      userId: owner.userId,
      authSessionId: issued.sessionId,
      generation: issued.generation,
      authenticatedAt: null,
      linkGuarded: false,
    });
    const session = await admit({ kind: 'canonical-token', token: issued.token });
    if (session.status !== 'admitted') throw new Error('Issued session not admitted');
    expect(session.session).toMatchObject({ userId: owner.userId, authSessionId: issued.sessionId, source: 'bridge' });
    expect(requireFreshAuthentication(session.session)).toBe(false);
    expect(session.session.authenticatedAt).toBeInstanceOf(Date);
  });

  it('a silent Google sign-in, or one whose token is stale or not bound to the flow, is carried', async () => {
    const owner = await providerOwner('google');
    const silent = resolved(await signIn({ provider: 'google', subject: owner.subject, webSession: {} }));
    const nonce = randomBytes(16).toString('hex');
    const stale = resolved(
      await signIn({
        provider: 'google',
        subject: owner.subject,
        flow: flowFor(nonce),
        webSession: { googleAuthentication: { idToken: await googleToken(owner.subject, nonce, 600), nonce } },
      }),
    );
    const otherNonce = randomBytes(16).toString('hex');
    const unbound = resolved(
      await signIn({
        provider: 'google',
        subject: owner.subject,
        webSession: {
          googleAuthentication: { idToken: await googleToken(owner.subject, otherNonce), nonce: otherNonce },
        },
      }),
    );
    for (const reply of [silent, stale, unbound]) {
      const session = await admit({ kind: 'canonical-token', token: reply.webSession!.token });
      if (session.status !== 'admitted') throw new Error('Issued session not admitted');
      expect(requireFreshAuthentication(session.session)).toBe(false);
      expect(reply.credentialProof).toMatchObject({ authenticatedAt: null, linkGuarded: false });
    }
  });

  it('a Google sign-in with a verified recent auth_time is a fresh login, and the proof carries it', async () => {
    const owner = await providerOwner('google');
    const nonce = randomBytes(16).toString('hex');
    const idToken = await googleToken(owner.subject, nonce, 30);
    const reply = resolved(
      await signIn({
        provider: 'google',
        subject: owner.subject,
        flow: flowFor(nonce),
        webSession: { googleAuthentication: { idToken, nonce } },
      }),
    );
    const session = await admit({ kind: 'canonical-token', token: reply.webSession!.token });
    if (session.status !== 'admitted') throw new Error('Issued session not admitted');
    expect(session.session.source).toBe('login');
    expect(requireFreshAuthentication(session.session)).toBe(true);
    const authTime = (Math.floor(Date.now() / 1000) - 30) * 1000;
    expect(Math.abs((session.session.authenticatedAt?.getTime() ?? 0) - authTime)).toBeLessThanOrEqual(2000);
    expect(reply.credentialProof).toMatchObject({
      authSessionId: reply.webSession!.sessionId,
      linkGuarded: true,
      authenticatedAt: session.session.authenticatedAt?.toISOString(),
    });
  });

  it('revokes the presented session, ending its intents and challenges, and mints no reauthentication receipt', async () => {
    const owner = await providerOwner('apple');
    const previous = await environment.actor('better-auth', 'canonical-token');
    const pendingLink = await createProviderSecurityIntent(environment.database, environment.runtime, {
      actor: previous.webActor,
      action: 'link',
      provider: 'google',
      methodId: null,
    });
    const receiptsBefore = await environment.database.select().from(authProviderReauthenticationReceipts);
    const reply = resolved(
      await signIn({ provider: 'apple', subject: owner.subject, webSession: { presented: presentedOf(previous) } }),
    );
    expect(await admit(previous.credential)).toEqual({ status: 'denied' });
    expect(await admit({ kind: 'canonical-token', token: reply.webSession!.token })).toMatchObject({
      status: 'admitted',
      session: { userId: owner.userId },
    });
    await expect(
      bindProviderSecurityFlow(environment.database, environment.runtime, {
        actor: previous.webActor,
        intentToken: pendingLink.intentToken,
        flowHash: randomBytes(32).toString('hex'),
      }),
    ).rejects.toMatchObject({ outcome: 'unauthenticated' });
    expect(await environment.database.select().from(authProviderReauthenticationReceipts)).toEqual(receiptsBefore);
  });

  it.each(['canonical-token', 'legacy-jwe'] as const)(
    'an unknown provider while signed in (%s) is link_required: no account, no row, presented kept, intent spent (D1)',
    async (kind) => {
      const previous = await environment.actor('better-auth', kind);
      const subject = randomUUID();
      const usersBefore = await environment.database.select({ id: users.id }).from(users);
      const sessionsBefore = await environment.database.select().from(authSession);
      const flow = randomBytes(32).toString('hex');
      const reply = await signIn({
        provider: 'google',
        subject,
        flow,
        webSession: { presented: presentedOf(previous) },
      });
      expect(reply).toMatchObject({ outcome: 'denied', code: 'link_required' });
      expect(await environment.database.select({ id: users.id }).from(users)).toHaveLength(usersBefore.length);
      expect(await environment.database.select().from(authSession)).toEqual(sessionsBefore);
      expect(await linkedTo(previous.userId, subject)).toBe(false);
      expect((await admit(previous.credential)).status).toBe('admitted');
      // The intent ended like any other outcome: the same flow cannot be resolved again.
      expect(await resolve({ provider: 'google', subject, flow, webSession: {} })).toMatchObject({ outcome: 'denied' });
    },
  );

  it('an unknown provider with no live presented session still creates the account (D1 applies to live sessions only)', async () => {
    const previous = await environment.actor('better-auth', 'canonical-token');
    await environment.database
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSession.id, previous.webActor.expectedAuthSessionId));
    expect((await admit(previous.credential)).status).not.toBe('admitted');
    const subject = randomUUID();
    const reply = resolved(
      await signIn({ provider: 'google', subject, webSession: { presented: presentedOf(previous) } }),
    );
    expect(reply.createdUser).toBe(true);
    expect(reply.user.id).not.toBe(previous.userId);
    expect(await linkedTo(previous.userId, subject)).toBe(false);
    expect(await linkedTo(reply.user.id, subject)).toBe(true);
  });

  it('two crossed sign-ins, each presenting the other account, both finish and both presented sessions end', async () => {
    const first = await providerOwner('apple');
    const second = await providerOwner('apple');
    const [one, two] = await Promise.all([
      signIn({ provider: 'apple', subject: first.subject, webSession: { presented: presentedOf(second) } }),
      signIn({ provider: 'apple', subject: second.subject, webSession: { presented: presentedOf(first) } }),
    ]);
    expect(resolved(one).user.id).toBe(first.userId);
    expect(resolved(two).user.id).toBe(second.userId);
    expect(await admit(first.credential)).toEqual({ status: 'denied' });
    expect(await admit(second.credential)).toEqual({ status: 'denied' });
  });

  it('a deleted account is refused: no session issued and the presented one left alone', async () => {
    const owner = await providerOwner('apple');
    const previous = await environment.actor('better-auth', 'canonical-token');
    await environment.database.insert(authSubjectCutoffs).values({
      userId: owner.userId,
      generation: 0,
      revokedThrough: new Date(),
      deletedAt: new Date(),
      lastOperationId: randomUUID(),
    });
    const before = await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId));
    const reply = await signIn({
      provider: 'apple',
      subject: owner.subject,
      webSession: { presented: presentedOf(previous) },
    });
    expect(reply.outcome).toBe('denied');
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId))).toEqual(
      before,
    );
    expect((await admit(previous.credential)).status).toBe('admitted');
  });

  it('a session request with an actor cookie is refused: a sign-in never links to the account it arrived as', async () => {
    const owner = await providerOwner('apple');
    const legacy = await environment.actor('better-auth', 'legacy-jwe');
    const reply = await signIn({
      provider: 'apple',
      subject: owner.subject,
      actorCookie: legacy.actor.credential,
      webSession: {},
    });
    expect(reply).toMatchObject({ outcome: 'denied', code: 'identity_unavailable' });
    expect(
      await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId)),
    ).toHaveLength(1);
  });

  it('presents a legacy NextAuth cookie with its own session id and revokes it', async () => {
    const owner = await providerOwner('apple');
    const legacy = await environment.actor('better-auth', 'legacy-jwe');
    expect((await admit(legacy.credential)).status).toBe('admitted');
    resolved(
      await signIn({ provider: 'apple', subject: owner.subject, webSession: { presented: presentedOf(legacy) } }),
    );
    expect(await admit(legacy.credential)).toEqual({ status: 'denied' });
  });

  it('a session request without a credential proof is refused before any work', async () => {
    const owner = await providerOwner('apple');
    const reply = await signIn({ provider: 'apple', subject: owner.subject, webSession: {}, credentialProof: false });
    expect(reply).toMatchObject({ outcome: 'denied', code: 'identity_unavailable' });
    expect(
      await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId)),
    ).toHaveLength(1);
  });

  it('an email that belongs to another account is a conflict when signed out: no session, no provider row', async () => {
    const existing = await providerOwner('apple');
    const [stored] = await environment.database.select().from(users).where(eq(users.id, existing.userId));
    const sessionsBefore = await environment.database.select().from(authSession);
    const subject = randomUUID();
    const reply = await signIn({ provider: 'google', subject, email: stored.email.toUpperCase(), webSession: {} });
    expect(reply).toMatchObject({ outcome: 'denied', code: 'email_conflict' });
    expect(await environment.database.select().from(authSession)).toEqual(sessionsBefore);
    expect(await linkedTo(existing.userId, subject)).toBe(false);
  });

  it('signed in, an unknown provider with the email of another account is link_required, presented kept (D1)', async () => {
    const existing = await providerOwner('apple');
    const [stored] = await environment.database.select().from(users).where(eq(users.id, existing.userId));
    const previous = await environment.actor('better-auth', 'canonical-token');
    const sessionsBefore = await environment.database.select().from(authSession);
    const subject = randomUUID();
    const reply = await signIn({
      provider: 'google',
      subject,
      email: stored.email.toUpperCase(),
      webSession: { presented: presentedOf(previous) },
    });
    expect(reply).toMatchObject({ outcome: 'denied', code: 'link_required' });
    expect(await environment.database.select().from(authSession)).toEqual(sessionsBefore);
    expect(await linkedTo(existing.userId, subject)).toBe(false);
    expect((await admit(previous.credential)).status).toBe('admitted');
  });

  it('a replayed ID token mints one fresh session at most: its flow is single use', async () => {
    const owner = await providerOwner('google');
    const nonce = randomBytes(16).toString('hex');
    const flow = flowFor(nonce);
    const googleAuthentication = { idToken: await googleToken(owner.subject, nonce), nonce };
    resolved(await signIn({ provider: 'google', subject: owner.subject, flow, webSession: { googleAuthentication } }));
    const sessionsAfterFirst = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.userId, owner.userId));
    expect(await recordIntent('google', flow)).toMatchObject({ outcome: 'denied', code: 'replayed' });
    expect(
      await resolve({ provider: 'google', subject: owner.subject, flow, webSession: { googleAuthentication } }),
    ).toMatchObject({ outcome: 'denied' });
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId))).toEqual(
      sessionsAfterFirst,
    );
  });

  it('with provider security staged (the production pairing) a sign-in still issues the session', async () => {
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
    const owner = await providerOwner('apple');
    const previous = await environment.actor('better-auth', 'canonical-token');
    const reply = resolved(
      await signIn({ provider: 'apple', subject: owner.subject, webSession: { presented: presentedOf(previous) } }),
    );
    expect(await admit({ kind: 'canonical-token', token: reply.webSession!.token })).toMatchObject({
      status: 'admitted',
      session: { userId: owner.userId, source: 'bridge' },
    });
    expect(await admit(previous.credential)).toEqual({ status: 'denied' });
    // A consumed intent is refused on this branch too.
    const flow = randomBytes(32).toString('hex');
    expect((await recordIntent('apple', flow)).outcome).toBe('recorded');
    resolved(await resolve({ provider: 'apple', subject: owner.subject, flow, webSession: {} }));
    expect(await resolve({ provider: 'apple', subject: owner.subject, flow, webSession: {} })).toMatchObject({
      outcome: 'denied',
    });
  });

  it('a verified Google token for another subject is denied, not carried', async () => {
    const owner = await providerOwner('google');
    const nonce = randomBytes(16).toString('hex');
    const sessionsBefore = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.userId, owner.userId));
    const reply = await signIn({
      provider: 'google',
      subject: owner.subject,
      flow: flowFor(nonce),
      webSession: { googleAuthentication: { idToken: await googleToken(randomUUID(), nonce), nonce } },
    });
    expect(reply).toMatchObject({ outcome: 'denied', code: 'identity_unavailable' });
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId))).toEqual(
      sessionsBefore,
    );
  });
});
