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

import { devices, expect, test, type Page } from '@playwright/test';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getAuroraBluetoothPacket } from '@boardsesh/ble-protocol/aurora';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';
import type { Climb } from '@boardsesh/shared-schema';
import { CONSENT_VERSION } from '@boardsesh/consent';
import {
  boardClimbs,
  boardClimbStats,
  closePool,
  createDb,
  userAnalyticsConsentEvents,
  userBoards,
  users,
} from '@boardsesh/db';

test.describe.configure({ mode: 'serial' });

const TEST_EMAIL = process.env.TEST_USER_EMAIL ?? 'test@boardsesh.com';
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'test';

/** First navigation may include the on-demand Metro compile of the bundle. */
const COLD_LOAD_TIMEOUT_MS = 180_000;
const WARM_TIMEOUT_MS = 30_000;

/** The five Material tab-bar entries, in mobile's canonical order. */
const TAB_NAMES = ['Home', 'Climbs', 'Session', 'Discover', 'Profile'] as const;

/** The seeded shared board the suite binds through the board sheet (see e2e/SEED_CONTRACT.md). */
const SEEDED_BOARD_NAME = 'Dyno Den';

/** The seeded shared board the suite already binds through the board sheet. */
async function findSeededBoard() {
  process.env.DATABASE_URL ??= 'postgres://postgres:password@localhost:5432/main';
  const db = createDb();
  try {
    const [board] = await db
      .select({
        slug: userBoards.slug,
        layout: userBoards.layoutId,
        size: userBoards.sizeId,
        type: userBoards.boardType,
        hasLeds: userBoards.hasLeds,
      })
      .from(userBoards)
      .where(eq(userBoards.name, SEEDED_BOARD_NAME))
      .limit(1);
    if (!board) {
      throw new Error(
        `No board named "${SEEDED_BOARD_NAME}" in the e2e database — the dev DB image is stale ` +
          '(docker compose down -v && vp run db:up).',
      );
    }
    return board;
  } finally {
    await closePool();
  }
}

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
  // The suite seeds a "No thanks" on the account (see `seedAccountConsent`),
  // so the prompt should not open. This stays as the fallback for a stack
  // where the seed could not land.
  const declineAnalytics = page.getByRole('button', { name: 'No thanks', exact: true });
  await expect(declineAnalytics.or(homeTab).first()).toBeVisible({ timeout: WARM_TIMEOUT_MS });
  if (await declineAnalytics.isVisible()) await declineAnalytics.click();
  await expect(homeTab).toBeVisible({ timeout: WARM_TIMEOUT_MS });
}

/**
 * Gives the test account an analytics answer before any test signs in.
 *
 * With no answer on the account, the consent prompt opens as a transparent
 * modal over the tab shell up to ~10 s after Home renders (a 5 s wait for the
 * account read, then a region lookup capped at 5 s). A check made when Home
 * first shows misses it, and the late modal then hides or covers the tabs.
 * With a denial stored, the account read settles consent and nothing opens.
 */
async function seedAccountConsent(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgres://postgres:password@localhost:5432/main';
  const db = createDb();
  try {
    const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, TEST_EMAIL)).limit(1);
    if (!account) {
      throw new Error(
        `No user ${TEST_EMAIL} in the e2e database — the dev DB image is stale (docker compose down -v && vp run db:up).`,
      );
    }
    const [existing] = await db
      .select({ id: userAnalyticsConsentEvents.id })
      .from(userAnalyticsConsentEvents)
      .where(eq(userAnalyticsConsentEvents.userId, account.id))
      .limit(1);
    if (existing) return;
    await db
      .insert(userAnalyticsConsentEvents)
      .values({ userId: account.id, analytics: 'denied', version: CONSENT_VERSION, source: 'web' });
  } finally {
    await closePool();
  }
}

