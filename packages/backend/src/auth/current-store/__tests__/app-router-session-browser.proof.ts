import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { hash } from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { authSubjectCutoffs, userCredentials, userProfiles, users } from '@boardsesh/db/schema/auth';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { startAppRouterHarness } from './fixtures/app-router-harness';

interface BrowserResponse {
  url(): string;
  status(): number;
  request(): { method(): string };
}
interface Page {
  setDefaultTimeout(milliseconds: number): void;
  setDefaultNavigationTimeout(milliseconds: number): void;
  goto(url: string): Promise<unknown>;
  setContent(html: string): Promise<void>;
  evaluate<Result>(operation: () => Result | Promise<Result>): Promise<Result>;
  getByRole(role: 'button', options: { name: string }): { click(): Promise<void> };
  waitForURL(url: string): Promise<void>;
  waitForResponse(predicate: (response: BrowserResponse) => boolean): Promise<BrowserResponse>;
}
interface BrowserRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(reason: string): Promise<void>;
}
interface BrowserCookie {
  name: string;
  value: string;
}
interface BrowserContext {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  cookies(url: string): Promise<BrowserCookie[]>;
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
const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const { chromium } = requireWeb('@playwright/test') as {
  chromium: { launch(options: { headless: boolean; args: string[] }): Promise<Browser> };
};
const role = `ba03_router_browser_${randomUUID().replaceAll('-', '')}`;
const rolePassword = randomBytes(32).toString('hex');
const credentialPassword = 'Owned-publication-password-123!';
const accountA = randomUUID();
const accountB = randomUUID();
const emailB = `${accountB}@example.test`;
const readable = [users, userCredentials, userProfiles, authSubjectCutoffs];
let roleTracked = false;
let browser: Browser | undefined;
let harness: Awaited<ReturnType<typeof startAppRouterHarness>> | undefined;

async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
function sessionCookie(cookies: BrowserCookie[]) {
  const name = '__Secure-next-auth.session-token';
  return (
    cookies.find((cookie) => cookie.name === name)?.value ??
    cookies
      .filter((cookie) => cookie.name.startsWith(`${name}.`))
      .sort((first, second) => Number(first.name.split('.').at(-1)) - Number(second.name.split('.').at(-1)))
      .map((cookie) => cookie.value)
      .join('')
  );
}
function attribute(content: string) {
  return content.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
async function boundedCleanup(pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned publication context cleanup deadline')), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('actual browser cookie storage after delayed public session responses', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
      );
      roleTracked = true;
      await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      await transaction.execute(sql`GRANT SELECT ON TABLE ${sql.join(readable, sql`, `)} TO ${sql.identifier(role)}`);
    });
    const database = new URL(process.env.DATABASE_URL ?? '');
    database.username = role;
    database.password = rolePassword;
    harness = await startAppRouterHarness({ databaseUrl: database.href, sessionPublicationProof: true });
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
    await db.delete(users);
    await db.insert(users).values([
      { id: accountA, email: `${accountA}@example.test`, emailVerified: new Date() },
      { id: accountB, email: emailB, emailVerified: new Date() },
    ]);
    await db.insert(userCredentials).values({ userId: accountB, passwordHash: await hash(credentialPassword, 12) });
  });
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await browser?.close();
    } catch {
      failures.push(new Error('Owned publication Chromium cleanup failed'));
    }
    try {
      await harness?.close();
    } catch {
      failures.push(new Error('Owned publication bridge cleanup failed'));
    }
    if (roleTracked) {
      for (const statement of [
        sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(readable, sql`, `)} FROM ${sql.identifier(role)}`,
        sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`,
        sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`,
      ]) {
        try {
          await admin(statement);
        } catch {
          failures.push(new Error('Owned publication role cleanup failed'));
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned publication cleanup failed');
  });

  it.each([
    { stale: false, peer: false },
    { stale: false, peer: true },
    { stale: true, peer: false },
    { stale: true, peer: true },
  ])(
    'characterizes stale=$stale peer-origin=$peer after B completes actual credentials login',
    async ({ stale, peer }) => {
      if (!harness?.peerOrigin || !browser) throw new Error('Missing owned publication browser fixture');
      const peerOrigin = harness.peerOrigin;
      const app = harness;
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      let gateId: string | undefined;
      let released = false;
      let delayedRead: Promise<{ status: number; body: unknown }> | undefined;
      let blocked = 0;
      let primaryFailure: unknown;
      let failed = false;
      const cleanupFailures: Error[] = [];
      try {
        await context.route('**/*', async (intercepted) => {
          const origin = new URL(intercepted.request().url()).origin;
          if (origin === app.origin || origin === peerOrigin) return intercepted.continue();
          blocked += 1;
          return intercepted.abort('blockedbyclient');
        });
        const pageA = await context.newPage();
        const pageB = await context.newPage();
        for (const page of [pageA, pageB]) {
          page.setDefaultTimeout(6000);
          page.setDefaultNavigationTimeout(6000);
        }
        await pageB.goto(`${app.origin}/api/auth/csrf`);
        const csrf = await pageB.evaluate(
          () => (JSON.parse(document.body.innerText) as { csrfToken: string }).csrfToken,
        );
        await pageB.goto(`${peer ? peerOrigin : app.origin}/__proof/page`);
        await pageA.goto(`${app.origin}/__proof/page`);
        // The old A lineage is explicitly synthetic; this is the real public
        // encoder, not a canonical source constructor or legacy admission proof.
        const original = String(
          await app.call('encode', {
            claims: { sub: accountA, id: accountA, authSessionId: 'old-A-fixture-lineage' },
            maxAge: stale ? -60 : 86400,
          }),
        );
        await context.addCookies([
          {
            url: app.origin,
            name: '__Secure-next-auth.session-token',
            value: original,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ]);
        expect(sessionCookie(await context.cookies(peerOrigin)) === original).toBe(true);
        gateId = await app.armSessionResponseGate();
        delayedRead = pageA.evaluate(async () =>
          navigator.locks.request('boardsesh-nextauth-cookie-v1', async () => {
            const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'include' });
            return { status: response.status, body: (await response.json()) as unknown };
          }),
        );
        void delayedRead.catch(() => {});
        const checkpoint = await app.waitSessionResponseGate(gateId);
        expect(checkpoint.headersSent).toBe(false);
        expect(checkpoint.status).toBe(200);
        expect(Number(checkpoint.authCookieCount)).toBeGreaterThan(0);
        expect(checkpoint.clearingAuthCookies).toBe(stale);
        // Native Web Locks are origin-scoped. This checks the browser API, not
        // installation of the application's fetch wrapper. Navigation below is
        // deliberately outside that cooperative fetch-only boundary.
        const peerLockAvailable = await pageB.evaluate(() =>
          navigator.locks.request('boardsesh-nextauth-cookie-v1', { ifAvailable: true }, (lock) => Boolean(lock)),
        );
        expect(peerLockAvailable).toBe(peer);
        await pageB.setContent(
          `<form method="POST" action="${attribute(app.origin)}/api/auth/callback/credentials">` +
            `<input name="csrfToken" value="${attribute(csrf)}"><input name="email" value="${attribute(emailB)}">` +
            `<input name="password" value="${attribute(credentialPassword)}"><input name="callbackUrl" value="${attribute(app.origin)}/__proof/page">` +
            '<button>Sign in B</button></form>',
        );
        const callback = pageB.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/auth/callback/credentials' &&
            response.request().method() === 'POST',
        );
        await pageB.getByRole('button', { name: 'Sign in B' }).click();
        expect((await callback).status()).toBe(302);
        await pageB.waitForURL(`${app.origin}/__proof/page`);
        const completedB = sessionCookie(await context.cookies(app.origin));
        expect(completedB.length).toBeGreaterThan(0);
        const claimsB = (await app.call('decode', { token: completedB })) as Record<string, unknown>;
        expect(claimsB.sub).toBe(accountB);
        expect(typeof claimsB.authSessionId === 'string' && claimsB.authSessionId.trim().length > 0).toBe(true);
        expect(claimsB.authSessionId).not.toBe('old-A-fixture-lineage');
        expect(sessionCookie(await context.cookies(peerOrigin)) === completedB).toBe(true);
        const before = (await app.call('snapshot')) as {
          responseGates: { gateId: string; released: boolean }[];
          signIns: { provider: string; userId: string }[];
        };
        expect(before.responseGates.find((gate) => gate.gateId === gateId)?.released).toBe(false);
        expect(before.signIns.some((signIn) => signIn.provider === 'credentials' && signIn.userId === accountB)).toBe(
          true,
        );
        expect(await app.releaseSessionResponseGate(gateId)).toBe(true);
        released = true;
        const delayed = await delayedRead;
        expect(delayed.status).toBe(200);
        const after = sessionCookie(await context.cookies(app.origin));
        if (stale) {
          expect(delayed.body).toEqual({});
          expect(after.length).toBe(0);
          expect(((await app.call('decode', { token: completedB })) as Record<string, unknown>).sub).toBe(accountB);
        } else {
          expect((delayed.body as { user: { id: string } }).user.id).toBe(accountA);
          expect(after !== completedB).toBe(true);
          const claimsA = (await app.call('decode', { token: after })) as Record<string, unknown>;
          expect(claimsA.sub).toBe(accountA);
          expect(claimsA.authSessionId).toBe('old-A-fixture-lineage');
        }
        const currentSession = await pageB.evaluate(async () => {
          const response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'include' });
          return { status: response.status, body: (await response.json()) as unknown };
        });
        expect(currentSession.status).toBe(200);
        if (stale) expect(currentSession.body).toEqual({});
        else expect((currentSession.body as { user: { id: string } }).user.id).toBe(accountA);
        const final = (await app.call('snapshot')) as {
          forwardedCookies: { preserved: boolean }[];
          responseGates: { gateId: string; released: boolean; headersSent: boolean }[];
        };
        expect(final.responseGates.find((gate) => gate.gateId === gateId)?.released).toBe(true);
        expect(final.responseGates.find((gate) => gate.gateId === gateId)?.headersSent).toBe(false);
        expect(final.forwardedCookies.every((entry) => entry.preserved)).toBe(true);
        expect(blocked).toBe(0);
      } catch (error) {
        failed = true;
        primaryFailure = error;
      } finally {
        if (gateId && !released) {
          try {
            await app.releaseSessionResponseGate(gateId);
          } catch {
            cleanupFailures.push(new Error('Owned publication gate cleanup failed'));
          }
        }
        // Closing the owned page cancels browser work even when evaluate's
        // promise has no Playwright timeout. Never wait for it before closing.
        try {
          await boundedCleanup(context.close());
        } catch {
          cleanupFailures.push(new Error('Owned publication context cleanup failed'));
        }
        if (delayedRead) {
          try {
            await boundedCleanup(Promise.allSettled([delayedRead]));
          } catch {
            cleanupFailures.push(new Error('Owned publication request cleanup failed'));
          }
        }
      }
      if (cleanupFailures.length)
        throw new AggregateError(
          failed ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
          'Owned publication case cleanup failed',
        );
      if (failed) throw primaryFailure;
    },
    30000,
  );
});
