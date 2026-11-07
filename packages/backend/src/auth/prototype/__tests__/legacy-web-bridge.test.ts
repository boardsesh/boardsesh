import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeLegacyHandler, PROTOTYPE_LEGACY_WEB_SECRET } from '../legacy-bridge';
import { PROTOTYPE_ISSUER } from '../oauth-options';

const { encode } = createRequire(new URL('../../../../../web/package.json', import.meta.url))('next-auth/jwt') as {
  encode: (options: { token: Record<string, unknown>; secret: string; maxAge?: number }) => Promise<string>;
};
type Environment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
type Handler = ReturnType<typeof createPrototypeLegacyHandler>;
let environment: Environment;
let firstHandler: Handler;
let secondHandler: Handler;

async function user() {
  const userId = randomUUID();
  await environment.database.insert(environment.schema.user).values({
    id: userId,
    name: 'Legacy browser fixture',
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  return userId;
}

function oldCookie(token: string, secure = true) {
  return `${secure ? '__Secure-' : ''}next-auth.session-token=${token}`;
}

function request(cookie: string, path = '/prototype-legacy-bridge', body: unknown = {}) {
  return new Request(`${PROTOTYPE_ISSUER}${path}`, {
    method: 'POST',
    headers: { cookie, origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function canonicalCookie(response: Response) {
  const header = response.headers.getSetCookie().find((cookie) => cookie.includes('better-auth.session_token='));
  expect(header).toBeDefined();
  return header!.split(';')[0];
}

function readSession(cookie: string, handler = secondHandler) {
  return handler(new Request(`${PROTOTYPE_ISSUER}/get-session`, { headers: { cookie } }));
}

function signedWebToken(userId: string, extra: Record<string, unknown> = {}) {
  return encode({ token: { sub: userId, ...extra }, secret: PROTOTYPE_LEGACY_WEB_SECRET, maxAge: 30 * 24 * 60 * 60 });
}

async function resetToken(userId: string) {
  const token = randomUUID();
  await environment.database.insert(environment.schema.verification).values({
    id: randomUUID(),
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return token;
}

describe('actual NextAuth cookie to canonical authority bridge', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    firstHandler = createPrototypeLegacyHandler(environment.database);
    secondHandler = createPrototypeLegacyHandler(environment.database);
  });
  afterAll(async () => environment?.close());

  it.each([false, true])(
    'bridges the installed encoder with secure-name=%s without manufacturing fresh auth',
    async (secure) => {
      const userId = await user();
      const token = await signedWebToken(userId, { auth_time: Math.floor(Date.now() / 1000) });
      const response = await firstHandler(request(oldCookie(token, secure)));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ userId });
      const cookie = canonicalCookie(response);
      expect(await (await readSession(cookie)).json()).toMatchObject({
        user: { id: userId },
        session: { createdAt: new Date(0).toISOString(), originalAuthenticatedAt: null },
      });
      const sensitive = await secondHandler(new Request(`${PROTOTYPE_ISSUER}/list-sessions`, { headers: { cookie } }));
      expect(sensitive.status).toBe(403);
      expect(await sensitive.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
    },
  );

  it('accepts contiguous chunks independent of header order and rejects cross-account conflicts', async () => {
    const userId = await user();
    const token = await signedWebToken(userId, { authSessionId: randomUUID() });
    const midpoint = Math.floor(token.length / 2);
    const chunks = `__Secure-next-auth.session-token.1=${token.slice(midpoint)}; __Secure-next-auth.session-token.0=${token.slice(0, midpoint)}`;
    const response = await firstHandler(request(chunks));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId });
    const otherUserToken = await signedWebToken(await user());
    expect((await secondHandler(request(`${chunks}; ${oldCookie(otherUserToken, false)}`))).status).toBe(401);
  });

  it('different rolling JWTs with one explicit login lineage remain one session across instances', async () => {
    const userId = await user();
    const authSessionId = randomUUID();
    const original = await signedWebToken(userId, { authSessionId });
    const rotated = await signedWebToken(userId, { authSessionId });
    expect(rotated).not.toBe(original);
    const results = await Promise.all([
      firstHandler(request(oldCookie(original))),
      secondHandler(request(oldCookie(rotated))),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    const bodies = await Promise.all(results.map(async (result) => result.json() as Promise<{ sessionId: string }>));
    expect(bodies[0].sessionId).toBe(bodies[1].sessionId);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, userId)),
    ).toHaveLength(1);
  });

  it.each([false, true])('sign-out tombstones a web lineage with explicit-session=%s', async (explicitSession) => {
    const userId = await user();
    const token = await signedWebToken(userId, explicitSession ? { authSessionId: randomUUID() } : {});
    const response = await firstHandler(request(oldCookie(token)));
    const cookie = canonicalCookie(response);
    expect((await secondHandler(request(cookie, '/sign-out'))).status).toBe(200);
    const restarted = createPrototypeLegacyHandler(environment.database);
    expect((await restarted(request(oldCookie(token)))).status).toBe(401);
    expect(await (await readSession(cookie)).json()).toBeNull();
  });

  it('an ahead-clock unbridged cookie cannot bypass a later password-reset cutoff', async () => {
    const userId = await user();
    let token: string;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 30_000);
      token = await signedWebToken(userId, { authSessionId: randomUUID() });
    } finally {
      vi.useRealTimers();
    }
    // This cookie is cryptographically valid under the 60-second backend policy,
    // but raw future iat is not evidence that it was issued after this reset.
    const tokenForReset = await resetToken(userId);
    expect(
      (
        await firstHandler(
          request('', '/reset-password', { token: tokenForReset, newPassword: 'new-browser-fixture-password' }),
        )
      ).status,
    ).toBe(200);
    expect((await secondHandler(request(oldCookie(token!)))).status).toBe(401);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, userId)),
    ).toHaveLength(0);
  });

  it('canonical signout denies new old-cookie admission while preserving another mapped live session', async () => {
    const registration = await firstHandler(
      request('', '/sign-up/email', {
        name: 'Canonical signout fixture',
        email: `${randomUUID()}@example.test`,
        password: 'canonical-signout-password',
      }),
    );
    expect(registration.status).toBe(200);
    const { user: registeredUser } = (await registration.json()) as { user: { id: string } };
    const freshCookie = canonicalCookie(registration);
    const mappedToken = await signedWebToken(registeredUser.id, { authSessionId: randomUUID() });
    const mapped = await firstHandler(request(oldCookie(mappedToken)));
    expect(mapped.status).toBe(200);
    const mappedCookie = canonicalCookie(mapped);
    const unseenToken = await signedWebToken(registeredUser.id);
    expect((await secondHandler(request(freshCookie, '/sign-out'))).status).toBe(200);

    const restarted = createPrototypeLegacyHandler(environment.database);
    expect((await restarted(request(oldCookie(unseenToken)))).status).toBe(401);
    const renewedUnseenToken = await signedWebToken(registeredUser.id, { authSessionId: randomUUID() });
    expect((await restarted(request(oldCookie(renewedUnseenToken)))).status).toBe(401);
    expect((await restarted(request(oldCookie(mappedToken)))).status).toBe(200);
    expect(await (await readSession(mappedCookie)).json()).toMatchObject({ user: { id: registeredUser.id } });
    expect(await (await readSession(freshCookie)).json()).toBeNull();
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, registeredUser.id)),
    ).toEqual([]);
  });

  it('preserves the signed expiry separately from the bounded accepted clock grace', async () => {
    const userId = await user();
    const now = Math.floor(Date.now() / 1000);
    const key = await hkdf(
      'sha256',
      new TextEncoder().encode(PROTOTYPE_LEGACY_WEB_SECRET),
      '',
      'NextAuth.js Generated Encryption Key',
      32,
    );
    const token = await new EncryptJWT({ sub: userId, iat: now - 100, exp: now - 30 })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .encrypt(key);
    const response = await firstHandler(request(oldCookie(token)));
    expect(response.status).toBe(200);
    const [lineage] = await environment.database
      .select()
      .from(environment.schema.prototypeLegacyLineage)
      .where(eq(environment.schema.prototypeLegacyLineage.userId, userId));
    const [session] = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.id, lineage.sessionId));
    expect(lineage.originalExpiresAt).toEqual(new Date((now - 30) * 1000));
    expect(session.expiresAt).toEqual(new Date((now + 30) * 1000));
    expect(session.createdAt).toEqual(new Date(0));
  });

  it('a valid canonical cookie for another account prevents a stale legacy cookie overwriting it', async () => {
    const userId = await user();
    const registration = await environment.auth.api.signUpEmail({
      body: {
        name: 'Current canonical account',
        email: `${randomUUID()}@example.test`,
        password: 'canonical-fixture-password',
      },
      asResponse: true,
    });
    expect(registration.status).toBe(200);
    const signedIn = (await registration.json()) as { user: { id: string } };
    const currentCookie = canonicalCookie(registration);
    const legacy = oldCookie(await signedWebToken(userId));
    expect((await firstHandler(request(`${legacy}; ${currentCookie}`))).status).toBe(401);
    expect(await (await readSession(currentCookie)).json()).toMatchObject({ user: { id: signedIn.user.id } });
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, userId)),
    ).toHaveLength(0);
  });

  it('a valid session survives an invalid stale alternate without trusting its claims', async () => {
    const userId = await user();
    const response = await firstHandler(
      request(`${oldCookie(await signedWebToken(userId))}; next-auth.session-token=not-a-jwe`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId });
  });

  it('reset racing a cookie bridge leaves no usable canonical descendant', async () => {
    const userId = await user();
    const cookie = oldCookie(await signedWebToken(userId));
    const tokenForReset = await resetToken(userId);
    const [bridge, reset] = await Promise.all([
      firstHandler(request(cookie)),
      secondHandler(request('', '/reset-password', { token: tokenForReset, newPassword: 'racing-browser-password' })),
    ]);
    expect(reset.status).toBe(200);
    expect([200, 401]).toContain(bridge.status);
    if (bridge.status === 200) expect(await (await readSession(canonicalCookie(bridge))).json()).toBeNull();
    expect((await firstHandler(request(cookie))).status).toBe(401);
  });
});
