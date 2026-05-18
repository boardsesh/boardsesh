import { type Page, test, expect } from '@playwright/test';

const CONSENT_COOKIE = 'boardsesh-consent';
const BANNER_TESTID = 'consent-banner';
const ACCEPT_ALL = 'Accept all';
const REJECT = 'Reject';
const CUSTOMIZE = 'Customize';
const SAVE = 'Save preferences';

// Override the global storageState (which pre-seeds the consent cookie so
// it doesn't cover bottom-of-viewport UI in other specs) — this spec needs
// the fresh, no-decision-yet state to actually verify the banner shows.
test.use({ storageState: { cookies: [], origins: [] } });

function banner(page: Page) {
  return page.getByTestId(BANNER_TESTID);
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
    await expect(banner(page)).toBeVisible({ timeout: 15000 });
    await expect(banner(page).getByRole('button', { name: ACCEPT_ALL })).toBeVisible();
    await expect(banner(page).getByRole('button', { name: REJECT })).toBeVisible();
    await expect(banner(page).getByRole('button', { name: CUSTOMIZE })).toBeVisible();
    await expect(await readConsentCookie(page)).toBeUndefined();
  });

  test('Accept all persists across reload and writes a granted cookie', async ({ page }) => {
    await page.goto('/');
    await banner(page).getByRole('button', { name: ACCEPT_ALL }).click();
    await expect(banner(page)).toBeHidden();

    const cookieValue = await readConsentCookie(page);
    expect(cookieValue).toContain('a=1');
    expect(cookieValue).toContain('e=1');
    expect(cookieValue).toContain('v=1');

    await page.reload();
    await expect(banner(page)).toBeHidden({ timeout: 15000 });
  });

  test('Reject persists across reload and writes a denied cookie', async ({ page }) => {
    await page.goto('/');
    await banner(page).getByRole('button', { name: REJECT }).click();
    await expect(banner(page)).toBeHidden();

    const cookieValue = await readConsentCookie(page);
    expect(cookieValue).toContain('a=0');
    expect(cookieValue).toContain('e=0');

    await page.reload();
    await expect(banner(page)).toBeHidden({ timeout: 15000 });
  });

  test('Customize opens dialog and saves per-category choices', async ({ page }) => {
    await page.goto('/');
    await banner(page).getByRole('button', { name: CUSTOMIZE }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Locate the analytics switch by its aria-label rather than by index —
    // ties the assertion to the semantics so a future reorder of switches
    // in the dialog can't silently flip which category we toggle.
    const analyticsSwitch = dialog.getByRole('switch', { name: 'Product analytics' });
    await analyticsSwitch.click();

    await dialog.getByRole('button', { name: SAVE }).click();
    await expect(dialog).toBeHidden();
    await expect(banner(page)).toBeHidden();

    const cookieValue = await readConsentCookie(page);
    expect(cookieValue).toContain('a=1');
    expect(cookieValue).toContain('e=0');
  });
});
