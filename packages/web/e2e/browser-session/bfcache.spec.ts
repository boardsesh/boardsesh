import { PROBE_HOST_ONE } from './stack';
import { expect, test } from './fixtures';

/**
 * Whether a page survives a back navigation in each engine, which decides how
 * the Phase B specs must be written: a page restored from the back/forward cache
 * is not reloaded, so it runs no script and makes no request until something
 * wakes it, and a sign-out on another tab can leave it showing a stale session.
 *
 * Read from playwright-core 1.62.1 (coreBundle.js):
 *   - Chromium launches with `--disable-back-forward-cache`, so every Chromium
 *     page answers `persisted: false`. The default headless shell would not do it
 *     even without the flag (CDP reports BackForwardCacheDisabledForDelegate), so
 *     the `chromium-bfcache` project runs the full Chromium build
 *     (`channel: 'chromium'`) and drops that one flag (`ignoreDefaultArgs`).
 *   - WebKit's launcher passes no such flag; whether its page cache is on is
 *     what the `webkit` row of EXPECTED records.
 */

const EXPECTED_PERSISTED: Record<string, boolean> = {
  chromium: false,
  'chromium-bfcache': true,
  webkit: false,
};

test('a back navigation restores the page from the back/forward cache only where the engine allows it', async ({
  page,
}, testInfo) => {
  await page.goto(`https://${PROBE_HOST_ONE}/bfcache/first`);
  await page.waitForFunction(() => (window as unknown as { __pageshows?: boolean[] }).__pageshows?.length === 1);
  await page.goto(`https://${PROBE_HOST_ONE}/bfcache/second`);
  // A restored page fires no load event, so wait for the commit and then for the page's own record.
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => (window as unknown as { __pageshows?: boolean[] }).__pageshows?.length);

  const pageshows = await page.evaluate(() => (window as unknown as { __pageshows: boolean[] }).__pageshows);
  const persisted = pageshows.at(-1) === true && pageshows.length >= 2;
  testInfo.annotations.push({ type: 'bfcache', description: `${testInfo.project.name}: persisted=${persisted}` });
  console.info(`[bfcache] ${testInfo.project.name}: pageshow persisted flags ${JSON.stringify(pageshows)}`);
  expect(persisted).toBe(EXPECTED_PERSISTED[testInfo.project.name]);
});
