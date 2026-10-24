// The final countdown's digits are the brand tint (`systemColors.accent`), and a
// climber reads them from the mat. Pin 4.5:1 (WCAG AA for text) against every
// opaque surface the pill, the arm row's clock and the sheet's hero sit on, in
// both schemes and under iOS Increase Contrast. Liquid Glass has no fixed colour
// to measure; its solid fallback (Reduce Transparency) is in the list.
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (colors: Record<string, string>) => colors,
}));

import { contrastRatioHex } from '../../../lib/color-contrast-oracle';
import { androidFallbackColors, brandAccentDynamic, materialSurfaceContainers } from '../../../theme/colors';

const AA_TEXT = 4.5;

// The iOS system backgrounds behind these views. PlatformColor has no hex to
// read in a test, so these are Apple's published values.
const IOS_SURFACES = {
  light: {
    systemBackground: '#FFFFFF',
    secondarySystemBackground: '#F2F2F7',
    tertiarySystemBackground: '#FFFFFF',
    systemGroupedBackground: '#F2F2F7',
  },
  dark: {
    systemBackground: '#000000',
    secondarySystemBackground: '#1C1C1E',
    tertiarySystemBackground: '#2C2C2E',
    systemGroupedBackground: '#000000',
  },
} as const;

describe('the final countdown tint', () => {
  it.each(['light', 'dark'] as const)(
    'clears AA on every iOS surface in %s, with and without Increase Contrast',
    (scheme) => {
      const tints =
        scheme === 'light'
          ? [brandAccentDynamic.light, brandAccentDynamic.highContrastLight]
          : [brandAccentDynamic.dark, brandAccentDynamic.highContrastDark];
      for (const tint of tints) {
        for (const surface of Object.values(IOS_SURFACES[scheme])) {
          expect(contrastRatioHex(tint, surface), `${tint} on ${surface}`).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    },
  );

  it.each(['light', 'dark'] as const)('clears AA on every Android and Material surface in %s', (scheme) => {
    const { accent, background, secondaryBackground, elevatedSurface } = androidFallbackColors[scheme];
    const { base, high } = materialSurfaceContainers[scheme];
    for (const surface of [background, secondaryBackground, elevatedSurface, base, high]) {
      expect(contrastRatioHex(accent, surface), `${accent} on ${surface}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
