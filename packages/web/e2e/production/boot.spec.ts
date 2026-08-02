// Production boot smoke for app.boardsesh.com.
//
// The curl smoke in production-deploy.yml already proves the transport layer:
// the shell 200s, a deep route falls back to it, the WASM binary serves, and a
// content-hashed asset comes back immutable. What none of that can prove is
// that the bundle actually *boots* — a JS chunk can serve with perfect headers
// and still throw on evaluation, and `_redirects`' `/* /index.html 200` means
// even a missing route answers 200. Both failures look healthy to curl and
// blank to a user.
//
// So this is deliberately one thing: put a real browser in front of the deploy
// and confirm React mounted. It never signs in — this runs against production
// and must stay read-only, which is also why it lives under its own config
// (playwright.production.config.ts) with no globalSetup.

import { expect, test, type Page } from '@playwright/test';

/**
 * Errors that mean the app is broken rather than noisy. Kept narrow on purpose:
 * a production smoke that fails on any console error becomes a flake generator
 * (third-party scripts, extensions, aborted requests on unload) and then gets
 * ignored, which is worse than not having it.
 */
const FATAL_CONSOLE_PATTERNS = [
  /Unable to get view config/i,
  /No QueryClient set/i,
  /Maximum update depth exceeded/i,
  /ChunkLoadError/i,
  /Failed to fetch dynamically imported module/i,
];

function collectFatalErrors(page: Page): string[] {
  const fatal: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (FATAL_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) fatal.push(text);
  });
  // An uncaught exception is always fatal — that is a bundle that failed to boot.
  page.on('pageerror', (error) => fatal.push(`pageerror: ${String(error)}`));
  return fatal;
}

test.describe('app.boardsesh.com boots', () => {
  test('mounts React into #root and renders visible content', async ({ page }) => {
    const fatalErrors = collectFatalErrors(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The shell ships `<div id="root"></div>` empty; anything inside it is
    // proof the bundle downloaded, evaluated and rendered. This is the check
    // that separates "assets serve" from "the app works".
    const root = page.locator('#root');
    await expect(root).toBeAttached();
    await expect(root.locator('> *').first()).toBeAttached({ timeout: 60_000 });

    // Rendered *something a human would see*, not just an empty wrapper tree.
    await expect
      .poll(async () => (await root.innerText()).trim().length, {
        timeout: 60_000,
        message: '#root mounted but rendered no visible text',
      })
      .toBeGreaterThan(0);

    expect(fatalErrors, `fatal errors during boot:\n${fatalErrors.join('\n')}`).toEqual([]);
  });

  test('serves the SPA shell for a deep route without a hard error', async ({ page }) => {
    const fatalErrors = collectFatalErrors(page);

    // `_redirects` answers `/* /index.html 200`, so this must boot the same
    // shell rather than a 404 page. A route that resolves to a blank body is
    // the regression: 200, correct headers, nothing rendered.
    await page.goto('/climbs', { waitUntil: 'domcontentloaded' });

    const root = page.locator('#root');
    await expect(root.locator('> *').first()).toBeAttached({ timeout: 60_000 });
    // Same bar as the root test: an empty wrapper is a mount, not a render,
    // and the SPA fallback makes an unresolved route look exactly like that.
    await expect
      .poll(async () => (await root.innerText()).trim().length, {
        timeout: 60_000,
        message: 'deep route mounted but rendered no visible text',
      })
      .toBeGreaterThan(0);

    expect(fatalErrors, `fatal errors on deep route:\n${fatalErrors.join('\n')}`).toEqual([]);
  });
});
