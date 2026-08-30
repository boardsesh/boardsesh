/**
 * Layout Screenshot Tests
 *
 * Captures screenshots of every unique board layout Boardsesh supports.
 * For each layout we:
 *   1. Navigate to the climb list front door (biggest available board size,
 *      default sets, 40°)
 *   2. Screenshot the climb list
 *   3. Follow the first row's anchor to that climb's front door
 *   4. Screenshot the climb front door
 *
 * Step 3 used to tap the thumbnail to open the play-view drawer. W-15 (#4369)
 * replaced both surfaces with server-rendered front doors, so there is no
 * drawer to open — and the front door is a better board-art source anyway: it
 * paints the full-resolution overlay rather than the drawer's scaled render.
 *
 * Screenshots are saved to e2e/screenshots/layouts/.
 *
 * Run:
 *   bunx playwright test e2e/layout-screenshots.spec.ts
 *
 * Prerequisites:
 *   - Dev server running (or use `bun run test:e2e:setup` first)
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { mkdirSync } from 'fs';
import { waitForBoardListReady } from './helpers/waits';

const SCREENSHOT_DIR = path.resolve(__dirname, 'screenshots/layouts');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Viewport/device settings come from the layout-screenshots project in
// playwright.config.ts (iPhone 16 Pro Max, 440×956 @ 3×).

/**
 * One entry per unique board layout.
 * URLs use numeric IDs (layout_id/size_id/set_ids) — the app accepts both
 * numeric and slug-based routes via hasOnlyNumericBoardRouteSegments().
 *
 * Size chosen is the largest physical board for each layout:
 *   kilter  layout 1  → size 28  "16 x 12 Super Wide"      sets 1,20  (Bolt Ons, Screw Ons)
 *   kilter  layout 8  → size 25  "10x12 Full Ride LED Kit"  sets 26,27,28,29
 *   tension layout 9  → size 1   "Full Wall"                sets 8,9,10,11
 *   tension layout 10 → size 6   "12 high x 12 wide"        sets 12,13  (Wood, Plastic)
 *   tension layout 11 → size 6   "12 high x 12 wide"        sets 12,13  (Wood, Plastic)
 */
const LAYOUTS = [
  {
    name: 'kilter-original',
    label: 'Kilter Board Original',
    url: '/kilter/1/28/1,20/40/list',
  },
  {
    name: 'kilter-homewall',
    label: 'Kilter Board Homewall',
    url: '/kilter/8/25/26,27,28,29/40/list',
  },
  {
    name: 'tension-original',
    label: 'Tension Original Layout',
    url: '/tension/9/1/8,9,10,11/40/list',
  },
  {
    name: 'tension-two-mirror',
    label: 'Tension Board 2 Mirror',
    url: '/tension/10/6/12,13/40/list',
  },
  {
    name: 'tension-two-spray',
    label: 'Tension Board 2 Spray',
    url: '/tension/11/6/12,13/40/list',
  },
] as const;

test.describe('Layout Screenshots', () => {
  // Run layouts one-at-a-time so heavy board-image loads don't pile up
  // on the dev server (and so any single layout's failure doesn't poison
  // the next via shared test-server state).
  test.describe.configure({ mode: 'serial' });

  // Board image assets can be large — give each test plenty of headroom
  test.setTimeout(90_000);

  for (const layout of LAYOUTS) {
    test(`${layout.label}`, async ({ page }) => {
      // ── 1. Navigate to the climb list front door ───────────────────────────
      await page.goto(layout.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Wait for the first climb row to render (board image assets may be slow)
      await waitForBoardListReady(page, 60_000);

      // ── 2. Screenshot: climb list ───────────────────────────────────────────
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/${layout.name}-01-climb-list.png`,
      });

      // ── 3. Follow the first row's anchor to the climb front door ───────────
      // Real navigation, not a drawer: the list rows are `<a href>` to the
      // canonical view URL, which is the whole point of the SSR list.
      const firstClimbLink = page.locator('a[href*="/view/"]').first();
      await firstClimbLink.waitFor({ state: 'visible', timeout: 15_000 });
      await firstClimbLink.click();
      await page.waitForURL(/\/view\//, { timeout: 30_000 });

      // ── 4. Wait for the front door's board render ──────────────────────────
      // The overlay `<img>` is the page's LCP element and the board art this
      // gallery exists to catch regressions in.
      const boardImage = page.locator('img[src*="/render/board"], img[src*="/api/internal/board-render"]').first();
      await boardImage.waitFor({ state: 'visible', timeout: 30_000 });
      await expect(page.locator('h1')).toBeVisible();

      // ── 5. Screenshot: climb front door ────────────────────────────────────
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/${layout.name}-02-climb-front-door.png`,
      });
    });
  }
});
