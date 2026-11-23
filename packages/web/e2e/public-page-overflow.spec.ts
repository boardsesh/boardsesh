import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  auditPublicPage,
  hasReadableTargetText,
  hasVisibleFocusOutline,
  readableContrastFailures,
  waitForSeededSetter,
} from './helpers/public-page-a11y';

test.use({
  viewport: { width: 390, height: 664 },
  ignoreHTTPSErrors: process.env.PLAYWRIGHT_TEST_BASE_URL?.startsWith('https://localhost:') ?? false,
});

test.beforeEach(async ({ page }) => {
  // Local development tools can cover the footer language control; they do not ship.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const developmentToolsStyle = document.createElement('style');
      developmentToolsStyle.textContent = 'nextjs-portal, [data-translation-editor] { display: none !important; }';
      document.head.appendChild(developmentToolsStyle);
    });
  });
});

const PUBLIC_PAGES = [
  '/',
  '/boards',
  '/spraywalls',
  '/spraywalls/find',
  '/for-gyms',
  '/about',
  '/support',
  '/legal',
  '/privacy',
  '/docs',
  '/bring-your-logbook',
  '/gyms',
  '/playlists',
  '/auth/login',
  '/help',
  '/help/finding-climbs',
  '/help/board-and-bluetooth',
  '/help/spray-walls',
  '/help/logbook',
  '/help/sessions',
];

