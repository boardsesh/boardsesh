// The wall button's label must read at WCAG AA (4.5:1) on its own fill, on
// every surface it can sit on: the Liquid Glass sheet (iOS system grounds) and
// the Material sheet (Velvet Send surfaces), light and dark (#7000).
import { describe, expect, it } from 'vitest';
import { blendOpaque, brandColors, brandColorsDark, materialSurfaces } from '@boardsesh/velvet-tokens';
import { contrastRatioHex } from '../../../lib/color-contrast-oracle';
import { WALL_CONTROL_TONAL_ALPHA } from '../wall-control';

const SURFACES = {
  light: ['#FFFFFF', '#F2F2F7', materialSurfaces.light.background, materialSurfaces.light.secondaryBackground],
  dark: [
    '#000000',
    '#1C1C1E',
    materialSurfaces.dark.background,
    materialSurfaces.dark.secondaryBackground,
    materialSurfaces.dark.tertiaryBackground,
  ],
} as const;

describe('wall button contrast', () => {
  it.each(['light', 'dark'] as const)('keeps Connect board and Put on the wall at 4.5:1 in %s', (scheme) => {
    const brand = scheme === 'dark' ? brandColorsDark : brandColors;
    for (const surface of SURFACES[scheme]) {
      const fill = blendOpaque(brand.primaryFill, surface, WALL_CONTROL_TONAL_ALPHA);
      expect(
        contrastRatioHex(brand.primary, fill),
        `${brand.primary} on ${fill} over ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is stronger than the old 14% wash, so it no longer reads as disabled', () => {
    expect(WALL_CONTROL_TONAL_ALPHA).toBeGreaterThan(0.14);
  });

  it('keeps Lit on the wall at 4.5:1 on the amber fill in both schemes', () => {
    expect(contrastRatioHex(brandColors.onPrimary, brandColors.live)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatioHex(brandColorsDark.onAccent, brandColorsDark.live)).toBeGreaterThanOrEqual(4.5);
  });
});
