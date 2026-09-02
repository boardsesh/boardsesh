import { type Page, test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth';

/**
 * E2E for the www chrome after W-16 (#4358).
 *
 * The old bottom tab bar + persistent queue control bar are gone, along with
 * every provider that fed them. What ships on every non-chrome-less page is a
 * fixed `MarketingHeader` at the top and a `SiteFooter` in normal flow at the
 * bottom — the footer being where the site's crawlable internal links and the
 * only remaining locale switcher live.
 *
 * The negative assertions matter as much as the positive ones: a rebase that
 * silently restores the bottom bar would otherwise pass unnoticed, since
 * `e2e-tests.yml` is `workflow_dispatch`-only.
 */

const boardUrl = '/kilter/original/12x12-square/screw_bolt/40/list';
const bottomTabBar = '[data-testid="bottom-tab-bar"]';
const queueControlBar = '[data-testid="queue-control-bar"]';
const bottomBarWrapper = '[data-testid="bottom-bar-wrapper"]';

// Target the chrome by testid, not by tag. `<header>` and `<footer>` are used
// by page content too — `kiosk/embed/embed-leaderboard.tsx` and
// `kiosk/leaderboard-rail/leaderboard-rail.tsx` both render their own
// `<footer>` — so a tag selector would make the chrome-less assertions below
// wrong in the one direction that matters.
const marketingHeader = '[data-testid="marketing-header"]';
const siteFooter = '[data-testid="site-footer"]';

async function expectChrome(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator(marketingHeader)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(siteFooter)).toBeVisible({ timeout: 15000 });
}

async function expectNoChrome(page: Page) {
  await expect(page.locator(marketingHeader)).toHaveCount(0);
  await expect(page.locator(siteFooter)).toHaveCount(0);
}

async function expectNoBottomBar(page: Page) {
  await expect(page.locator(bottomTabBar)).toHaveCount(0);
  await expect(page.locator(queueControlBar)).toHaveCount(0);
  await expect(page.locator(bottomBarWrapper)).toHaveCount(0);
}

test.describe('Site chrome - visibility', () => {
  for (const [label, url] of [
    ['the home page', '/'],
    ['a board list page', boardUrl],
    ['the settings page', '/settings'],
    ['the playlists page', '/playlists'],
  ] as const) {
    test(`renders the header and footer on ${label}`, async ({ page }) => {
      await page.goto(url);
      await expectChrome(page);
      await expectNoBottomBar(page);
    });
  }

  // `/playlists` on purpose, not `/settings`: the `/settings` branch of
  // `MarketingHeader` renders the brand link and a spacer and never reads the
  // session, so a signed-in run there would assert nothing the unauthenticated
  // `/settings` case above doesn't already cover. `/playlists` falls through to
  // the default branch, which is where the account affordance renders. It also
  // has to be a path that still serves 200 on www: W-20b (#4439) turned
  // `/notifications` — the page this used to sign in to — into a cross-origin
  // 307, and `loginAs` waits for the callback URL to be the browser's final URL.
  test('renders the header and footer for a signed-in visitor', async ({ page }) => {
    await loginAs(page, '/playlists');
    await expectChrome(page);
    await expectNoBottomBar(page);
  });

  // W-19 deleted `/you`, and with it the only other www link to `/settings`.
  // Until W-21 (#4440) reworks `/settings`, the account slot in this header is
  // the sole way in. W-20b (#4439) moved notifications to the app, so the bell
  // that used to sit beside the cog is gone — the negative assertion is the e2e
  // twin of `marketing-header.test.tsx`'s `links nowhere into /notifications`.
  test('keeps settings reachable once signed in', async ({ page }) => {
    await loginAs(page, '/playlists');
    await expectChrome(page);

    const header = page.locator(marketingHeader);
    await expect(header.locator('a[href="/settings"]')).toBeVisible();
    await expect(header.locator('a[href^="/you"]')).toHaveCount(0);
    await expect(header.locator('a[href^="/notifications"]')).toHaveCount(0);
  });
});

test.describe('Site chrome - footer links', () => {
  test('carries crawlable links to every static sitemap page', async ({ page }) => {
    await page.goto('/');
    await expectChrome(page);

    const footer = page.locator(siteFooter);
    for (const href of ['/', '/about', '/help', '/docs', '/playlists', '/aurora-migration', '/legal', '/privacy']) {
      await expect(footer.locator(`a[href="${href}"]`)).toHaveCount(1);
    }
  });

  // `/gyms` is `noindex, follow` and out of the sitemap until the duplicate-gym
  // queue drains, so the footer is the only crawl path into the directory.
  test('carries the gym directory links, one per board type', async ({ page }) => {
    await page.goto('/');
    await expectChrome(page);

    const footer = page.locator(siteFooter);
    for (const href of ['/gyms', '/gyms/kilter', '/gyms/tension', '/gyms/moonboard']) {
      await expect(footer.locator(`a[href="${href}"]`)).toHaveCount(1);
    }
  });

  test('keeps a locale switcher — the user drawer that used to host it is gone', async ({ page }) => {
    await page.goto('/');
    await expectChrome(page);

    await expect(page.locator(siteFooter).getByRole('button', { name: /language/i })).toBeVisible();
  });
});

