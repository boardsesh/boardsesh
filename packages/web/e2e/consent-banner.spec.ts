import { test, expect } from '@playwright/test';
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('analytics privacy choices everywhere', () => {
  test('fresh visit asks without a location lookup or pre-consent analytics', async ({ page }) => {
    const forbidden: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (
        (request.postData() ?? '').includes('consentRegion') ||
        /connect\.facebook\.net|redditstatic\.com\/ads|facebook\.com\/tr|reddit\.com\/rp\/|\/api\/posthog\/(batch|e|i\/v0\/e|s)(?:\/|\?|$)/.test(
          url,
        )
      )
        forbidden.push(url);
    });
    await page.goto('/');
    const banner = page.getByTestId('consent-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'No thanks', exact: true })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Read our privacy policy' })).toHaveAttribute('href', '/privacy');
    await expect(banner).not.toContainText(/session replay|session recording/i);
    expect(forbidden).toEqual([]);
  });
  for (const [label, choice] of [
    ['Allow', 'granted'],
    ['No thanks', 'denied'],
  ] as const) {
    test(`${label} persists and can be changed from the footer`, async ({ page, context }) => {
      await page.goto('/');
      await page.getByTestId('consent-banner').getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByTestId('consent-banner')).toBeHidden();
      expect((await context.cookies()).find((stored) => stored.name === 'boardsesh-consent')?.value).toContain(
        `v1.${choice}.`,
      );
      await page.reload();
      await expect(page.getByTestId('consent-banner')).toBeHidden();
      await page.getByRole('button', { name: 'Privacy choices', exact: true }).click();
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
  test('Not now leaves analytics unanswered while navigating', async ({ page, context }) => {
    await page.goto('/');
    await page.getByTestId('consent-banner').getByRole('button', { name: 'Not now', exact: true }).click();
    expect((await context.cookies()).find((stored) => stored.name === 'boardsesh-consent')).toBeUndefined();
    await page
      .getByRole('link', { name: /privacy policy/i })
      .last()
      .click();
    await expect(page).toHaveURL(/\/privacy/);
    await expect(page.getByTestId('consent-banner')).toBeHidden();
    await page.getByRole('button', { name: 'Privacy choices', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
  test('legacy region defaults are unanswered and prompt again', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'boardsesh-consent', value: 'v1.granted.1760000000.web.region', url: baseURL! }]);
    await page.goto('/');
    await expect(page.getByTestId('consent-banner')).toBeVisible();
    await page.getByTestId('consent-banner').getByRole('button', { name: 'No thanks', exact: true }).click();
    await page.reload();
    await expect(page.getByTestId('consent-banner')).toBeHidden();
    expect((await context.cookies()).find((stored) => stored.name === 'boardsesh-consent')?.value).toMatch(
      /^v1\.denied\.\d+\.web$/,
    );
  });
  test('asks even with Global Privacy Control and an unavailable location backend', async ({ page, context }) => {
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true }),
    );
    await page.route('**/graphql', (route) => route.abort('failed'));
    await page.goto('/');
    await expect(page.getByTestId('consent-banner')).toBeVisible();
    expect((await context.cookies()).find((stored) => stored.name === 'boardsesh-consent')).toBeUndefined();
  });
});
