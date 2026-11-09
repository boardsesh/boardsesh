import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeAuthority } from '../authority';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeNativeFacade } from '../identity-native-facade';
import { revokePrototypeUser } from '../legacy-bridge';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import { prototypeSessionPassesRevocation } from '../session-revocation';
import { assertLegacyNativeTokenPair } from './identity-native-contract';

const nativeKey = new TextEncoder().encode('boardsesh-synthetic-generation-native-key-6975');
const password = 'synthetic-generation-password';
type PrototypeEnvironment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
let environment: PrototypeEnvironment;

describe('trusted revocation generation and original authentication age', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
  });
  afterAll(async () => {
    vi.useRealTimers();
    await environment?.close();
  });

  it('preserves custom create hooks while overriding supplied generation with authoritative state', async () => {
    const originalAuthentication = new Date(Date.now() - 120_000);
    let beforeCalls = 0;
    let afterCalls = 0;
    const authority = environment.createAuthority({
      databaseHooks: {
        session: {
          create: {
            async before() {
              beforeCalls += 1;
              return {
                data: { createdAt: originalAuthentication, userAgent: 'generation-hook', revocationGeneration: 999 },
              };
            },
            async after() {
              afterCalls += 1;
            },
          },
        },
      },
    });
    const response = await authority.handler(
      new Request(`${PROTOTYPE_ISSUER}/sign-up/email`, {
        method: 'POST',
        headers: { origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
        body: JSON.stringify({
          email: `${randomUUID()}@example.test`,
          name: 'Generation fixture',
          password,
          revocationGeneration: 888,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const registration = (await response.json()) as { user: { id: string } };
    const [session] = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.userId, registration.user.id));
    expect(session).toMatchObject({
      revocationGeneration: 0,
      userAgent: 'generation-hook',
      createdAt: originalAuthentication,
    });
    expect(beforeCalls).toBe(1);
    expect(afterCalls).toBe(1);
  });

  it('honors an existing create-hook cancellation without issuing any session', async () => {
    let afterCalls = 0;
    const authority = environment.createAuthority({
      databaseHooks: {
        session: {
          create: {
            async before() {
              return false;
            },
            async after() {
              afterCalls += 1;
            },
          },
        },
      },
    });
    const email = `${randomUUID()}@example.test`;
    const response = await authority.handler(
      new Request(`${PROTOTYPE_ISSUER}/sign-up/email`, {
        method: 'POST',
        headers: { origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
        body: JSON.stringify({ email, name: 'Cancelled session fixture', password }),
      }),
    );
    expect(response.headers.getSetCookie().some((cookie) => cookie.includes('session_token='))).toBe(false);
    expect(
      await environment.database
        .select({ id: environment.schema.session.id })
        .from(environment.schema.session)
        .innerJoin(environment.schema.user, eq(environment.schema.user.id, environment.schema.session.userId))
        .where(eq(environment.schema.user.email, email)),
    ).toEqual([]);
    expect(afterCalls).toBe(0);
  });

  it('supports fresh canonical authentication after a cutoff ahead of the local clock', async () => {
    const registration = await environment.auth.api.signUpEmail({
      body: { email: `${randomUUID()}@example.test`, name: 'Clock fixture', password },
    });
    const native = createPrototypeNativeFacade(environment.database, nativeKey);
    const original = await native.credentials(registration.user.email, password);
    const futureCutoff = new Date(Date.now() + 86_400_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(futureCutoff);
      await environment.database.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
        expect(await revokePrototypeUser(transaction, registration.user.id)).toBe(1);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(await native.validateAccessToken(original.jwt)).toBeNull();
    const replacement = await native.credentials(registration.user.email, password);
    expect(await native.validateAccessToken(replacement.jwt)).toMatchObject({ userId: registration.user.id });
    const [session] = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.userId, registration.user.id));
    expect(session.createdAt.getTime()).toBeLessThan(futureCutoff.getTime());
    expect(session.revocationGeneration).toBe(1);
    await assertLegacyNativeTokenPair(await native.refresh(replacement.refreshToken), nativeKey, registration.user.id);
  });

  it('distinguishes two mutations in the same millisecond without manufacturing newer authentication', async () => {
    const registration = await environment.auth.api.signUpEmail({
      body: { email: `${randomUUID()}@example.test`, name: 'Replacement fixture', password },
    });
    const mutationTime = new Date();
    const originalAuthentication = new Date(mutationTime.getTime() - 120_000);
    const native = createPrototypeNativeFacade(environment.database, nativeKey);
    async function replaceSession() {
      return environment.database.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
        const generation = await revokePrototypeUser(transaction, registration.user.id);
        const authority = createPrototypeAuthority(transaction, {
          databaseHooks: {
            session: {
              create: {
                async before() {
                  return {
                    data: { createdAt: originalAuthentication, originalAuthenticatedAt: originalAuthentication },
                  };
                },
              },
            },
          },
        });
        const context = await authority.$context;
        const session = await context.internalAdapter.createSession(registration.user.id);
        if (!session) throw new Error('Expected a trusted replacement session');
        return { session, generation };
      });
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(mutationTime);
      const first = await replaceSession();
      expect(first.generation).toBe(1);
      const firstPair = await native.issueForVerifiedSession(registration.user.id, first.session.id);
      expect(await native.validateAccessToken(firstPair.jwt)).not.toBeNull();
      const second = await replaceSession();
      expect(second.generation).toBe(2);
      expect(await native.validateAccessToken(firstPair.jwt)).toBeNull();
      await expect(native.refresh(firstPair.refreshToken)).rejects.toMatchObject({ status: 401 });
      const secondPair = await native.issueForVerifiedSession(registration.user.id, second.session.id);
      const claims = await assertLegacyNativeTokenPair(secondPair, nativeKey, registration.user.id);
      expect(claims.auth_time).toBe(Math.floor(originalAuthentication.getTime() / 1000));
      const [stored] = await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.id, second.session.id));
      expect(stored.createdAt).toEqual(originalAuthentication);
      expect(stored.originalAuthenticatedAt).toEqual(originalAuthentication);
      expect(stored.revocationGeneration).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stock session creation racing a reset, without the global advisory lock', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
  });
  afterAll(async () => {
    await environment?.close();
  });

  async function registerUser() {
    const registration = await environment.auth.api.signUpEmail({
      body: { email: `${randomUUID()}@example.test`, name: 'Race fixture', password },
    });
    return registration.user;
  }

  function stockSignIn(email: string): Promise<Response> {
    return environment.auth.handler(
      new Request(`${PROTOTYPE_ISSUER}/sign-in/email`, {
        method: 'POST',
        headers: { origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  /** Observes the other connection queued on a lock, so the interleaving is forced rather than timed. */
  async function waitForBackendBlockedOn(statementPattern: string) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const blocked = await environment.database.execute<{ waiting: number }>(sql`
        SELECT count(*)::integer AS waiting FROM pg_catalog.pg_stat_activity
        WHERE datname = pg_catalog.current_database() AND wait_event_type = 'Lock'
          AND query ILIKE ${statementPattern}`);
      if ((blocked[0]?.waiting ?? 0) > 0) return;
      await new Promise((settle) => setTimeout(settle, 10));
    }
    throw new Error(`No backend blocked on ${statementPattern}`);
  }

  async function expectSignInLostTheRace(signIn: Promise<Response> | undefined, userId: string) {
    const response = await signIn;
    if (!response) throw new Error('Expected the sign-in to have started');
    expect(response.status).toBe(401);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.includes('session_token='))).toBe(false);
    expect(
      await environment.database
        .select({ id: environment.schema.session.id })
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, userId)),
    ).toEqual([]);
    const cookieHeader = cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
    expect(await environment.auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }) })).toBeNull();
  }

  it('rejects a session stamped before a reset that committed ahead of its insert', async () => {
    const user = await registerUser();
    let signIn: Promise<Response> | undefined;
    await environment.database.transaction(async (transaction) => {
      // Lets the sign-in read generation 0 and then parks its insert, so the
      // reset commits between the read and the insert, exactly as a slow request.
      await transaction.execute(sql`LOCK TABLE "session" IN SHARE ROW EXCLUSIVE MODE`);
      signIn = stockSignIn(user.email);
      await waitForBackendBlockedOn('insert into "session"%');
      expect(await revokePrototypeUser(transaction, user.id)).toBe(1);
    });
    await expectSignInLostTheRace(signIn, user.id);
  });

  it('makes a session committed during a reset wait for that reset and lose', async () => {
    const user = await registerUser();
    let signIn: Promise<Response> | undefined;
    await environment.database.transaction(async (transaction) => {
      expect(await revokePrototypeUser(transaction, user.id)).toBe(1);
      // The reset's delete has already run, so this committed row is invisible
      // to it. Only waiting on the user row can see the generation it published.
      signIn = stockSignIn(user.email);
      await waitForBackendBlockedOn('select "id" from "user"%for share%');
    });
    await expectSignInLostTheRace(signIn, user.id);
  });
});

describe('pre-generation compatibility boundaries', () => {
  const cutoff = { generation: 2, revokedThrough: new Date('2026-01-01T00:00:00.000Z') };
  it.each([
    { generation: 2, createdAt: new Date(0), accepted: true },
    { generation: 1, createdAt: new Date('2099-01-01'), accepted: false },
    { generation: 0, createdAt: new Date('2099-01-01'), accepted: false },
    { generation: null, createdAt: cutoff.revokedThrough, accepted: false },
    { generation: null, createdAt: new Date(cutoff.revokedThrough.getTime() + 1), accepted: true },
  ])('retains explicit generation and conservative unbound-row behavior: %j', ({ generation, createdAt, accepted }) => {
    expect(prototypeSessionPassesRevocation({ createdAt, revocationGeneration: generation }, cutoff)).toBe(accepted);
  });
  it('does not bless a bound nonzero generation when its authoritative cutoff is missing', () => {
    expect(prototypeSessionPassesRevocation({ createdAt: new Date(), revocationGeneration: 2 }, null)).toBe(false);
  });
});