test.beforeAll(async () => {
  await seedAccountConsent();
});

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
    // The app opens on Climbs (`getAppEntryTab`), so the feed needs a tap.
    await tabButton(page, 'Home').click();
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
   * Binds one of the test user's seeded boards via the board sheet so the
   * Climbs tab has a list and play-drawer actions aren't blocked by the
   * switch-board overlay (feed climbs live on other boards). Fresh contexts
   * start unbound. The sheet lists the account's boards under "Your boards";
   * which boards the seed image puts there can vary, so this takes
   * the first one rather than naming it.
   */
  async function bindSeededBoard(page: Page): Promise<void> {
    await tabButton(page, 'Climbs').click();
    const findBoardButton = page.getByRole('button', { name: 'Find my board' });
    const boundThumbnail = page.getByTestId('climb-list').locator('img[src^="blob:"]').first();
    // The Climbs tab settles into one of two determinate states: the follow-
    // your-wall empty state (fresh context) or a populated list (already bound).
    // Wait for whichever appears so the bind decision below isn't racing an
    // unrendered UI — an immediate `isVisible()` could read false mid-mount and
    // silently skip binding.
    await expect(findBoardButton.or(boundThumbnail).first()).toBeVisible({ timeout: WARM_TIMEOUT_MS });
    if (await findBoardButton.isVisible()) {
      await findBoardButton.click({ force: true });
      // Board rows contain artwork; their separate action menus and the
      // collapsed list's "Show all" button do not. Keep the pick inside the
      // saved-board list so nearby boards cannot satisfy it.
      const savedBoard = page
        .getByTestId('picker-your-boards')
        .getByRole('button')
        .filter({ has: page.locator('img') })
        .first();
      await savedBoard.click({ force: true });
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
    await expect(page.getByRole('button', { name: 'Log ascent' }).first()).toBeVisible({ timeout: WARM_TIMEOUT_MS });
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

  async function checkBrowserDriving(page: Page, input: 'mouse' | 'touch'): Promise<void> {
    const packets: number[][] = [];
    const pendingBytes: number[] = [];
    await page.exposeFunction('captureBoardWrite', (chunk: number[]) => {
      pendingBytes.push(...chunk);
      // A GATT write can carry part of an Aurora frame. Its length byte counts
      // the body only, leaving five framing bytes to wait for.
      while (pendingBytes.length >= 2 && pendingBytes.length >= pendingBytes[1] + 5) {
        const packet = pendingBytes.splice(0, pendingBytes[1] + 5);
        if (packet[1] > 1) packets.push(packet);
      }
    });
    await page.addInitScript(() => {
      const characteristic = {
        writeValueWithoutResponse: (bytes: Uint8Array) =>
          (window as unknown as { captureBoardWrite: (chunk: number[]) => Promise<void> }).captureBoardWrite(
            Array.from(bytes),
          ),
      };
      const gatt = {
        connected: false,
        async connect() {
          this.connected = true;
          return this;
        },
        disconnect() {
          this.connected = false;
        },
        async getPrimaryService() {
          return { getCharacteristic: async () => characteristic };
        },
      };
      const device = Object.assign(new EventTarget(), { id: 'test-kilter', name: 'Kilter Board#12345@3', gatt });
      Object.defineProperty(navigator, 'bluetooth', {
        configurable: true,
        value: { requestDevice: async () => device },
      });
    });
    await ensureSignedIn(page);
    // The web smoke runs --no-dev and declines analytics. Pin the rollout in
    // this fresh browser's existing device preferences before reloading it.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('boardsesh-mobile-web');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction('entries', 'readwrite');
            transaction
              .objectStore('entries')
              .put(JSON.stringify({ 'wall-swipe-to-drive': true }), 'featureFlagOverrides');
            transaction.oncomplete = () => {
              db.close();
              resolve();
            };
            transaction.onabort = () => {
              db.close();
              reject(transaction.error);
            };
          };
        }),
    );
    const boardFixture = await findSeededBoard();
    expect(boardFixture.type).toBe('kilter');
    expect(boardFixture.hasLeds).toBe(true);
    const positions = getLedPlacements('kilter', Number(boardFixture.layout), Number(boardFixture.size));
    // Take three real single-frame climbs the fixture board can light. Pin their
    // order so a change in the account's feed cannot change the swipe target.
    type FixtureClimb = { climb: Climb; packet: number[] };
    const fixture: FixtureClimb[] = [];
    await page.route('**/graphql', async (route) => {
      if (
        route.request().method() !== 'POST' ||
        !/\bquery SearchClimbs\b/.test(route.request().postDataJSON().query ?? '')
      ) {
        return route.fallback();
      }
      if (!fixture.length) {
        const response = await route.fetch();
        const { data } = (await response.json()) as { data: { searchClimbs: { climbs: Climb[] } } };
        for (const climb of data.searchClimbs.climbs.toSorted((left, right) => left.uuid.localeCompare(right.uuid))) {
          if ((climb.framesCount ?? 1) !== 1 || !climb.frames) continue;
          const { packet, ledsWritten } = getAuroraBluetoothPacket(climb.frames, positions, 'kilter', 3);
          // This test compares one complete, non-clear Aurora packet per climb.
          if (!ledsWritten || packet.length !== packet[1] + 5) continue;
          const bytes = Array.from(packet);
          if (fixture.some((entry) => entry.climb.name === climb.name || entry.packet.join() === bytes.join()))
            continue;
          fixture.push({ climb, packet: bytes });
          if (fixture.length === 3) break;
        }
      }
      await route.fulfill({
        json: { data: { searchClimbs: { climbs: fixture.map(({ climb }) => climb), hasMore: false } } },
      });
    });
    await page.goto(`/app/b/${boardFixture.slug}/40/list`);
    const list = page.getByTestId('climb-list');
    await expect(list.locator('img[src^="blob:"]').first()).toBeVisible({ timeout: 60_000 });
    expect(fixture, 'three different single-frame climbs on the seeded Kilter board').toHaveLength(3);
    const [first, second, third] = fixture;
    await list.getByRole('button').filter({ hasText: first.climb.name }).first().click({ force: true });
    const control = page.getByTestId('play-drawer-wall-control');
    const selectedHeader = page.getByTestId('play-drawer-header-accessibility');
    await expect.poll(() => selectedHeader.getAttribute('aria-label')).toContain(first.climb.name);
    await tapThroughGestureLayer(control);
    await expect(control).toHaveAccessibleName(/You are driving the wall/i, { timeout: WARM_TIMEOUT_MS });
    await expect.poll(() => packets.at(-1)).toEqual(first.packet);
    const firstLabel = await selectedHeader.getAttribute('aria-label');
    if (!firstLabel) throw new Error('The selected climb has no header');
    const board = page.getByTestId('play-drawer-board-container');
    if (input === 'mouse') expect(new URL(page.url()).pathname).toBe('/app/climbs');
    const touch = input === 'touch' ? await page.context().newCDPSession(page) : null;
    async function swipe(direction: 1 | -1): Promise<void> {
      const box = await board.boundingBox();
      if (!box) throw new Error('The player board has no hit area');
      const y = box.y + box.height / 2;
      const start = box.x + box.width * (direction === 1 ? 0.8 : 0.2);
      if (!touch) {
        await page.mouse.move(start, y);
        await page.mouse.down();
        await page.mouse.move(start - direction * 0.6 * box.width, y, { steps: 12 });
        await page.mouse.up();
        return;
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] });
      for (let step = 1; step <= 8; step++) {
        const x = start - (direction * box.width * 0.6 * step) / 8;
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    async function swipeWhileDriving(direction: 1 | -1, expected: FixtureClimb): Promise<void> {
      const before = packets.length;
      await swipe(direction);
      await expect.poll(() => selectedHeader.getAttribute('aria-label')).toContain(expected.climb.name);
      await expect.poll(() => packets.slice(before).at(-1)).toEqual(expected.packet);
      await expect(control).toHaveAccessibleName(/You are driving the wall/i);
    }
    await swipeWhileDriving(1, second);
    await swipeWhileDriving(-1, first);
    await expect(selectedHeader).toHaveAttribute('aria-label', firstLabel);
    // The web fallback paints the climb's holds as CSS radial gradients.
    await expect(control.getByTestId('wall-glow-blobs').locator(':scope > div').first()).toHaveCSS(
      'background-image',
      /radial-gradient/,
    );
    // A connected browser can stop driving and preview a different list climb.
    // Put that preview up, then let the confirmation settle before swiping.
    await tapThroughGestureLayer(control);
    await expect(control).not.toHaveAccessibleName(/You are driving the wall/i);
    const beforePreview = packets.length;
    await swipe(1);
    await expect.poll(() => selectedHeader.getAttribute('aria-label')).toContain(second.climb.name);
    await expect(control).toHaveAccessibleName(/Put on board/i);
    // Leave the preview dark through the wall control's 600 ms double-tap guard.
    await page.waitForTimeout(650);
    expect(packets).toHaveLength(beforePreview);
    await tapThroughGestureLayer(control);
    await expect.poll(() => packets.slice(beforePreview).at(-1)).toEqual(second.packet);
    await expect(control).toHaveAccessibleName(/You are driving the wall/i);
    await expect(control).toContainText(/0:(?:39|40)/, { timeout: 12_000 });
    await swipeWhileDriving(1, third);
    await expect(control).toContainText(/0:4[3-5]/);
    await swipeWhileDriving(-1, second);
  }

  test('a browser driving the wall lights the next climb on swipe and restores the first on swipe back', async ({
    page,
  }) => {
    await checkBrowserDriving(page, 'touch');
  });

  test.describe('desktop board driving', () => {
    test.use({
      userAgent: devices['Desktop Chrome'].userAgent,
      viewport: { width: 1440, height: 900 },
      contextOptions: { screen: { width: 1440, height: 900 } },
      hasTouch: false,
      isMobile: false,
    });

    test('dragging the board in the desktop pane lights each selected climb', async ({ page }) => {
      await checkBrowserDriving(page, 'mouse');
    });
  });

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
        // The center of a full-screen backdrop meets the 50% queue sheet's
        // top edge on desktop. Click its exposed corner with real hit testing
        // so the pointer reaches the backdrop rather than the sheet above it.
        await backdrop.click({ position: { x: 10, y: 10 }, timeout: 2_000 });
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
    const saveTickButton = page.getByRole('button', { name: /Log (flash|send|attempt)/i }).first();
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
    // The history toggle belongs to the presented queue sheet, including when
    // the queue is empty and correctly has no editing actions. Its visibility
    // and dismissal prove the gorhom web shim opened and closed the sheet.
    const historyToggle = page.getByRole('button', { name: 'Toggle history', exact: true });
    await expect(historyToggle).toBeVisible({ timeout: 15_000 });
    await dismissSheet(page, historyToggle);
    expect(fatalErrors).toEqual([]);
  });

  /**
   * Regression for a touch-only scroll deadlock: react-native-gesture-handler's
   * web `GestureDetector` defaults its DOM node to `touch-action: none` unless a
   * `touchAction` prop is passed, which blocks the browser's native touch-scroll
   * for any drag starting on that node — independent of the gesture's own
   * activeOffsetX/failOffsetY (those only gate the JS recognizer, which the
   * browser never consults once it has decided not to hand a touch to it).
   * Mouse-wheel scrolling never goes through this path, so it worked even while
   * touch scrolling was fully dead. Real hardware-originated touch input is
   * required to exercise the browser's touch-action gating — a JS-dispatched
   * synthetic TouchEvent bypasses it — so this drives touches through the CDP
   * Input domain rather than `element.dispatchEvent`.
   */
  test('touch-drag scrolls the climbs list', async ({ page, context }) => {
    const fatalErrors = collectFatalConsoleErrors(page);
    await ensureSignedIn(page);

    // Bind a board so the Climbs tab renders a long enough list to scroll.
    await bindSeededBoard(page);

    const list = page.getByTestId('climb-list');
    await expect(list).toBeVisible({ timeout: WARM_TIMEOUT_MS });
    const box = await list.boundingBox();
    if (!box) throw new Error('climb-list has no bounding box');

    const scrollTopBefore = await list.evaluate((element) => element.scrollTop);

    const cdpSession = await context.newCDPSession(page);
    const centerX = box.x + box.width / 2;
    const dragStartY = box.y + box.height * 0.85;
    const dragEndY = box.y + box.height * 0.15;
    // A late RNGH config update used to reset the swipeable host to `none`.
    // Check the browser's actual hit path so a failure identifies that policy
    // regression; the CDP drag and scroll-distance assertion below still decide
    // whether touch scrolling works.
    await expect
      .poll(() =>
        page.evaluate(
          ({ x, y }) => {
            const policies: string[] = [];
            for (let element = document.elementFromPoint(x, y); element; element = element.parentElement) {
              policies.push(getComputedStyle(element).touchAction);
              if (element.getAttribute('data-testid') === 'climb-list') break;
            }
            return policies.filter((policy) => policy === 'none' || policy === 'pan-x');
          },
          { x: centerX, y: dragStartY },
        ),
      )
      .toEqual([]);
    const dragSteps = 10;
    await cdpSession.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: centerX, y: dragStartY }],
    });
    for (let step = 1; step <= dragSteps; step += 1) {
      const y = dragStartY + (dragEndY - dragStartY) * (step / dragSteps);
      await cdpSession.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: centerX, y }],
      });
      // Deliberate fixed delay, not a replaceable `expect.poll`: this paces the
      // synthetic touchmove stream at roughly one frame apart (~60fps) so the
      // browser's real touch-scroll physics sees a plausible drag rather than a
      // burst of same-tick moves.
      await page.waitForTimeout(16);
    }
    await cdpSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect
      .poll(() => list.evaluate((element) => element.scrollTop), { timeout: 5_000 })
      .toBeGreaterThan(scrollTopBefore + 10);
    expect(fatalErrors).toEqual([]);
  });

  test.describe('desktop adaptive shell', () => {
    test('uses the tablet rail and keeps default play actions and deferred sections in the detail pane', async ({
      browser,
    }, testInfo) => {
      // `screen` is a browser-context option rather than a per-test fixture.
      // Create the context here so Dimensions.get('screen') sees desktop
      // eligibility before the Expo bundle evaluates.
      const context = await browser.newContext({
        baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000',
        // A bare context sends Playwright's default `HeadlessChrome` UA, which
        // the crawler policy refuses in a production build.
        userAgent: devices['Desktop Chrome'].userAgent,
        viewport: { width: 1440, height: 900 },
        screen: { width: 1440, height: 900 },
        isMobile: false,
        hasTouch: false,
        // A fresh web install must start dark even when the browser prefers light.
        colorScheme: 'light',
      });
      const page = await context.newPage();
      const fatalErrors = collectFatalConsoleErrors(page);

      try {
        await ensureSignedIn(page);

        await expect
          .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
          .toBe('dark');
        await expect
          .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
          // Material uses the canonical Graphite page background (#0E0E0E).
          .toBe('rgb(14, 14, 14)');

        // Desktop uses the same destinations in a rail; Wall display is a
        // separate full-screen route, not a sixth tab.
        for (const tabName of TAB_NAMES) {
          await expect(page.getByRole('tab', { name: tabName, exact: true })).toBeVisible();
        }

        await openPlayDrawerFromClimbsList(page);
        expect(new URL(page.url()).pathname).not.toContain('/play');

        const playPane = page.getByTestId('desktop-play-pane');
        const miniPlayer = page.getByTestId('persistent-mini-player');
        await expect(miniPlayer).toBeVisible();

        // Mouse browsers show transport controls by default (#7963). These
        // occupy the slots that phones use for Favorite and Share; optional
        // actions remain available through the menus.
        for (const actionName of ['Log ascent', 'Choose Angle', 'Previous climb', 'Next climb']) {
          await expect(playPane.getByRole('button', { name: actionName, exact: true })).toBeVisible();
        }
        const wallControl = playPane.getByTestId('play-drawer-wall-control');
        await expect(wallControl).toBeVisible();
        await expect(wallControl).toHaveRole('button');
        await expect(wallControl).toHaveAccessibleName(/\S/);
        const queueButton = playPane.getByRole('button', { name: /^Queue, (nothing up next|\d+ climbs?( up next)?)$/ });
        await expect(queueButton).toBeVisible();

        const logAscentButton = playPane.getByRole('button', { name: 'Log ascent', exact: true });
        await tapThroughGestureLayer(logAscentButton);
        const saveTickButton = page.getByRole('button', { name: /Log (flash|send|attempt)/i }).first();
        await expect(saveTickButton).toBeVisible({ timeout: 15_000 });
        await dismissSheet(page, saveTickButton);

        await tapThroughGestureLayer(queueButton);
        const historyToggle = page.getByRole('button', { name: 'Toggle history', exact: true });
        await expect(historyToggle).toBeVisible({ timeout: 15_000 });
        await dismissSheet(page, historyToggle);

        // Desktop wheel/trackpad scrolling does not emit RN's begin-drag event.
        // Scrolling over the pane must still open the deferred-content gate.
        await logAscentButton.hover({ force: true });
        await page.mouse.wheel(0, 1200);

        for (const sectionName of ['Logbook', 'Beta Videos', 'Community', 'Similar Climbs']) {
          await expect(playPane.getByText(sectionName, { exact: true }).first()).toBeVisible({
            timeout: WARM_TIMEOUT_MS,
          });
        }
        // Profile must retain queue access without finding an action in the pane.
        // These use real mouse hit testing: dispatchEvent would miss an overlay
        // swallowing the new bar's controls.
        await tabButton(page, 'Profile').click();
        await expect(miniPlayer).toBeVisible();
        await miniPlayer.getByRole('button', { name: /^More actions for / }).click();
        await page.getByRole('menuitem', { name: 'Open the queue', exact: true }).click();
        await expect(historyToggle).toBeVisible({ timeout: 15_000 });
        await dismissSheet(page, historyToggle);
        await expect(page).toHaveURL(/\/profile(?:[/?#]|$)/);
        await expect(playPane).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('desktop-profile-mini-player.png') });

        // Start compact so the measured bottom-tab height is cached, then cross
        // both the rail and detail-pane boundaries on the same browser screen.
        for (const width of [699, 700, 815, 816, 1176, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await expect(miniPlayer).toHaveCount(1);
          await expect(miniPlayer).toBeVisible();
          await expect(playPane).toHaveCount(width >= 816 ? 1 : 0);
          if (width >= 700) {
            await expect.poll(async () => Math.round((await miniPlayer.boundingBox())?.x ?? -1)).toBe(104);
            await expect
              .poll(async () => {
                const bounds = await miniPlayer.boundingBox();
                return bounds ? Math.round(bounds.y + bounds.height) : -1;
              })
              .toBe(900);
          }
        }
        expect(fatalErrors).toEqual([]);
      } finally {
        await context.close();
      }
    });
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

  // The canonical board URLs the Next app hands out, served by the SPA. Every
  // one of these is a *cold* navigation: a full page load restores the session
  // asynchronously, so board resolution has to wait for it or it reads
  // "signed out", skips the owned-board reuse, and mints a duplicate of a board
  // the user already has. Unit tests can only mock that transition — this is
  // the flow against a real session round-trip.
  test.describe('canonical board URLs', () => {
    // The seeded default test board (see e2e/SEED_CONTRACT.md), in both the
    // named-slug form the app emits and the numeric-id form.
    const BOARD_SLUG_PATH = 'kilter/original/12x12-square/screw_bolt/40';
    const BOARD_TUPLE_PATH = 'kilter/1/10/1,20/40';
    const SEEDED_BOARD = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20], angle: 40 } as const;

    /**
     * A climb that really is listed on the seeded board at this angle. Picked
     * by lowest uuid among the matching climbs, so the URL under test is
     * deterministic per dev-DB image without pinning a uuid the image is free
     * to drop.
     */
    async function findSeededClimbUuid(): Promise<string> {
      process.env.DATABASE_URL ??= 'postgres://postgres:password@localhost:5432/main';
      const db = createDb();
      try {
        const setIdLiterals = sql.join(
          SEEDED_BOARD.setIds.map((setId) => sql`${setId}`),
          sql`, `,
        );
        const [climb] = await db
          .select({ uuid: boardClimbs.uuid })
          .from(boardClimbs)
          .innerJoin(
            boardClimbStats,
            and(eq(boardClimbs.uuid, boardClimbStats.climbUuid), eq(boardClimbs.boardType, boardClimbStats.boardType)),
          )
          .where(
            and(
              eq(boardClimbs.boardType, SEEDED_BOARD.boardType),
              eq(boardClimbs.layoutId, SEEDED_BOARD.layoutId),
              eq(boardClimbs.isListed, true),
              eq(boardClimbs.isDraft, false),
              eq(boardClimbStats.angle, SEEDED_BOARD.angle),
              sql`${SEEDED_BOARD.sizeId} = ANY(${boardClimbs.compatibleSizeIds})`,
              sql`${boardClimbs.requiredSetIds} <@ ARRAY[${setIdLiterals}]::int[]`,
            ),
          )
          .orderBy(asc(boardClimbs.uuid))
          .limit(1);
        if (!climb) {
          throw new Error(
            'No listed Kilter original 12x12 screw/bolt climb with stats at 40 degrees in the e2e database — ' +
              'the dev DB image is stale (docker compose down -v && vp run db:up).',
          );
        }
        return climb.uuid;
      } finally {
        await closePool();
      }
    }

    let seededClimbUuid = '';
    let seededBoardSlug = '';

    test.beforeAll(async () => {
      seededClimbUuid = await findSeededClimbUuid();
      seededBoardSlug = (await findSeededBoard()).slug;
    });

    /** The board's climbs, whichever board is active, render WASM thumbnails. */
    function climbThumbnails(page: Page) {
      return page.locator('img[src^="blob:"]');
    }

    test('a cold list URL adopts its board and lands on the climbs tab', async ({ page }) => {
      const fatalErrors = collectFatalConsoleErrors(page);
      await ensureSignedIn(page);

      await page.goto(`/app/${BOARD_SLUG_PATH}/list`, { timeout: COLD_LOAD_TIMEOUT_MS });

      await expect(tabButton(page, 'Climbs')).toBeVisible({ timeout: COLD_LOAD_TIMEOUT_MS });
      // The board resolved and was adopted: its climbs render. A not-found
      // (the failure mode when resolution races the session) never gets here.
      await expect(climbThumbnails(page).first()).toBeVisible({ timeout: 60_000 });
      expect(fatalErrors).toEqual([]);
    });

    test('a cold climb URL opens the play drawer as a preview, and survives a hard refresh', async ({ page }) => {
      const fatalErrors = collectFatalConsoleErrors(page);
      await ensureSignedIn(page);

      const climbUrl = `/app/${BOARD_TUPLE_PATH}/view/${seededClimbUuid}`;
      await page.goto(climbUrl, { timeout: COLD_LOAD_TIMEOUT_MS });

      // preview:true — a deep link must not take over the queue's current climb,
      // which in a party session is everyone's climb.
      await expect(page.getByRole('button', { name: 'Log ascent' })).toBeVisible({ timeout: COLD_LOAD_TIMEOUT_MS });
      await expect(page.getByRole('button', { name: 'Put on board', exact: true })).toBeVisible({
        timeout: WARM_TIMEOUT_MS,
      });

      // Second cold load of the same URL — a `reload()` would not do it, since
      // handing off rewrites the address bar to the drawer's own route. This is
      // the run that matters: the board is owned by now, so a resolve that
      // starts before the session settles mints a duplicate instead of reusing
      // it, and the create is rejected → "not found" on a URL that just worked.
      await page.goto(climbUrl, { timeout: COLD_LOAD_TIMEOUT_MS });
      await expect(page.getByRole('button', { name: 'Log ascent' })).toBeVisible({ timeout: COLD_LOAD_TIMEOUT_MS });
      expect(fatalErrors).toEqual([]);
    });

    // `/b/{slug}` is the other URL family, and a different resolution path: the
    // board is a server entity fetched by slug, not a config tuple, so nothing
    // is minted and no owned-board list is read.
    test('a cold /b/{slug} URL adopts the board it names', async ({ page }) => {
      const fatalErrors = collectFatalConsoleErrors(page);
      await ensureSignedIn(page);

      await page.goto(`/app/b/${seededBoardSlug}/40/list`, { timeout: COLD_LOAD_TIMEOUT_MS });

      await expect(tabButton(page, 'Climbs')).toBeVisible({ timeout: COLD_LOAD_TIMEOUT_MS });
      await expect(climbThumbnails(page).first()).toBeVisible({ timeout: 60_000 });
      expect(fatalErrors).toEqual([]);
    });

    test('the named-slug climb URL resolves the same climb as the numeric one', async ({ page }) => {
      const fatalErrors = collectFatalConsoleErrors(page);
      await ensureSignedIn(page);

      await page.goto(`/app/${BOARD_SLUG_PATH}/view/${seededClimbUuid}`, { timeout: COLD_LOAD_TIMEOUT_MS });

      await expect(page.getByRole('button', { name: 'Log ascent' })).toBeVisible({ timeout: COLD_LOAD_TIMEOUT_MS });
      expect(fatalErrors).toEqual([]);
    });
  });
});
