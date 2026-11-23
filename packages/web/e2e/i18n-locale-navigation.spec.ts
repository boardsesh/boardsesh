import { test, expect } from '@playwright/test';

/**
 * Locale-aware navigation: cookie persistence, in-app link prefixing,
 * and the API/external pass-through guards.
 *
 * Sister spec to i18n-locale-routing.spec.ts which covers the static
 * middleware → server-component → catalog pipeline. This one exercises
 * the runtime navigation surface behind the language switcher, which now
 * lives in the SiteFooter (it moved there from the deleted user drawer).
 */
test.describe('i18n locale navigation', () => {
  test('cookie pre-set redirects unprefixed URL to the cookie locale', async ({ context, page }) => {
    await context.addCookies([
      {
        name: 'boardsesh-locale',
        value: 'es',
        domain: 'localhost',
        path: '/',
      },
    ]);

    const response = await page.goto('/about', { waitUntil: 'domcontentloaded' });

    // Final landing URL should be the Spanish version after the 308.
    expect(page.url()).toMatch(/\/es\/about$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');

    // Confirm the redirect chain saw a 308 from the unprefixed entry.
    const chain = response?.request().redirectedFrom();
    expect(chain).not.toBeNull();
  });

  test('visiting /es/* writes the locale cookie back', async ({ context, page }) => {
    await context.clearCookies();

    await page.goto('/es/about', { waitUntil: 'domcontentloaded' });

    const cookies = await context.cookies();
    const localeCookie = cookies.find((c) => c.name === 'boardsesh-locale');
    expect(localeCookie?.value).toBe('es');
  });

  test('default locale visit does NOT write a cookie', async ({ context, page }) => {
    await context.clearCookies();

    await page.goto('/about', { waitUntil: 'domcontentloaded' });

    const cookies = await context.cookies();
    const localeCookie = cookies.find((c) => c.name === 'boardsesh-locale');
    expect(localeCookie).toBeUndefined();
  });

  test('in-app hrefs render with the /es prefix on Spanish pages', async ({ page }) => {
    await page.goto('/es/about', { waitUntil: 'domcontentloaded' });

    const localizedHrefs = await page
      .locator('a[href^="/es/"]')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).getAttribute('href')));
    expect(localizedHrefs.length).toBeGreaterThan(0);

    // Negative invariant: no anchor anywhere on the page should pretend
    // /api/* is locale-scoped. If LocaleLink ever regresses this guard,
    // a sign-in or webhook anchor will pollute the document.
    const prefixedApi = await page
      .locator('a[href^="/es/api/"]')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).getAttribute('href')));
    expect(prefixedApi).toEqual([]);
  });

  test('French visitors can open an English app guide and return to French', async ({ context, page }) => {
    await page.goto('/fr/boards');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await page.locator('footer button[aria-haspopup="menu"]').click();
    await expect(page.getByRole('menuitem', { name: 'Français' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('a[href="/apps/kilter"]').first().click();
    await expect(page).toHaveURL(/\/apps\/kilter$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('footer button[aria-haspopup="menu"]')).toHaveCount(0);

    const alias = await page.goto('/fr/apps/kilter?ref=test');
    expect(alias?.status()).toBe(200);
    const aliasRequest = alias?.request().redirectedFrom();
    expect((await aliasRequest?.response())?.status()).toBe(307);
    expect(aliasRequest?.redirectedFrom()).toBeNull();
    await expect(page).toHaveURL(/\/apps\/kilter\?ref=test$/);
    expect((await context.cookies()).find(({ name }) => name === 'boardsesh-locale')?.value).toBe('fr');

    await page.locator('footer a[href="/boards"]').click();
    await expect(page).toHaveURL(/\/fr\/boards$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  });

  test('an unknown app guide still returns 404 after one alias redirect', async ({ page }) => {
    const response = await page.goto('/fr/apps/unknown-guide?ref=test');
    expect(response?.status()).toBe(404);
    await expect(page).toHaveURL(/\/apps\/unknown-guide\?ref=test$/);
    const aliasRequest = response?.request().redirectedFrom();
    expect((await aliasRequest?.response())?.status()).toBe(307);
    expect(aliasRequest?.redirectedFrom()).toBeNull();
  });
});
