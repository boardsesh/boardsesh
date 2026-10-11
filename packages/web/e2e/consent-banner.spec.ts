import { test, expect, type Page } from '@playwright/test';
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The banner only asks in the prompt regions (EU, EEA, UK, Switzerland, ...),
 * which the browser learns from the backend's `consentRegion` query. Stub that
 * one operation so every run takes a known path, whatever country the runner
 * or the backend sits in. Every other GraphQL request goes through untouched.
 */
async function stubConsentRegion(page: Page, region: { countryCode: string | null; promptRequired: boolean } | 'fail') {
  await page.route('**/graphql', async (route) => {
    if (!(route.request().postData() ?? '').includes('consentRegion')) return route.fallback();
    if (region === 'fail') return route.abort('failed');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ data: { consentRegion: region } }),
    });
  });
}

test.describe('analytics privacy choices in a prompt region', () => {
  test.beforeEach(async ({ page }) => {
    await stubConsentRegion(page, { countryCode: 'DE', promptRequired: true });
  });
  test('fresh visit offers equally weighted choices and a policy link', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/');
    const banner = page.getByTestId('consent-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'No thanks', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Read our privacy policy' })).toHaveAttribute('href', '/privacy');
  });
  for (const [label, choice] of [
    ['Allow', 'granted'],
    ['No thanks', 'denied'],
  ] as const) {
    test(`${label} persists and can be changed from the footer`, async ({ page, context }) => {
      await context.clearCookies();
      await page.goto('/');
      await page.getByTestId('consent-banner').getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByTestId('consent-banner')).toBeHidden();
      const cookie = (await context.cookies()).find((stored) => stored.name === 'boardsesh-consent');
      expect(cookie?.value).toContain(`v1.${choice}.`);
      await page.reload();
      await expect(page.getByTestId('consent-banner')).toBeHidden();
      await page.getByRole('button', { name: 'Privacy choices', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: choice === 'granted' ? 'No thanks' : 'Allow', exact: true })
        .click();
      await expect(page.getByRole('dialog')).toBeHidden();
      expect((await context.cookies()).find((stored) => stored.name === 'boardsesh-consent')?.value).toContain(
        choice === 'granted' ? '.denied.' : '.granted.',
      );
    });
  }
});

test.describe('analytics privacy choices outside the prompt regions', () => {
  test('a US visitor gets no banner, analytics on, and can still switch it off', async ({ page, context }) => {
    await stubConsentRegion(page, { countryCode: 'US', promptRequired: false });
    await context.clearCookies();
    await page.goto('/');
    await expect
      .poll(async () => (await context.cookies()).find((stored) => stored.name === 'boardsesh-consent')?.value)
      .toMatch(/^v1\.granted\.\d+\.web\.region$/);
    await expect(page.getByTestId('consent-banner')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('consent-banner')).toHaveCount(0);
    await page.getByRole('button', { name: 'Privacy choices', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'No thanks', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    expect((await context.cookies()).find((stored) => stored.name === 'boardsesh-consent')?.value).toMatch(
      /^v1\.denied\.\d+\.web$/,
    );
  });

  test('a visitor whose region lookup fails still gets the banner', async ({ page, context }) => {
    await stubConsentRegion(page, 'fail');
    await context.clearCookies();
    await page.goto('/');
    await expect(page.getByTestId('consent-banner')).toBeVisible();
  });

  test('a US visitor whose browser sends Global Privacy Control gets no default and no banner', async ({
    page,
    context,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    });
    await stubConsentRegion(page, { countryCode: 'US', promptRequired: false });
    await context.clearCookies();
    // Wait for the lookup to land before checking that nothing was written.
    const regionAnswered = page.waitForResponse((response) =>
      (response.request().postData() ?? '').includes('consentRegion'),
    );
    await page.goto('/');
    await regionAnswered;
    await page.waitForTimeout(500);
    expect((await context.cookies()).find((stored) => stored.name === 'boardsesh-consent')).toBeUndefined();
    await expect(page.getByTestId('consent-banner')).toHaveCount(0);
  });
});
