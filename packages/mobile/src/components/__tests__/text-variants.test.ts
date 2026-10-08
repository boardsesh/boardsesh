import { describe, it, expect, vi } from 'vitest';

// Mock react-native so StyleSheet.create is a pass-through identity function.
vi.mock('react-native', () => ({
  Text: 'Text',
  StyleSheet: {
    create: <T extends Record<string, Record<string, unknown>>>(styles: T): T => styles,
  },
}));

// Text reads its default colour from the theme provider. Stub it so importing
// Text doesn't pull in the full provider chain (SecureStore / key-value-storage)
// in this typography-only unit test.
vi.mock('../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
}));

// Import after mock so StyleSheet.create returns raw objects
import { variantStyles, type TextVariant } from '../Text';

// ── Helpers ─────────────────────────────────────────────────────────────

const allVariantNames: TextVariant[] = [
  'largeTitle',
  'title1',
  'title2',
  'title3',
  'headline',
  'body',
  'callout',
  'subheadline',
  'footnote',
  'caption1',
  'caption2',
];

// ── Tests ───────────────────────────────────────────────────────────────

describe('variantStyles', () => {
  it('defines the 11 Apple HIG text variants plus the top-bar label', () => {
    const definedVariants = Object.keys(variantStyles);
    expect(definedVariants).toHaveLength(12);
    for (const variant of allVariantNames) {
      expect(variantStyles[variant]).toBeDefined();
    }
    // Not part of the size ladder below: a bar label is body-sized on iOS.
    expect(variantStyles.label).toEqual({ fontSize: 17, fontWeight: '400', lineHeight: 22 });
  });

  it.each(allVariantNames)('variant "%s" has fontSize, fontWeight, and lineHeight', (variant) => {
    const style = variantStyles[variant];
    expect(typeof style.fontSize).toBe('number');
    expect(typeof style.fontWeight).toBe('string');
    expect(typeof style.lineHeight).toBe('number');
  });

  it.each(allVariantNames)('variant "%s" has lineHeight greater than fontSize', (variant) => {
    const style = variantStyles[variant];
    expect(style.lineHeight).toBeGreaterThan(style.fontSize as number);
  });

  it('font sizes follow Apple HIG scale', () => {
    expect(variantStyles.largeTitle.fontSize).toBe(34);
    expect(variantStyles.title1.fontSize).toBe(28);
    expect(variantStyles.title2.fontSize).toBe(22);
    expect(variantStyles.title3.fontSize).toBe(20);
    expect(variantStyles.headline.fontSize).toBe(17);
    expect(variantStyles.body.fontSize).toBe(17);
    expect(variantStyles.callout.fontSize).toBe(16);
    expect(variantStyles.subheadline.fontSize).toBe(15);
    expect(variantStyles.footnote.fontSize).toBe(13);
    expect(variantStyles.caption1.fontSize).toBe(12);
    expect(variantStyles.caption2.fontSize).toBe(11);
  });

  it('font sizes decrease monotonically from largeTitle through caption2 (headline=body tie allowed)', () => {
    const sizes = allVariantNames.map((variant) => variantStyles[variant].fontSize as number);
    for (let index = 1; index < sizes.length; index++) {
      expect(sizes[index]).toBeLessThanOrEqual(sizes[index - 1]);
    }
  });
});
