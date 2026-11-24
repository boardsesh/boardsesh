import { describe, expect, it } from 'vite-plus/test';
import { STATIC_MARKETING_ASSET_OBJECT_KEYS } from '@boardsesh/static-assets/marketing';
import { resolveMarketingStaticAssetUrl } from '../marketing-static-asset-url';
import { marketingScreenshot } from '../marketing-screenshots';
import { SUPPORTED_LOCALES } from '../i18n/config';

describe('marketing asset resolution', () => {
  it('retains local paths outside production and normalizes missing slashes', () => {
    expect(resolveMarketingStaticAssetUrl('/images/app/ios/queue.webp', '')).toBe('/images/app/ios/queue.webp');
    expect(resolveMarketingStaticAssetUrl('images/app/ios/queue.webp', '')).toBe('/images/app/ios/queue.webp');
  });
  it('uses immutable generated object keys with the configured CDN origin', () => {
    expect(
      resolveMarketingStaticAssetUrl('/videos/home/showcase-9x16-lite.webm', 'https://assets.boardsesh.com/'),
    ).toBe(
      `https://assets.boardsesh.com/${STATIC_MARKETING_ASSET_OBJECT_KEYS['/videos/home/showcase-9x16-lite.webm']}`,
    );
  });
  it('fails closed for production assets outside the compact catalog', () => {
    expect(() => resolveMarketingStaticAssetUrl('/images/kilter/wall.webp', 'https://assets.boardsesh.com')).toThrow(
      'Static marketing asset is missing from the generated catalog',
    );
  });
  it('covers every platform, locale and screenshot fallback', () => {
    for (const platform of ['ios', 'android'] as const) {
      for (const locale of SUPPORTED_LOCALES) {
        for (const shot of [
          'kilter',
          'tension',
          'moonboard',
          'queue',
          'wall-status',
          'profile',
          'spray-wall',
          'workouts',
        ] as const) {
          expect(
            resolveMarketingStaticAssetUrl(
              marketingScreenshot(platform, locale, shot).src,
              'https://assets.boardsesh.com',
            ),
          ).toMatch(/^https:\/\/assets\.boardsesh\.com\/static\/v1\/[a-f0-9]{64}\.webp$/);
        }
      }
    }
  });
});
