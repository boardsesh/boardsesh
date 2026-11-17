import { describe, expect, it } from 'vitest';

// No react-native mock: the module must load without one (the chart and
// live-rail layout modules import it from tests that have none).
import { dynamicTypeRamps, rampFontScale, textFontScale } from '../dynamic-type';

// React Native's fontScale per content size category (RCTAccessibilityManager.mm).
const XXXLARGE = 1.353;
const AX1 = 1.786;
const AX3 = 2.643;
const AX5 = 3.571;

describe('rampFontScale', () => {
  it('is 1 for every ramp at the default size', () => {
    for (const ramp of new Set(Object.values(dynamicTypeRamps))) {
      expect(rampFontScale(ramp, 1)).toBe(1);
    }
  });

  it("matches React Native's own table for body up to xxxLarge", () => {
    // xSmall, Small, Medium, xLarge, xxLarge, xxxLarge: 14, 15, 16, 19, 21, 23 over 17.
    for (const fontScale of [0.823, 0.882, 0.941, 1.118, 1.235, XXXLARGE]) {
      expect(rampFontScale('body', fontScale)).toBeCloseTo(fontScale, 2);
    }
  });

  it("falls behind React Native's table for body at the accessibility sizes", () => {
    expect(rampFontScale('body', AX1)).toBeCloseTo(28 / 17, 5);
    expect(rampFontScale('body', AX3)).toBeCloseTo(40 / 17, 5);
    expect(rampFontScale('body', AX5)).toBeCloseTo(53 / 17, 5);
    expect(rampFontScale('body', AX3)).toBeLessThan(AX3 * 0.9);
  });

  it('grows titles less and captions more than body, as UIKit does', () => {
    expect(rampFontScale('largeTitle', AX3)).toBeCloseTo(52 / 34, 5);
    expect(rampFontScale('title1', XXXLARGE)).toBeCloseTo(34 / 28, 5);
    expect(rampFontScale('caption2', XXXLARGE)).toBeCloseTo(17 / 11, 5);
    expect(rampFontScale('footnote', AX3)).toBeCloseTo(33 / 13, 5);
  });

  it('interpolates between two categories and scales on past either end', () => {
    const between = rampFontScale('body', (XXXLARGE + AX1) / 2);
    expect(between).toBeGreaterThan(23 / 17);
    expect(between).toBeLessThan(28 / 17);
    expect(rampFontScale('body', AX5 * 2)).toBeCloseTo((53 / 17) * 2, 5);
    expect(rampFontScale('body', 0.823 / 2)).toBeCloseTo(14 / 17 / 2, 5);
  });
});

describe('textFontScale', () => {
  it("follows the variant's ramp on iOS; a bar label follows body", () => {
    expect(textFontScale('title1', AX3, 'ios')).toBeCloseTo(48 / 28, 5);
    expect(textFontScale('label', AX3, 'ios')).toBeCloseTo(40 / 17, 5);
  });

  it('is fontScale itself off iOS, where Text has no ramp', () => {
    expect(textFontScale('title1', AX3, 'android')).toBe(AX3);
    expect(textFontScale('caption2', 1.3, 'web')).toBe(1.3);
  });
});
