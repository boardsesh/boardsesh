import { createHash, randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { oauthSession, oauthVerification, users } from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { PartnerIdentityWriteError } from '../adapter-guard';
import { handlePartnerRequest } from '../transaction';
import {
  createPartnerTestEnvironment,
  dropReadOnlyUsersTrigger,
  installReadOnlyUsersTrigger,
  READ_ONLY_PROOF_APPLICATION_NAME,
  TEST_ISSUER,
  TEST_OAUTH_OPTIONS,
  TEST_SESSION_HEADER,
  testSessionBridge,
  type PartnerTestEnvironment,
} from './partner-fixture';

describe('proof (a): the provider runs on users read-only', () => {
  let environment: PartnerTestEnvironment;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
    await installReadOnlyUsersTrigger();
  });

  afterAll(async () => {
    await dropReadOnlyUsersTrigger();
    await environment?.close();
  });

  async function countRows() {
    const [row] = await db.execute<{ users: number; sessions: number }>(sql`
      select (select count(*)::int from users) as users,
             (select count(*)::int from oauth_session) as sessions
    `);
    return row;
  }

  it('reports account as the only schema gap', async () => {
    const context = await environment.auth.$context;
    expect(context.checkSchema, 'runtime validation must be off').toBeUndefined();
    await expect(context.explicitSchemaCheck?.()).rejects.toMatchObject({
      findings: [{ kind: 'missing-table', table: 'account' }],
    });
  });

  it('the trigger really refuses a write from the proof connection, so the rest of this suite means something', async () => {
    const client = await environment.createClient();
    const refusedByTrigger = { cause: { message: expect.stringContaining('partner authority wrote users') } };
    await expect(
      environment.database.update(users).set({ name: 'proof' }).where(eq(users.id, client.owner.userId)),
    ).rejects.toMatchObject(refusedByTrigger);
    await expect(environment.database.delete(users).where(eq(users.id, client.owner.userId))).rejects.toMatchObject(
      refusedByTrigger,
    );
    // Fixture seeding on the test connection is untouched.
    await expect(
      db.update(users).set({ name: 'unaffected' }).where(eq(users.id, client.owner.userId)),
    ).resolves.toBeDefined();
  });

  it('a full authorize, consent, token, refresh and revoke cycle writes users nowhere', async () => {
    const before = await countRows();
    const client = await environment.createClient({ skipConsent: false });
    const atConsent = await environment.authorize(client);
    expect(atConsent.location).toContain(TEST_OAUTH_OPTIONS.consentPage);
    const accepted = await environment.consent(client.owner, {
      accept: true,
      oauth_query: new URL(atConsent.location!).searchParams.toString(),
    });
    expect(accepted.response.status).toBe(200);
    const issued = await environment.exchange(client, { location: accepted.body.url!, verifier: atConsent.verifier });
    expect(issued.response.status).toBe(200);
    expect(issued.response.headers.getSetCookie()).toEqual([]);
    const rotated = await environment.refresh(client, issued.body.refresh_token!);
    expect(rotated.response.status).toBe(200);
    expect(rotated.response.headers.getSetCookie()).toEqual([]);
    expect((await environment.introspect(client, rotated.body.access_token!)).body.active).toBe(true);
    expect(
      (await environment.revoke(client, { token: rotated.body.refresh_token!, token_type_hint: 'refresh_token' }))
        .response.status,
    ).toBe(200);
    const after = await countRows();
    expect(after.users).toBe(before.users + 1);
    expect(after.sessions).toBe(before.sessions + 1);
  });

  it('reads the user through findUserById with no write, and maps a real row', async () => {
    const client = await environment.createClient();
    const context = await environment.auth.$context;
    const user = await context.internalAdapter.findUserById(client.owner.userId);
    expect(user).toMatchObject({ id: client.owner.userId, email: `${client.owner.userId}@example.invalid` });
  });

  describe('every identity write through the adapter is refused before it reaches the database', () => {
    // Every spelling the adapter accepts: the model name and the mapped table name.
    const models = ['user', 'users', 'session', 'oauthSession', 'account'];

    it.each(models)('refuses writes to the %s model', async (model) => {
      const context = await environment.auth.$context;
      const where = [{ field: 'id', value: 'not-a-real-row' }];
      const attempts: Array<() => Promise<unknown>> = [
        () => context.adapter.create({ model, data: { id: randomUUID() } }),
        () => context.adapter.update({ model, where, update: { name: 'written' } }),
        () => context.adapter.updateMany({ model, where, update: { name: 'written' } }),
        () => context.adapter.delete({ model, where }),
        () => context.adapter.deleteMany({ model, where }),
        () => context.adapter.consumeOne({ model, where }),
        () => context.adapter.incrementOne({ model, where, increment: {}, set: { name: 'written' } }),
      ];
      for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(PartnerIdentityWriteError);
    });

    it('refuses the internal adapter paths that would create a first-party account or session', async () => {
      const context = await environment.auth.$context;
      const client = await environment.createClient();
      await expect(
        context.internalAdapter.createUser(
          { email: `${randomUUID()}@example.invalid`, name: 'nobody' },
          undefined as never,
        ),
      ).rejects.toBeInstanceOf(PartnerIdentityWriteError);
      await expect(context.internalAdapter.createSession(client.owner.userId)).rejects.toBeInstanceOf(
        PartnerIdentityWriteError,
      );
      await expect(context.internalAdapter.updateUser(client.owner.userId, { name: 'written' })).rejects.toBeInstanceOf(
        PartnerIdentityWriteError,
      );
    });

    it('turns an attempted write in a request into a rollback, not a partial mint', async () => {
      const client = await environment.createClient();
      const writingInstance = environment.createInstance([
        {
          id: 'test-attempted-user-write',
          hooks: {
            after: [
              {
                matcher: (context) => context.path === '/oauth2/token',
                handler: createAuthMiddleware(async (context) => {
                  await context.context.adapter.update({
                    model: 'user',
                    where: [{ field: 'id', value: client.owner.userId }],
                    update: { name: 'written' },
                  });
                }),
              },
            ],
          },
        },
      ]);
      const authorization = await environment.authorize(client);
      const attempted = await environment.exchange(client, authorization, writingInstance);
      expect(attempted.response.status).toBe(500);
      expect(attempted.body.access_token).toBeUndefined();
      const [user] = await db.select().from(users).where(eq(users.id, client.owner.userId));
      expect(user.name).toBeNull();
      // The code survives the rollback, so the app can finish the exchange.
      expect((await environment.exchange(client, authorization)).response.status).toBe(200);
    });
  });

  describe('email and social sign-in are off', () => {
    // The specific refusal matters: with sign-in on, the adapter guard would still
    // stop the write, and that second layer must not hide a misconfigured first one.
    const signInAttempts = [
      [
        '/sign-up/email',
        { email: 'nobody@example.invalid', password: 'long-enough-password-1', name: 'n' },
        400,
        'EMAIL_PASSWORD_SIGN_UP_DISABLED',
      ],
      [
        '/sign-in/email',
        { email: 'nobody@example.invalid', password: 'long-enough-password-1' },
        400,
        'EMAIL_PASSWORD_DISABLED',
      ],
      [
        '/sign-in/social',
        { provider: 'google', callbackURL: 'https://www.boardsesh.test/' },
        404,
        'PROVIDER_NOT_FOUND',
      ],
    ] as const;

    it.each(signInAttempts)('%s is off: no row, no session cookie', async (path, body, status, code) => {
      const before = await countRows();
      const response = await environment.auth.handler(
        new Request(`${TEST_ISSUER}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(status);
      expect(await response.clone().json()).toMatchObject({ code });
      expect(response.headers.getSetCookie().filter((cookie) => cookie.includes('session'))).toEqual([]);
      expect(await countRows()).toEqual(before);
    });

    it('refuses sign-up and sign-in through the server API too', async () => {
      await expect(
        environment.auth.api.signUpEmail({
          body: { email: 'nobody-api@example.invalid', password: 'long-enough-password-1', name: 'n' },
        }),
      ).rejects.toThrow();
      await expect(
        environment.auth.api.signInEmail({
          body: { email: 'nobody-api@example.invalid', password: 'long-enough-password-1' },
        }),
      ).rejects.toThrow();
      expect(await db.select().from(users).where(eq(users.email, 'nobody-api@example.invalid'))).toHaveLength(0);
    });

    it('never answers a request with a Better Auth session cookie', async () => {
      const client = await environment.createClient();
      const issued = await environment.authorize(client);
      expect(issued.response.headers.getSetCookie().filter((cookie) => cookie.includes('session_token'))).toEqual([]);
    });
  });
});

describe('proof (b): a before hook setting ctx.context.session reaches the provider', () => {
  let environment: PartnerTestEnvironment;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
  });

  afterAll(async () => {
    await environment?.close();
  });

  it('with no session the provider asks the climber to sign in', async () => {
    const client = await environment.createClient();
    const signedOut = await environment.instance.handler(
      new Request(
        `${TEST_ISSUER}/oauth2/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          scope: 'profile:read',
          code_challenge: createHash('sha256').update('proof-b-verifier').digest('base64url'),
          code_challenge_method: 'S256',
        }).toString()}`,
      ),
    );
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get('location')).toContain(TEST_OAUTH_OPTIONS.loginPage);
  });

  it('the authorize endpoint sees the injected session and binds the code to its row', async () => {
    const client = await environment.createClient();
    const authorization = await environment.authorize(client);
    expect(new URL(authorization.location!).searchParams.has('code')).toBe(true);
    const codes = await db.select().from(oauthVerification);
    const code = codes.find(
      (record) => (JSON.parse(record.value) as { userId?: string }).userId === client.owner.userId,
    );
    expect((JSON.parse(code!.value) as { sessionId?: string }).sessionId).toBe(client.owner.sessionId);
  });

  it('the consent endpoint accepts it through its session middleware', async () => {
    const client = await environment.createClient({ skipConsent: false });
    const atConsent = await environment.authorize(client);
    const unauthenticated = await environment.instance.handler(
      new Request(`${TEST_ISSUER}/oauth2/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://www.boardsesh.test' },
        body: JSON.stringify({ accept: true, oauth_query: new URL(atConsent.location!).searchParams.toString() }),
      }),
    );
    expect(unauthenticated.status).toBe(401);
    const accepted = await environment.consent(client.owner, {
      accept: true,
      oauth_query: new URL(atConsent.location!).searchParams.toString(),
    });
    expect(accepted.response.status).toBe(200);
    expect(new URL(accepted.body.url!).searchParams.has('code')).toBe(true);
  });

  it('a bridge-supplied session row is enough to mint, with no Better Auth login behind it', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    expect(issued.access_token).toBeTypeOf('string');
    const [session] = await db
      .select()
      .from(oauthSession)
      .where(and(eq(oauthSession.id, client.owner.sessionId), eq(oauthSession.userId, client.owner.userId)));
    expect(session).toBeDefined();
  });

  it('an expired bridge session is refused at the token endpoint', async () => {
    const client = await environment.createClient();
    const authorization = await environment.authorize(client);
    await db
      .update(oauthSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthSession.id, client.owner.sessionId));
    const redeemed = await environment.exchange(client, authorization);
    expect(redeemed.response.status).toBe(400);
    expect(redeemed.body.access_token).toBeUndefined();
  });

  it('a session set by a hook on a second plugin is still visible to the fence', async () => {
    const client = await environment.createClient();
    const lateBridge: BetterAuthPlugin = {
      id: 'test-session-after-first-hook',
      hooks: {
        before: [
          {
            matcher: (context) => context.path === '/oauth2/authorize',
            handler: createAuthMiddleware(async (context) => {
              expect(context.context.session?.session.id).toBe(client.owner.sessionId);
            }),
          },
        ],
      },
    };
    const instance = environment.createInstance([lateBridge]);
    const authorization = await environment.authorize(client, {}, instance);
    expect(new URL(authorization.location!).searchParams.has('code')).toBe(true);
  });

  it('request-level session headers do not leak between concurrent requests', async () => {
    const firstClient = await environment.createClient();
    const secondClient = await environment.createClient();
    const [first, second] = await Promise.all([
      environment.authorize(firstClient),
      environment.authorize(secondClient),
    ]);
    for (const [authorization, client] of [
      [first, firstClient],
      [second, secondClient],
    ] as const) {
      expect((await environment.exchange(client, authorization)).response.status).toBe(200);
    }
  });

  it('exposes nothing to unauthenticated session probes', async () => {
    const client = await environment.createClient();
    await environment.authorize(client);
    const sessionProbe = await environment.instance.handler(
      new Request(`${TEST_ISSUER}/get-session`, { headers: { [TEST_SESSION_HEADER]: client.owner.sessionToken } }),
    );
    expect(await sessionProbe.json()).toBeNull();
  });
});

