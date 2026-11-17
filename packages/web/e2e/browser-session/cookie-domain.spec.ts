import { PARENT_DOMAIN, PROBE_HOST_ONE, PROBE_HOST_TWO } from './stack';
import { expect, test } from './fixtures';

/**
 * The engine-level facts the whole harness stands on, with no Boardsesh code in
 * the way: in this browser, over this proxy and this self-signed certificate,
 * is a `__Secure-` cookie with `Secure; Domain=.boardsesh.test` stored, sent to
 * a sibling host, and removed by an expiring Set-Cookie? Public-suffix rules can
 * reject a parent-domain cookie, and an engine may refuse `Secure` cookies when
 * HTTPS errors are ignored, so each answer is tested here rather than assumed.
 * When the sign-in spec fails in one engine, read this one first.
 */

test.describe('a Domain cookie on the parent domain', () => {
  test('is accepted from one host and sent to a sibling', async ({ page, context }) => {
    await page.goto(`https://${PROBE_HOST_ONE}/set`);
    await page.goto(`https://${PROBE_HOST_TWO}/echo`);
    const echo = JSON.parse(await page.evaluate(() => document.body.innerText)) as { host: string; cookie: string };
    expect(echo.host).toBe(PROBE_HOST_TWO);
    expect(echo.cookie).toContain('__Secure-probe=1');

    const stored = (await context.cookies()).find((cookie) => cookie.name === '__Secure-probe');
    expect(stored).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax' });
    expect(stored?.domain.replace(/^\./, '')).toBe(PARENT_DOMAIN);
  });

  test('is removed on every host by one expiring Set-Cookie', async ({ page }) => {
    await page.goto(`https://${PROBE_HOST_ONE}/set?name=__Secure-gone`);
    await page.goto(`https://${PROBE_HOST_TWO}/echo`);
    expect(await page.evaluate(() => document.body.innerText)).toContain('__Secure-gone=1');

    await page.goto(`https://${PROBE_HOST_TWO}/clear?name=__Secure-gone`);
    await page.goto(`https://${PROBE_HOST_ONE}/echo`);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('__Secure-gone');
  });

  test('stays on its host when it carries no Domain', async ({ page }) => {
    await page.goto(`https://${PROBE_HOST_ONE}/set-host-only?name=__Secure-solo`);
    await page.goto(`https://${PROBE_HOST_ONE}/echo`);
    expect(await page.evaluate(() => document.body.innerText)).toContain('__Secure-solo=1');
    await page.goto(`https://${PROBE_HOST_TWO}/echo`);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('__Secure-solo');
  });
});
