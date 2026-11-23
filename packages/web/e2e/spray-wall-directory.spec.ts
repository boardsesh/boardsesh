import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('spray directory server-renders angle controls and switches mobile map views', async ({ page }) => {
  const response = await page.goto('/spraywalls/find?angle=40', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await expect(page.locator('main h1')).toHaveText('Find a spray wall');
  await expect(page.getByRole('checkbox', { name: '40°', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Show map', exact: true }).click();
  await expect(page.locator('#spray-directory-map')).toBeVisible();
  await expect(page.locator('#spray-directory-results')).toBeHidden();
  await page.getByRole('button', { name: 'Hide map', exact: true }).click();
  await expect(page.locator('#spray-directory-results')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('spray directory keeps nearby failures visible on the map and retries', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 52.123456, longitude: 4.123456 });
  let failNearby = true;
  await page.route('**/graphql', async (route) => {
    const request: { query?: string; variables?: { input?: { angles?: number[]; latitude?: number } } } = route
      .request()
      .postDataJSON();
    if (!request.query?.includes('publicSprayWalls')) return route.continue();
    expect(request.variables?.input?.angles).toEqual([40]);
    expect(request.variables?.input?.latitude).toBe(52.123);
    if (failNearby) {
      failNearby = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ errors: [{ message: 'Fixture outage' }] }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          searchBoards: {
            boards: [
              {
                uuid: 'qa-wall',
                slug: 'canal-crew',
                name: 'Canal crew',
                angle: 40,
                latitude: 52.124,
                longitude: 4.124,
                locationName: 'Amsterdam',
                gymName: null,
                distanceMeters: 1000,
              },
            ],
            totalCount: 1,
            hasMore: false,
          },
        },
      }),
    });
  });
  const response = await page.goto('/spraywalls/find?angle=40', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.getByRole('button', { name: 'Show map', exact: true }).click();
  await expect(page.locator('#spray-directory-map .leaflet-control-zoom')).toBeVisible();
  await page.getByRole('button', { name: 'Near me', exact: true }).click();
  const nearbyError = page.getByRole('alert').filter({ hasText: 'Try again to find a wall.' });
  await expect(nearbyError).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(nearbyError).toHaveCount(0);
  await expect(page.locator('#spray-directory-map .leaflet-marker-icon')).toHaveCount(1);
  await page.getByRole('button', { name: 'Hide map', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Canal crew', exact: true })).toHaveAttribute('href', '/b/canal-crew');
  await expect(page.locator('#spray-directory-results')).toContainText('1 km away');
});

test('spray directory has translated first-render content and a desktop map', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await page.goto('/es/spraywalls/find', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await expect(page.locator('main h1')).toHaveText('Encuentra un Spraywall');
  await expect(page.locator('#spray-directory-map')).toBeVisible();
  await expect(page.locator('#spray-directory-map .leaflet-control-zoom')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ver el mapa', exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
});
