import { PROBE_HOST_ONE, WWW_HOST, WWW_ORIGIN, COOKIE_DOMAIN } from './stack';
import { readViewer, signInOnWww } from './helpers';
import { expect, sessionSetCookies, test } from './fixtures';

/**
 * `edgeCookies`: what every response carried in Set-Cookie, per host and path,
 * as names and attributes only. A spec can then say "this request emitted no
 * session cookie" instead of inferring it from the cookie jar, which cannot tell
 * "never written" from "rewritten with the same value".
 */

test('names every Set-Cookie of a probe response, attributes included and values never', async ({
  page,
  edgeCookies,
}) => {
  const { records } = await edgeCookies.during(async () => {
    await page.goto(`https://${PROBE_HOST_ONE}/set?name=__Secure-recorded`);
    await page.goto(`https://${PROBE_HOST_ONE}/clear?name=__Secure-recorded`);
  });

  const set = records.find((record) => record.path === '/set');
  expect(set).toMatchObject({ host: PROBE_HOST_ONE, method: 'GET', status: 200 });
  expect(set?.setCookies).toEqual([
    {
      name: '__Secure-recorded',
      attributes: [`Domain=${COOKIE_DOMAIN}`, 'Max-Age=3600', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax'],
      clears: false,
      valueDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
    },
  ]);
  const clear = records.find((record) => record.path === '/clear');
  expect(clear?.setCookies[0]).toMatchObject({ name: '__Secure-recorded', clears: true });
  // The probe sets the value `1`. It appears nowhere in what was recorded.
  expect(JSON.stringify(records)).not.toContain('=1');
});

test('shows a sign-in writing the session cookie, a session read rolling it, the cookie route writing none, and a sign-out clearing it', async ({
  page,
  accountA,
  edgeCookies,
  stack,
}) => {
  test.skip(stack.browserSessionMode !== 'legacy', 'Legacy behaviour; reads-write-nothing.spec.ts covers better-auth.');
  const signIn = await edgeCookies.during(() => signInOnWww(page, accountA));
  const written = sessionSetCookies(signIn.records).filter((cookie) => !cookie.clears);
  // The credentials callback writes it first. Legacy NextAuth also rewrites it on each /api/auth/session read.
  expect(written[0]).toMatchObject({
    host: WWW_HOST,
    path: '/api/auth/callback/credentials',
    name: '__Secure-next-auth.session-token',
  });
  for (const cookie of written) {
    expect(cookie).toMatchObject({ host: WWW_HOST, name: '__Secure-next-auth.session-token' });
    expect(cookie.attributes).toEqual(expect.arrayContaining([`Domain=${COOKIE_DOMAIN}`, 'Secure', 'HttpOnly']));
  }
  // The cookie's value is in the browser's jar, and not in the record.
  const [sessionCookie] = (await page.context().cookies()).filter((cookie) => cookie.name === written[0]?.name);
  expect(sessionCookie?.value.length).toBeGreaterThan(20);
  expect(JSON.stringify(signIn.records)).not.toContain(sessionCookie?.value ?? 'unreachable');

  // Legacy mode rolls the cookie on a session read. Phase B's no-write-on-read rule is the contrast.
  const rolled = await edgeCookies.during(() =>
    page.evaluate(
      async (origin) => (await fetch(`${origin}/api/auth/session`, { credentials: 'include' })).status,
      WWW_ORIGIN,
    ),
  );
  expect(sessionSetCookies(rolled.records).filter((cookie) => cookie.path === '/api/auth/session')).not.toEqual([]);

  // The cookie route only reads the session: the request is in the log, with no session Set-Cookie.
  const idle = await edgeCookies.during(() => readViewer(page));
  const read = idle.records.find((record) => record.host === WWW_HOST && record.path === '/api/internal/ws-auth');
  expect(read?.status).toBe(200);
  expect(sessionSetCookies(idle.records)).toEqual([]);

  const signOut = await edgeCookies.during(async () => {
    await page.goto(`${WWW_ORIGIN}/auth/signout?callbackUrl=${encodeURIComponent('/')}`);
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/signout'));
  });
  const cleared = sessionSetCookies(signOut.records).filter((cookie) => cookie.clears);
  expect(cleared.map((cookie) => cookie.name)).toContain('__Secure-next-auth.session-token');
});
