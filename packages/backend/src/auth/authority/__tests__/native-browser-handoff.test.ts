import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { and, eq, like, sql } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  mobileRefreshTokens,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { issueBrowserDelegation, admitBrowserDelegation } from '../browser-delegation';
import {
  issueNativeBrowserHandoff,
  redeemNativeBrowserHandoff,
  NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX,
} from '../native-browser-handoff';
import { beginBrowserIntent, commitBrowserLogin } from '../browser-binding';
import { nativeSessionRequiresAccountCutoff } from '../../native-session-ancestry';
import {
  deleteExpiredNativeBrowserHandoffClaims,
  runNativeBrowserHandoffMaintenance,
  NATIVE_BROWSER_HANDOFF_CLEANUP_BATCH_SIZE,
} from '../native-browser-handoff-maintenance';
import { clearExpiredAuthRecords } from '../../../services/background-job-maintenance';
import type { AuthorityDatabase } from '../adapter';

vi.mock('../../credential-database', () => ({ getCredentialDatabase: vi.fn() }));
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_CONTENT_NATIVE_ISSUER');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_CONTENT_NATIVE_READ');
      },
    },
  ),
}));
vi.mock('../../../redis/client', () => ({ redisClientManager: { isRedisConnected: () => false } }));
import { getCredentialDatabase } from '../../credential-database';
import { handleNativeAuthExchange, __resetNativeAuthStateForTests } from '../../../handlers/native-auth';

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
let server: Server;
let origin: string;
const handoffSecret = 'owned-native-browser-handoff-distinct-secret-6975';
const delegationSecret = 'owned-native-test-backend-delegation-secret-6975';
const secrets = () => ({
  NEXTAUTH_SECRET: environment.secret,
  NATIVE_BROWSER_HANDOFF_SECRET: handoffSecret,
  BROWSER_DELEGATION_SECRET: delegationSecret,
});
type Owner = Awaited<ReturnType<typeof environment.actor>>;
function possession(owner: Owner) {
  return {
    bindingToken: owner.actor.browserBindingToken,
    actor: { version: owner.actor.browserVersion, credential: owner.credential },
  };
}
async function issued(owner: Owner) {
  const result = await issueNativeBrowserHandoff(
    environment.database,
    environment.qualification,
    possession(owner),
    secrets(),
  );
  expect(result.status).toBe('admitted');
  if (result.status !== 'admitted') throw new Error('Owned handoff issuance refused');
  return result;
}
async function exchange(transferToken: string) {
  const response = await fetch(`${origin}/auth/native/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transferToken }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const claims = () =>
  environment.database
    .select()
    .from(verificationTokens)
    .where(like(verificationTokens.identifier, `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}%`));

describe('production selected browser handoff with the real native HTTP issuer and PostgreSQL', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    server = createServer((request, response) => {
      void handleNativeAuthExchange(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned native listener missing');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    __resetNativeAuthStateForTests();
    vi.mocked(getCredentialDatabase).mockResolvedValue(environment.database);
    for (const [name, setting] of Object.entries({
      ...secrets(),
      CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_PROJECTION_ID: environment.qualification.expectedProjectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-native-handoff-deleted-address-key-6975',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      BETTER_AUTH_LEGACY_BRIDGE_MODE: 'off',
    }))
      vi.stubEnv(name, setting);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await environment?.close();
  });

  for (const authority of ['current-store', 'better-auth'] as const)
    for (const kind of ['legacy-jwe', 'canonical-token'] as const)
      it.each([false, true])(
        `${authority}/${kind} preserves original known age=%s and the unchanged native response`,
        async (knownAge) => {
          const owner = await environment.actor(authority, kind, { unknownAge: !knownAge });
          const handoff = await issued(owner);
          expect(handoff.token).toMatch(/^bsnh1_[A-Za-z0-9_-]+$/);
          expect(handoff.token).not.toContain(owner.actor.credential);
          const result = await exchange(handoff.token);
          expect(result.status).toBe(200);
          expect(Object.keys(result.body).sort()).toEqual(['expiresAt', 'jwt', 'refreshToken', 'userId']);
          expect(result.body.userId).toBe(owner.userId);
          expect(getCredentialDatabase).toHaveBeenLastCalledWith('private-native-handoff-v1');
          if (typeof result.body.jwt !== 'string' || typeof result.body.refreshToken !== 'string')
            throw new Error('Owned native pair absent');
          const verified = await jwtVerify(result.body.jwt, new TextEncoder().encode(environment.secret), {
            issuer: 'boardsesh',
            audience: 'boardsesh-mobile',
            algorithms: ['HS256'],
          });
          expect(verified.payload.sub).toBe(owner.userId);
          expect(verified.payload.gen).toBe(0);
          expect(verified.payload.auth_time).toBe(
            owner.authenticatedAt ? owner.authenticatedAt.getTime() / 1000 : undefined,
          );
          expect(verified.payload.exp! - verified.payload.iat!).toBe(7 * 86400);
          const [refresh] = await environment.database
            .select()
            .from(mobileRefreshTokens)
            .where(
              eq(mobileRefreshTokens.tokenHash, createHash('sha256').update(result.body.refreshToken).digest('hex')),
            );
          expect(refresh.userId).toBe(owner.userId);
          expect(refresh.authenticatedAt).toEqual(owner.authenticatedAt);
          expect(refresh.subjectGeneration).toBe(0);
          expect(refresh.sessionId && nativeSessionRequiresAccountCutoff(refresh.sessionId)).toBe(
            handoff.session.requiresAccountCutoff,
          );
          expect(refresh.expiresAt.getTime()).toBeGreaterThan(Date.now() + 89 * 86400_000);
          expect(await exchange(handoff.token)).toMatchObject({ status: 409 });
        },
      );

  it('spends a capability once across simultaneous real HTTP requests', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const handoff = await issued(owner);
    const replies = await Promise.all([exchange(handoff.token), exchange(handoff.token), exchange(handoff.token)]);
    expect(replies.map((reply) => reply.status).sort((left, right) => left - right)).toEqual([200, 409, 409]);
    expect(
      await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, owner.userId)),
    ).toHaveLength(1);
    const digest = createHash('sha256').update(handoff.token).digest('hex');
    const [receipt] = await environment.database
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.identifier, `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${digest}`));
    expect(receipt).toEqual({
      identifier: `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${digest}`,
      token: digest,
      expires: handoff.expiresAt,
    });
  });

  it('keeps backend and native capabilities purpose-separated with no legacy fallback', async () => {
    const owner = await environment.actor('current-store', 'canonical-token');
    const handoff = await issued(owner);
    const delegated = await issueBrowserDelegation(
      environment.database,
      environment.qualification,
      possession(owner),
      secrets(),
    );
    if (delegated.status !== 'admitted') throw new Error('Owned backend delegation unavailable');
    expect(
      await admitBrowserDelegation(environment.database, environment.qualification, handoff.token, secrets()),
    ).toEqual({ status: 'denied' });
    expect(
      await redeemNativeBrowserHandoff(
        environment.database,
        environment.qualification,
        delegated.token,
        async () => 'forbidden',
        secrets(),
      ),
    ).toEqual({ status: 'denied' });
    expect(await exchange(delegated.token)).toMatchObject({ status: 401 });
    expect(await exchange(`bsnh1_${handoff.token.slice(6)}x`)).toMatchObject({ status: 401 });
    expect(
      await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, owner.userId)),
    ).toEqual([]);
  });

  it.each(['generation', 'session-denial', 'canonical-token', 'authority'] as const)(
    'refuses changed %s before creating a spent receipt or native row',
    async (changed) => {
      const owner = await environment.actor('current-store', 'canonical-token');
      const handoff = await issued(owner);
      if (changed === 'generation')
        await environment.database
          .insert(authSubjectCutoffs)
          .values({ userId: owner.userId, generation: 1, revokedThrough: new Date(0), lastOperationId: randomUUID() });
      if (changed === 'session-denial')
        await environment.database
          .insert(authSessionDenials)
          .values({ userId: owner.userId, sessionId: owner.sid, expiresAt: owner.sourceExpiresAt });
      if (changed === 'canonical-token')
        await environment.database
          .update(authSession)
          .set({ token: randomUUID() })
          .where(eq(authSession.id, owner.sid));
      if (changed === 'authority') await environment.selectAuthority('better-auth');
      const before = await claims();
      expect(await exchange(handoff.token)).toMatchObject({ status: 401 });
      expect(await claims()).toEqual(before);
      expect(
        await environment.database
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.userId, owner.userId)),
      ).toEqual([]);
    },
  );

  it('refuses the old account after the same browser binding selects another account', async () => {
    const owner = await environment.actor('current-store', 'canonical-token');
    const handoff = await issued(owner);
    const nextOwner = await environment.actor('current-store', 'canonical-token');
    const intent = await beginBrowserIntent(
      environment.database,
      environment.qualification,
      owner.actor.browserBindingToken,
      { operation: 'login', expectedVersion: owner.actor.browserVersion, presented: possession(owner).actor },
    );
    if (intent.status !== 'prepared') throw new Error('Owned replacement unavailable');
    expect(
      (
        await commitBrowserLogin(
          environment.database,
          environment.qualification,
          owner.actor.browserBindingToken,
          intent.intentToken,
          nextOwner.credential,
          possession(owner).actor,
        )
      ).status,
    ).toBe('committed');
    expect(await exchange(handoff.token)).toMatchObject({ status: 401 });
  });

  it('rolls back receipt and real issuer row when PostgreSQL insertion fails, permitting a later retry', async () => {
    const owner = await environment.actor('current-store', 'canonical-token');
    const handoff = await issued(owner);
    await environment.client.unsafe(
      `CREATE FUNCTION owned_handoff_reject() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'owned unavailable issuer'; END$$; CREATE TRIGGER owned_handoff_reject BEFORE INSERT ON mobile_refresh_tokens FOR EACH ROW EXECUTE FUNCTION owned_handoff_reject()`,
    );
    const before = await claims();
    try {
      expect(await exchange(handoff.token)).toMatchObject({ status: 503 });
      expect(await claims()).toEqual(before);
      expect(
        await environment.database
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.userId, owner.userId)),
      ).toEqual([]);
    } finally {
      await environment.client.unsafe(
        'DROP TRIGGER owned_handoff_reject ON mobile_refresh_tokens; DROP FUNCTION owned_handoff_reject()',
      );
    }
    expect(await exchange(handoff.token)).toMatchObject({ status: 200 });
  });

  it('never reconstructs a pair after an unknown COMMIT; its committed receipt still refuses replay', async () => {
    const owner = await environment.actor('current-store', 'canonical-token');
    const handoff = await issued(owner);
    const database = environment.database;
    const uncertain = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'transaction')
          return async (operation: Parameters<AuthorityDatabase['transaction']>[0]) => {
            await target.transaction(operation);
            throw new Error('owned commit acknowledgement lost');
          };
        return Reflect.get(target, property, receiver);
      },
    });
    vi.mocked(getCredentialDatabase).mockResolvedValueOnce(uncertain);
    expect(await exchange(handoff.token)).toMatchObject({
      status: 503,
      body: { error: 'Authentication is temporarily unavailable' },
    });
    expect(
      await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, owner.userId)),
    ).toHaveLength(1);
    expect(await exchange(handoff.token)).toMatchObject({ status: 409 });
  });

  it('rolls back the actual native insert and receipt when the final DB deadline passes despite a slow host clock', async () => {
    const owner = await environment.actor('current-store', 'canonical-token');
    await environment.database
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() + 450) })
      .where(eq(authSession.id, owner.sid));
    const handoff = await issued(owner);
    const before = await claims();
    await environment.client.unsafe(
      `CREATE FUNCTION owned_handoff_delay() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.7); RETURN NEW; END$$; CREATE TRIGGER owned_handoff_delay AFTER INSERT ON mobile_refresh_tokens FOR EACH ROW EXECUTE FUNCTION owned_handoff_delay()`,
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      expect(await exchange(handoff.token)).toMatchObject({ status: 401 });
      expect(await claims()).toEqual(before);
      expect(
        await environment.database
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.userId, owner.userId)),
      ).toEqual([]);
    } finally {
      clock.mockRestore();
      await environment.client.unsafe(
        'DROP TRIGGER owned_handoff_delay ON mobile_refresh_tokens; DROP FUNCTION owned_handoff_delay()',
      );
    }
  });

  it.each(['malformed', 'missing-key', 'shared-key', 'disabled'] as const)(
    'refuses %s before opening the qualified writer pool',
    async (refusal) => {
      const owner = await environment.actor('current-store', 'canonical-token');
      const handoff = await issued(owner);
      vi.mocked(getCredentialDatabase).mockClear();
      if (refusal === 'missing-key') vi.stubEnv('NATIVE_BROWSER_HANDOFF_SECRET', '');
      if (refusal === 'shared-key') vi.stubEnv('NATIVE_BROWSER_HANDOFF_SECRET', environment.secret);
      if (refusal === 'disabled') vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'legacy');
      expect(await exchange(refusal === 'malformed' ? 'bsnh1_not-authenticated' : handoff.token)).toMatchObject({
        status: refusal === 'malformed' ? 401 : 503,
      });
      expect(getCredentialDatabase).not.toHaveBeenCalled();
    },
  );

  it('uses DB expiry for cleanup despite host-clock skew and a non-UTC connection', async () => {
    const owner = await environment.actor('current-store', 'canonical-token');
    const handoff = await issued(owner);
    expect(await exchange(handoff.token)).toMatchObject({ status: 200 });
    const expiredHash = createHash('sha256').update(randomUUID()).digest('hex');
    await environment.database.insert(verificationTokens).values({
      identifier: `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${expiredHash}`,
      token: expiredHash,
      expires: new Date(Date.now() - 60_000),
    });
    const futureHostTime = Date.now() + 86400_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(futureHostTime);
    const timezoneDatabase = new Proxy(environment.database, {
      get(target, property, receiver) {
        if (property === 'transaction')
          return (operation: Parameters<AuthorityDatabase['transaction']>[0]) =>
            target.transaction(async (transaction) => {
              await transaction.execute(sql`SET LOCAL TIME ZONE 'Pacific/Honolulu'`);
              return operation(transaction);
            });
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      expect(await deleteExpiredNativeBrowserHandoffClaims(timezoneDatabase)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const digest = createHash('sha256').update(handoff.token).digest('hex');
    expect(
      await environment.database
        .select()
        .from(verificationTokens)
        .where(
          and(
            eq(verificationTokens.identifier, `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${digest}`),
            eq(verificationTokens.token, digest),
          ),
        ),
    ).toHaveLength(1);
    expect(await exchange(handoff.token)).toMatchObject({ status: 409 });
  });

  it('cleans through the qualified compatible pool while browser rollout is off, without a content fallback', async () => {
    const digest = createHash('sha256').update(randomUUID()).digest('hex');
    await environment.database.insert(verificationTokens).values({
      identifier: `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${digest}`,
      token: digest,
      expires: new Date(Date.now() - 60_000),
    });
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', 'owned-configured-principal');
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'legacy');
    vi.mocked(getCredentialDatabase).mockClear();
    const content = new Proxy(
      {},
      {
        get() {
          throw new Error('owned content connection unavailable');
        },
      },
    ) as AuthorityDatabase;
    await clearExpiredAuthRecords(content);
    expect(getCredentialDatabase).toHaveBeenCalledExactlyOnceWith('private-web-v1');
    expect(
      await environment.database
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.identifier, `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${digest}`)),
    ).toEqual([]);
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', '');
    vi.mocked(getCredentialDatabase).mockClear();
    expect(await runNativeBrowserHandoffMaintenance()).toBeNull();
    expect(getCredentialDatabase).not.toHaveBeenCalled();
  });

  it('bounds an expiry backlog and leaves unrelated verification purposes intact', async () => {
    const expired = Array.from({ length: NATIVE_BROWSER_HANDOFF_CLEANUP_BATCH_SIZE + 1 }, () => {
      const digest = createHash('sha256').update(randomUUID()).digest('hex');
      return {
        identifier: `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${digest}`,
        token: digest,
        expires: new Date(Date.now() - 60_000),
      };
    });
    const unrelated = { identifier: `unrelated-owned-${randomUUID()}`, token: randomUUID(), expires: new Date(0) };
    await environment.database.insert(verificationTokens).values([...expired, unrelated]);
    expect(await deleteExpiredNativeBrowserHandoffClaims(environment.database)).toBe(
      NATIVE_BROWSER_HANDOFF_CLEANUP_BATCH_SIZE,
    );
    expect(await deleteExpiredNativeBrowserHandoffClaims(environment.database)).toBe(1);
    expect(
      await environment.database
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.identifier, unrelated.identifier)),
    ).toEqual([unrelated]);
  });
});
