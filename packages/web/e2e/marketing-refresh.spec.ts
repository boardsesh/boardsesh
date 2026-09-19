import { expect, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

for (const width of [1440, 390]) {
  test(`marketing pages keep their dark layout and type scale at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of ['/', '/support', '/gyms/kilter', '/about', '/help', '/legal', '/privacy']) {
      await page.goto(route);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('[data-testid="marketing-header"]')).toBeVisible();
      await expect(page.locator('[data-testid="site-footer"]')).toBeVisible();
      for (const landmark of ['marketing-header', 'site-footer']) {
        const logo = page.getByTestId(landmark).locator('img[src*="boardsesh-mark"]');
        await logo.scrollIntoViewIfNeeded();
        await expect(logo).toBeVisible();
        await expect(logo).toHaveAttribute('alt', '');
        await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, route).toBeLessThanOrEqual(1);
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 10, 32)');
      await expect(page.locator('h1')).toHaveCSS(
        'font-size',
        route === '/' ? (width === 390 ? '40px' : '64px') : width === 390 ? '30px' : '40px',
      );
    }
  });
}

test('the homepage explains the app before gym and board discovery', async ({ page }) => {
  await page.goto('/');
  const benefits = page.getByRole('heading', { name: 'Board night, sorted', exact: true });
  const gyms = page.getByRole('heading', { name: 'Find a board near you', exact: true });
  await expect(benefits).toBeVisible();
  await expect(gyms).toBeVisible();
  const benefitsTop = await benefits.evaluate((heading) => heading.getBoundingClientRect().top);
  const gymsTop = await gyms.evaluate((heading) => heading.getBoundingClientRect().top);
  expect(benefitsTop).toBeLessThan(gymsTop);
});

test('the compact mobile header keeps the app and account reachable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  const header = page.getByTestId('marketing-header');
  await expect(header.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await header.getByRole('button', { name: 'Open menu', exact: true }).click();
  const appLink = page.getByRole('menuitem', { name: 'Start climbing', exact: true });
  await expect(appLink).toBeVisible();
  await expect(appLink).toHaveAttribute('href', /^(https?:\/\/|\/app)/);
});

for (const width of [320, 390]) {
  test(`the branded header and homepage fit all locales at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ['/', '/es', '/fr', '/de']) {
      await page.goto(route);
      await expect(page.locator('h1')).toHaveCount(1);
      const header = page.getByTestId('marketing-header');
      const homeLink = header.locator('a').filter({ has: page.locator('img[src*="boardsesh-mark"]') });
      await expect(homeLink).toBeVisible();
      await expect(homeLink).toHaveAttribute('aria-label', /.+/);
      const controls = await header.locator('a, button').evaluateAll((elements) =>
        elements
          .map((element) => element.getBoundingClientRect())
          .filter((rectangle) => rectangle.width > 0)
          .map((rectangle) => ({ left: rectangle.left, right: rectangle.right, height: rectangle.height })),
      );
      for (const control of controls) {
        expect(control.left, route).toBeGreaterThanOrEqual(0);
        expect(control.right, route).toBeLessThanOrEqual(width);
        expect(control.height, route).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), route).toBeLessThanOrEqual(
        1,
      );
    }
  });
}

test('the mobile directory does not request map tiles before Show map', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tileRequests: string[] = [];
  page.on('request', (request) => {
    if (/tiles\.openfreemap\.org|tile\.openstreetmap\.org/.test(request.url())) tileRequests.push(request.url());
  });
  await page.goto('/gyms/kilter');
  await expect(page.getByRole('button', { name: 'Show map', exact: true })).toBeVisible();
  expect(tileRequests).toEqual([]);
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) => route.abort());
  await page.getByRole('button', { name: 'Show map', exact: true }).click();
  await expect(page.locator('.leaflet-tile').first()).toBeAttached();
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
});
