import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql, type SQL } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  accounts,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  authWebOAuthCommands,
  authWebOAuthIntents,
  sessions,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type ExpectedCurrentStoreAuthority } from '../foundation-context';
import { startAppRouterHarness } from './fixtures/app-router-harness';
import { startWebOAuthBackend } from './fixtures/web-oauth-backend';

const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
interface Page {
  url(): string;
  setDefaultTimeout(milliseconds: number): void;
  setDefaultNavigationTimeout(milliseconds: number): void;
  goto(url: string): Promise<unknown>;
  evaluate<Result>(operation: () => Result): Promise<Result>;
  setContent(html: string): Promise<void>;
  getByRole(role: 'button', options: { name: string }): { click(): Promise<void> };
  waitForURL(destination: string | ((url: URL) => boolean)): Promise<void>;
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
const { chromium } = webRequire('@playwright/test') as {
  chromium: { launch(options: { headless: boolean; args: string[] }): Promise<Browser> };
};
const suffix = randomUUID().replaceAll('-', '');
const readerRole = `ba03_router_readonly_${suffix}`;
const writerRole = `ba03_weboauth_browser_${suffix}`;
const password = randomBytes(32).toString('hex');
const trackedRoles: string[] = [];
const resources: { close(): Promise<void> }[] = [];
const readTables = [users, accounts, userCredentials, userProfiles, sessions, verificationTokens, authSubjectCutoffs];
const backendTables = [
  users,
  accounts,
  userProfiles,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  authWebOAuthCommands,
  authWebOAuthIntents,
];
const insertTables = [
  users,
  accounts,
  userProfiles,
  authEmailReservations,
  authEmailReservationMembers,
  authWebOAuthCommands,
  authWebOAuthIntents,
];
const updateTables = [
  users,
  accounts,
  authEmailProjection,
  authEmailReservations,
  authSubjectCutoffs,
  authWebOAuthIntents,
];
const cleanupTables = [...new Set([...readTables, ...backendTables])];
const sessionName = '__Secure-next-auth.session-token';
let pool: ReturnType<typeof postgres> | undefined;
let readerUrl: string;
let authority: ExpectedCurrentStoreAuthority;
let browser: Browser | undefined;

async function boundedCleanup(pending: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned browser cleanup deadline')), 8000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
async function closeResources() {
  const failures: Error[] = [];
  for (const resource of resources.splice(0).reverse()) {
    try {
      await boundedCleanup(resource.close());
    } catch {
      resources.unshift(resource);
      failures.push(new Error('Owned web OAuth browser resource cleanup failed'));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned browser resource cleanup failed');
}
async function fixture(profile: { subject: string; email: string }) {
  if (!pool || !browser) throw new Error('Missing owned browser resources');
  const secret = randomBytes(32).toString('base64url');
  const nextAuthSecret = randomBytes(32).toString('base64url');
  for (const [name, content] of Object.entries({
    CURRENT_STORE_WEB_OAUTH_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_PROJECTION_ID: authority.expectedProjectionId,
    CURRENT_STORE_AUTH_WRITER_EPOCH: String(authority.expectedWriterEpoch),
    CURRENT_STORE_AUTH_RPC_SECRET: secret,
    NEXTAUTH_SECRET: nextAuthSecret,
    DEBUG_SQL: 'false',
  }))
    vi.stubEnv(name, content);
  const backend = await startWebOAuthBackend(drizzle(pool));
  resources.push(backend);
  const harness = await startAppRouterHarness({
    databaseUrl: readerUrl,
    nextAuthSecret,
    webOAuthIdentity: { origin: backend.origin, secret },
    browserIdentity: { ...profile, name: 'Owned Apple Browser Climber' },
  });
  resources.push(harness);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  resources.push(context);
  let blocked = 0;
  await context.route('**/*', async (intercepted) => {
    const destination = new URL(intercepted.request().url());
    if (destination.origin === harness.origin || destination.origin === harness.providerOrigin)
      return intercepted.continue();
    blocked += 1;
    return intercepted.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(6000);
  return { backend, harness, context, page, blocked: () => blocked };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function seedOwner(profile: { subject: string; email: string }) {
  const userId = randomUUID();
  await db.transaction(async (transaction) => {
    await reserveEnforcedEmail(transaction, { ...authority, rawEmail: profile.email, requestedUserId: userId });
    await transaction
      .insert(users)
      .values({ id: userId, email: profile.email, emailVerified: new Date('2020-01-02Z') });
    await transaction.insert(userProfiles).values({ userId });
    await transaction
      .insert(accounts)
      .values({ userId, provider: 'apple', providerAccountId: profile.subject, type: 'oauth' });
  });
  return userId;
}
async function setActor(current: Fixture, userId: string, sid = randomUUID()) {
  const token = String(await current.harness.call('encode', { claims: { sub: userId, authSessionId: sid } }));
  await current.context.addCookies([
    {
      url: current.harness.origin,
      name: sessionName,
      value: token,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return token;
}
async function startApple(page: Page, current: Fixture) {
  await page.goto(`${current.harness.origin}/api/auth/csrf`);
  const csrfToken = await page.evaluate(() => (JSON.parse(document.body.innerText) as { csrfToken: string }).csrfToken);
  await page.setContent(
    `<form method="POST" action="${current.harness.origin}/api/auth/signin/apple"><input type="hidden" name="csrfToken" value="${csrfToken}"><input type="hidden" name="callbackUrl" value="${current.harness.origin}/signed-in"><button>Start Apple</button></form>`,
  );
  await page.getByRole('button', { name: 'Start Apple' }).click();
  await page.waitForURL(`${current.harness.providerOrigin}/owned-authorization/**`);
  const cookies = await current.context.cookies(current.harness.origin);
  expect(cookies.some((cookie) => cookie.name.includes('state.') && cookie.sameSite === 'None' && cookie.secure)).toBe(
    true,
  );
}
async function sessionCookie(context: BrowserContext, origin: string) {
  return (await context.cookies(origin)).find((cookie) => cookie.name === sessionName)?.value;
}
async function transportFacts(current: Fixture, expectedActor: boolean) {
  const snapshot = (await current.harness.call('snapshot')) as {
    transports: { method: string; path: string; session: boolean; state: boolean }[];
    forwardedCookies: { preserved: boolean }[];
    providerRedirects: { official: boolean; cookiesPreserved: boolean }[];
  };
  expect(
    snapshot.transports.some(
      (entry) => entry.path.endsWith('/callback/apple') && entry.method === 'POST' && !entry.session && entry.state,
    ),
  ).toBe(true);
  expect(
    snapshot.transports.some(
      (entry) =>
        entry.path.endsWith('/callback/apple') &&
        entry.method === 'GET' &&
        entry.session === expectedActor &&
        entry.state,
    ),
  ).toBe(true);
  expect(snapshot.forwardedCookies.every((entry) => entry.preserved)).toBe(true);
  expect(snapshot.providerRedirects).toEqual([expect.objectContaining({ official: true, cookiesPreserved: true })]);
  expect(current.blocked()).toBe(0);
  const cookies = await current.context.cookies(current.harness.origin);
  expect(
    cookies.some(
      (cookie) =>
        cookie.name.includes('boardsesh.web-oauth.apple.') ||
        /next-auth\.(?:state|callback-url|pkce\.code_verifier)\.[a-f0-9]{32}$/.test(cookie.name),
    ),
  ).toBe(false);
}

describe('real Chromium Apple continuation with production identity delegation', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.transaction(async (transaction) => {
      for (const role of [readerRole, writerRole]) {
        await transaction.execute(
          sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${password}'`)}`,
        );
        trackedRoles.push(role);
        await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      }
      await transaction.execute(
        sql`GRANT SELECT ON TABLE ${sql.join(readTables, sql`, `)} TO ${sql.identifier(readerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT ON TABLE ${sql.join(backendTables, sql`, `)} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT INSERT ON TABLE ${sql.join(insertTables, sql`, `)} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT UPDATE ON TABLE ${sql.join(updateTables, sql`, `)} TO ${sql.identifier(writerRole)}`,
      );
    });
    const database = new URL(process.env.DATABASE_URL ?? '');
    database.username = readerRole;
    database.password = password;
    readerUrl = database.href;
    database.username = writerRole;
    pool = postgres(database.href, {
      max: 2,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 5000, lock_timeout: 4000 },
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
    await db.delete(authWebOAuthIntents);
    await db.delete(authWebOAuthCommands);
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
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  afterEach(closeResources, 30000);
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await closeResources();
    } catch {
      failures.push(new Error('Owned browser final resource cleanup failed'));
    }
    try {
      if (browser) await boundedCleanup(browser.close());
    } catch {
      failures.push(new Error('Owned Chromium cleanup failed'));
    }
    try {
      await pool?.end({ timeout: 3 });
    } catch {
      failures.push(new Error('Owned browser pool cleanup failed'));
    }
    for (const role of trackedRoles) {
      let roleMayExist = true;
      try {
        roleMayExist = (await admin(sql`SELECT 1 FROM pg_roles WHERE rolname=${role}`)).length > 0;
      } catch {
        failures.push(new Error('Owned browser role lookup failed'));
      }
      if (!roleMayExist) continue;
      for (const statement of [
        sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(cleanupTables, sql`, `)} FROM ${sql.identifier(role)}`,
        sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`,
        sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`,
      ]) {
        try {
          await admin(statement);
        } catch {
          failures.push(new Error('Owned browser role cleanup failed'));
        }
      }
    }
    if (!failures.length) vi.unstubAllEnvs();
    if (failures.length) throw new AggregateError(failures, 'Owned browser final cleanup failed');
  }, 30000);

  it('signs a new anonymous Apple climber in after an actual cross-site POST and same-origin continuation', async () => {
    const profile = { subject: randomUUID(), email: `${randomUUID()}@example.test` };
    const current = await fixture(profile);
    await startApple(current.page, current);
    await current.page.getByRole('button', { name: 'Complete Apple' }).click();
    await current.page.waitForURL(`${current.harness.origin}/signed-in`);
    const token = await sessionCookie(current.context, current.harness.origin);
    expect(Boolean(token)).toBe(true);
    const claims = (await current.harness.call('decode', { token })) as { sub: string; authSessionId: string };
    expect(Boolean(claims.authSessionId)).toBe(true);
    const [owner] = await db.select().from(users).where(eq(users.id, claims.sub));
    expect(owner.email).toBe(profile.email);
    expect(owner.emailVerified).toBeNull();
    expect(current.backend.requests).toEqual([
      { operation: 'intent', status: 200 },
      { operation: 'resolve', status: 200 },
    ]);
    await transportFacts(current, false);
  }, 30000);

  it('restores a same-owner Lax actor before resolving an existing Apple account', async () => {
    const profile = { subject: randomUUID(), email: `${randomUUID()}@example.test` };
    const ownerId = await seedOwner(profile);
    const current = await fixture(profile);
    const original = await setActor(current, ownerId);
    await startApple(current.page, current);
    await current.page.getByRole('button', { name: 'Complete Apple' }).click();
    await current.page.waitForURL(`${current.harness.origin}/signed-in`);
    const token = await sessionCookie(current.context, current.harness.origin);
    expect(Boolean(token && token !== original)).toBe(true);
    expect(((await current.harness.call('decode', { token })) as { sub: string }).sub).toBe(ownerId);
    expect((await db.select().from(users).where(eq(users.id, ownerId)))[0].emailVerified?.toISOString()).toBe(
      '2020-01-02T00:00:00.000Z',
    );
    await transportFacts(current, true);
  }, 30000);

  it.each(['different-owner', 'same-owner-new-login'] as const)(
    'preserves the current login when Apple returns after %s',
    async (change) => {
      const profile = { subject: randomUUID(), email: `${randomUUID()}@example.test` };
      const ownerId = await seedOwner(profile);
      const current = await fixture(profile);
      await setActor(current, ownerId);
      await startApple(current.page, current);
      let currentUserId = ownerId;
      if (change === 'different-owner') {
        const otherProfile = { subject: randomUUID(), email: `${randomUUID()}@example.test` };
        currentUserId = await seedOwner(otherProfile);
      }
      const replacement = await setActor(current, currentUserId);
      await current.page.getByRole('button', { name: 'Complete Apple' }).click();
      await current.page.waitForURL(
        (destination) => destination.origin === current.harness.origin && destination.searchParams.has('error'),
      );
      expect(new URL(current.page.url()).searchParams.get('error')).toBe('AccessDenied');
      expect((await sessionCookie(current.context, current.harness.origin)) === replacement).toBe(true);
      expect(current.backend.requests).toEqual([
        { operation: 'intent', status: 200 },
        { operation: 'resolve', status: 409 },
      ]);
      expect((await db.select().from(accounts).where(eq(accounts.providerAccountId, profile.subject)))[0].userId).toBe(
        ownerId,
      );
      await transportFacts(current, true);
    },
    30000,
  );
});
