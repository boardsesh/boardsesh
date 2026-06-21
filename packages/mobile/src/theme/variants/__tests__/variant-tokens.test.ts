// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// variant-tokens pulls in the theme colour modules (colors.ts / ios-colors.ts),
// which read Platform/PlatformColor at import. jsdom can't satisfy react-native,
// so stub the surface they touch — Platform.OS='android' takes colors.ts down its
// non-PlatformColor fallback path. Mirrors theme-provider.test.tsx.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
}));

import { selectByVariant } from '../select-by-variant';
import {
  resolveActionColors,
  resolveChartColors,
  sectionCaptionByVariant,
  applySectionCaption,
} from '../variant-tokens';

describe('selectByVariant', () => {
  it('returns the value for the active variant', () => {
    expect(selectByVariant('liquidGlass', { liquidGlass: 'a', material: 'b' })).toBe('a');
    expect(selectByVariant('material', { liquidGlass: 'a', material: 'b' })).toBe('b');
  });
});

describe('resolveActionColors', () => {
  const inputs = { label: '#LABEL', accent: '#ACCENT', brandSuccess: '#SUCCESS', brandPrimary: '#PRIMARY' };

  it('renders every role monochrome (label) on Liquid Glass', () => {
    const colors = resolveActionColors('liquidGlass', inputs);
    expect([colors.neutral, colors.success, colors.favorite, colors.accent, colors.pin]).toEqual([
      '#LABEL',
      '#LABEL',
      '#LABEL',
      '#LABEL',
      '#LABEL',
    ]);
  });

  it('tints each role by semantic meaning on Material', () => {
    const colors = resolveActionColors('material', inputs);
    expect(colors.neutral).toBe('#LABEL');
    expect(colors.success).toBe('#SUCCESS');
    expect(colors.accent).toBe('#ACCENT');
    expect(colors.pin).toBe('#PRIMARY');
    expect(colors.favorite).toBe('#FF3B30'); // static iOS systemRed
  });
});

describe('resolveChartColors', () => {
  it('returns plain-string palettes for every variant + scheme', () => {
    expect(typeof resolveChartColors('material', 'light').separator).toBe('string');
    expect(typeof resolveChartColors('material', 'dark').secondaryLabel).toBe('string');
    expect(typeof resolveChartColors('liquidGlass', 'light').tertiaryLabel).toBe('string');
    expect(typeof resolveChartColors('liquidGlass', 'dark').separator).toBe('string');
  });
});

describe('sectionCaptionByVariant / applySectionCaption', () => {
  it('uppercases on Liquid Glass and leaves sentence case on Material', () => {
    expect(applySectionCaption('Today', sectionCaptionByVariant.liquidGlass).text).toBe('TODAY');
    expect(applySectionCaption('Today', sectionCaptionByVariant.material).text).toBe('Today');
  });

  it('carries the dim/tracked treatment on Liquid Glass only', () => {
    expect(applySectionCaption('x', sectionCaptionByVariant.liquidGlass).style).toEqual({
      opacity: 0.6,
      letterSpacing: 0.5,
    });
    expect(applySectionCaption('x', sectionCaptionByVariant.material).style).toEqual({ opacity: 1, letterSpacing: 0 });
  });

  it('declares every variant (exhaustive map)', () => {
    expect(Object.keys(sectionCaptionByVariant).sort()).toEqual(['liquidGlass', 'material']);
  });
});
