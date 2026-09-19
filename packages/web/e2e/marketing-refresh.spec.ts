import { expect, test } from '@playwright/test';

test.use({ colorScheme: 'light' });

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

test('the homepage explains the app before gym and board discovery', async ({ page }) => {
  await page.goto('/');
  const benefits = page.getByRole('heading', { name: 'Board night, sorted', exact: true });
  const gyms = page.getByRole('heading', { name: 'Find a board near you', exact: true });
  await expect(benefits).toBeVisible();
  await expect(gyms).toBeVisible();
  const benefitsTop = await benefits.evaluate((heading) => heading.getBoundingClientRect().top);
  const gymsTop = await gyms.evaluate((heading) => heading.getBoundingClientRect().top);
  expect(benefitsTop).toBeLessThan(gymsTop);
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

test('gym board previews are bounded and retain their physical board identity', async ({ page }) => {
  await page.goto('/');
  const previewLists = page.getByTestId('gym-board-previews');
  if ((await previewLists.count()) === 0) {
    test.info().annotations.push({ type: 'data-availability', description: 'No homepage gyms with eligible boards' });
    await expect(page.getByRole('heading', { name: 'Find a board near you', exact: true })).toBeVisible();
    return;
  }
  expect(await previewLists.count()).toBeLessThanOrEqual(4);
  for (const previews of await previewLists.all()) {
    const boards = previews.locator('li');
    expect(await boards.count()).toBeGreaterThan(0);
    expect(await boards.count()).toBeLessThanOrEqual(3);
    for (const board of await boards.all()) {
      const publicLink = board.locator('a[href^="/b/"]');
      await expect(publicLink).toHaveCount(1);
      await expect(board.getByRole('img')).toHaveAttribute('aria-label', /.+/);
      const boardPath = await publicLink.getAttribute('href');
      const appHref = await board.getByRole('link', { name: 'Open this board', exact: true }).getAttribute('href');
      const appPath = new URL(appHref!, page.url()).pathname;
      expect(appPath.slice(appPath.indexOf('/b/')).split('/').slice(0, 3).join('/')).toBe(boardPath);
      expect(appPath).toMatch(/\/-?\d+\/list$/);
    }
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
      await expect(feature.locator('h3')).toHaveCSS('font-size', '20px');
      const paragraph = feature.locator('p');
      await expect(paragraph).toHaveCSS('font-size', '16px');
      const textBox = await paragraph.boundingBox();
      const imageBox = await feature.locator('img').boundingBox();
      expect(textBox!.width).toBeGreaterThanOrEqual(200);
      expect(imageBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height);
    }
    for (const preview of await page.getByTestId('gym-board-previews').all()) {
      for (const board of await preview.locator('li').all()) {
        const artwork = await board.getByRole('img').boundingBox();
        const name = await board.locator('a[href^="/b/"]').boundingBox();
        expect(artwork!.width).toBeLessThanOrEqual(80);
        expect(name!.x).toBeGreaterThanOrEqual(artwork!.x + artwork!.width);
      }
      for (const action of await preview.getByRole('link', { name: 'Open this board', exact: true }).all()) {
        const metrics = await action.evaluate((element) => ({
          fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
          height: element.getBoundingClientRect().height,
        }));
        expect(metrics.fontSize).toBeGreaterThanOrEqual(14);
        expect(metrics.height).toBeGreaterThanOrEqual(44);
      }
    }
    for (const buttonName of ['Search', 'Use my location']) {
      const button = page.getByRole('button', { name: buttonName, exact: true });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  });
}
