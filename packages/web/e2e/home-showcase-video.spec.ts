import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) {
  test.describe(`hero demo at ${width}px`, () => {
    test.use({
      viewport: { width, height: width === 390 ? 664 : 900 },
      userAgent:
        width === 390
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36',
    });

    test('keeps Play stable under the pointer and plays on the first click', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      const hero = page.locator('main section').first();
      const video = hero.locator('video');
      await expect(page.locator('video')).toHaveCount(1);
      await expect(video).not.toHaveAttribute('src');
      const play = hero.getByRole('button', { name: 'Play demo', exact: true });
      // Reduced-motion preference hydrates after SSR; wait for its larger manual control.
      await expect.poll(async () => (await play.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(48);
      const initial = (await play.boundingBox())!;
      if (width === 390) expect(initial.y + initial.height).toBeLessThanOrEqual(664);
      await play.hover();
      const hovered = (await play.boundingBox())!;
      expect(Math.abs(hovered.x - initial.x)).toBeLessThan(1);
      expect(Math.abs(hovered.y - initial.y)).toBeLessThan(1);
      await play.click();
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.1);
      const pause = hero.getByRole('button', { name: 'Pause demo', exact: true });
      await pause.click();
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    });
  });
}
