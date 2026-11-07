import { createHash, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createIdentityPrototypeOptions, PROTOTYPE_GOOGLE_AUDIENCES } from '../identity-providers';
import { planPrototypeIdentityImport, type PrototypeLegacyIdentity } from '../identity-fixtures';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import { createSerializedPrototypeOAuthHandler } from '../oauth-transaction';
import {
  createPrototypeProviderLinkLifecycle,
  PROTOTYPE_PROVIDER_LINK_CALLBACK,
  PROTOTYPE_PROVIDER_LINK_PATHS,
} from '../provider-link-lifecycle';

const callbackURL = `${PROTOTYPE_ISSUER}/callback/google`;
const successURL = 'https://www.boardsesh.test/settings?googleBrowser=complete';
const errorURL = 'https://www.boardsesh.test/auth/login?googleBrowser=failed';
const password = 'synthetic-google-browser-password';

interface CodeFixture {
  readonly challenge: string;
  readonly idToken: string;
  readonly failure?: 'reject' | 'redirect';
}

function cookies(response: Response, sessionOnly = false) {
  return response.headers
    .getSetCookie()
    .filter((cookie) => !sessionOnly || cookie.includes('better-auth.session_token='))
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

describe('configured Google authorization-code browser callbacks', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let authority: ReturnType<Awaited<ReturnType<typeof createPrototypeEnvironment>>['createAuthority']>;
  let primary: ReturnType<typeof createSerializedPrototypeOAuthHandler>;
  let secondary: ReturnType<typeof createSerializedPrototypeOAuthHandler>;
  let linkPrimary: ReturnType<typeof createPrototypeProviderLinkLifecycle>;
  let linkSecondary: ReturnType<typeof createPrototypeProviderLinkLifecycle>;
  let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let passwordHash: string;
  const pendingCodes = new Map<string, CodeFixture>();
  const requests: string[] = [];

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    const options = createIdentityPrototypeOptions(async () => null);
    const configured = { ...options, advanced: { disableOriginCheck: false, disableCSRFCheck: false } };
    authority = environment.createAuthority(configured);
    primary = createSerializedPrototypeOAuthHandler(environment.database, configured);
    secondary = createSerializedPrototypeOAuthHandler(environment.database, configured);
    linkPrimary = createPrototypeProviderLinkLifecycle(environment.database, { authority: configured });
    linkSecondary = createPrototypeProviderLinkLifecycle(environment.database, { authority: configured });
    signingKey = (await generateKeyPair('RS256')).privateKey;
    passwordHash = await hash(password, 4);
  });
  afterAll(async () => environment?.close());
  beforeEach(() => {
    requests.length = 0;
    pendingCodes.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        requests.push(url.toString());
        if (url.toString() !== 'https://oauth2.googleapis.com/token')
          throw new Error('Unexpected Google browser transport');
        expect(request.method).toBe('POST');
        expect(request.redirect).toBe('manual');
        const form = new URLSearchParams(await request.text());
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('client_id')).toBe(PROTOTYPE_GOOGLE_AUDIENCES[0]);
        expect(form.get('client_secret')).toBe('prototype-google-secret-not-used-for-id-token-login');
        expect(form.get('redirect_uri')).toBe(callbackURL);
        const code = form.get('code') ?? '';
        const fixture = pendingCodes.get(code);
        if (!fixture) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        pendingCodes.delete(code);
        expect(form.get('code_verifier')).toBeTruthy();
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(fixture.challenge);
        if (fixture.failure === 'reject') return Response.json({ error: 'invalid_grant' }, { status: 400 });
        if (fixture.failure === 'redirect')
          return new Response(null, { status: 302, headers: { location: 'https://attacker.example/token' } });
        return Response.json({
          access_token: `synthetic-google-access-${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: fixture.idToken,
        });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  async function identity(options: { google?: boolean; verified?: boolean } = {}) {
    const id = randomUUID();
    const subject = `google-browser-${id}`;
    const fixture: PrototypeLegacyIdentity = {
      id,
      email: `${id}@example.test`,
      name: 'Unchanged local climber',
      image: null,
      emailVerifiedAt: options.verified ? new Date('2024-01-01Z') : null,
      createdAt: new Date('2023-01-01Z'),
      updatedAt: new Date(),
      passwordHash,
      providers: options.google ? [{ provider: 'google', subject }] : [],
    };
    const planned = planPrototypeIdentityImport([fixture]);
    await environment.database.transaction(async (transaction) => {
      await transaction.insert(environment.schema.user).values(planned.users);
      await transaction.insert(environment.schema.account).values(planned.accounts);
    });
    const signedIn = await authority.api.signInEmail({ body: { email: fixture.email, password }, asResponse: true });
    expect(signedIn.status).toBe(200);
    return { ...fixture, subject, cookie: cookies(signedIn, true) };
  }

  async function begin(actor?: { cookie: string }) {
    const response = await (actor ? linkPrimary : primary).handler(
      new Request(`${PROTOTYPE_ISSUER}${actor ? PROTOTYPE_PROVIDER_LINK_PATHS.link : '/sign-in/social'}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://www.boardsesh.test',
          ...(actor ? { cookie: actor.cookie } : {}),
        },
        body: JSON.stringify(
          actor
            ? { provider: 'google' }
            : {
                provider: 'google',
                callbackURL: successURL,
                errorCallbackURL: errorURL,
                disableRedirect: true,
              },
        ),
      }),
    );
    expect(response.status).toBe(200);
    const authorization = new URL(((await response.json()) as { url: string }).url);
    expect(authorization.origin + authorization.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorization.searchParams.get('client_id')).toBe(PROTOTYPE_GOOGLE_AUDIENCES[0]);
    expect(authorization.searchParams.get('redirect_uri')).toBe(callbackURL);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('scope')?.split(' ').sort()).toEqual(['email', 'openid', 'profile']);
    const state = authorization.searchParams.get('state');
    const challenge = authorization.searchParams.get('code_challenge');
    if (!state || !challenge) throw new Error('Missing generated Google state or PKCE');
    return {
      state,
      challenge,
      cookie: [actor?.cookie, cookies(response)].filter(Boolean).join('; '),
      linked: Boolean(actor),
    };
  }

  async function code(
    started: Awaited<ReturnType<typeof begin>>,
    subject: string,
    email: string,
    failure?: CodeFixture['failure'],
  ) {
    const authorizationCode = randomUUID();
    const idToken = await new SignJWT({ sub: subject, email, email_verified: true, name: 'Provider display name' })
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-google-browser-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience(PROTOTYPE_GOOGLE_AUDIENCES[0])
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(signingKey);
    pendingCodes.set(authorizationCode, { challenge: started.challenge, idToken, failure });
    return authorizationCode;
  }

  function callback(
    started: Awaited<ReturnType<typeof begin>>,
    fields: Record<string, string>,
    cookie = started.cookie,
  ) {
    const url = new URL(callbackURL);
    url.search = new URLSearchParams({ state: started.state, ...fields }).toString();
    return (started.linked ? linkSecondary : secondary).handler(new Request(url, { headers: { cookie } }));
  }
  function current(cookie: string) {
    return authority.api.getSession({ headers: new Headers({ cookie }) });
  }
  async function accountRows(userId: string) {
    return environment.database
      .select()
      .from(environment.schema.account)
      .where(eq(environment.schema.account.userId, userId));
  }

  it('maps an imported Google subject to its stable user despite another local user owning the claim email', async () => {
    const imported = await identity({ google: true });
    const emailOwner = await identity({ verified: true });
    const started = await begin();
    const completed = await callback(started, { code: await code(started, imported.subject, emailOwner.email) });
    expect(completed.status).toBe(302);
    expect(completed.headers.get('location')).toBe(successURL);
    const signedIn = await current(cookies(completed, true));
    expect(signedIn?.user.id).toBe(imported.id);
    expect(signedIn?.user.email).toBe(imported.email);
    expect(signedIn?.user.emailVerified).toBe(false);
    expect((await current(emailOwner.cookie))?.user.id).toBe(emailOwner.id);
    expect((await accountRows(emailOwner.id)).some((account) => account.providerId === 'google')).toBe(false);
    expect(requests).toEqual(['https://oauth2.googleapis.com/token']);
  });

  it('creates a new Google identity through the same configured code exchange', async () => {
    const started = await begin();
    const subject = randomUUID();
    const email = `${subject}@new-google.example.test`;
    const completed = await callback(started, { code: await code(started, subject, email) });
    expect(completed.headers.get('location')).toBe(successURL);
    const signedIn = await current(cookies(completed, true));
    expect(signedIn?.user.email).toBe(email);
    const accounts = await environment.database
      .select()
      .from(environment.schema.account)
      .where(
        and(eq(environment.schema.account.providerId, 'google'), eq(environment.schema.account.accountId, subject)),
      );
    expect(accounts).toHaveLength(1);
    expect(accounts[0].userId).toBe(signedIn?.user.id);
  });

  it('never attaches an unknown matching-email Google subject to an existing user', async () => {
    const owner = await identity({ verified: true });
    const started = await begin();
    const completed = await callback(started, { code: await code(started, randomUUID(), owner.email) });
    expect(completed.status).toBe(302);
    expect(new URL(completed.headers.get('location')!).searchParams.get('error')).toBe('account_not_linked');
    expect(cookies(completed, true)).toBe('');
    expect(await accountRows(owner.id)).toHaveLength(1);
    expect((await current(owner.cookie))?.user.id).toBe(owner.id);
  });

  it('cancellation consumes browser state before any token exchange and a new flow can succeed', async () => {
    const actor = await identity({ google: true });
    const started = await begin();
    const cancelled = await callback(started, { error: 'access_denied' });
    expect(new URL(cancelled.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(cookies(cancelled, true)).toBe('');
    const replay = await callback(started, { code: await code(started, actor.subject, actor.email) });
    expect(new URL(replay.headers.get('location')!).searchParams.get('error')).toBeTruthy();
    expect(cookies(replay, true)).toBe('');
    expect(requests).toHaveLength(0);
    const restarted = await begin();
    const completed = await callback(restarted, { code: await code(restarted, actor.subject, actor.email) });
    expect((await current(cookies(completed, true)))?.user.id).toBe(actor.id);
  });

  it.each(['reject', 'redirect'] as const)(
    'a token endpoint %s fails without sign-in or callback replay',
    async (failure) => {
      const actor = await identity({ google: true });
      const before = await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, actor.id));
      const started = await begin();
      const failed = await callback(started, { code: await code(started, actor.subject, actor.email, failure) });
      expect(new URL(failed.headers.get('location')!).searchParams.get('error')).toBe('invalid_code');
      expect(cookies(failed, true)).toBe('');
      expect(requests).toEqual(['https://oauth2.googleapis.com/token']);
      expect(
        await environment.database
          .select()
          .from(environment.schema.session)
          .where(eq(environment.schema.session.userId, actor.id)),
      ).toEqual(before);
      const replay = await callback(started, { code: await code(started, actor.subject, actor.email) });
      expect(new URL(replay.headers.get('location')!).searchParams.get('error')).toBeTruthy();
      expect(requests).toHaveLength(1);
      expect((await current(actor.cookie))?.user.id).toBe(actor.id);
    },
  );

  it('requires the real signed state cookie before Google code exchange', async () => {
    const actor = await identity({ google: true });
    const started = await begin();
    const rejected = await callback(started, { code: await code(started, actor.subject, actor.email) }, '');
    expect(new URL(rejected.headers.get('location')!).searchParams.get('error')).toBeTruthy();
    expect(cookies(rejected, true)).toBe('');
    expect(requests).toHaveLength(0);
  });

  it('explicitly links a browser Google subject with another email without changing the local identity', async () => {
    const actor = await identity();
    const source = await current(actor.cookie);
    const started = await begin(actor);
    const subject = randomUUID();
    const completed = await callback(started, {
      code: await code(started, subject, 'different-email@google.example.test'),
    });
    expect(completed.status).toBe(302);
    expect(completed.headers.get('location')).toBe(PROTOTYPE_PROVIDER_LINK_CALLBACK);
    const replacement = await current(cookies(completed, true));
    expect(replacement?.user.id).toBe(actor.id);
    expect(replacement?.user.email).toBe(actor.email);
    expect(replacement?.user.emailVerified).toBe(false);
    expect(replacement?.session.createdAt).toEqual(source?.session.createdAt);
    expect(replacement?.session.expiresAt).toEqual(source?.session.expiresAt);
    expect(await current(actor.cookie)).toBeNull();
    expect(
      (await accountRows(actor.id))
        .filter((account) => account.providerId === 'google')
        .map((account) => account.accountId),
    ).toEqual([subject]);
    expect(requests).toEqual(['https://oauth2.googleapis.com/token']);
  });

  it('rejects an explicit browser link to another user’s Google subject and spends the validated intent', async () => {
    const owner = await identity({ google: true });
    const actor = await identity();
    const started = await begin(actor);
    const rejected = await callback(started, { code: await code(started, owner.subject, actor.email) });
    expect(rejected.status).toBe(409);
    expect(cookies(rejected, true)).toBe('');
    expect(await accountRows(actor.id)).toHaveLength(1);
    expect((await accountRows(owner.id)).find((account) => account.providerId === 'google')?.accountId).toBe(
      owner.subject,
    );
    expect((await current(actor.cookie))?.user.id).toBe(actor.id);
    expect((await callback(started, { code: await code(started, randomUUID(), actor.email) })).status).toBe(400);
    expect(requests).toHaveLength(1);
  });
});
