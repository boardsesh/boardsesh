import { test, expect } from '@playwright/test';
test.use({ storageState: { cookies: [], origins: [] } });
test.describe('analytics privacy choices', () => {
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
