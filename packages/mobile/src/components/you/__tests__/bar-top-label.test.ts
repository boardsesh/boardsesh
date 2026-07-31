// Issue #3779: the counts above the You -> Progress "Flash vs Redpoint" bars
// were clipped on a phone. Seven grade pairs across a 320pt card leave each bar
// about 13px wide, and gifted-charts boxes the top label to exactly one bar
// width, so "128" lost its digits. These pin the sizing decisions.
import { describe, expect, it } from 'vitest';
import { computeBarTopLabelLayout, estimateBarTopLabelWidth, longestBarValue } from '../bar-top-label';

describe('longestBarValue', () => {
  it('picks the value with the most digits, not the largest', () => {
    expect(longestBarValue([9, 128, 82])).toBe(128);
    expect(longestBarValue([])).toBe(0);
  });
});

describe('estimateBarTopLabelWidth', () => {
  it('grows with digit count and with the accessibility font scale', () => {
    expect(estimateBarTopLabelWidth(7)).toBeLessThan(estimateBarTopLabelWidth(82));
    expect(estimateBarTopLabelWidth(82)).toBeLessThan(estimateBarTopLabelWidth(128));
    expect(estimateBarTopLabelWidth(128, 1.5)).toBeGreaterThan(estimateBarTopLabelWidth(128));
  });
});

describe('computeBarTopLabelLayout', () => {
  it('leaves a single digit alone: no wider box, no rotation', () => {
    const layout = computeBarTopLabelLayout(7, 13, 16);
    expect(layout.rotated).toBe(false);
    expect(layout.width).toBe(13);
    expect(layout.left).toBe(0);
    expect(layout.headroom).toBe(0);
  });

  it('borrows the gap beside the bar when that is enough room', () => {
    // "82" needs ~18px: more than a 16px bar, but the 22px column has it.
    const layout = computeBarTopLabelLayout(82, 16, 22);
    expect(layout.rotated).toBe(false);
    expect(layout.width).toBeGreaterThan(16);
    expect(layout.width).toBeLessThanOrEqual(22);
    // Re-centred over its own bar, so the box overhangs both sides evenly.
    expect(layout.left).toBe(Math.round((16 - layout.width) / 2));
  });

  it('stands a three-digit count vertical when the column is a phone-width 13px', () => {
    const layout = computeBarTopLabelLayout(128, 13, 16);
    expect(layout.rotated).toBe(true);
    // The box has to be at least as wide as the text or the glyphs clip before
    // the rotation ever happens.
    expect(layout.width).toBeGreaterThanOrEqual(estimateBarTopLabelWidth(128));
    expect(layout.left).toBeLessThan(0);
    // Rotation pivots on the centre, so the label is lifted clear of the bar.
    expect(layout.marginBottom).toBeGreaterThan(2);
    expect(layout.headroom).toBeGreaterThan(0);
  });

  it('does not rotate the same count once the chart is zoomed and bars are wide', () => {
    const layout = computeBarTopLabelLayout(128, 40, 46);
    expect(layout.rotated).toBe(false);
    expect(layout.headroom).toBe(0);
  });

  it('rotates at a bar width that was fine, once accessibility text scales up', () => {
    expect(computeBarTopLabelLayout(128, 24, 30, 1).rotated).toBe(false);
    expect(computeBarTopLabelLayout(128, 24, 30, 1.5).rotated).toBe(true);
  });
});
