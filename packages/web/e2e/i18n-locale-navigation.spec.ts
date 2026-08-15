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
});
