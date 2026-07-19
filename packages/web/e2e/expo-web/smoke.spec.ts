// Expo-web smoke: drives the mobile app compiled for the browser (the /app
// surface, react-native-web + the Material variant) through the Phase 0
// go/no-go flows. Runs only in the `expo-web-smoke` Playwright project, which
// requires the full expo-web dev stack (backend + Next proxy + Metro web) —
// start it with `vp run test:e2e:expo-web`, or `vp run dev:mobile:web` and run
// the project manually. The chromium project ignores this directory.
//
// Selector strategy: react-native-web maps accessibilityRole/Label to ARIA, so
// everything here queries by role/name through the app's i18n strings (en-US
// catalog — the dev stack runs untranslated). No CSS classes: RNW class names
// are generated and unstable.
//
// Serial: the first /app load compiles the whole Metro web bundle on demand
// (minutes, once per stack). Parallel workers would each pay that cost and
// time out; serial lets the first test absorb the compile and the rest run
// against a warm bundle.

import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const TEST_EMAIL = process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com';
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'test';

/** First navigation may include the on-demand Metro compile of the bundle. */
const COLD_LOAD_TIMEOUT_MS = 180_000;
const WARM_TIMEOUT_MS = 30_000;

/** The five Material tab-bar entries, in mobile's canonical order. */
const TAB_NAMES = ['Home', 'Climbs', 'Record', 'Discover', 'Profile'] as const;

/**
 * Console/page-error budget: the smoke fails on error classes that historically
 * meant a broken surface rather than noise.
 */
const FATAL_CONSOLE_PATTERNS = [
  /Maximum update depth exceeded/i,
  /Cannot update a component/i,
  /Reanimated/i,
  /ws-auth returned no token/i,
  /Unable to get view config/i,
  /No QueryClient set/i,
];

function collectFatalConsoleErrors(page: Page): string[] {
  const fatalErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (FATAL_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) {
      fatalErrors.push(text);
    }
  });
  page.on('pageerror', (error) => {
    fatalErrors.push(String(error));
  });
  return fatalErrors;
}

function tabButton(page: Page, name: (typeof TAB_NAMES)[number]) {
  // MaterialTabBar sets `accessibilityRole="tab"` + `accessibilityLabel={label}`
  // on each destination, which react-native-web maps to role=tab with an
  // aria-label equal to the tab title verbatim. Each label is unique and the
  // hidden /wall route is filtered out, so an exact accessible-name match
  // resolves to the one real tab — no positional `.last()` needed.
  return page.getByRole('tab', { name, exact: true });
}

/**
 * Lands on /app and ends signed in on the tab shell, tolerating either entry
 * state: a fresh context gets the credentials screen; a context that inherited
 * a NextAuth session through the SSO bridge lands straight on Home.
 */