for (const pathname of PUBLIC_PAGES) {
  test(`public page fits a 390px phone: ${pathname}`, async ({ page }) => {
    const response = await page.goto(pathname, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator('main h1').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}

test('browser audit identifies poor contrast, small targets and unresolved gradients', async ({ page }) => {
  await page.setContent(`
    <style>
      a { color: inherit; }
      #unresolved-hover:hover { background-image: linear-gradient(black, white); }
    </style>
    <main style="background: black; color: white">
      <h1>Clear heading</h1>
      <div style="background: rgba(255, 255, 255, 0.5)"><p>Translucent background</p></div>
      <p style="color: rgba(255, 255, 255, 0.4)">Translucent foreground</p>
      <p style="background: linear-gradient(black, white)">Unresolved gradient</p>
      <a href="/fixture" style="display: inline-flex; width: 32px; height: 32px">X</a>
      <button disabled style="background: black; color: #333"><span>Inactive label</span></button>
      <button style="background: black; color: #333"><span>Enabled label</span></button>
      <p style="color: #333">Adjacent metadata</p>
      <span aria-disabled="true" style="color: #333">Aria-disabled text</span>
      <button id="unresolved-hover" style="background-color: black; color: white">Unresolved hover</button>
      <a href="#visible" style="outline: 2px solid white; outline-offset: 2px">Visible outline</a>
      <a href="#transparent" style="outline: 2px solid transparent; outline-offset: 2px">Transparent outline</a>
      <a href="#faint" style="outline: 2px solid rgba(255, 255, 255, 0.1); outline-offset: 2px">Faint outline</a>
      <a href="#invisible" style="outline: 2px solid white; outline-offset: 2px; opacity: 0">Invisible outline</a>
      <div style="overflow: hidden; width: 48px; height: 48px"><a href="#clipped" style="display: block; width: 48px; height: 48px; outline: 2px solid white">Clipped outline</a></div>
      <div style="overflow: hidden; width: 48px; height: 48px; padding: 4px"><a href="#padded" style="display: block; width: 48px; height: 48px; outline: 2px solid white">Padded outline</a></div>
    </main>
  `);
  const audit = await auditPublicPage(page);
  expect(audit.text.find((entry) => entry.label === 'Clear heading')?.ratio).toBe(21);
  for (const label of ['Translucent background', 'Translucent foreground']) {
    const measured = audit.text.find((entry) => entry.label === label);
    expect(measured?.ratio).toBeGreaterThan(3.5);
    expect(measured?.ratio).toBeLessThan(4.1);
  }
  expect(audit.text.find((entry) => entry.label === 'Unresolved gradient')).toMatchObject({
    ratio: null,
    unresolved: 'background image or gradient',
  });
  expect(audit.targets.find((target) => target.href === '/fixture')).toMatchObject({ width: 32, height: 32 });
  expect(audit.text.find((entry) => entry.label === 'Inactive label')).toMatchObject({ inactive: true });
  expect(audit.text.find((entry) => entry.label === 'Inactive label')?.ratio).toBeLessThan(4.5);
  expect(readableContrastFailures(audit).map((entry) => entry.label)).toEqual([
    'Translucent background',
    'Translucent foreground',
    'Enabled label',
    'Adjacent metadata',
    'Aria-disabled text',
  ]);
  expect(hasReadableTargetText(await auditPublicPage(page, page.getByRole('button', { name: 'Enabled label' })))).toBe(
    false,
  );

  const unresolvedHover = page.getByRole('button', { name: 'Unresolved hover', exact: true });
  expect(hasReadableTargetText(await auditPublicPage(page, unresolvedHover))).toBe(true);
  await unresolvedHover.hover();
  const hoveredAudit = await auditPublicPage(page, unresolvedHover);
  expect(hoveredAudit.targetText).toHaveLength(1);
  expect(hoveredAudit.targetText[0]).toMatchObject({ ratio: null, unresolved: 'background image or gradient' });
  expect(hasReadableTargetText(hoveredAudit)).toBe(false);

  for (const [label, visible] of [
    ['Visible outline', true],
    ['Transparent outline', false],
    ['Faint outline', false],
    ['Invisible outline', false],
    ['Clipped outline', false],
    ['Padded outline', true],
  ] as const) {
    const focusTarget = page.getByRole('link', { name: label, exact: true });
    await focusTarget.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(focusTarget).toBeFocused();
    const focusAudit = await auditPublicPage(page, focusTarget);
    expect(focusAudit.focusOutline?.visible).toBe(label !== 'Invisible outline');
    if (label === 'Faint outline') {
      expect(focusAudit.focusOutline?.alpha).toBeGreaterThan(0);
      expect(focusAudit.focusOutline?.ratio).toBeLessThan(3);
    }
    expect(hasVisibleFocusOutline(focusAudit), JSON.stringify(focusAudit.focusOutline)).toBe(visible);
  }
});

async function expectPublicReading(page: Page, testInfo: TestInfo, label: string, target?: Locator) {
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.locator('main h1')).toBeVisible();
  const audit = await auditPublicPage(page, target);
  await testInfo.attach(`${label}-${audit.width}px-a11y.json`, {
    body: JSON.stringify(audit, null, 2),
    contentType: 'application/json',
  });
  expect(audit.overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(1);
  const resolvedText = audit.text.filter((entry) => !entry.inactive && entry.ratio !== null);
  expect(resolvedText.length, `${label}: measured readable text`).toBeGreaterThan(0);
  expect(
    readableContrastFailures(audit),
    `${label}: text contrast below 4.5:1; image/gradient cases remain unresolved in the attachment`,
  ).toEqual([]);
  expect(
    audit.targets.filter((target) => !target.disabled && (target.width < 44 || target.height < 44)),
    `${label}: enabled content, chrome and opened-menu targets below 44×44px`,
  ).toEqual([]);
  return audit;
}

/** The hovered label of a violet text action (#B6AFFF) and of a grey outlined secondary (#EDEDED). */
const TEXT_ACTION_HOVER_INK = 'rgb(182, 175, 255)';
const SECONDARY_HOVER_INK = 'rgb(237, 237, 237)';

/** A text or outlined button: the button state layer on hover, and its label still readable. */
async function expectReadableButtonHover(
  page: Page,
  testInfo: TestInfo,
  target: Locator,
  label: string,
  hoverInk: typeof TEXT_ACTION_HOVER_INK | typeof SECONDARY_HOVER_INK,
) {
  await target.hover();
  await expect(target).toHaveCSS('color', hoverInk);
  await expect(target).toHaveCSS('background-color', 'rgba(237, 237, 237, 0.08)');
  const audit = await expectPublicReading(page, testInfo, label, target);
  expect(
    hasReadableTargetText(audit),
    `${label}: the hovered label must resolve at 4.5:1 or better; ${JSON.stringify(audit.targetText)}`,
  ).toBe(true);
  await page.mouse.move(0, 0);
}

/** A filled brand button keeps its own fill on hover; only its label's contrast is held to 4.5:1. */
async function expectReadableFilledHover(page: Page, testInfo: TestInfo, target: Locator, label: string) {
  await expect(target).toHaveCount(1);
  await target.hover();
  const audit = await expectPublicReading(page, testInfo, label, target);
  expect(
    hasReadableTargetText(audit),
    `${label}: the hovered label must resolve at 4.5:1 or better; ${JSON.stringify(audit.targetText)}`,
  ).toBe(true);
  await page.mouse.move(0, 0);
}

async function expectKeyboardTarget(page: Page, link: Locator) {
  await link.scrollIntoViewIfNeeded();
  const rectangle = await link.boundingBox();
  if (!rectangle) throw new Error('The actual anchor has no hit box');
  expect(rectangle.width, 'anchor width').toBeGreaterThanOrEqual(44);
  expect(rectangle.height, 'anchor height').toBeGreaterThanOrEqual(44);
  // Enter from the preceding focus stop so :focus-visible is keyboard driven.
  await link.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  const audit = await auditPublicPage(page, link);
  expect(
    hasVisibleFocusOutline(audit),
    `keyboard focus needs a visible 2px outline at 3:1 or better; ${JSON.stringify(audit.focusOutline)}`,
  ).toBe(true);
}

for (const width of [390, 1440]) {
  test(`shared list → climb → setter journey stays readable and tappable at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/kilter/original/12x12-square/screw_bolt/40/list', { waitUntil: 'domcontentloaded' });
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb', exact: true });
    await expect(breadcrumb.locator('[aria-current="page"] a')).toHaveCount(0);
    await expectKeyboardTarget(page, breadcrumb.getByRole('link').first());
    const firstClimb = page.locator('main a[href*="/view/"]').first();
    await expect(firstClimb).toBeVisible();
    const climbHref = await firstClimb.evaluate((element: HTMLAnchorElement) => element.href);
    await page.mouse.move(0, 0);
    await expectPublicReading(page, testInfo, 'list');
    await expectReadableButtonHover(
      page,
      testInfo,
      page.locator('main a[rel="next"]'),
      'list-next-hover',
      SECONDARY_HOVER_INK,
    );
    if (width === 1440) {
      // A laptop's store links are the official badges in the QR card: no text
      // to colour on hover, so hold them to the target size and a visible focus ring.
      await expectKeyboardTarget(page, page.locator('main a[href*="play.google.com"]:visible').first());
      await page.mouse.move(0, 0);
    } else {
      // A phone's one store link is its store's official badge, which has no
      // text to colour on hover: hold it to the target size and a visible focus
      // ring. CSS shows exactly one of the two stacked badges, before and after
      // hydration.
      const phoneBadge = page.locator('main [data-cta="mobile-install"] a[data-store-badge]:visible');
      await expect(phoneBadge).toHaveCount(1);
      await expectKeyboardTarget(page, phoneBadge);
      await page.mouse.move(0, 0);
    }
    const footer = page.getByTestId('site-footer');
    await expectReadableButtonHover(
      page,
      testInfo,
      footer.getByRole('link', { name: 'Start climbing in the app', exact: true }),
      'footer-app-hover',
      SECONDARY_HOVER_INK,
    );
    const languageTrigger = footer.getByRole('button', { name: /language/i });
    await expectReadableButtonHover(page, testInfo, languageTrigger, 'footer-language-hover', TEXT_ACTION_HOVER_INK);
    await languageTrigger.click();
    const languageMenu = page.getByRole('menu');
    await expect(languageMenu.locator('..')).toHaveCSS('opacity', '1');
    await expect(languageMenu.locator('..')).toHaveCSS('transform', 'none');
    await expect(page.getByRole('menuitem')).toHaveCount(6);
    for (const menuItem of await page.getByRole('menuitem').all()) {
      const rectangle = await menuItem.boundingBox();
      expect(rectangle?.height, 'phone keeps its 48px menu rows').toBeGreaterThanOrEqual(width === 390 ? 48 : 44);
    }
    await expectPublicReading(page, testInfo, 'language-menu-open');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await firstClimb.click();
    await expect(page).toHaveURL(climbHref);
    await expect(breadcrumb.getByRole('link')).toHaveCount(2);
    await expect(breadcrumb.getByRole('link').first()).toHaveAttribute('href', '/');
    await expect(breadcrumb.getByRole('link').nth(1)).toHaveAttribute('href', /\/list$/);
    await expect(breadcrumb.locator('[aria-current="page"] a')).toHaveCount(0);
    for (const crumbLink of await breadcrumb.getByRole('link').all()) {
      await expectKeyboardTarget(page, crumbLink);
    }
    const setterLink = page.locator('main dl a[href*="/setter/"]').first();
    await expect(setterLink).toBeVisible();
    const setterHref = await setterLink.evaluate((element: HTMLAnchorElement) => element.href);
    await expectKeyboardTarget(page, setterLink);
    await page.mouse.move(0, 0);
    await expectPublicReading(page, testInfo, 'climb');

    // DOM-only stress: these are deliberately long tokens, not seeded content.
    await breadcrumb
      .getByRole('link')
      .nth(1)
      .evaluate((element) => {
        element.textContent = 'LongBoardName'.repeat(30);
      });
    await breadcrumb.locator('[aria-current="page"]').evaluate((element) => {
      element.textContent = 'LongClimbName'.repeat(30);
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await expectKeyboardTarget(page, breadcrumb.getByRole('link').nth(1));
    await setterLink.click();
    await expect(page).toHaveURL(setterHref);
    await waitForSeededSetter(page);
    await expect(page.locator('main dl')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expectPublicReading(page, testInfo, 'setter');
    // A phone's store link is its badge; from md the QR card's pair of badges
    // takes its place. Either way: a 44px target with a visible focus ring.
    await expectKeyboardTarget(page, page.locator('main a[href*="play.google.com"]:visible').first());
    await page.mouse.move(0, 0);
    if (width === 1440) {
      await expect(page.locator('main').getByRole('img', { name: /^QR code that opens/ })).toBeVisible();
      // One store block per screen: the QR card's pair, not the phone's as well.
      await expect(page.locator('main a[href*="apps.apple.com"]:visible')).toHaveCount(1);
    }
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();

    // Discover lists public playlists only, so the first one has a QR code to show.
    await page.goto('/playlists', { waitUntil: 'domcontentloaded' });
    const playlist = page.locator('main a[href^="/playlists/"]').first();
    await expect(playlist).toBeVisible();
    await playlist.click();
    await expect(page.locator('main h1')).toBeVisible();
    const playlistQr = page.locator('main').getByRole('img', { name: /^QR code that opens/ });
    const playlistHandoff = page.locator('main [data-cta="handoff"]');
    await expect(playlistHandoff).toBeVisible();
    await page.mouse.move(0, 0);
    await expectPublicReading(page, testInfo, 'playlist');
    if (width === 1440) {
      await expect(playlistQr).toBeVisible();
      await expect(page.locator('main [data-cta="mobile-install"]')).toBeHidden();
      await expectReadableFilledHover(page, testInfo, playlistHandoff, 'playlist-handoff-hover');
    } else {
      await expect(playlistQr).toBeHidden();
      await expect(page.locator('main [data-cta="mobile-install"] a[data-store-badge]:visible')).toHaveCount(1);
    }
  });
}
