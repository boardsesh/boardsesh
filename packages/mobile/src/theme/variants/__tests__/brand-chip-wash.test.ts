// @vitest-environment jsdom
// The decorative brand chips (the workout line on a feed card, the logbook's day
// divider) draw caption text on a light violet wash. Their label is `primaryStrong`,
// so it must clear WCAG AA on that wash over every sheet it can sit on.
import { describe, expect, it, vi } from 'vitest';

// variant-tokens pulls in the theme colour modules, which read Platform/PlatformColor
// at import. Same stub as heat-ramp.test.ts.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
}));

import { blendOpaque, brandColors, brandColorsDark } from '@boardsesh/velvet-tokens';
import { contrastRatioHex } from '../../../lib/color-contrast-oracle';
import { BRAND_CHIP_WASH_ALPHA } from '../variant-tokens';

const GROUNDS = {
  light: ['#FFFFFF', '#F2F2F7', '#F2F2F2'],
  dark: ['#000000', '#1C1C1E', '#2C2C2E', '#0E0E0E', '#1E1E1E', '#262626'],
} as const;

describe.each(Object.entries(BRAND_CHIP_WASH_ALPHA))('the %s chip wash (alpha %s)', (_chip, alpha) => {
  it.each(['light', 'dark'] as const)('keeps primaryStrong at 4.5:1 on it over every %s sheet', (scheme) => {
    const brand = scheme === 'dark' ? brandColorsDark : brandColors;
    for (const ground of GROUNDS[scheme]) {
      const wash = blendOpaque(brand.primaryFill, ground, alpha);
      expect(
        contrastRatioHex(brand.primaryStrong, wash),
        `${brand.primaryStrong} on ${wash} over ${ground}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is why the label is not the tint: the dark tint drops under 4.5:1 over #2C2C2E', () => {
    const wash = blendOpaque(brandColorsDark.primaryFill, '#2C2C2E', alpha);
    expect(contrastRatioHex(brandColorsDark.primary, wash)).toBeLessThan(4.5);
  });
});
