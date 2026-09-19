import { expect, test } from '@playwright/test';

const ignoreHTTPSErrors = process.env.PLAYWRIGHT_TEST_BASE_URL?.startsWith('https://localhost:') ?? false;
test.use({ colorScheme: 'light', ignoreHTTPSErrors });

const platformBrowsers = [
  {
    name: 'iPhone',
    platform: 'ios',
    mobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  },
  {
    name: 'Android',
    platform: 'android',
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/133.0.0.0 Mobile Safari/537.36',
  },
  {
    name: 'Mac',
    platform: 'ios',
    mobile: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36',
  },
  {
    name: 'Windows',
    platform: 'android',
    mobile: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36',
  },
] as const;

for (const browserProfile of platformBrowsers) {
  test(`${browserProfile.name} receives matching screenshots in server HTML and browser requests`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      ignoreHTTPSErrors,
      userAgent: browserProfile.userAgent,
      viewport: { width: browserProfile.mobile ? 390 : 1440, height: 1000 },
      isMobile: browserProfile.mobile,
      hasTouch: browserProfile.mobile,
    });
    try {
      const page = await context.newPage();
      const imageRequests: string[] = [];
      const hydrationErrors: string[] = [];
      page.on('request', (request) => {
        if (request.resourceType() === 'image') imageRequests.push(decodeURIComponent(request.url()));
      });
      page.on('console', (message) => {
        if (/hydration|did not match|server rendered HTML/i.test(message.text())) hydrationErrors.push(message.text());
      });
      const response = await page.goto('/');
      const html = await response!.text();
      const oppositePlatform = browserProfile.platform === 'ios' ? 'android' : 'ios';
      expect(html).toContain(`data-preview-platform="${browserProfile.platform}"`);
      expect(html).not.toContain(`/images/app/${oppositePlatform}/`);
      expect(html).not.toContain(encodeURIComponent(`/images/app/${oppositePlatform}/`));
      const screenshots = page.locator('[data-marketing-shot]');
      await expect(screenshots).toHaveCount(6);
      for (const screenshot of await screenshots.all()) {
        await screenshot.scrollIntoViewIfNeeded();
        await expect(screenshot).toHaveAttribute('data-preview-platform', browserProfile.platform);
        await expect
          .poll(() => screenshot.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
          .toBeGreaterThan(0);
      }
      expect(imageRequests.some((url) => url.includes(`/images/app/${browserProfile.platform}/`))).toBe(true);
      expect(imageRequests.filter((url) => url.includes(`/images/app/${oppositePlatform}/`))).toEqual([]);
      expect(hydrationErrors).toEqual([]);
      if (browserProfile.mobile) {
        await expect(page.getByRole('button', { name: 'iOS', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Android', exact: true })).toHaveCount(0);
        const expectedStore = browserProfile.platform === 'ios' ? 'apps.apple.com' : 'play.google.com';
        const otherStore = browserProfile.platform === 'ios' ? 'play.google.com' : 'apps.apple.com';
        expect(await page.locator(`main a[href*="${expectedStore}"]`).count()).toBeGreaterThan(0);
        await expect(page.locator(`main a[href*="${otherStore}"]`)).toHaveCount(0);
      } else {
        await expect(page.getByRole('button', { name: 'iOS', exact: true })).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Android', exact: true })).toHaveCount(1);
        expect(await page.locator('main a[href*="apps.apple.com"]').count()).toBeGreaterThan(0);
        expect(await page.locator('main a[href*="play.google.com"]').count()).toBeGreaterThan(0);
      }
    } finally {
      await context.close();
    }
  });
}

test('desktop preview switching persists when navigating to About', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors,
    userAgent: platformBrowsers[3].userAgent,
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'iOS', exact: true }).click();
    await expect(page.locator('[data-preview-platform="ios"]')).toHaveCount(6);
    await page.getByTestId('marketing-header').getByRole('link', { name: 'About', exact: true }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(
      page.getByTestId('marketing-header').getByRole('link', { name: 'About', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-marketing-shot="profile"]')).toHaveAttribute('data-preview-platform', 'ios');
    await expect(page.getByRole('button', { name: 'iOS', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Android', exact: true }).click();
    await expect(page.locator('[data-marketing-shot="profile"]')).toHaveAttribute('data-preview-platform', 'android');
  } finally {
    await context.close();
  }
});

for (const width of [1440, 390]) {
  test(`marketing pages keep their dark layout and type scale at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of ['/', '/support', '/gyms/kilter', '/about', '/help', '/legal', '/privacy']) {
      await page.goto(route);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('[data-testid="marketing-header"]')).toBeVisible();
      await expect(page.locator('[data-testid="site-footer"]')).toBeVisible();
      for (const landmark of ['marketing-header', 'site-footer']) {
        const logo = page.getByTestId(landmark).locator('img[src*="boardsesh-mark"]');
        await logo.scrollIntoViewIfNeeded();
        await expect(logo).toBeVisible();
        await expect(logo).toHaveAttribute('alt', '');
        await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, route).toBeLessThanOrEqual(1);
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 10, 32)');
      await expect(page.locator('h1')).toHaveCSS(
        'font-size',
        route === '/' ? (width === 390 ? '40px' : '64px') : width === 390 ? '32px' : '40px',
      );
    }
  });
}

test('the homepage uses campaign benefits before organic boards and gym search', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your boards. One app.');
  for (const name of ['Your crew. One live queue.', 'See what’s on the wall.', 'All your boards. One profile.']) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  const benefits = page.getByRole('heading', { name: 'Board night, sorted', exact: true });
  const gyms = page.getByRole('heading', { name: 'Find a board near you', exact: true });
  await expect(benefits).toBeVisible();
  await expect(gyms).toBeVisible();
  const benefitsTop = await benefits.evaluate((heading) => heading.getBoundingClientRect().top);
  const gymsTop = await gyms.evaluate((heading) => heading.getBoundingClientRect().top);
  expect(benefitsTop).toBeLessThan(gymsTop);
  const boards = page.getByTestId('physical-board-rail');
  if (await boards.count()) {
    const boardsTop = await boards.evaluate((section) => section.getBoundingClientRect().top);
    expect(boardsTop).toBeGreaterThan(benefitsTop);
    expect(boardsTop).toBeLessThan(gymsTop);
  }
});

test('the compact mobile header keeps the app and account reachable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  const header = page.getByTestId('marketing-header');
  await expect(header.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await header.getByRole('button', { name: 'Open menu', exact: true }).click();
  const appLink = page.getByRole('menuitem', { name: 'Start climbing', exact: true });
  await expect(appLink).toBeVisible();
  await expect(appLink).toHaveAttribute('href', /^(https?:\/\/|\/app)/);
});

for (const width of [320, 390]) {
  test(`the branded header and homepage fit all locales at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ['/', '/es', '/fr', '/de']) {
      await page.goto(route);
      await expect(page.locator('h1')).toHaveCount(1);
      const header = page.getByTestId('marketing-header');
      const homeLink = header.locator('a').filter({ has: page.locator('img[src*="boardsesh-mark"]') });
      await expect(homeLink).toBeVisible();
      await expect(homeLink).toHaveAttribute('aria-label', /.+/);
      const controls = await header.locator('a, button').evaluateAll((elements) =>
        elements
          .map((element) => element.getBoundingClientRect())
          .filter((rectangle) => rectangle.width > 0)
          .map((rectangle) => ({ left: rectangle.left, right: rectangle.right, height: rectangle.height })),
      );
      for (const control of controls) {
        expect(control.left, route).toBeGreaterThanOrEqual(0);
        expect(control.right, route).toBeLessThanOrEqual(width);
        expect(control.height, route).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), route).toBeLessThanOrEqual(
        1,
      );
    }
  });
}

