import { createHash, createHmac, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { eq, like, sql } from 'drizzle-orm';
import { decodeJwt, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { z } from 'zod';
import {
  createPrototypeCanonicalHandoff,
  PROTOTYPE_CANONICAL_HANDOFF_PATHS,
  PROTOTYPE_CANONICAL_HANDOFF_PREFIX,
} from '../canonical-handoff';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeAuthority } from '../authority';
import { createPrototypeNativeFacade } from '../identity-native-facade';
import { createPrototypeLegacyHandler, PROTOTYPE_LEGACY_KEY, revokePrototypeUser } from '../legacy-bridge';
import { createPrototypeLegacyTransferFacade } from '../legacy-transfer';
import { createPrototypeLifecycleMutations, PROTOTYPE_LIFECYCLE_PATHS } from '../lifecycle-mutations';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import { assertLegacyNativeTokenPair } from './identity-native-contract';

const password = 'canonical-handoff-original-password';
const nextPassword = 'canonical-handoff-next-password';
const handoffKey = new TextEncoder().encode('boardsesh-disposable-canonical-handoff-only-key-6975');
const nativeKey = new TextEncoder().encode('boardsesh-disposable-canonical-handoff-native-key-6975');
const legacyTransferSecret = 'boardsesh-disposable-handoff-old-transfer-secret';
type Facade = ReturnType<typeof createPrototypeCanonicalHandoff>;

function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .filter((cookie) => cookie.includes('better-auth.session_token='))
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function request(path: string, body: unknown = {}, cookie?: string, extra: Record<string, string> = {}) {
  return new Request(`${PROTOTYPE_ISSUER}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie, origin: 'https://www.boardsesh.test' } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

describe('future fenced canonical browser-to-native handoff', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let passwordHash: string;
  let first: Facade;
  let second: Facade;
  let native: ReturnType<typeof createPrototypeNativeFacade>;

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    passwordHash = await hash(password, 4);
    first = createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey);
    second = createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey);
    native = createPrototypeNativeFacade(environment.database, nativeKey);
  });
  afterAll(async () => environment?.close());

  async function fixture() {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    await environment.database
      .insert(environment.schema.user)
      .values({ id: userId, name: 'Handoff fixture', email, emailVerified: true });
    await environment.database.insert(environment.schema.account).values({
      id: randomUUID(),
      userId,
      providerId: 'credential',
      accountId: userId,
      password: passwordHash,
    });
    const signedIn = await environment.auth.api.signInEmail({ body: { email, password }, asResponse: true });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.getSetCookie().join(';')).toMatch(/HttpOnly/i);
    const cookie = cookieFrom(signedIn);
    const session = await environment.secondaryAuth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.id).toBe(userId);
    return { userId, email, cookie, sessionId: session!.session.id };
  }

  async function issue(cookie: string, facade = first) {
    const response = await facade.handler(request(PROTOTYPE_CANONICAL_HANDOFF_PATHS.issue, {}, cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return z.object({ transferToken: z.string(), expiresAt: z.iso.datetime() }).parse(await response.json());
  }

  function exchange(transferToken: string, facade = second, cookie?: string) {
    return facade.handler(request(PROTOTYPE_CANONICAL_HANDOFF_PATHS.exchange, { transferToken }, cookie));
  }

  async function session(sessionId: string) {
    const [record] = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.id, sessionId));
    return record;
  }

  async function receipt(transferToken: string) {
    const identifier = `${PROTOTYPE_CANONICAL_HANDOFF_PREFIX}${createHash('sha256').update(transferToken).digest('hex')}`;
    const [record] = await environment.database
      .select()
      .from(environment.schema.verification)
      .where(eq(environment.schema.verification.id, identifier));
    return record;
  }

  async function reset(userId: string, afterMutation?: () => Promise<void>) {
    const token = randomUUID();
    await environment.database.insert(environment.schema.verification).values({
      id: randomUUID(),
      identifier: `reset-password:${token}`,
      value: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return createPrototypeLegacyHandler(
      environment.database,
      afterMutation,
    )(request('/reset-password', { token, newPassword: nextPassword }));
  }

  async function signout(cookie: string) {
    return createPrototypeLegacyHandler(environment.database)(request('/sign-out', {}, cookie));
  }

  async function assertRejectedPair(response: Response) {
    if (response.status === 200) {
      const pair = z.object({ jwt: z.string(), refreshToken: z.string() }).parse(await response.json());
      expect(await native.validateAccessToken(pair.jwt)).toBeNull();
      await expect(native.refresh(pair.refreshToken)).rejects.toThrow();
    } else expect(response.status).toBe(401);
  }

  it('uses a real HttpOnly canonical cookie and persists only hashed token/nonce with an exact 120-second source binding', async () => {
    const identity = await fixture();
    const original = await session(identity.sessionId);
    const issued = await issue(identity.cookie);
    const claims = decodeJwt(issued.transferToken);
    expect(claims).toMatchObject({
      sub: identity.userId,
      sid: identity.sessionId,
      generation: 0,
      purpose: 'canonical-browser-native-handoff',
      version: 1,
    });
    expect(Number(claims.expiresAtMs) - Number(claims.issuedAtMs)).toBe(120_000);
    const stored = await receipt(issued.transferToken);
    expect(stored.expiresAt.toISOString()).toBe(issued.expiresAt);
    expect(stored.value).not.toContain(issued.transferToken);
    expect(stored.value).not.toContain(claims.nonce);
    expect(JSON.parse(stored.value)).toMatchObject({
      userId: identity.userId,
      sessionId: identity.sessionId,
      generation: 0,
      consumedAt: null,
    });
    expect(await session(identity.sessionId)).toEqual(original);
    const response = await exchange(issued.transferToken);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const pair = await response.json();
    const verified = await assertLegacyNativeTokenPair(pair, nativeKey, identity.userId);
    expect(verified.sid).toBe(identity.sessionId);
    expect(verified.auth_time).toBe(Math.floor(original.createdAt.getTime() / 1000));
    expect(await native.validateAccessToken(z.object({ jwt: z.string() }).parse(pair).jwt)).toEqual({
      userId: identity.userId,
      sessionId: identity.sessionId,
    });
    expect((await session(identity.sessionId)).createdAt).toEqual(original.createdAt);
    expect(JSON.parse((await receipt(issued.transferToken)).value).consumedAt).not.toBeNull();
  });

  it('accepts an ordinary unknown-age real legacy bridge session without granting fresh authentication', async () => {
    const identity = await fixture();
    const legacy = await new SignJWT({ sub: identity.userId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(PROTOTYPE_LEGACY_KEY);
    const bridged = await createPrototypeLegacyHandler(environment.database)(
      request('/prototype-legacy-bridge', {}, undefined, { authorization: `Bearer ${legacy}` }),
    );
    expect(bridged.status).toBe(200);
    const cookie = cookieFrom(bridged);
    const canonical = await environment.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(canonical?.session.createdAt).toEqual(new Date(0));
    const original = await session(canonical!.session.id);
    expect(original.originalAuthenticatedAt).toBeNull();
    const issued = await issue(cookie);
    const response = await exchange(issued.transferToken);
    const pair = await response.json();
    expect(response.status).toBe(200);
    const claims = await assertLegacyNativeTokenPair(pair, nativeKey, identity.userId);
    expect(claims.auth_time).toBeUndefined();
    const continued = await session(canonical!.session.id);
    expect(continued.createdAt).toEqual(new Date(0));
    expect(continued.originalAuthenticatedAt).toBeNull();
    expect(continued.legacyLineageId).toBe(original.legacyLineageId);
    expect(
      (
        await environment.secondaryAuth.handler(
          new Request(`${PROTOTYPE_ISSUER}/list-sessions`, { headers: { cookie } }),
        )
      ).status,
    ).toBe(403);
  });

  it('retains old proven authentication time through exchange and refresh', async () => {
    const identity = await fixture();
    const authenticatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await environment.database
      .update(environment.schema.session)
      .set({ createdAt: authenticatedAt, originalAuthenticatedAt: authenticatedAt })
      .where(eq(environment.schema.session.id, identity.sessionId));
    const issued = await issue(identity.cookie);
    const response = await exchange(issued.transferToken);
    const pair = z.object({ jwt: z.string(), refreshToken: z.string() }).parse(await response.json());
    expect(response.status).toBe(200);
    expect(decodeJwt(pair.jwt).auth_time).toBe(Math.floor(authenticatedAt.getTime() / 1000));
    const refreshed = await native.refresh(pair.refreshToken);
    expect(decodeJwt(refreshed.jwt).auth_time).toBe(Math.floor(authenticatedAt.getTime() / 1000));
    expect((await session(identity.sessionId)).createdAt).toEqual(authenticatedAt);
  });

  it.each(['missing-cookie', 'tampered-cookie', 'attacker-origin', 'cross-site', 'public-owner'] as const)(
    'rejects issuing through %s without publishing a receipt',
    async (failure) => {
      const identity = await fixture();
      const before = await environment.database
        .select()
        .from(environment.schema.verification)
        .where(like(environment.schema.verification.id, `${PROTOTYPE_CANONICAL_HANDOFF_PREFIX}%`));
      const headers: Record<string, string> =
        failure === 'attacker-origin'
          ? { origin: 'https://attacker.example.test' }
          : failure === 'cross-site'
            ? { 'sec-fetch-site': 'cross-site', origin: 'https://attacker.example.test' }
            : {};
      const response = await first.handler(
        request(
          PROTOTYPE_CANONICAL_HANDOFF_PATHS.issue,
          failure === 'public-owner' ? { userId: identity.userId } : {},
          failure === 'missing-cookie'
            ? undefined
            : failure === 'tampered-cookie'
              ? `${identity.cookie}tampered`
              : identity.cookie,
          headers,
        ),
      );
      expect([400, 401, 403]).toContain(response.status);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(
        await environment.database
          .select()
          .from(environment.schema.verification)
          .where(like(environment.schema.verification.id, `${PROTOTYPE_CANONICAL_HANDOFF_PREFIX}%`)),
      ).toEqual(before);
    },
  );

  it('rejects a conflicting optional browser actor, leaves receipt unused, and permits cookie-less native exchange', async () => {
    const identity = await fixture();
    const other = await fixture();
    const issued = await issue(identity.cookie);
    const denied = await exchange(issued.transferToken, second, other.cookie);
    expect(denied.status).toBe(403);
    expect(JSON.parse((await receipt(issued.transferToken)).value).consumedAt).toBeNull();
    expect((await exchange(issued.transferToken)).status).toBe(200);
  });

  it('allows the exact source-session optional browser cookie without changing its owner', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    expect((await exchange(issued.transferToken, second, identity.cookie)).status).toBe(200);
    expect(
      (await environment.secondaryAuth.api.getSession({ headers: new Headers({ cookie: identity.cookie }) }))?.user.id,
    ).toBe(identity.userId);
  });

  it.each(['cookie-less', 'exact-source-cookie'] as const)(
    'rejects a different live same-user cookie without consumption or mint, then permits %s exchange',
    async (retry) => {
      const identity = await fixture();
      const issued = await issue(identity.cookie);
      const another = await environment.secondaryAuth.api.signInEmail({
        body: { email: identity.email, password },
        asResponse: true,
      });
      expect(another.status).toBe(200);
      const anotherCookie = cookieFrom(another);
      const actor = await environment.auth.api.getSession({ headers: new Headers({ cookie: anotherCookie }) });
      expect(actor?.user.id).toBe(identity.userId);
      expect(actor?.session.id).not.toBe(identity.sessionId);
      expect((await session(identity.sessionId)).expiresAt.getTime()).toBeGreaterThan(Date.now());
      const before = await receipt(issued.transferToken);
      const originalSource = await session(identity.sessionId);
      const denied = await exchange(issued.transferToken, second, anotherCookie);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'ACCOUNT_MISMATCH' });
      expect(await receipt(issued.transferToken)).toEqual(before);
      expect(await session(identity.sessionId)).toEqual(originalSource);
      expect(
        await environment.database
          .select()
          .from(environment.schema.prototypeNativeRefresh)
          .where(eq(environment.schema.prototypeNativeRefresh.userId, identity.userId)),
      ).toEqual([]);
      const accepted = await exchange(
        issued.transferToken,
        second,
        retry === 'cookie-less' ? undefined : identity.cookie,
      );
      expect(accepted.status).toBe(200);
      const claims = await assertLegacyNativeTokenPair(await accepted.json(), nativeKey, identity.userId);
      expect(claims.sid).toBe(identity.sessionId);
    },
  );

  it('one of two authorities consumes once, retains its tombstone after recreation, and does not recover a lost response', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    const responses = await Promise.all([
      exchange(issued.transferToken, first),
      exchange(issued.transferToken, second),
    ]);
    expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([200, 401]);
    const recreated = createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey);
    expect((await exchange(issued.transferToken, recreated)).status).toBe(401);
    const pending = await issue(identity.cookie, recreated);
    // Deliberately discard a successful HTTP response after the commit.
    expect((await exchange(pending.transferToken, recreated)).status).toBe(200);
    expect((await exchange(pending.transferToken, recreated)).status).toBe(401);
    expect((await exchange((await issue(identity.cookie, recreated)).transferToken, recreated)).status).toBe(200);
  });

  it('expires at the exact signed millisecond bound with zero grace', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse(issued.expiresAt));
      expect((await exchange(issued.transferToken)).status).toBe(401);
      expect(JSON.parse((await receipt(issued.transferToken)).value).consumedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['signature', 'purpose', 'version', 'nonce', 'source', 'native-token', 'legacy-key'] as const)(
    'rejects %s substitution without consuming the genuine receipt',
    async (failure) => {
      const identity = await fixture();
      const issued = await issue(identity.cookie);
      let substituted = issued.transferToken;
      if (failure === 'signature') substituted = `${issued.transferToken.slice(0, -5)}aaaaa`;
      else if (failure === 'native-token')
        substituted = (await native.issueForVerifiedSession(identity.userId, identity.sessionId)).jwt;
      else {
        const claims = { ...decodeJwt(issued.transferToken) };
        if (failure === 'purpose') claims.purpose = 'password-reset';
        if (failure === 'version') claims.version = 2;
        if (failure === 'nonce') claims.nonce = '0'.repeat(64);
        if (failure === 'source') claims.sid = randomUUID();
        substituted = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'HS256', typ: 'boardsesh-canonical-handoff+jwt' })
          .sign(failure === 'legacy-key' ? PROTOTYPE_LEGACY_KEY : handoffKey);
      }
      expect((await exchange(substituted)).status).toBe(401);
      expect((await exchange(issued.transferToken)).status).toBe(200);
    },
  );

  it('rejects expiry and purpose corruption in the stored receipt', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    const stored = await receipt(issued.transferToken);
    await environment.database
      .update(environment.schema.verification)
      .set({ expiresAt: new Date(stored.expiresAt.getTime() + 1) })
      .where(eq(environment.schema.verification.id, stored.id));
    expect((await exchange(issued.transferToken)).status).toBe(401);
    await environment.database
      .update(environment.schema.verification)
      .set({
        expiresAt: stored.expiresAt,
        value: JSON.stringify({ ...JSON.parse(stored.value), purpose: 'password-reset' }),
      })
      .where(eq(environment.schema.verification.id, stored.id));
    expect((await exchange(issued.transferToken)).status).toBe(401);
  });

  it('rolls back a translated post-issuance 500 and publishes no token or cookie', async () => {
    const identity = await fixture();
    const faulty = createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey, {
      afterIssued: async () => {
        throw new APIError('INTERNAL_SERVER_ERROR');
      },
    });
    const before = await environment.database
      .select()
      .from(environment.schema.verification)
      .where(like(environment.schema.verification.id, `${PROTOTYPE_CANONICAL_HANDOFF_PREFIX}%`));
    const response = await faulty.handler(request(PROTOTYPE_CANONICAL_HANDOFF_PATHS.issue, {}, identity.cookie));
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).not.toContain('transferToken');
    expect(
      await environment.database
        .select()
        .from(environment.schema.verification)
        .where(like(environment.schema.verification.id, `${PROTOTYPE_CANONICAL_HANDOFF_PREFIX}%`)),
    ).toEqual(before);
  });

  it('rolls back actual native mint, receipt consumption and session extension on a translated post-mint 500', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    const original = await session(identity.sessionId);
    let minted = false;
    const faulty = createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey, {
      afterMint: async () => {
        minted = true;
        throw new APIError('INTERNAL_SERVER_ERROR');
      },
    });
    const response = await exchange(issued.transferToken, faulty);
    expect(minted).toBe(true);
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).not.toMatch(/refreshToken|"jwt"/);
    expect(await session(identity.sessionId)).toEqual(original);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.sessionId, identity.sessionId)),
    ).toEqual([]);
    expect(JSON.parse((await receipt(issued.transferToken)).value).consumedAt).toBeNull();
    expect(
      (
        await exchange(
          issued.transferToken,
          createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey),
        )
      ).status,
    ).toBe(200);
  });

  it('rolls back late policy failure and strips all pending auth cookies', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    const faulty = createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey, {
      authority: {
        hooks: {
          after: createAuthMiddleware(async (context) => {
            if (context.path === PROTOTYPE_CANONICAL_HANDOFF_PATHS.exchange) {
              context.setHeader('set-cookie', 'uncommitted=secret; HttpOnly');
              throw new APIError('FORBIDDEN');
            }
          }),
        },
      },
    });
    const response = await exchange(issued.transferToken, faulty);
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(JSON.parse((await receipt(issued.transferToken)).value).consumedAt).toBeNull();
    expect((await exchange(issued.transferToken)).status).toBe(200);
  });

  it.each(['issue', 'exchange'] as const)('rolls back a caller plugin policy APIError after %s', async (operation) => {
    const identity = await fixture();
    const issued = operation === 'exchange' ? await issue(identity.cookie) : null;
    const originalSource = await session(identity.sessionId);
    const before = await environment.database
      .select()
      .from(environment.schema.verification)
      .where(like(environment.schema.verification.id, `${PROTOTYPE_CANONICAL_HANDOFF_PREFIX}%`));
    const faulty = createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey, {
      authority: {
        plugins: [
          {
            id: 'late-canonical-handoff-policy',
            hooks: {
              after: [
                {
                  matcher: (context) => context.path === PROTOTYPE_CANONICAL_HANDOFF_PATHS[operation],
                  handler: createAuthMiddleware(async (context) => {
                    context.setHeader('set-cookie', 'uncommitted-plugin=secret; HttpOnly');
                    throw new APIError('FORBIDDEN', { code: 'HANDOFF_POLICY_REJECTED' });
                  }),
                },
              ],
            },
          },
        ],
      },
    });
    const response = issued
      ? await exchange(issued.transferToken, faulty)
      : await faulty.handler(request(PROTOTYPE_CANONICAL_HANDOFF_PATHS.issue, {}, identity.cookie));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'HANDOFF_POLICY_REJECTED' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await session(identity.sessionId)).toEqual(originalSource);
    expect(
      await environment.database
        .select()
        .from(environment.schema.verification)
        .where(like(environment.schema.verification.id, `${PROTOTYPE_CANONICAL_HANDOFF_PREFIX}%`)),
    ).toEqual(before);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, identity.userId)),
    ).toEqual([]);
    if (issued) expect((await exchange(issued.transferToken)).status).toBe(200);
  });

  it.each(['reset', 'logout', 'delete', 'expired-source', 'generation'] as const)(
    'cannot restore a source after %s',
    async (mutation) => {
      const identity = await fixture();
      const issued = await issue(identity.cookie);
      if (mutation === 'reset') expect((await reset(identity.userId)).status).toBe(200);
      if (mutation === 'logout') expect((await signout(identity.cookie)).status).toBe(200);
      if (mutation === 'delete')
        await environment.database.transaction(async (transaction) => {
          await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
          await revokePrototypeUser(transaction, identity.userId);
          await (await createPrototypeAuthority(transaction).$context).internalAdapter.deleteUser(identity.userId);
        });
      if (mutation === 'expired-source')
        await environment.database
          .update(environment.schema.session)
          .set({ expiresAt: new Date(0) })
          .where(eq(environment.schema.session.id, identity.sessionId));
      if (mutation === 'generation')
        await environment.database
          .insert(environment.schema.prototypeUserCutoff)
          .values({ userId: identity.userId, revokedThrough: new Date(), generation: 1 });
      expect((await exchange(issued.transferToken)).status).toBe(401);
      expect((await first.handler(request(PROTOTYPE_CANONICAL_HANDOFF_PATHS.issue, {}, identity.cookie))).status).toBe(
        401,
      );
    },
  );

  it.each(['reset', 'logout'] as const)(
    'revokes every handoff descendant when exchange wins the %s race',
    async (mutation) => {
      const identity = await fixture();
      const issued = await issue(identity.cookie);
      const entered = deferred();
      const release = deferred();
      const held = createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey, {
        afterMint: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const exchanging = exchange(issued.transferToken, held);
      await entered.promise;
      const mutating = mutation === 'reset' ? reset(identity.userId) : signout(identity.cookie);
      release.resolve();
      const [response, changed] = await Promise.all([exchanging, mutating]);
      expect(response.status).toBe(200);
      expect(changed.status).toBe(200);
      await assertRejectedPair(response);
    },
  );

  it('rejects a waiting exchange when reset commits first', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    const entered = deferred();
    const release = deferred();
    const resetting = reset(identity.userId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const exchanging = exchange(issued.transferToken);
    release.resolve();
    expect((await resetting).status).toBe(200);
    expect((await exchanging).status).toBe(401);
  });

  it('revokes a winning exchange when account deletion races it', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    const entered = deferred();
    const release = deferred();
    const held = createPrototypeCanonicalHandoff(environment.database, handoffKey, nativeKey, {
      afterMint: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const exchanging = exchange(issued.transferToken, held);
    await entered.promise;
    const deleting = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
      await revokePrototypeUser(transaction, identity.userId);
      await (await createPrototypeAuthority(transaction).$context).internalAdapter.deleteUser(identity.userId);
    });
    release.resolve();
    const [response] = await Promise.all([exchanging, deleting]);
    expect(response.status).toBe(200);
    await assertRejectedPair(response);
    expect((await exchange(issued.transferToken)).status).toBe(401);
  });

  it('rejects a token that expires while queued behind the lifecycle fence', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    const entered = deferred();
    const release = deferred();
    const holding = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const exchanging = exchange(issued.transferToken);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse(issued.expiresAt));
      release.resolve();
      const [, response] = await Promise.all([holding, exchanging]);
      expect(response.status).toBe(401);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });

  it('does not substitute another live same-user session when the original source signed out', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    const another = await environment.auth.api.signInEmail({
      body: { email: identity.email, password },
      asResponse: true,
    });
    const anotherCookie = cookieFrom(another);
    expect((await signout(identity.cookie)).status).toBe(200);
    expect((await exchange(issued.transferToken, second, anotherCookie)).status).toBe(401);
    expect((await exchange((await issue(anotherCookie)).transferToken)).status).toBe(200);
  });

  it('permits a genuinely new canonical login after reset while denying every old source', async () => {
    const identity = await fixture();
    const issued = await issue(identity.cookie);
    expect((await reset(identity.userId)).status).toBe(200);
    expect((await exchange(issued.transferToken)).status).toBe(401);
    const signedIn = await environment.secondaryAuth.api.signInEmail({
      body: { email: identity.email, password: nextPassword },
      asResponse: true,
    });
    expect(signedIn.status).toBe(200);
    const fresh = await issue(cookieFrom(signedIn));
    expect(decodeJwt(fresh.transferToken).generation).toBe(1);
    expect(decodeJwt(fresh.transferToken).sid).not.toBe(identity.sessionId);
    expect((await exchange(fresh.transferToken)).status).toBe(200);
  });

  it('copies the optional actor headers before waiting for the lifecycle fence', async () => {
    const identity = await fixture();
    const other = await fixture();
    const issued = await issue(identity.cookie);
    const entered = deferred();
    const release = deferred();
    const holding = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const incoming = request(
      PROTOTYPE_CANONICAL_HANDOFF_PATHS.exchange,
      { transferToken: issued.transferToken },
      other.cookie,
    );
    const exchanging = second.handler(incoming);
    incoming.headers.set('cookie', identity.cookie);
    release.resolve();
    const [, response] = await Promise.all([holding, exchanging]);
    expect(response.status).toBe(403);
    expect((await exchange(issued.transferToken)).status).toBe(200);
  });

  it.each(['change', 'set'] as const)(
    'permits only the new retained-device source after password %s while legacy source-less handoff remains denied',
    async (mutation) => {
      const identity = await fixture();
      if (mutation === 'set') {
        // Trusted fixture setup: a still-authenticated account now lacks its
        // credential. The actual server-only setPassword API creates the new one.
        await environment.database
          .delete(environment.schema.account)
          .where(eq(environment.schema.account.userId, identity.userId));
      }
      const preceding = await exchange((await issue(identity.cookie)).transferToken);
      expect(preceding.status).toBe(200);
      const oldPair = z.object({ jwt: z.string(), refreshToken: z.string() }).parse(await preceding.json());
      const old = await issue(identity.cookie);
      const authenticatedAt = (await session(identity.sessionId)).createdAt;
      const changed = await createPrototypeLifecycleMutations(environment.database).handler(
        request(
          mutation === 'change' ? PROTOTYPE_LIFECYCLE_PATHS.changePassword : PROTOTYPE_LIFECYCLE_PATHS.setPassword,
          { ...(mutation === 'change' ? { currentPassword: password } : {}), newPassword: nextPassword },
          identity.cookie,
        ),
      );
      expect(changed.status).toBe(200);
      const newCookie = cookieFrom(changed);
      expect(newCookie).not.toBe(identity.cookie);
      expect(await native.validateAccessToken(oldPair.jwt)).toBeNull();
      await expect(native.refresh(oldPair.refreshToken)).rejects.toThrow();
      expect((await exchange(old.transferToken)).status).toBe(401);
      const issued = await issue(newCookie, second);
      expect(decodeJwt(issued.transferToken).generation).toBe(1);
      const response = await exchange(issued.transferToken, first);
      expect(response.status).toBe(200);
      const claims = await assertLegacyNativeTokenPair(await response.json(), nativeKey, identity.userId);
      expect(claims.sid).not.toBe(identity.sessionId);
      expect(claims.auth_time).toBe(Math.floor(authenticatedAt.getTime() / 1000));
      const issuedAt = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(
        JSON.stringify({ userId: identity.userId, nextPath: '/', iat: issuedAt, exp: issuedAt + 120 }),
      ).toString('base64url');
      const legacy = `${payload}.${createHmac('sha256', legacyTransferSecret).update(payload).digest('base64url')}`;
      await expect(
        createPrototypeLegacyTransferFacade(environment.database, legacyTransferSecret, nativeKey).exchange(legacy),
      ).rejects.toMatchObject({ status: 401 });
      expect((await reset(identity.userId)).status).toBe(200);
      expect((await first.handler(request(PROTOTYPE_CANONICAL_HANDOFF_PATHS.issue, {}, newCookie))).status).toBe(401);
    },
  );

  it('requires a distinct dedicated synthetic key and copies key bytes before caller mutation', async () => {
    expect(() => createPrototypeCanonicalHandoff(environment.database, nativeKey, nativeKey)).toThrow(
      /own synthetic signing key/,
    );
    expect(() => createPrototypeCanonicalHandoff(environment.database, new Uint8Array(4), nativeKey)).toThrow(
      /at least 32 bytes/,
    );
    const identity = await fixture();
    const mutable = new Uint8Array(handoffKey);
    const sender = createPrototypeCanonicalHandoff(environment.database, mutable, nativeKey);
    mutable.fill(0);
    expect((await exchange((await issue(identity.cookie, sender)).transferToken)).status).toBe(200);
  });
});
