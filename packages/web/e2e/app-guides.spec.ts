import { expect, test } from '@playwright/test';

const GUIDE_PATHS = [
  '/apps',
  '/apps/kilter',
  '/apps/aurora',
  '/apps/moonboard',
  '/apps/woods',
  '/compare/spray-wall-apps',
];

for (const width of [390, 1440]) {
  for (const pathname of GUIDE_PATHS) {
    test(`${pathname} is readable at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      const response = await page.goto(pathname, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      await expect(page.locator('main h1')).toHaveCount(1);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('main')).toContainText('App Store ratings in');
      await expect(page.locator('main')).toContainText('independent');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `https://www.boardsesh.com${pathname}`,
      );
      expect(
        await page
          .locator('link[rel="alternate"][hreflang]')
          .evaluateAll((links) => links.map((link) => link.getAttribute('hreflang'))),
      ).toEqual(['en-US', 'x-default']);
      await expect(page.locator('main a[href*="apps.apple.com"]').first()).toBeVisible();
      if (pathname !== '/apps') {
        await expect(page.locator('main table')).toHaveCount(1);
        await expect(page.locator('main table')).toContainText('Boardsesh');
      }
      // Every link and disclosure in the page body is a 44px target.
      const shortTargets = await page.locator('main a, main summary, main button').evaluateAll((elements) =>
        elements
          .map((element) => ({
            text: element.textContent?.trim().slice(0, 40),
            height: element.getBoundingClientRect().height,
          }))
          .filter(({ height }) => height > 0 && height < 43.5),
      );
      expect(shortTargets).toEqual([]);
      if (pathname === '/apps/kilter' || pathname === '/compare/spray-wall-apps') {
        await page.screenshot({ path: testInfo.outputPath(`${width}.png`), fullPage: true });
      }
    });
  }
}

test('homepage guide link has visible copy and English guide navigation preserves the document', async ({ page }) => {
  await page.goto('/');
  const heroGuideLink = page.getByRole('link', { name: "Compare Boardsesh with your board's app" });
  await expect(heroGuideLink).toBeVisible();
  await expect(heroGuideLink).toHaveAttribute('href', '/apps');
  await page.goto('/boards?utm_source=partner&utm_medium=referral');
  await page.locator('footer button[aria-haspopup="menu"]').click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    Reflect.set(window, '__appGuideDocument', 'retained');
  });
  await page.locator('main a[href="/apps/kilter"]').click();
  await expect(page).toHaveURL(/\/apps\/kilter$/);
  expect(await page.evaluate(() => Reflect.get(window, '__appGuideDocument'))).toBe('retained');
  await expect(page.locator('main a[href*="play.google.com"]').first()).toHaveAttribute('href', /partner/);
});

test('old Aurora brand guides land on their section of /apps/aurora', async ({ page }) => {
  for (const brand of ['tension', 'decoy', 'touchstone', 'grasshopper', 'so-ill']) {
    const response = await page.goto(`/apps/${brand}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/apps/aurora#${brand}$`));
    await expect(page.locator(`main li#${brand}`)).toBeVisible();
  }
});

test('guide router prefetches and navigation do not receive public HTML cache headers', async ({ page }) => {
  const routerResponses: { pathname: string; headers: Record<string, string> }[] = [];
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    const headers = response.headers();
    if (pathname.startsWith('/apps/') && headers['content-type']?.includes('text/x-component')) {
      routerResponses.push({ pathname, headers });
    }
  });
  await page.goto('/apps', { waitUntil: 'networkidle' });
  await page.evaluate(() => Reflect.set(window, '__cacheNavigationDocument', 'retained'));
  await page.locator('main a[href="/apps/kilter"]').first().click();
  await expect(page).toHaveURL(/\/apps\/kilter$/);
  await expect(page.locator('main h1')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, '__cacheNavigationDocument'))).toBe('retained');
  expect(routerResponses.some(({ pathname }) => pathname === '/apps/kilter')).toBe(true);
  for (const { headers } of routerResponses) {
    expect(headers['cache-control']).toContain('no-store');
    expect(headers['cache-control']).not.toMatch(/public|s-maxage|stale-while-revalidate/);
    expect(headers['cdn-cache-control'] ?? 'no-store').toBe('no-store');
  }
});
