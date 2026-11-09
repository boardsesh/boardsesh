import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  accounts,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  sessions,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { eq, sql, type SQL } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { startAppRouterHarness } from './fixtures/app-router-harness';
import { startAppRouterCompound } from './fixtures/app-router-compound';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type ExpectedCurrentStoreAuthority } from '../foundation-context';
interface Page {
  url(): string;
  setDefaultTimeout(milliseconds: number): void;
  setDefaultNavigationTimeout(milliseconds: number): void;
  goto(url: string): Promise<unknown>;
  evaluate<T>(operation: () => T): Promise<T>;
  setContent(html: string): Promise<void>;
  getByRole(role: 'button', options: { name: string }): { click(): Promise<void> };
  waitForURL(url: string): Promise<void>;
}
interface BrowserRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(reason: string): Promise<void>;
}
interface BrowserContext {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  cookies(url: string): Promise<{ name: string; value: string; sameSite: string; secure: boolean }[]>;
  addCookies(
    cookies: { url: string; name: string; value: string; httpOnly: boolean; secure: boolean; sameSite: string }[],
  ): Promise<void>;
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Browser {
  newContext(options: { ignoreHTTPSErrors: boolean }): Promise<BrowserContext>;
  close(): Promise<void>;
}

// Explicit local proof selection; normal backend CI does not imply Chromium exists.
const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { chromium } = webRequire('@playwright/test') as {
  chromium: { launch(options: { headless: boolean; args: string[] }): Promise<Browser> };
};
const role = `ba03_router_browser_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(32).toString('hex');
const tables = [users, accounts, userCredentials, userProfiles, sessions, verificationTokens];
const admissionReadTables = [authSubjectCutoffs];
const actorId = randomUUID();
const ownerId = randomUUID();
const subject = randomUUID();
const email = `${ownerId}@example.test`;
let tracked = false;
let harness: Awaited<ReturnType<typeof startAppRouterHarness>> | undefined;
let browser: Browser | undefined;
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
async function startApple(context: BrowserContext, page: Page, app = harness) {
  if (!app) throw new Error('Missing owned browser fixture');
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(6000);
  let blocked = 0;
  await context.route('**/*', async (intercepted) => {
    const address = new URL(intercepted.request().url());
    if (address.origin === app.origin || address.origin === app.providerOrigin) return intercepted.continue();
    blocked += 1;
    return intercepted.abort('blockedbyclient');
  });
  let checkpoint = 'csrf';
  try {
    await page.goto(`${app.origin}/api/auth/csrf`);
    const csrfToken = await page.evaluate(
      () => (JSON.parse(document.body.innerText) as { csrfToken: string }).csrfToken,
    );
    await page.setContent(
      `<form method="POST" action="${app.origin}/api/auth/signin/apple"><input name="csrfToken" type="hidden" value="${csrfToken}"><input name="callbackUrl" type="hidden" value="${app.origin}/signed-in"><button>Start Apple</button></form>`,
    );
    checkpoint = 'start-form';
    await page.getByRole('button', { name: 'Start Apple' }).click();
    checkpoint = 'provider-landing';
    await page.waitForURL(`${app.providerOrigin}/owned-authorization/**`);
  } catch {
    const settled = new URL(page.url());
    const location =
      settled.origin === app.origin
        ? 'application'
        : settled.origin === app.providerOrigin
          ? 'owned-provider'
          : 'other';
    const snapshot = (await app.call('snapshot')) as { logs: string[] };
    throw new Error(
      `Owned browser failed at ${checkpoint} (blocked=${blocked}, location=${location}, logs=${snapshot.logs.filter((code) => /^[A-Z_]+$/.test(code)).join(',')})`,
    );
  }
  return { blocked: () => blocked };
}

describe('real Chromium transport around actual App Router bridge', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${password}'`)}`,
      );
      tracked = true;
      await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${sql.join(tables, sql`, `)} TO ${sql.identifier(role)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT ON TABLE ${sql.join(admissionReadTables, sql`, `)} TO ${sql.identifier(role)}`,
      );
    });
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
    databaseUrl.username = role;
    databaseUrl.password = password;
    harness = await startAppRouterHarness({
      databaseUrl: databaseUrl.href,
      browserIdentity: { subject, email, name: 'Browser Owner' },
    });
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      ],
    });
  }, 30000);
  beforeEach(async () => {
    await db.delete(verificationTokens);
    await db.delete(users);
  });
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await browser?.close();
    } catch {
      failures.push(new Error('Owned Chromium cleanup failed'));
    }
    try {
      await harness?.close();
    } catch {
      failures.push(new Error('Owned browser bridge cleanup failed'));
    }
    if (tracked) {
      try {
        await admin(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join([...tables, ...admissionReadTables], sql`, `)} FROM ${sql.identifier(role)}`,
        );
      } catch {
        failures.push(new Error('Owned browser grants cleanup failed'));
      }
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned browser schema cleanup failed'));
      }
      try {
        await admin(sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned browser role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned browser cleanup failed');
  });

  it('shows actual Apple cross-site POST omits the Lax actor but delivers None state/PKCE and replaces that login', async () => {
    if (!harness || !browser) throw new Error('Missing owned browser fixture');
    await db.insert(users).values([
      { id: actorId, email: `${actorId}@example.test` },
      { id: ownerId, email },
    ]);
    await db.insert(accounts).values({ userId: ownerId, type: 'oauth', provider: 'apple', providerAccountId: subject });
    const original = String(
      await harness.call('encode', { claims: { sub: actorId, id: actorId, authSessionId: 'original-actor-session' } }),
    );
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await context.addCookies([
        {
          url: harness.origin,
          name: '__Secure-next-auth.session-token',
          value: original,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);
      const page = await context.newPage();
      const controls = await startApple(context, page);
      const flowCookies = await context.cookies(harness.origin);
      expect(
        flowCookies.some((cookie) => cookie.name.includes('state') && cookie.sameSite === 'None' && cookie.secure),
      ).toBe(true);
      expect(
        flowCookies.some((cookie) => cookie.name.includes('pkce') && cookie.sameSite === 'None' && cookie.secure),
      ).toBe(true);
      await page.getByRole('button', { name: 'Complete Apple' }).click();
      await page.waitForURL(`${harness.origin}/signed-in`);
      const received = (await context.cookies(harness.origin)).find(
        (cookie) => cookie.name === '__Secure-next-auth.session-token',
      );
      expect(Boolean(received && received.value !== original)).toBe(true);
      const claims = (await harness.call('decode', { token: received?.value })) as Record<string, unknown>;
      expect(claims.sub === ownerId).toBe(true);
      const snapshot = (await harness.call('snapshot')) as {
        transports: { method: string; path: string; session: boolean; state: boolean; pkce: boolean }[];
        providerRedirects: { official: boolean; cookiesPreserved: boolean; count: number }[];
        forwardedCookies: { preserved: boolean; count: number }[];
      };
      expect(snapshot.providerRedirects).toEqual([{ official: true, cookiesPreserved: true, count: 3 }]);
      expect(snapshot.forwardedCookies.every((entry) => entry.preserved)).toBe(true);
      expect(snapshot.transports.some((entry) => entry.path.endsWith('/signin/apple') && entry.session)).toBe(true);
      expect(
        snapshot.transports.some(
          (entry) =>
            entry.path.endsWith('/callback/apple') &&
            entry.method === 'POST' &&
            !entry.session &&
            entry.state &&
            entry.pkce,
        ),
      ).toBe(true);
      expect(controls.blocked()).toBe(0);
    } finally {
      await context.close();
    }
  }, 30000);
});

describe('real Chromium with an explicitly synthetic actor-bound continuation', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const readRole = `ba03_router_readonly_${suffix}`;
  const writerRole = `ba03_router_writer_${suffix}`;
  const rolePassword = randomBytes(32).toString('hex');
  const trackedRoles: string[] = [];
  const mutable = [
    users,
    accounts,
    userProfiles,
    sessions,
    verificationTokens,
    authEmailProjection,
    authEmailReservations,
    authEmailReservationMembers,
    authSubjectCutoffs,
  ];
  const resources: { close(): Promise<void> }[] = [];
  let pool: ReturnType<typeof postgres> | undefined;
  let readUrl: string;
  let authority: ExpectedCurrentStoreAuthority;
  let guardedBrowser: Browser | undefined;

  async function closeResources() {
    const failures: Error[] = [];
    for (const resource of resources.splice(0).reverse()) {
      try {
        await resource.close();
      } catch {
        failures.push(new Error('Owned continuation resource cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned continuation cleanup failed');
  }
  async function seedOwner(userId: string, provider: 'apple' | 'google', providerSubject: string) {
    const email = `${userId}@example.test`;
    await db.transaction(async (transaction) => {
      await reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId });
      await transaction.insert(users).values({ id: userId, email });
      await transaction.insert(userProfiles).values({ userId });
      await transaction
        .insert(accounts)
        .values({ userId, provider, providerAccountId: providerSubject, type: 'oauth' });
    });
    return email;
  }
  async function fixture(providerSubject: string, providerEmail: string) {
    if (!pool) throw new Error('Missing owned continuation pool');
    const nextAuthSecret = randomBytes(32).toString('base64url');
    const compound = await startAppRouterCompound({ database: drizzle(pool), authority, nextAuthSecret });
    resources.push(compound);
    const bridge = await startAppRouterHarness({
      databaseUrl: readUrl,
      nextAuthSecret,
      compound: { origin: compound.origin, secret: compound.secret },
      browserIdentity: { subject: providerSubject, email: providerEmail, name: 'Owned continuation user' },
    });
    resources.push(bridge);
    return { compound, bridge };
  }
  async function validate(compound: Awaited<ReturnType<typeof startAppRouterCompound>>, actorCookie: string) {
    return fetch(`${compound.origin}/validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${compound.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorCookie }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  }
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.transaction(async (transaction) => {
      for (const roleName of [readRole, writerRole]) {
        await transaction.execute(
          sql`CREATE ROLE ${sql.identifier(roleName)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
        );
        trackedRoles.push(roleName);
        await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(roleName)}`);
      }
      await transaction.execute(
        sql`GRANT SELECT ON TABLE ${users}, ${accounts}, ${userProfiles}, ${authSubjectCutoffs} TO ${sql.identifier(readRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${sql.join(mutable, sql`, `)} TO ${sql.identifier(writerRole)}`,
      );
    });
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
    databaseUrl.username = readRole;
    databaseUrl.password = rolePassword;
    readUrl = databaseUrl.href;
    databaseUrl.username = writerRole;
    pool = postgres(databaseUrl.href, {
      max: 3,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 6000, lock_timeout: 4000 },
    });
    guardedBrowser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      ],
    });
  }, 30000);
  beforeEach(async () => {
    await db.delete(verificationTokens);
    await db.delete(sessions);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
    const projectionId = randomUUID();
    authority = {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
  });
  afterEach(closeResources);
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await closeResources();
    } catch {
      failures.push(new Error('Owned continuation listener cleanup failed'));
    }
    try {
      await guardedBrowser?.close();
    } catch {
      failures.push(new Error('Owned continuation browser cleanup failed'));
    }
    try {
      await pool?.end({ timeout: 3 });
    } catch {
      failures.push(new Error('Owned continuation pool cleanup failed'));
    }
    for (const roleName of trackedRoles) {
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(mutable, sql`, `)} FROM ${sql.identifier(roleName)}`);
      } catch {
        failures.push(new Error('Owned continuation grants cleanup failed'));
      }
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(roleName)}`);
      } catch {
        failures.push(new Error('Owned continuation schema cleanup failed'));
      }
      try {
        await admin(sql`DROP ROLE IF EXISTS ${sql.identifier(roleName)}`);
      } catch {
        failures.push(new Error('Owned continuation role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned continuation teardown failed');
  });

  it('restores the initiating Lax actor on a same-origin GET before the real callback exchange', async () => {
    if (!guardedBrowser) throw new Error('Missing owned continuation browser');
    const owner = randomUUID();
    const providerSubject = randomUUID();
    const providerEmail = await seedOwner(owner, 'apple', providerSubject);
    const current = await fixture(providerSubject, providerEmail);
    const originalAuthenticatedAt = Date.now() - 90000;
    const source = await current.compound.issueSource(owner, originalAuthenticatedAt);
    const context = await guardedBrowser.newContext({ ignoreHTTPSErrors: true });
    try {
      await context.addCookies([
        {
          url: current.bridge.origin,
          name: '__Secure-next-auth.session-token',
          value: source.cookie,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);
      const page = await context.newPage();
      const controls = await startApple(context, page, current.bridge);
      await page.getByRole('button', { name: 'Complete Apple' }).click();
      await page.waitForURL(`${current.bridge.origin}/signed-in`);
      const received = (await context.cookies(current.bridge.origin)).find(
        (entry) => entry.name === '__Secure-next-auth.session-token',
      );
      expect(Boolean(received && received.value !== source.cookie)).toBe(true);
      const claims = (await current.bridge.call('decode', { token: received?.value })) as Record<string, unknown>;
      expect(claims.sub === owner && claims.originalAuthenticatedAt === originalAuthenticatedAt).toBe(true);
      expect((await validate(current.compound, received!.value)).status).toBe(200);
      const snapshot = (await current.bridge.call('snapshot')) as {
        transports: { path: string; method: string; session: boolean; state: boolean; pkce: boolean }[];
        forwardedCookies: { preserved: boolean }[];
        delegate: { deniedMutations: string[] };
      };
      expect(
        snapshot.transports.some(
          (entry) =>
            entry.path === '/api/auth/callback/apple' &&
            entry.method === 'POST' &&
            !entry.session &&
            entry.state &&
            entry.pkce,
        ),
      ).toBe(true);
      expect(
        snapshot.transports.some(
          (entry) => entry.path.startsWith('/__proof/continue/') && entry.method === 'GET' && entry.session,
        ),
      ).toBe(true);
      expect(snapshot.forwardedCookies.every((entry) => entry.preserved)).toBe(true);
      expect(snapshot.delegate.deniedMutations).toEqual([]);
      expect(controls.blocked()).toBe(0);
    } finally {
      await context.close();
    }
  }, 30000);

  it.each(['different-owner', 'same-user-new-sid'] as const)(
    'retains the current browser login when continuation actor changes: %s',
    async (change) => {
      if (!guardedBrowser) throw new Error('Missing owned continuation browser');
      const owner = randomUUID();
      const providerSubject = randomUUID();
      const providerEmail = await seedOwner(owner, 'apple', providerSubject);
      const actor = change === 'different-owner' ? randomUUID() : owner;
      if (actor !== owner) await seedOwner(actor, 'google', randomUUID());
      const current = await fixture(providerSubject, providerEmail);
      const source = await current.compound.issueSource(actor, null);
      const context = await guardedBrowser.newContext({ ignoreHTTPSErrors: true });
      try {
        await context.addCookies([
          {
            url: current.bridge.origin,
            name: '__Secure-next-auth.session-token',
            value: source.cookie,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ]);
        const page = await context.newPage();
        const controls = await startApple(context, page, current.bridge);
        const retained = change === 'same-user-new-sid' ? await current.compound.issueSource(actor, null) : source;
        if (retained !== source)
          await context.addCookies([
            {
              url: current.bridge.origin,
              name: '__Secure-next-auth.session-token',
              value: retained.cookie,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax',
            },
          ]);
        await page.getByRole('button', { name: 'Complete Apple' }).click();
        await page.waitForURL(`${current.bridge.origin}/__proof/continue/**`);
        const received = (await context.cookies(current.bridge.origin)).find(
          (entry) => entry.name === '__Secure-next-auth.session-token',
        );
        expect(received?.value === retained.cookie).toBe(true);
        expect((await validate(current.compound, retained.cookie)).status).toBe(200);
        const snapshot = (await current.bridge.call('snapshot')) as {
          transports: { path: string; method: string; session: boolean }[];
          delegate: { deniedMutations: string[]; compounds: number };
        };
        expect(
          snapshot.transports.some(
            (entry) => entry.path === '/api/auth/callback/apple' && entry.method === 'POST' && !entry.session,
          ),
        ).toBe(true);
        expect(
          snapshot.transports.some(
            (entry) => entry.path.startsWith('/__proof/continue/') && entry.method === 'GET' && entry.session,
          ),
        ).toBe(true);
        expect(snapshot.delegate.deniedMutations).toEqual([]);
        expect(snapshot.delegate.compounds).toBe(1);
        expect(current.compound.facts.compoundCalls).toBe(1);
        expect(await page.evaluate(() => document.body.innerText)).toBe('Owned fixture unavailable');
        expect((await db.select().from(sessions)).length).toBe(change === 'same-user-new-sid' ? 2 : 1);
        expect(controls.blocked()).toBe(0);
      } finally {
        await context.close();
      }
    },
    30000,
  );
});
