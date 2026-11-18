import { readViewer } from './helpers';
import { LEGACY_SESSION_SHAPES } from './legacy-session';
import { WWW_ORIGIN } from './stack';
import { expect, test } from './fixtures';

/**
 * `legacySession`: a NextAuth session cookie minted in test code, for a seeded
 * account, in each shape the fleet still holds. If www reads the account back
 * from each, the Phase B specs can start a context from a pre-cutover cookie
 * without driving a sign-in.
 */

test.skip(
  !!process.env.AUTH_BROWSER_SESSION_MODE,
  'The baseline runs in legacy mode; AUTH_BROWSER_SESSION_MODE is set for this run.',
);

for (const shape of LEGACY_SESSION_SHAPES) {
  test(`www reads the account from a ${shape} legacy session cookie`, async ({
    page,
    context,
    accountB,
    legacySession,
  }) => {
    const minted = await legacySession.addTo(context, accountB, shape);
    expect(minted.cookieNames.length).toBe(shape === 'chunked' ? 3 : 1);

    await page.goto(`${WWW_ORIGIN}/auth/login`);
    const viewer = await readViewer(page);
    expect(viewer.authenticated).toBe(true);
    expect(viewer.userId).toBe(accountB.userId);
  });
}
