import { describe, expect, it } from 'vite-plus/test';
import { SUPPORTED_LOCALES } from '../i18n/config';
import { marketingScreenshot, type MarketingShot } from '../marketing-screenshots';

const shots: MarketingShot[] = ['kilter', 'tension', 'moonboard', 'queue', 'wall-status', 'profile'];

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
