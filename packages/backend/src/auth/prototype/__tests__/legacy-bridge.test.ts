import { randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { SignJWT, type JWTPayload } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeLegacyHandler, PROTOTYPE_LEGACY_KEY } from '../legacy-bridge';
import { PROTOTYPE_ISSUER } from '../oauth-options';

type Environment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
type Handler = ReturnType<typeof createPrototypeLegacyHandler>;
const PASSWORD = 'unchanged-legacy-password';
let environment: Environment;
let firstHandler: Handler;
let secondHandler: Handler;
let passwordHash: string;

async function seedUser() {
  const userId = randomUUID();
  await environment.database.insert(environment.schema.user).values({
    id: userId,
    name: 'Legacy fixture',
    email: `${userId}@example.com`,
    emailVerified: true,
  });
  await environment.database.insert(environment.schema.account).values({
    id: randomUUID(),
    userId,
    providerId: 'credential',
    accountId: userId,
    password: passwordHash,
  });
  return userId;
}

function request(path: string, body: unknown = {}, cookie?: string, credential?: string) {
  return new Request(`${PROTOTYPE_ISSUER}${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://www.boardsesh.test',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function legacyToken(userId: string, claims: JWTPayload = {}, key = PROTOTYPE_LEGACY_KEY) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: userId,
    iat: now - 60,
    exp: now + 3600,
    iss: 'boardsesh',
    aud: 'boardsesh-mobile',
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(key);
}

function cookieFrom(response: Response) {
  const header = response.headers.getSetCookie().find((cookie) => cookie.includes('better-auth.session_token='));
  expect(header).toBeDefined();
  return header!.split(';')[0];
}

function readSession(cookie: string, handler = firstHandler) {
  return handler(new Request(`${PROTOTYPE_ISSUER}/get-session`, { headers: { cookie } }));
}

async function seedReset(userId: string) {
  const token = randomUUID();
  await environment.database.insert(environment.schema.verification).values({
    id: randomUUID(),
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return token;
}

describe('cryptographically verified legacy lineage and transactional revocation prototype', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    firstHandler = createPrototypeLegacyHandler(environment.database);
    secondHandler = createPrototypeLegacyHandler(environment.database);
    passwordHash = await hash(PASSWORD, 4);
  });
  afterAll(async () => environment?.close());

  it.each([false, true])(
    'rejects rolled old issuance after reset even with unseen explicit-lineage=%s',
    async (explicitLineage) => {
      const userId = await seedUser();
      const tokenForReset = await seedReset(userId);
      expect(
        (
          await firstHandler(
            request('/reset-password', { token: tokenForReset, newPassword: 'new-rolled-issuer-password' }),
          )
        ).status,
      ).toBe(200);
      const [cutoff] = await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, userId));
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 10_000);
        const rolledIssueTime = Math.floor(Date.now() / 1000);
        expect(rolledIssueTime * 1000).toBeGreaterThan(cutoff.revokedThrough.getTime());
        const credential = await legacyToken(userId, {
          iat: rolledIssueTime,
          exp: rolledIssueTime + 3600,
          ...(explicitLineage ? { authSessionId: randomUUID() } : {}),
        });
        expect((await secondHandler(request('/prototype-legacy-bridge', {}, undefined, credential))).status).toBe(401);
        expect(
          await environment.database
            .select()
            .from(environment.schema.session)
            .where(eq(environment.schema.session.userId, userId)),
        ).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('bridges actual historic native claim shape without treating rolling iat as fresh authentication', async () => {
    const userId = await seedUser();
    const credential = await legacyToken(userId);
    const result = await firstHandler(
      request('/prototype-legacy-bridge', { userId: 'attacker-selected-account' }, undefined, credential),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ userId });
    const cookie = cookieFrom(result);
    expect(await (await readSession(cookie, secondHandler)).json()).toMatchObject({
      user: { id: userId },
      session: { createdAt: new Date(0).toISOString(), originalAuthenticatedAt: null },
    });
    const sensitive = await secondHandler(new Request(`${PROTOTYPE_ISSUER}/list-sessions`, { headers: { cookie } }));
    expect(sensitive.status).toBe(403);
    expect(await sensitive.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
  });

  it('concurrent repeated bridge and process recreation preserve one canonical session', async () => {
    const userId = await seedUser();
    const credential = await legacyToken(userId);
    const results = await Promise.all(
      [firstHandler, secondHandler].map((handler) =>
        handler(request('/prototype-legacy-bridge', {}, undefined, credential)),
      ),
    );
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    const sessionIds = await Promise.all(
      results.map(async (response) => ((await response.json()) as { sessionId: string }).sessionId),
    );
    expect(new Set(sessionIds).size).toBe(1);
    const restarted = createPrototypeLegacyHandler(environment.database);
    const repeated = await restarted(request('/prototype-legacy-bridge', {}, undefined, credential));
    expect(await repeated.json()).toMatchObject({ sessionId: sessionIds[0] });
    const sessions = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.userId, userId));
    expect(sessions).toHaveLength(1);
  });

  it('retains trustworthy original auth age across a newer credential for the same stable lineage', async () => {
    const userId = await seedUser();
    const originalAuthTime = Math.floor(Date.now() / 1000) - 86_400;
    const lineageClaims = { auth_time: originalAuthTime, authSessionId: randomUUID() };
    const original = await legacyToken(userId, lineageClaims);
    const first = await firstHandler(request('/prototype-legacy-bridge', {}, undefined, original));
    const firstBody = (await first.json()) as { sessionId: string };
    const renewed = await legacyToken(userId, { ...lineageClaims, iat: Math.floor(Date.now() / 1000) - 1 });
    const repeated = await secondHandler(request('/prototype-legacy-bridge', {}, undefined, renewed));
    expect(await repeated.json()).toMatchObject(firstBody);
    const [session] = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.id, firstBody.sessionId));
    expect(session.createdAt).toEqual(new Date(originalAuthTime * 1000));
  });

  it('sign-out leaves a durable lineage tombstone and rejects replay after restart', async () => {
    const userId = await seedUser();
    const credential = await legacyToken(userId);
    const bridged = await firstHandler(request('/prototype-legacy-bridge', {}, undefined, credential));
    const cookie = cookieFrom(bridged);
    expect((await secondHandler(request('/sign-out', {}, cookie))).status).toBe(200);
    expect(await (await readSession(cookie)).json()).toBeNull();
    const restarted = createPrototypeLegacyHandler(environment.database);
    expect((await restarted(request('/prototype-legacy-bridge', {}, undefined, credential))).status).toBe(401);
    const [cutoff] = await environment.database
      .select()
      .from(environment.schema.prototypeUserCutoff)
      .where(eq(environment.schema.prototypeUserCutoff.userId, userId));
    expect(cutoff).toBeDefined();
  });

  it('deleting the canonical session never allows an old credential to mint another', async () => {
    const userId = await seedUser();
    const credential = await legacyToken(userId, { authSessionId: randomUUID() });
    const bridged = await firstHandler(request('/prototype-legacy-bridge', {}, undefined, credential));
    const { sessionId } = (await bridged.json()) as { sessionId: string };
    await environment.database.delete(environment.schema.session).where(eq(environment.schema.session.id, sessionId));
    expect((await secondHandler(request('/prototype-legacy-bridge', {}, undefined, credential))).status).toBe(401);
  });

  it.each([
    ['wrong issuer', { iss: 'someone-else' }],
    ['wrong audience', { aud: 'partner-api' }],
    ['expired', { iat: 1, exp: 2 }],
    ['future issuance', { iat: Math.floor(Date.now() / 1000) + 3600, exp: Math.floor(Date.now() / 1000) + 7200 }],
    ['overlong lifetime', { iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 }],
    ['manufactured auth age', { auth_time: Math.floor(Date.now() / 1000) + 60 }],
  ] satisfies [string, JWTPayload][])('rejects %s without writing a session', async (_name, claims) => {
    const userId = await seedUser();
    const credential = await legacyToken(userId, claims);
    expect((await firstHandler(request('/prototype-legacy-bridge', {}, undefined, credential))).status).toBe(401);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, userId)),
    ).toHaveLength(0);
  });

  it('rejects forged signatures and deleted users', async () => {
    const userId = await seedUser();
    const forged = await legacyToken(userId, {}, new TextEncoder().encode('a-different-synthetic-verification-key'));
    expect((await firstHandler(request('/prototype-legacy-bridge', {}, undefined, forged))).status).toBe(401);
    const deletedUserToken = await legacyToken(userId);
    await environment.database.delete(environment.schema.user).where(eq(environment.schema.user.id, userId));
    expect((await firstHandler(request('/prototype-legacy-bridge', {}, undefined, deletedUserToken))).status).toBe(401);
  });

  it('password reset atomically changes the password, consumes the link and revokes all legacy descendants', async () => {
    const userId = await seedUser();
    const credential = await legacyToken(userId);
    const bridged = await firstHandler(request('/prototype-legacy-bridge', {}, undefined, credential));
    const cookie = cookieFrom(bridged);
    const resetToken = await seedReset(userId);
    const reset = await secondHandler(
      request('/reset-password', { token: resetToken, newPassword: 'changed-password-once' }),
    );
    expect(reset.status).toBe(200);
    expect(
      (await firstHandler(request('/reset-password', { token: resetToken, newPassword: 'replayed-password' }))).status,
    ).toBe(400);
    expect((await firstHandler(request('/prototype-legacy-bridge', {}, undefined, credential))).status).toBe(401);
    expect(await (await readSession(cookie)).json()).toBeNull();
    const [account] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(eq(environment.schema.account.userId, userId));
    expect(await compare('changed-password-once', account.password!)).toBe(true);
    expect(await compare(PASSWORD, account.password!)).toBe(false);
  });

  it('a reset racing a bridge cannot leave a usable descendant on either instance', async () => {
    const userId = await seedUser();
    const credential = await legacyToken(userId);
    const resetToken = await seedReset(userId);
    const [bridge, reset] = await Promise.all([
      firstHandler(request('/prototype-legacy-bridge', {}, undefined, credential)),
      secondHandler(request('/reset-password', { token: resetToken, newPassword: 'race-safe-password' })),
    ]);
    expect(reset.status).toBe(200);
    expect([200, 401]).toContain(bridge.status);
    if (bridge.status === 200) expect(await (await readSession(cookieFrom(bridge))).json()).toBeNull();
    expect((await firstHandler(request('/prototype-legacy-bridge', {}, undefined, credential))).status).toBe(401);
  });

  it('a provider-translated 500 rolls back password, token consumption and revocation together', async () => {
    const userId = await seedUser();
    const resetToken = await seedReset(userId);
    let mutationHookReached = false;
    const failing = createPrototypeLegacyHandler(environment.database, async () => {
      mutationHookReached = true;
      throw new Error('Synthetic failure after cutoff persistence');
    });
    const result = await failing(
      request('/reset-password', { token: resetToken, newPassword: 'must-not-be-committed' }),
    );
    expect(result.status).toBe(500);
    expect(mutationHookReached).toBe(true);
    const [account] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(eq(environment.schema.account.userId, userId));
    expect(account.password).toBe(passwordHash);
    expect(
      await environment.database
        .select()
        .from(environment.schema.verification)
        .where(eq(environment.schema.verification.identifier, `reset-password:${resetToken}`)),
    ).toHaveLength(1);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, userId)),
    ).toHaveLength(0);
  });

  it('a rollback rehearsal preserves already committed cutoffs and changed credentials', async () => {
    const userId = await seedUser();
    const credential = await legacyToken(userId);
    const resetToken = await seedReset(userId);
    expect(
      (
        await firstHandler(
          request('/reset-password', {
            token: resetToken,
            newPassword: 'committed-before-rollback',
          }),
        )
      ).status,
    ).toBe(200);
    const restarted = createPrototypeLegacyHandler(environment.database);
    expect((await restarted(request('/prototype-legacy-bridge', {}, undefined, credential))).status).toBe(401);
    const [account] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(eq(environment.schema.account.userId, userId));
    expect(await compare('committed-before-rollback', account.password!)).toBe(true);
    expect(await compare(PASSWORD, account.password!)).toBe(false);
  });
});
