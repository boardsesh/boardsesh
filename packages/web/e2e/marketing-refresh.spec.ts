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
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, route).toBeLessThanOrEqual(1);
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 10, 32)');
      await expect(page.locator('h1')).toHaveCSS(
        'font-size',
        route === '/' ? (width === 390 ? '34px' : '60px') : width === 390 ? '30px' : '40px',
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