test.describe('Site chrome - header nav', () => {
  // The nav row stays mounted at every width — CSS hides it below 900px and
  // shows the menu button instead — so the anchors are in the markup on a phone
  // too. `toHaveCount`, not `toBeVisible`, is the assertion that survives both.
  for (const [label, url] of [
    ['the home page', '/'],
    ['the about page', '/about'],
  ] as const) {
    test(`links to gyms, playlists, about and help on ${label}`, async ({ page }) => {
      await page.goto(url);
      await expectChrome(page);

      const header = page.locator(marketingHeader);
      for (const href of ['/gyms', '/playlists', '/about', '/help']) {
        await expect(header.locator(`nav a[href="${href}"]`)).toHaveCount(1);
      }
    });
  }

  // `/boards` is drawn in the wireframe but the route does not exist. A link to
  // it would be a chrome-wide 404 on every page at once.
  test('links nowhere into /boards — the route does not exist', async ({ page }) => {
    await page.goto('/');
    await expectChrome(page);

    await expect(page.locator(marketingHeader).locator('a[href^="/boards"]')).toHaveCount(0);
  });
});

test.describe('Site chrome - header hand-off', () => {
  test('offers a sign-in entry point when signed out', async ({ page }) => {
    await page.goto('/');
    await expectChrome(page);

    await expect(page.locator(marketingHeader).locator('a[href="/auth/login"]')).toBeVisible();
  });

  test('links straight to the app', async ({ page }) => {
    await page.goto('/');
    await expectChrome(page);

    await expect(page.locator(marketingHeader).locator('a[href*="boardsesh.com"]').first()).toBeVisible();
  });
});

test.describe('Site chrome - no dead bottom gutter', () => {
  // The old chrome reserved ~145px at the bottom of every page via
  // `--bottom-bar-height`. The footer that replaced the bottom bar sits in
  // normal flow, so nothing below it should reserve space: the document should
  // end within a few pixels of the footer's bottom edge.
  for (const [label, url] of [
    ['the home page', '/'],
    ['the about page', '/about'],
    ['the playlists page', '/playlists'],
  ] as const) {
    test(`ends at the footer on ${label}`, async ({ page }) => {
      await page.goto(url);
      await expectChrome(page);

      const gutter = await page.evaluate(() => {
        const footer = document.querySelector('[data-testid="site-footer"]');
        if (!footer) return Number.NaN;
        const footerBottom = footer.getBoundingClientRect().bottom + window.scrollY;
        return document.documentElement.scrollHeight - footerBottom;
      });

      expect(Number.isNaN(gutter)).toBe(false);
      expect(gutter, `${url} reserves ${gutter}px below the footer`).toBeLessThan(24);
    });
  }

  test('defines no --bottom-bar-height custom property', async ({ page }) => {
    await page.goto('/');
    await expectChrome(page);

    const value = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bottom-bar-height').trim(),
    );
    expect(value).toBe('');
  });
});

test.describe('Site chrome - chrome-less surfaces', () => {
  test('renders zero chrome on a kiosk route', async ({ page }) => {
    const response = await page.goto('/kiosk/does-not-exist/does-not-exist');
    // 404 is fine — what matters is that no app chrome is injected either way.
    expect(response).not.toBeNull();
    await page.waitForLoadState('domcontentloaded');
    await expectNoBottomBar(page);
    await expectNoChrome(page);
  });

  test('renders zero chrome on an embed route', async ({ page }) => {
    await page.goto('/embed/gym/00000000-0000-0000-0000-000000000000/leaderboard');
    await page.waitForLoadState('domcontentloaded');
    await expectNoBottomBar(page);
    await expectNoChrome(page);
  });

  // Socket budget. Before W-16 the root `PersistentSessionWrapper` opened a
  // `connectionName: 'session'` client on *every* route, kiosk TVs and embeds
  // included. Both routes below are unseeded and 404 through `notFound()`, so
  // neither mounts a product socket of its own — `KioskPresenceHub` never
  // renders. That makes zero the only correct count on both, and what these two
  // guard is precisely the root socket coming back: a restored root client
  // attaches before the route resolves and would push either count to 1.
  // `embed-access.test.ts` and the leaderboard page pin the embed side.
  async function countSockets(page: Page, url: string): Promise<number> {
    let sockets = 0;
    page.on('websocket', () => {
      sockets += 1;
    });
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    return sockets;
  }

  test('opens no root WebSocket on a kiosk route', async ({ page }) => {
    expect(await countSockets(page, '/kiosk/does-not-exist/does-not-exist')).toBe(0);
  });

  test('opens zero WebSockets on an embed route', async ({ page }) => {
    expect(await countSockets(page, '/embed/gym/00000000-0000-0000-0000-000000000000/leaderboard')).toBe(0);
  });
});
