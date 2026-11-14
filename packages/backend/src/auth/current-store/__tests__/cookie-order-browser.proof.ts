import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { hash } from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import {
  accounts,
  authEmailProjection,
  authSessionDenials,
  authSubjectCutoffs,
  userCredentials,
  userProfiles,
  users,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';
import { startAppRouterHarness } from './fixtures/app-router-harness';

interface Page {
  setDefaultTimeout(milliseconds: number): void;
  setDefaultNavigationTimeout(milliseconds: number): void;
  goto(url: string): Promise<unknown>;
  setContent(html: string): Promise<void>;
  evaluate<Result, Argument = void>(
    operation: (argument: Argument) => Result | Promise<Result>,
    argument?: Argument,
  ): Promise<Result>;
  getByRole(role: 'button', options: { name: string }): { click(): Promise<void> };
  waitForURL(url: string): Promise<void>;
  waitForResponse(
    predicate: (response: { url(): string; status(): number; request(): { method(): string } }) => boolean,
  ): Promise<{ status(): number }>;
}
interface BrowserContext {
  route(
    pattern: string,
    handler: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(reason: string): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  cookies(url: string): Promise<{ name: string; value: string }[]>;
  addCookies(
    cookies: {
      domain: string;
      path: string;
      name: string;
      value: string;
      httpOnly: boolean;
      secure: boolean;
      sameSite: string;
    }[],
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
const secret = randomBytes(32).toString('base64url');
const rpcSecret = randomBytes(32).toString('base64url');
const originalPassword = 'Owned-cookie-order-password-123!';
const newPassword = 'Owned-cookie-order-replacement-123!';
const readable = [users, userCredentials, userProfiles, authSubjectCutoffs, authSessionDenials, accounts];
let browser: Browser;
let backend: Server;
let backendOrigin = '';
let accountA = '';
let accountB = '';
let emailA = '';
let emailB = '';
let projectionId = '';
let roleTracked = false;

function escapeAttribute(content: string) {
  return content.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function form(action: string, fields: Record<string, string>) {
  return `<form method="POST" action="${escapeAttribute(action)}">${Object.entries(fields)
    .map(([name, content]) => `<input name="${escapeAttribute(name)}" value="${escapeAttribute(content)}">`)
    .join('')}<button>Continue</button></form>`;
}
async function cookie(context: BrowserContext, origin: string) {
  const cookies = await context.cookies(origin);
  const name = '__Secure-next-auth.session-token';
  return (
    cookies.find((entry) => entry.name === name)?.value ??
    cookies
      .filter((entry) => entry.name.startsWith(`${name}.`))
      .sort((first, second) => Number(first.name.split('.').at(-1)) - Number(second.name.split('.').at(-1)))
      .map((entry) => entry.value)
      .join('')
  );
}
async function csrf(page: Page, origin: string) {
  await page.goto(`${origin}/api/auth/csrf`);
  return page.evaluate(() => (JSON.parse(document.body.innerText) as { csrfToken: string }).csrfToken);
}
async function login(
  page: Page,
  origin: string,
  csrfToken: string,
  email: string,
  password: string,
  returnOrigin = origin,
) {
  await page.setContent(
    form(`${origin}/api/auth/callback/credentials`, {
      csrfToken,
      email,
      password,
      callbackUrl: `${returnOrigin}/__proof/page`,
    }),
  );
  const callback = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/callback/credentials' && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Continue' }).click();
  expect((await callback).status()).toBe(302);
  await page.waitForURL(`${returnOrigin}/__proof/page`);
}

describe('BA05 acceptance: later shared-domain login survives delayed cookie publication', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.execute(
      sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
    );
    roleTracked = true;
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
    await db.execute(sql`GRANT SELECT ON TABLE ${sql.join(readable, sql`, `)} TO ${sql.identifier(role)}`);
    backend = createServer((request, response) => {
      void handleCurrentStoreWebAuth(request, response, db).catch(() => {
        response.writeHead(503);
        response.end();
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const address = backend.address();
    if (!address || typeof address === 'string') throw new Error('Owned password backend did not bind');
    backendOrigin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-background-networking',
        '--no-proxy-server',
        '--host-resolver-rules=MAP *.boardsesh.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      ],
    });
  });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE ${users}, ${authEmailProjection} CASCADE`);
    accountA = randomUUID();
    accountB = randomUUID();
    projectionId = randomUUID();
    emailA = `${accountA}@example.test`;
    emailB = `${accountB}@example.test`;
    await db.insert(users).values([
      { id: accountA, email: emailA, emailVerified: new Date() },
      { id: accountB, email: emailB, emailVerified: new Date() },
    ]);
    await db.insert(userCredentials).values([
      { userId: accountA, passwordHash: await hash(originalPassword, 4) },
      { userId: accountB, passwordHash: await hash(originalPassword, 4) },
    ]);
    await db
      .insert(accounts)
      .values({ userId: accountA, type: 'oauth', provider: 'apple', providerAccountId: 'owned-cookie-order-apple' });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await browser?.close();
    if (backend)
      await new Promise<void>((resolve) => {
        backend.close(() => resolve());
        backend.closeAllConnections();
      });
    if (roleTracked) {
      await db.execute(sql`DROP OWNED BY ${sql.identifier(role)}`);
      await db.execute(sql`DROP ROLE ${sql.identifier(role)}`);
    }
  });

  for (const action of ['session', 'password', 'callback'] as const) {
    for (const later of ['none', 'other-account', 'same-user-new-sid'] as const) {
      it(`${action}: preserves ${later === 'none' ? 'successful A publication control' : later + ' completed on sibling origin'}`, async () => {
        const password = action === 'password';
        if (password) {
          await db.delete(userCredentials).where(eq(userCredentials.userId, accountA));
          await db.transaction(async (transaction) => {
            await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
            await transaction
              .update(authEmailProjection)
              .set({ phase: 'enforced' })
              .where(eq(authEmailProjection.projectionId, projectionId));
          });
          for (const [name, content] of Object.entries({
            NODE_ENV: 'test',
            NEXTAUTH_SECRET: secret,
            CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
            CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
            CURRENT_STORE_SET_PASSWORD_MODE: 'backend-staging',
            AUTH_IDENTITY_MIRROR: 'off',
            AUTH_CUTOFF_ENFORCEMENT: 'enforce',
            CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
            CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
            CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
            CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-cookie-order-deleted-email-key-at-least-32-bytes',
          }))
            vi.stubEnv(name, content);
        }
        const database = new URL(process.env.DATABASE_URL ?? '');
        database.username = role;
        database.password = rolePassword;
        const app = await startAppRouterHarness({
          databaseUrl: database.href,
          nextAuthSecret: secret,
          sessionPublicationProof: true,
          publicationTopology: 'shared-domain',
          ...(password
            ? { publicationPasswordBackend: { origin: backendOrigin, secret: rpcSecret, projectionId } }
            : {}),
        });
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        let gateId: string | undefined;
        let delayed: Promise<unknown> | undefined;
        let blocked = 0;
        try {
          if (!app.peerOrigin) throw new Error('Owned sibling origin missing');
          await context.route('**/*', async (route) => {
            const target = new URL(route.request().url()).origin;
            if ([app.origin, app.peerOrigin].includes(target)) await route.continue();
            else {
              blocked += 1;
              await route.abort('blockedbyclient');
            }
          });
          const pageA = await context.newPage();
          const pageB = await context.newPage();
          for (const page of [pageA, pageB]) {
            page.setDefaultTimeout(6000);
            page.setDefaultNavigationTimeout(6000);
          }
          const csrfA = await csrf(pageA, app.origin);
          const csrfB = await csrf(pageB, app.origin);
          await pageB.goto(`${app.peerOrigin}/__proof/page`);
          let originalSid: string | undefined;
          if (action === 'session') {
            await login(pageA, app.origin, csrfA, emailA, originalPassword);
            const claims = (await app.call('decode', { token: await cookie(context, app.origin) })) as Record<
              string,
              unknown
            >;
            originalSid = String(claims.authSessionId);
          } else if (password) {
            // Explicit signed synthetic source. The password mutation, receipt,
            // public route, replacement cookie and later login remain actual.
            originalSid = randomUUID();
            const source = String(
              await app.call('encode', {
                claims: {
                  sub: accountA,
                  authSessionId: originalSid,
                  gen: 0,
                  auth_time: Math.floor(Date.now() / 1000) - 15,
                  link_guarded: true,
                },
                maxAge: 3600,
              }),
            );
            await context.addCookies([
              {
                domain: '.boardsesh.test',
                path: '/',
                name: '__Secure-next-auth.session-token',
                value: source,
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
              },
            ]);
            await pageA.goto(`${app.origin}/__proof/page`);
          } else {
            await pageA.goto(`${app.origin}/__proof/page`);
          }
          gateId = await app.armSessionResponseGate(
            action === 'session'
              ? '/api/auth/session'
              : password
                ? '/api/internal/set-password'
                : '/api/auth/callback/apple',
          );
          if (action === 'callback') {
            const authorization = await pageA.evaluate(
              async ({ csrfToken, callbackUrl }) => {
                const response = await fetch('/api/auth/signin/apple', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({ csrfToken, callbackUrl, json: 'true' }).toString(),
                });
                return { status: response.status, body: (await response.json()) as { url?: string } };
              },
              { csrfToken: csrfA, callbackUrl: `${app.origin}/__proof/page` },
            );
            // The real browser stored the actual start's HttpOnly flow cookies.
            // Only the external provider is synthetic.
            if (authorization.status !== 200 || !authorization.body.url)
              throw new Error('Owned provider initiation unavailable');
            const callback = await app.authorize(authorization.body.url, {
              subject: 'owned-cookie-order-apple',
              email: emailA,
              emailVerified: true,
            });
            await pageA.setContent(form(callback.url, Object.fromEntries(new URLSearchParams(callback.form))));
            delayed = pageA.getByRole('button', { name: 'Continue' }).click();
          } else {
            delayed = pageA.evaluate(
              async ({ password, accountA, originalSid, newPassword }) => {
                const response = await fetch(password ? '/api/internal/set-password' : '/api/auth/session', {
                  credentials: 'include',
                  cache: 'no-store',
                  ...(password
                    ? {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          password: newPassword,
                          confirmPassword: newPassword,
                          expectedUserId: accountA,
                          expectedAuthSessionId: originalSid,
                        }),
                      }
                    : {}),
                });
                return { status: response.status, body: (await response.json()) as unknown };
              },
              { password, accountA, originalSid, newPassword },
            );
          }
          if (!delayed) throw new Error('Owned delayed request did not start');
          void delayed.catch(() => {});
          const checkpoint = await app.waitSessionResponseGate(gateId);
          expect(checkpoint.headersSent).toBe(false);
          expect(checkpoint.status).toBe(action === 'callback' ? 302 : 200);
          expect(Number(checkpoint.authCookieCount)).toBeGreaterThan(0);
          if (action === 'callback') {
            const observed = (await app.call('snapshot')) as {
              sessionPublication: { encodes: { userId: string | null; authSessionId: string | null }[] };
            };
            originalSid =
              observed.sessionPublication.encodes.filter((entry) => entry.userId === accountA).at(-1)?.authSessionId ??
              undefined;
          }
          expect(typeof originalSid === 'string' && originalSid.length > 0).toBe(true);
          let latest: Record<string, unknown> | undefined;
          if (later !== 'none') {
            await login(
              pageB,
              app.origin,
              csrfB,
              later === 'other-account' ? emailB : emailA,
              password && later === 'same-user-new-sid' ? newPassword : originalPassword,
              app.peerOrigin,
            );
            latest = (await app.call('decode', { token: await cookie(context, app.origin) })) as Record<
              string,
              unknown
            >;
            expect(latest.sub).toBe(later === 'other-account' ? accountB : accountA);
            expect(typeof latest.authSessionId === 'string' && latest.authSessionId.length > 0).toBe(true);
            if (originalSid) expect(latest.authSessionId).not.toBe(originalSid);
            expect(await cookie(context, app.peerOrigin)).toBe(await cookie(context, app.origin));
          }
          expect(await app.releaseSessionResponseGate(gateId)).toBe(true);
          gateId = undefined;
          await delayed;
          if (action === 'callback') await pageA.waitForURL(`${app.origin}/__proof/page`);
          const final = (await app.call('decode', { token: await cookie(context, app.origin) })) as Record<
            string,
            unknown
          >;
          const read = await pageB.evaluate(async (origin) => {
            const response = await fetch(`${origin}/api/auth/session`, { credentials: 'include', cache: 'no-store' });
            return {
              status: response.status,
              session: (await response.json()) as { user?: { id?: string }; authSessionId?: string },
            };
          }, app.origin);
          expect(read.status).toBe(200);
          expect(read.session.user?.id === final.sub && read.session.authSessionId === final.authSessionId).toBe(true);
          expect(blocked).toBe(0);
          process.stdout.write(
            JSON.stringify({
              proof: 'BA05-cookie-order',
              action,
              later,
              headersHeld: true,
              storedOwner: final.sub === accountA ? 'A' : final.sub === accountB ? 'B' : 'unexpected',
              storedLogin:
                final.authSessionId === originalSid
                  ? 'earlier-A'
                  : final.authSessionId === latest?.authSessionId
                    ? 'later-login'
                    : 'unexpected',
            }) + '\n',
          );
          if (later === 'none') {
            expect(final.sub).toBe(accountA);
            if (originalSid) expect(final.authSessionId).toBe(originalSid);
          } else {
            // This is the BA05 acceptance condition, intentionally red until a
            // publication protocol prevents the browser overwriting newer B.
            expect(final.sub === latest?.sub && final.authSessionId === latest?.authSessionId).toBe(true);
          }
        } finally {
          if (gateId) await app.releaseSessionResponseGate(gateId);
          await context.close();
          if (delayed) await Promise.allSettled([delayed]);
          await app.close();
        }
      }, 40_000);
    }
  }
});
