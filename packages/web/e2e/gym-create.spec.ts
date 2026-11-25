import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth';

test.describe('Create a gym from the directory', () => {
  test('signed-out setup preserves the locale and saved gym return path', async ({ page }) => {
    const gymUuid = randomUUID();
    await page.goto(`/es/gyms/new?gym=${gymUuid}`);
    await expect(page).toHaveURL(/\/es\/auth\/login\?callbackUrl=/);
    const returnPath = new URL(page.url()).searchParams.get('callbackUrl');
    expect(returnPath).toBe(`/es/gyms/new?gym=${gymUuid}`);
  });

  test('saves details, resumes setup, and publishes the same gym', async ({ page }) => {
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(`${page.url()}: ${error.stack ?? error.message}`));
    const gymName = `Gym setup ${randomUUID().slice(0, 8)}`;
    const address = '123 Gym Setup Street, London';
    const hours = 'Mon-Fri 9am-9pm';
    let addressLookups = 0;
    await page.route('**/graphql', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      const operation = request.postDataJSON() as { query?: unknown; variables?: { address?: unknown } };
      if (typeof operation.query !== 'string' || !/\blookupGymAddressCoordinates\b/.test(operation.query)) {
        return route.continue();
      }
      expect(operation.variables?.address).toBe(address);
      addressLookups += 1;
      await route.fulfill({
        json: { data: { lookupGymAddressCoordinates: { latitude: 51.5074, longitude: -0.1278 } } },
      });
    });

    await loginAs(page, '/gyms');
    await page.getByTestId('gym-directory-map').getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('link', { name: 'Create gym', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Add your gym' })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await page.getByLabel('Gym Name').fill(gymName);
    await page.getByLabel('Address', { exact: true }).fill(address);
    await page.getByLabel('Opening hours').fill(hours);
    await page.getByRole('button', { name: 'Set location on map' }).click();
    await page.getByPlaceholder('Search address or city...').fill(address);
    expect(addressLookups).toBe(0);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('button', { name: /Location: 51\.5074, -0\.1278/ })).toBeVisible();
    expect(addressLookups).toBe(1);
    await page.getByRole('button', { name: 'Save and choose boards' }).click();
    // Every gym within 150 m counts as similar, so a gym an earlier run (or a
    // retry) left at these coordinates refuses the save until it's confirmed.
    const addNewGym = page.getByRole('button', { name: 'No, add a new gym' });
    await expect
      .poll(async () => (await addNewGym.isVisible()) || /\/gyms\/new\?gym=/.test(page.url()), { timeout: 15_000 })
      .toBe(true);
    if (await addNewGym.isVisible()) await addNewGym.click();
    await expect(page).toHaveURL(/\/gyms\/new\?gym=/);
    const savedGymUuid = new URL(page.url()).searchParams.get('gym');
    expect(savedGymUuid).toBeTruthy();

    await page.reload();
    await expect(page.getByText(`${gymName} is saved.`, { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Edit details' }).click();
    await expect(page.getByLabel('Gym Name')).toHaveValue(gymName);
    await expect(page.getByLabel('Opening hours')).toHaveValue(hours);
    await page.getByLabel('Description', { exact: true }).fill('Created through the directory setup.');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Save and choose boards' }).click();
    await expect(page.getByRole('link', { name: 'Skip for now' })).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).searchParams.get('gym')).toBe(savedGymUuid);
    await page.getByRole('link', { name: 'Skip for now' }).click();
    await expect(page.getByRole('heading', { name: gymName, exact: true })).toBeVisible();
    await expect(page.getByText(address, { exact: true })).toBeVisible();
    await expect(page.getByText(hours, { exact: true })).toBeVisible();

    await page.goto(`/gyms?q=${encodeURIComponent(gymName)}`);
    await expect(page.getByRole('link', { name: new RegExp(gymName) })).toBeVisible();
    expect(browserErrors).toEqual([]);
  });
});
