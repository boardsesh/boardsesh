import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 664 }, storageState: { cookies: [], origins: [] } });

const PUBLIC_PAGES = [
  '/',
  '/about',
  '/support',
  '/legal',
  '/privacy',
  '/docs',
  '/bring-your-logbook',
  '/gyms',
  '/playlists',
  '/auth/login',
  '/help',
  '/help/finding-climbs',
  '/help/board-and-bluetooth',
  '/help/spray-walls',
  '/help/logbook',
  '/help/sessions',
];

for (const pathname of PUBLIC_PAGES) {
  test(`public page fits a 390px phone: ${pathname}`, async ({ page }) => {
    const response = await page.goto(pathname, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator('main h1').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}

test('shared climb, setter and playlist paths fit a 390px phone', async ({ page }) => {
  await page.goto('/kilter/1/28/1,20/40/list', { waitUntil: 'domcontentloaded' });
  const firstClimb = page.locator('main a[href*="/view/"]').first();
  await expect(firstClimb).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await firstClimb.click();
  await expect(page.locator('main h1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const setterLink = page.locator('main a[href*="/setter/"]').first();
  await expect(setterLink).toBeVisible();
  await setterLink.click();
  await expect(page.locator('main h1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await page.goto('/playlists', { waitUntil: 'domcontentloaded' });
  const playlist = page.locator('main a[href^="/playlists/"]').first();
  await expect(playlist).toBeVisible();
  await playlist.click();
  await expect(page.locator('main h1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