describe('a provider failure on the read-only path', () => {
  it('reports the guard as the cause, never a database error', async () => {
    const environment = await createPartnerTestEnvironment();
    const logged = vi.spyOn(await import('../../../utils/logger').then((module) => module.logger), 'error');
    try {
      await installReadOnlyUsersTrigger();
      const client = await environment.createClient();
      const brokenBridge = testSessionBridge(environment.database);
      const failing = environment.createInstance([
        brokenBridge,
        {
          id: 'test-identity-write-in-hook',
          hooks: {
            after: [
              {
                matcher: (context) => context.path === '/oauth2/token',
                handler: createAuthMiddleware(async (context) => {
                  await context.context.adapter.update({
                    model: 'users',
                    where: [{ field: 'id', value: client.owner.userId }],
                    update: { name: 'written' },
                  });
                }),
              },
            ],
          },
        },
      ]);
      const authorization = await environment.authorize(client);
      const failed = await handlePartnerRequest(
        environment.database,
        new Request(`${TEST_ISSUER}/oauth2/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: new URL(authorization.location!).searchParams.get('code')!,
            code_verifier: authorization.verifier,
            redirect_uri: client.redirectUri,
            client_id: client.clientId,
            client_secret: client.clientSecret!,
          }),
        }),
        failing.handler,
      );
      expect(failed.status).toBe(500);
      expect(logged).toHaveBeenCalledWith(
        'Partner OAuth request failed',
        expect.objectContaining({ errorName: 'PartnerIdentityWriteError' }),
      );
    } finally {
      logged.mockRestore();
      await dropReadOnlyUsersTrigger();
      await environment.close();
    }
  });

  it('keeps the proof connection name out of production code', () => {
    expect(READ_ONLY_PROOF_APPLICATION_NAME).toBe('partner-oauth-read-only-proof');
  });
});
