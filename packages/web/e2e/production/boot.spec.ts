// Production boot smoke for app.boardsesh.com.
//
// The curl smoke in production-deploy.yml already proves the transport layer:
// the shell 200s, a deep route falls back to it, the WASM binary serves, and the
// entry chunk comes back as immutable JavaScript rather than the SPA fallback.
// What none of that can prove is that the bundle actually *boots* — a JS chunk
// can serve with perfect headers and still throw on evaluation, and
// `_redirects`' `/* /index.html 200` means even a missing route answers 200.
// Both failures look healthy to curl and blank to a user.
//
// So this is deliberately one thing: put a real browser in front of the deploy
// and confirm React mounted. It never signs in — this runs against production
// and must stay read-only, which is also why it lives under its own config
// (playwright.production.config.ts) with no globalSetup.

// Measured against live app.boardsesh.com on 2026-08-02: root boot 5.3s, deep
// route 1.8s. The 60s polls below are ~10x that, so they are headroom for a
// cold edge rather than a value anything is expected to approach. If a future
// splash screen renders with no text at all, this is the test that will say so
// — which is the point; a splash with no visible text is not a booted app.
import { expect, test } from '@playwright/test';
import { collectDiagnostics, expectMounted, formatDiagnostics } from './boot-diagnostics';

test.describe('app.boardsesh.com boots', () => {
  test('mounts React into #root and renders visible content', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The shell ships `<div id="root"></div>` empty; anything inside it is
    // proof the bundle downloaded, evaluated and rendered. This is the check
    // that separates "assets serve" from "the app works".
    const root = page.locator('#root');
    await expect(root).toBeAttached();
    await expectMounted(page, 60_000, diagnostics);

    // Rendered *something a human would see*, not just an empty wrapper tree.
    await expect
      .poll(async () => (await root.innerText()).trim().length, {
        timeout: 60_000,
        message: '#root mounted but rendered no visible text',
      })
      .toBeGreaterThan(0);

    expect(diagnostics.fatal, `fatal errors during boot:\n${formatDiagnostics(diagnostics)}`).toEqual([]);
  });

  test('serves the SPA shell for a deep route without a hard error', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);

    // `_redirects` answers `/* /index.html 200`, so this must boot the same
    // shell rather than a 404 page. A route that resolves to a blank body is
    // the regression: 200, correct headers, nothing rendered.
    await page.goto('/climbs', { waitUntil: 'domcontentloaded' });

    const root = page.locator('#root');
    await expectMounted(page, 60_000, diagnostics);
    // Same bar as the root test: an empty wrapper is a mount, not a render,
    // and the SPA fallback makes an unresolved route look exactly like that.
    await expect
      .poll(async () => (await root.innerText()).trim().length, {
        timeout: 60_000,
        message: 'deep route mounted but rendered no visible text',
      })
      .toBeGreaterThan(0);

    expect(diagnostics.fatal, `fatal errors on deep route:\n${formatDiagnostics(diagnostics)}`).toEqual([]);
  });
});
