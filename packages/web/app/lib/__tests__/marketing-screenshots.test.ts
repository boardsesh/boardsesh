import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vite-plus/test';
import { SUPPORTED_LOCALES } from '../i18n/config';
import { marketingScreenshot, type MarketingShot } from '../marketing-screenshots';

const shots: MarketingShot[] = ['kilter', 'tension', 'moonboard', 'queue', 'wall-status', 'profile', 'spray-wall'];

describe('marketing capture selection', () => {
  for (const platform of ['ios', 'android'] as const) {
    it(`resolves every purpose and locale to a real ${platform} capture`, () => {
      for (const locale of SUPPORTED_LOCALES) {
        for (const shot of shots) {
          const capture = marketingScreenshot(platform, locale, shot);
          expect(capture.src).toMatch(new RegExp(`/images/app/${platform}/`));
          expect(capture.src).toMatch(/\.webp$/);
          expect(capture.width).toBeGreaterThan(0);
          expect(capture.height).toBeGreaterThan(capture.width);
        }
      }
    });

    it(`falls back to English without crossing from ${platform} to the other platform`, () => {
      for (const shot of shots) {
        expect(marketingScreenshot(platform, 'de', shot)).toEqual(marketingScreenshot(platform, 'en-US', shot));
      }
    });
  }
});

describe('the workouts capture', () => {
  it('is the one Play Store crop on both platforms, sized to the file it names', async () => {
    const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public');
    for (const platform of ['ios', 'android'] as const) {
      const capture = marketingScreenshot(platform, 'en-US', 'workouts');
      expect(capture.src).toBe('/images/app/android/workouts.webp');
      // The declared size is what `next/image` reserves: a mismatch is a stretched phone.
      const metadata = await sharp(`${publicRoot}${capture.src}`).metadata();
      expect({ width: metadata.width, height: metadata.height }).toEqual({
        width: capture.width,
        height: capture.height,
      });
    }
  });
});
