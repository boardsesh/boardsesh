import { describe, it, expect } from 'vitest';
import { gradeSortValue } from '../grade-sort-value';

describe('gradeSortValue', () => {
  it('orders V-only labels numerically, not alphabetically', () => {
    const sorted = ['V10', 'V2', 'V0'].sort((a, b) => gradeSortValue(a) - gradeSortValue(b));
    expect(sorted).toEqual(['V0', 'V2', 'V10']);
  });

  it('breaks the V3 / V3+ tie via the font token on combined grades', () => {
    // "6a/V3" and "6a+/V3" both carry "/V3"; only the font "+" distinguishes them.
    const sorted = ['7a/V6', '6a+/V3', '6a/V3', '4a/V0'].sort((a, b) => gradeSortValue(a) - gradeSortValue(b));
    expect(sorted).toEqual(['4a/V0', '6a/V3', '6a+/V3', '7a/V6']);
  });

  it('orders font-only labels easy to hard, case-insensitively', () => {
    const sorted = ['7A', '6A+', '6A'].sort((a, b) => gradeSortValue(a) - gradeSortValue(b));
    expect(sorted).toEqual(['6A', '6A+', '7A']);
  });

  it('sorts unknown labels last', () => {
    expect(gradeSortValue('???')).toBe(Number.MAX_SAFE_INTEGER);
    const sorted = ['???', '6a/V3'].sort((a, b) => gradeSortValue(a) - gradeSortValue(b));
    expect(sorted).toEqual(['6a/V3', '???']);
  });
});