async function ensureSignedIn(page: Page): Promise<void> {
  await page.goto('/app', { timeout: COLD_LOAD_TIMEOUT_MS });
  const emailField = page.getByRole('textbox', { name: 'Email', exact: true });
  const homeTab = tabButton(page, 'Home');
  await expect(emailField.or(homeTab).first()).toBeVisible({ timeout: COLD_LOAD_TIMEOUT_MS });

  if (await emailField.isVisible()) {
    await emailField.fill(TEST_EMAIL);
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(homeTab).toBeVisible({ timeout: WARM_TIMEOUT_MS });
}

test.describe('expo-web smoke', () => {
  test('boots, signs in, and renders the five-tab Material shell', async ({ page }) => {
    const fatalErrors = collectFatalConsoleErrors(page);
    await ensureSignedIn(page);
    for (const tabName of TAB_NAMES) {
      await expect(tabButton(page, tabName)).toBeVisible();
    }
    expect(fatalErrors).toEqual([]);
  });

  test('home feed renders WASM board thumbnails; climbs tab shows the follow-your-wall state', async ({ page }) => {
    const fatalErrors = collectFatalConsoleErrors(page);
    await ensureSignedIn(page);
    // WASM overlay renders resolve to blob: object URLs inside expo-image
    // <img>s — the Home feed's session cards carry them without any board
    // context.
    const blobThumbnails = page.locator('img[src^="blob:"]');
    await expect(blobThumbnails.first()).toBeVisible({ timeout: 60_000 });
    // Each blob: src appears only when that card's WASM render resolves, and
    // nothing synchronizes the renders — at the instant the first thumbnail is
    // visible the others may still be in flight. Waiting on the third keeps
    // the "several cards rendered" assertion retrying instead of snapshotting
    // a racy count.
    await expect(blobThumbnails.nth(2)).toBeVisible({ timeout: 60_000 });
    // A fresh browser context has no followed board, so the Climbs tab shows
    // the follow-your-wall empty state rather than a list.
    await tabButton(page, 'Climbs').click();
    await expect(page.getByRole('button', { name: 'Find my board' })).toBeVisible({ timeout: WARM_TIMEOUT_MS });
    expect(fatalErrors).toEqual([]);
  });

  /**
   * Binds the seeded kilter board (Dyno Den) via the board sheet so the Climbs
   * tab has a list and play-drawer actions aren't blocked by the switch-board
   * overlay (feed climbs live on other boards). Fresh contexts start unbound.
   */
  async function bindSeededBoard(page: Page): Promise<void> {
    await tabButton(page, 'Climbs').click();
    const findBoardButton = page.getByRole('button', { name: 'Find my board' });
    const boundThumbnail = page.locator('img[src^="blob:"]').first();
    // The Climbs tab settles into one of two determinate states: the follow-
    // your-wall empty state (fresh context) or a populated list (already bound).
    // Wait for whichever appears so the bind decision below isn't racing an
    // unrendered UI — an immediate `isVisible()` could read false mid-mount and
    // silently skip binding.
    await expect(findBoardButton.or(boundThumbnail).first()).toBeVisible({ timeout: WARM_TIMEOUT_MS });
    if (await findBoardButton.isVisible()) {
      await findBoardButton.click({ force: true });
      await page
        .getByRole('button', { name: /Dyno Den/ })
        .first()
        .click({ force: true });
    }
    // Bound board → the list renders WASM thumbnails. Assert unconditionally so
    // a skipped bind (e.g. the empty-state button got renamed) fails loudly
    // here instead of letting downstream steps pass vacuously.
    await expect(boundThumbnail).toBeVisible({ timeout: 60_000 });
  }

  /** Opens the first climbs-list climb into the play drawer. */
  async function openPlayDrawerFromClimbsList(page: Page): Promise<void> {
    await bindSeededBoard(page);
    // Each list row is an accessible button named after its climb and wraps
    // the blob thumbnail; force bypasses the row's cross-dissolve animation
    // that never settles for hit-testing.
    const firstClimbRow = page
      .getByRole('button')
      .filter({ has: page.locator('img[src^="blob:"]') })
      .first();
    await firstClimbRow.click({ force: true });
    await expect(page.getByRole('button', { name: 'Log ascent' })).toBeVisible({ timeout: WARM_TIMEOUT_MS });
  }

  /**
   * Play-drawer action buttons sit under a transparent react-native-gesture-
   * handler layer: real pointers reach them (the layer is pass-through), but
   * Playwright's hit-testing sees the overlay and never completes a default
   * click. force skips the hit-test while still requiring the visible, enabled
   * target we already asserted.
   */
  async function tapThroughGestureLayer(locator: ReturnType<Page['getByRole']>): Promise<void> {
    // force-clicks still deliver events to the overlay at that position, so
    // dispatch the click on the button element itself.
    await locator.dispatchEvent('click');
  }

  /**
   * Dismisses the presented sheet and waits for `stillVisible` to disappear.
   * gorhom's web backdrop and the Escape key each dismiss on their own, but
   * either can no-op if fired mid present-animation, so this alternates them
   * until the sheet is actually gone (killing a dismiss-timing flake).
   */
  async function dismissSheet(page: Page, stillVisible: ReturnType<Page['getByRole']>): Promise<void> {
    const backdrop = page.getByRole('button', { name: 'Bottom sheet backdrop' }).last();
    await expect(async () => {
      if (await backdrop.isVisible().catch(() => false)) {
        await backdrop.click({ force: true });
      }
      await page.keyboard.press('Escape');
      await expect(stillVisible).toBeHidden({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  }

  test('opens the play drawer from the feed and reaches the log-ascent sheet', async ({ page }) => {
    const fatalErrors = collectFatalConsoleErrors(page);
    await ensureSignedIn(page);
    await openPlayDrawerFromClimbsList(page);
    await tapThroughGestureLayer(page.getByRole('button', { name: 'Log ascent' }));

    // Log-ascent sheet: the save row ("Log attempt" outlined + "Log flash"/
    // "Log send" filled) proves the sheet presented; dismiss restores the
    // drawer.
    const saveTickButton = page.getByRole('button', { name: /Log (flash|send|attempt)/ }).first();
    await expect(saveTickButton).toBeVisible({ timeout: 15_000 });
    await dismissSheet(page, saveTickButton);
    expect(fatalErrors).toEqual([]);
  });

  test('queue sheet opens and dismisses from the play drawer', async ({ page }) => {
    const fatalErrors = collectFatalConsoleErrors(page);
    await ensureSignedIn(page);
    await openPlayDrawerFromClimbsList(page);

    const queueButton = page.getByRole('button', { name: /queue/i }).first();
    await expect(queueButton).toBeVisible({ timeout: WARM_TIMEOUT_MS });
    await tapThroughGestureLayer(queueButton);
    // The queue sheet hosts its list in a BottomSheetFlatList; its "Edit queue"
    // header action is unique to the presented sheet and proves the gorhom web
    // shim mounted it. Backdrop dismissal proves it closes.
    const editQueueButton = page.getByRole('button', { name: 'Edit queue' });
    await expect(editQueueButton).toBeVisible({ timeout: 15_000 });
    await dismissSheet(page, editQueueButton);
    expect(fatalErrors).toEqual([]);
  });

  test('deep route reloads through the /app proxy without losing the shell', async ({ page }) => {
    const fatalErrors = collectFatalConsoleErrors(page);
    await ensureSignedIn(page);
    await tabButton(page, 'Discover').click();
    await page.waitForURL(/\/app\//, { timeout: 15_000 });
    const deepPath = new URL(page.url()).pathname;
    await page.reload();
    await expect(tabButton(page, 'Profile')).toBeVisible({ timeout: WARM_TIMEOUT_MS });
    expect(new URL(page.url()).pathname).toBe(deepPath);
    expect(fatalErrors).toEqual([]);
  });

  test('/app responses carry the noindex header through the proxy', async ({ page }) => {
    const response = await page.goto('/app', { timeout: COLD_LOAD_TIMEOUT_MS });
    expect(response).not.toBeNull();
    expect(response?.headers()['x-robots-tag']).toContain('noindex');
  });
});
