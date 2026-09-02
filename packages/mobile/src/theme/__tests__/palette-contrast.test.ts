// @vitest-environment jsdom
//
// The palettes document their WCAG ratios in prose ("opaque so secondary text
// clears WCAG AA — 6.44:1 on bg") but nothing checked them, so a surface tweak
// could quietly push a label under AA. These assertions are that check.
//
// They cover the two palettes Android can resolve — `materialSurfaces` (the
// Material variant, Android's default) and `androidFallbackColors` (Liquid Glass
// on Android) — in both schemes. iOS Liquid Glass resolves PlatformColor, which
// Apple guarantees and which has no hex to measure.
import { describe, it, expect, vi } from 'vitest';

// colors.ts touches Platform/PlatformColor at import; the Android branch skips
// the iOS PlatformColor path. Same shim as material-surfaces.test.ts.
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, PlatformColor: (name: string) => name }));

import { contrastRatio, relativeLuminance } from '@boardsesh/velvet-tokens';
import { androidFallbackColors, materialSurfaces } from '../colors';

const SCHEMES = ['light', 'dark'] as const;

// WCAG 2.1 AA: 4.5:1 for body text, 3:1 for large text and UI components.
const AA_BODY = 4.5;
const AA_LARGE = 3;

const PALETTES = {
  materialSurfaces,
  androidFallbackColors,
} as const;

// Grounds a label can actually sit on. `separator` / `fill` are strokes and
// translucent washes, not text grounds, so they are not asserted here.
const GROUNDS = ['background', 'secondaryBackground', 'groupedBackground', 'elevatedSurface'] as const;

describe('relativeLuminance', () => {
  it('anchors at the ends of the range', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('returns null for anything that is not opaque hex', () => {
    expect(relativeLuminance('rgba(0, 0, 0, 0.5)')).toBeNull();
    expect(relativeLuminance('label')).toBeNull();
  });
});

describe('contrastRatio', () => {
  it('gives 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 2);
    expect(contrastRatio('#15101E', '#15101E')).toBeCloseTo(1, 5);
  });

  it('is symmetric — it measures the pair, not a direction', () => {
    expect(contrastRatio('#F5F2FB', '#15101E')).toBe(contrastRatio('#15101E', '#F5F2FB'));
  });
});

describe.each(Object.entries(PALETTES))('%s label contrast', (paletteName, palette) => {
  it.each(SCHEMES)(`clears WCAG AA in %s`, (scheme) => {
    const colors = palette[scheme];
    for (const ground of GROUNDS) {
      // The primary label carries body copy everywhere, so it must clear 4.5:1.
      const labelRatio = contrastRatio(colors.label, colors[ground]);
      expect(labelRatio, `${paletteName}.${scheme}: label on ${ground}`).not.toBeNull();
      expect(labelRatio ?? 0, `${paletteName}.${scheme}: label on ${ground}`).toBeGreaterThanOrEqual(AA_BODY);

      // Secondary label is body copy too (descriptions, section footers) — the
      // palettes went opaque rather than 0.6-alpha specifically to clear this.
      const secondaryRatio = contrastRatio(colors.secondaryLabel, colors[ground]);
      expect(secondaryRatio ?? 0, `${paletteName}.${scheme}: secondaryLabel on ${ground}`).toBeGreaterThanOrEqual(
        AA_BODY,
      );

      // Tertiary is reserved for de-emphasised, large or non-essential glyphs,
      // so it is held to the AA large-text / UI-component bar.
      const tertiaryRatio = contrastRatio(colors.tertiaryLabel, colors[ground]);
      expect(tertiaryRatio ?? 0, `${paletteName}.${scheme}: tertiaryLabel on ${ground}`).toBeGreaterThanOrEqual(
        AA_LARGE,
      );
    }
  });

  it.each(SCHEMES)(`keeps the interactive accent legible in %s`, (scheme) => {
    const colors = palette[scheme];
    // `accent` is link/affordance text on the base ground — the reason the dark
    // sets lift the violet to #A78BFA instead of reusing #6D28D9.
    const ratio = contrastRatio(colors.accent, colors.background);
    expect(ratio ?? 0, `${paletteName}.${scheme}: accent on background`).toBeGreaterThanOrEqual(AA_LARGE);
  });
});

describe('the regression this suite exists for', () => {
  it('fails a near-black label on the dark purple ground', () => {
    // Compose's `LocalContentColor` default, on `materialSurfaces.dark.background`.
    // This is what every un-coloured @expo/ui `<Text>` rendered as.
    const ratio = contrastRatio('#1D1B20', materialSurfaces.dark.background);
    expect(ratio ?? 0).toBeLessThan(AA_LARGE);
  });
});
