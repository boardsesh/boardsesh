// The wall button's words must read on their own fill, on every surface it can
// sit on: the Liquid Glass sheet (iOS system grounds) and the Material sheet
// (Velvet Send surfaces), light and dark (#7000). 4.6:1, a margin over WCAG
// AA's 4.5:1 (spec B2): the brand violet measured 4.54:1 on the Material light
// ground, so the tonal label takes `primaryStrong`.
import { describe, expect, it } from 'vitest';
import { blendOpaque, brandColors, brandColorsDark, materialSurfaces } from '@boardsesh/velvet-tokens';
import { contrastRatioHex } from '../../../lib/color-contrast-oracle';
import { BOKEH_DARK_SURFACE, BOKEH_LIGHT_SURFACE } from '@boardsesh/frosted-bokeh';
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

const SCHEMES = ['light', 'dark'] as const;
const brandFor = (scheme: (typeof SCHEMES)[number]) => (scheme === 'dark' ? brandColorsDark : brandColors);
/** The tonal pill's fill over one sheet. */
const tonalFill = (scheme: (typeof SCHEMES)[number], surface: string) =>
  blendOpaque(brandFor(scheme).primaryFill, surface, WALL_CONTROL_TONAL_ALPHA);

describe('wall button contrast', () => {
  it.each(SCHEMES)('keeps Put on board at 4.6:1 in %s', (scheme) => {
    const brand = brandFor(scheme);
    for (const surface of SURFACES[scheme]) {
      const fill = tonalFill(scheme, surface);
      expect(
        contrastRatioHex(brand.primaryStrong, fill),
        `${brand.primaryStrong} on ${fill} over ${surface}`,
      ).toBeGreaterThanOrEqual(4.6);
    }
  });

  // Put on board's timed drive with no holds to frost (2.7): the flat amber
  // shrinks over the frost pill whose label is the amber's own ink, so the
  // label, and the clock in the same colour, read on both as the amber drains.
  it('keeps a timed drive’s label at 4.5:1 on the shrinking amber and the pill under it', () => {
    // Light: white on the amber and on the dark frost pill.
    expect(contrastRatioHex(brandColors.onPrimary, brandColors.live)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatioHex(brandColors.onPrimary, BOKEH_DARK_SURFACE.base)).toBeGreaterThanOrEqual(4.5);
    // Dark: dark ink on the pale amber and on the light frost pill.
    expect(contrastRatioHex(brandColorsDark.onAccent, brandColorsDark.live)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatioHex(brandColorsDark.onAccent, BOKEH_LIGHT_SURFACE.base)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the deeper violet for light only: dark keeps its lifted foreground', () => {
    expect(brandColors.primaryStrong).toBe('#5B21B6');
    expect(brandColorsDark.primaryStrong).toBe(brandColorsDark.primary);
  });

  it('is stronger than the old 14% wash, so it no longer reads as disabled', () => {
    expect(WALL_CONTROL_TONAL_ALPHA).toBeGreaterThan(0.14);
  });

  it('keeps Lit on the wall at 4.5:1 on the amber fill in both schemes', () => {
    expect(contrastRatioHex(brandColors.onPrimary, brandColors.live)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatioHex(brandColorsDark.onAccent, brandColorsDark.live)).toBeGreaterThanOrEqual(4.5);
  });

  // B1: the top bar's "Preview · not on the wall" line (PlayListContext), and
  // B3: the board sheet's status line (BoardSheetStatusLine), its full-size
  // fallback, are drawn in Velvet's opaque secondary label on both variants.
  // iOS's own secondaryLabel is translucent and measures 3.44:1 on a white sheet.
  it.each(['light', 'dark'] as const)(
    'keeps the preview and board sheet lines well past 4.6:1 on every %s ground',
    (scheme) => {
      const label = materialSurfaces[scheme].secondaryLabel;
      for (const surface of SURFACES[scheme]) {
        expect(contrastRatioHex(label, surface), `${label} on ${surface}`).toBeGreaterThanOrEqual(6);
      }
    },
  );
});
