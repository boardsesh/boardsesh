import type { Page } from '@playwright/test';
import {
  expectSessionReadNames,
  openApp,
  readSession,
  readViewer,
  signInOnWww,
  signInOverExistingSession,
} from './helpers';
import { BRIDGED_COOKIE, LEGACY_COOKIE, LOGIN_COOKIE, WWW_ORIGIN } from './stack';
import { expect, sessionSetCookies, test } from './fixtures';

/**
 * #7596 acceptance 6, in Chromium and WebKit, by restarting both servers with
 * AUTH_BROWSER_SESSION_MODE switched inside one run (`restartStack`):
 *
 * 1. Under `better-auth` a login writes the first-party cookie and its legacy
 *    twin with one session id.
 * 2. Rolled back to `legacy`: that browser is still signed in on www and the
 *    app through the twin, with no cookie-clearing step.
 * 3. Someone else logs in on that browser under `legacy`, then the mode rolls
 *    forward: the newer legacy login wins, the stale first-party cookie is
 *    replaced (decisions 2026-11-18, "A newer legacy login beats a stale new
 *    cookie" and "Rollback"), and a second browser signed in to the first
 *    account before the rollback is still signed in.
 * 4. The same rule without a rollback in between: a first-party login cookie
 *    beside a newer legacy cookie of another login (written outside
 *    `/api/auth/*`, which `legacy` mode cannot clear) is replaced by the
 *    bridged newer login.
 *
 * Each restart is a cold start of both servers; under `next dev` that is
 * minutes, hence the long timeout.
 */

test.skip(process.env.AUTH_BROWSER_SESSION_MODE !== 'better-auth', 'Runs under AUTH_BROWSER_SESSION_MODE=better-auth.');
test.describe.configure({ timeout: 1_200_000 });

const homeTab = (page: Page) => page.getByRole('tab', { name: 'Home', exact: true });
const sessionCookieNames = async (page: Page) =>
  (await page.context().cookies())
    .map((cookie) => cookie.name)
    .filter((name) => [LOGIN_COOKIE, BRIDGED_COOKIE, LEGACY_COOKIE].includes(name))
    .sort();

test('rollback keeps browsers signed in through the legacy twin, and a newer legacy login wins the roll-forward', async ({
  page,
  openContext,
  freshAccount,
  restartStack,
  edgeCookies,
}) => {
  const first = freshAccount();
  const second = freshAccount();
  const bystander = await (await openContext()).newPage();
  await signInOnWww(bystander, first);
  await expectSessionReadNames(bystander, first);
  await signInOnWww(page, first);
  await expectSessionReadNames(page, first);
  const viewer = await readViewer(page);
  expect(await sessionCookieNames(page)).toEqual([LEGACY_COOKIE, LOGIN_COOKIE].sort());

  try {
    // The rollback as the runbook does it: Settings' provider and first-password modes need
    // better-auth (the backend refuses to start otherwise), so they go back with it.
    await restartStack({
      env: {
        AUTH_BROWSER_SESSION_MODE: 'legacy',
        CURRENT_STORE_PROVIDER_SECURITY_MODE: 'legacy',
        CURRENT_STORE_FIRST_PASSWORD_MODE: 'legacy',
      },
    });
    const underLegacy = await edgeCookies.during(async () => {
      await page.goto(`${WWW_ORIGIN}/settings`);
      expect(await readSession(page)).toMatchObject({ userId: first.userId, authSessionId: viewer.authSessionId });
      const appPage = await page.context().newPage();
      await openApp(appPage);
      await expect(homeTab(appPage)).toBeVisible({ timeout: 120_000 });
      expect(await readViewer(appPage)).toMatchObject({ authenticated: true, userId: first.userId });
      await appPage.close();
    });
    // No cookie-clearing step: nothing cleared a cookie this browser holds. The only clears are
    // NextAuth's own host-only deletion of the legacy name (no Domain), which legacy www sends
    // beside every write of its cookie since the shared domain (secure-cookies.ts); the browser's
    // Domain-scoped twin is not touched by it, and is still there below.
    for (const cookie of sessionSetCookies(underLegacy.records).filter((written) => written.clears)) {
      expect(cookie.name).toBe(LEGACY_COOKIE);
      expect(cookie.attributes.some((attribute) => attribute.startsWith('Domain='))).toBe(false);
    }
    expect(await sessionCookieNames(page)).toContain(LEGACY_COOKIE);

    // Someone else logs in on this browser while the mode is rolled back.
    await signInOverExistingSession(page, second);
    await expectSessionReadNames(page, second);
    expect((await readViewer(page)).userId).toBe(second.userId);
  } finally {
    await restartStack();
  }

  await page.goto(`${WWW_ORIGIN}/settings`);
  await expect.poll(async () => (await readSession(page)).userId, { timeout: 60_000 }).toBe(second.userId);
  expect(await sessionCookieNames(page)).not.toContain(LOGIN_COOKIE);
  expect((await readViewer(page)).userId).toBe(second.userId);
  // The browser that signed in to the first account before the rollback is untouched.
  expect(await readViewer(bystander)).toMatchObject({ authenticated: true, userId: first.userId });
});

test('a newer legacy login beside a stale first-party login cookie replaces it', async ({
  context,
  page,
  freshAccount,
  legacySession,
  edgeCookies,
}) => {
  const stale = freshAccount();
  const newer = freshAccount();
  await signInOnWww(page, stale);
  await expectSessionReadNames(page, stale);
  expect(await sessionCookieNames(page)).toContain(LOGIN_COOKIE);
  // A legacy login of someone else, written later than the first-party login, outside /api/auth/*.
  // `auth_time` counts whole seconds and must be later than the session's sign-in time, so the
  // two logins are at least a second apart, as two real sign-ins are.
  await page.waitForTimeout(1_100);
  await context.clearCookies({ name: LEGACY_COOKIE });
  const minted = await legacySession.addTo(context, newer, 'normal');

  const read = await edgeCookies.during(async () => {
    await page.goto(`${WWW_ORIGIN}/settings`);
    await expect.poll(async () => (await readSession(page)).userId, { timeout: 60_000 }).toBe(newer.userId);
  });
  const writes = sessionSetCookies(read.records);
  expect(writes.filter((cookie) => cookie.name === BRIDGED_COOKIE && !cookie.clears)).toHaveLength(1);
  expect(writes.filter((cookie) => cookie.name === LOGIN_COOKIE && cookie.clears).length).toBeGreaterThan(0);
  expect(await sessionCookieNames(page)).not.toContain(LOGIN_COOKIE);
  expect(await readViewer(page)).toEqual({
    authenticated: true,
    userId: newer.userId,
    authSessionId: minted.authSessionId,
  });
});