test('the mobile directory does not request map tiles before Show map', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tileRequests: string[] = [];
  page.on('request', (request) => {
    if (/tiles\.openfreemap\.org|tile\.openstreetmap\.org/.test(request.url())) tileRequests.push(request.url());
  });
  await page.goto('/gyms/kilter');
  await expect(page.getByRole('button', { name: 'Show map', exact: true })).toBeVisible();
  expect(tileRequests).toEqual([]);
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) => route.abort());
  await page.getByRole('button', { name: 'Show map', exact: true }).click();
  await expect(page.locator('.leaflet-tile').first()).toBeAttached();
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
});

test('physical board discovery keeps public and app links on the same named board', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const rail = page.getByTestId('physical-board-rail');
  if ((await rail.count()) === 0) {
    // The standard CI seed does not guarantee public gym-linked installations.
    // Positive rendering and privacy eligibility have dedicated fixture tests.
    test.info().annotations.push({ type: 'data-availability', description: 'No eligible public physical boards' });
    await expect(page.getByRole('heading', { name: 'Popular boards', exact: true })).toHaveCount(0);
    return;
  }
  const cards = rail.locator('li');
  expect(await cards.count()).toBeGreaterThan(0);
  for (const card of await cards.all()) {
    const boardPath = await card.locator('h3 a').getAttribute('href');
    expect(boardPath).toMatch(/^\/b\/[^/]+$/);
    await expect(card.getByRole('img')).toHaveAttribute('aria-label', /.+/);
    await expect(card.locator('a[href^="/gym/"]')).toHaveCount(1);
    const appHref = await card.getByRole('link', { name: 'Open this board', exact: true }).getAttribute('href');
    const appPath = new URL(appHref!, page.url()).pathname;
    const namedPath = appPath.slice(appPath.indexOf('/b/'));
    expect(namedPath).toMatch(/^\/b\/[^/]+\/-?\d+\/list$/);
    expect(namedPath.split('/').slice(0, 3).join('/')).toBe(boardPath);
    const angle = namedPath.split('/')[3];
    await expect(card).toContainText(`${angle}°`);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('home gym discovery uses at most four location rows without duplicate board artwork', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('gym-board-previews')).toHaveCount(0);
  const locator = page.locator('#gyms');
  await expect(locator.getByRole('search')).toHaveAttribute('method', 'get');
  await expect(locator.getByRole('link', { name: /Browse the full gym directory/ })).toHaveAttribute('href', '/gyms');
  const rows = locator.locator('li');
  expect(await rows.count()).toBeLessThanOrEqual(4);
  for (const row of await rows.all()) {
    await expect(row.locator('h3 a')).toHaveAttribute('href', /^\/gym\/[^/]+$/);
    await expect(row.locator('[data-testid="gym-board-previews"]')).toHaveCount(0);
    await expect(row).not.toContainText(/\d+ km away/);
  }
});

for (const width of [320, 390, 430]) {
  test(`mobile typography stays readable without narrow text columns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.locator('h1')).toHaveCSS('font-size', width < 360 ? '36px' : '40px');
    for (const name of ['Board night, sorted', 'Find a board near you']) {
      await expect(page.getByRole('heading', { name, exact: true })).toHaveCSS('font-size', '28px');
    }
    const features = page.getByTestId('home-feature-column');
    await expect(features).toHaveCount(3);
    for (const feature of await features.all()) {
      await expect(feature.locator('h3')).toHaveCSS('font-size', '24px');
      const paragraph = feature.locator('p');
      await expect(paragraph).toHaveCSS('font-size', '16px');
      const textBox = await paragraph.boundingBox();
      const imageBox = await feature.locator('img').boundingBox();
      expect(textBox!.width).toBeGreaterThanOrEqual(200);
      expect(imageBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height);
    }
    await expect(page.getByTestId('gym-board-previews')).toHaveCount(0);
    for (const buttonName of ['Search', 'Use my location']) {
      const button = page.getByRole('button', { name: buttonName, exact: true });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  });
}
