import { WWW_ORIGIN } from './stack';
import { readViewer, signInOnWww } from './helpers';
import { expect, test } from './fixtures';

/**
 * `accountA` and `accountB`: two real accounts that can each sign in through
 * www's own form, each in a context of its own, without seeing the other. The
 * Phase B account-switch and cross-account specs start from here.
 */

test.skip(
  !!process.env.AUTH_BROWSER_SESSION_MODE,
  'The baseline runs in legacy mode; AUTH_BROWSER_SESSION_MODE is set for this run.',
);

test('the two accounts are different people with working credentials', async ({ accountA, accountB, openContext }) => {
  expect(accountA.userId).not.toBe(accountB.userId);
  expect(accountA.email).not.toBe(accountB.email);

  const contextA = await openContext();
  const contextB = await openContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await signInOnWww(pageA, accountA);
  await signInOnWww(pageB, accountB);

  expect((await readViewer(pageA)).userId).toBe(accountA.userId);
  expect((await readViewer(pageB)).userId).toBe(accountB.userId);

  // Signing B out leaves A signed in: the contexts share nothing.
  await pageB.goto(`${WWW_ORIGIN}/auth/signout?callbackUrl=${encodeURIComponent('/')}`);
  await pageB.waitForURL((url) => !url.pathname.startsWith('/auth/signout'));
  expect((await readViewer(pageB)).authenticated).toBe(false);
  expect((await readViewer(pageA)).userId).toBe(accountA.userId);
});
