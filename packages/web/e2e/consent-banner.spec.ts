import { type Page, test, expect } from '@playwright/test';

const CONSENT_COOKIE = 'boardsesh:consent';
const BANNER_HEADLINE = "We don't track you by default.";
const ACCEPT_ALL = 'Accept all';
const REJECT = 'Reject';
const CUSTOMIZE = 'Customize';

// Override the global storageState (which pre-seeds the consent cookie so
// it doesn't cover bottom-of-viewport UI in other specs) — this spec needs
// the fresh, no-decision-yet state to actually verify the banner shows.
test.use({ storageState: { cookies: [], origins: [] } });

function bannerRegion(page: Page) {
  return page.getByRole('region', { name: BANNER_HEADLINE });
}

async function readConsentCookie(page: Page): Promise<string | undefined> {
  const cookies = await page.context().cookies();
  return cookies.find((cookie) => cookie.name === CONSENT_COOKIE)?.value;
}

test.describe('Cookie consent banner', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('shows the banner on a fresh visit', async ({ page }) => {
    await page.goto('/');
    await expect(bannerRegion(page)).toBeVisible({ timeout: 15000 });
    await expect(bannerRegion(page).getByRole('button', { name: ACCEPT_ALL })).toBeVisible();
    await expect(bannerRegion(page).getByRole('button', { name: REJECT })).toBeVisible();
    await expect(bannerRegion(page).getByRole('button', { name: CUSTOMIZE })).toBeVisible();
    await expect(await readConsentCookie(page)).toBeUndefined();
  });

  test('Accept all persists across reload and writes a granted cookie', async ({ page }) => {
    await page.goto('/');
    await bannerRegion(page).getByRole('button', { name: ACCEPT_ALL }).click();
    await expect(bannerRegion(page)).toBeHidden();

    const cookieValue = await readConsentCookie(page);
    expect(cookieValue).toContain('a=1');
    expect(cookieValue).toContain('e=1');
    expect(cookieValue).toContain('v=1');

    await page.reload();
    await expect(bannerRegion(page)).toBeHidden({ timeout: 15000 });
  });

  test('Reject persists across reload and writes a denied cookie', async ({ page }) => {
    await page.goto('/');
    await bannerRegion(page).getByRole('button', { name: REJECT }).click();
    await expect(bannerRegion(page)).toBeHidden();

    const cookieValue = await readConsentCookie(page);
    expect(cookieValue).toContain('a=0');
    expect(cookieValue).toContain('e=0');

    await page.reload();
    await expect(bannerRegion(page)).toBeHidden({ timeout: 15000 });
  });

  test('Customize opens dialog and saves per-category choices', async ({ page }) => {
    await page.goto('/');
    await bannerRegion(page).getByRole('button', { name: CUSTOMIZE }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Two switches: Analytics + Error monitoring. Both start at the consent default ('unknown' → off).
    const analyticsSwitch = dialog.getByRole('switch').first();
    await analyticsSwitch.click();

    await dialog.getByRole('button', { name: 'Save preferences' }).click();
    await expect(dialog).toBeHidden();
    await expect(bannerRegion(page)).toBeHidden();

    const cookieValue = await readConsentCookie(page);
    expect(cookieValue).toContain('a=1');
    expect(cookieValue).toContain('e=0');
  });
});
