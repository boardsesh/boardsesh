import { describe, expect, it } from 'vitest';
import { getBoardSizesForLayoutId } from '@boardsesh/board-config';
import { SETUP_MENU_MAX_OPTIONS, setupRowControl } from '../setup-option-handoff';
import { readSetupOptionNumber, setupOptionRows } from '../setup-option-rows';

describe('setupRowControl', () => {
  it.each([
    { count: 1, control: 'menu' },
    { count: SETUP_MENU_MAX_OPTIONS, control: 'menu' },
    { count: SETUP_MENU_MAX_OPTIONS + 1, control: 'list' },
    // Kilter Homewall's sizes.
    { count: 10, control: 'list' },
  ])('$count options open a $control', ({ count, control }) => {
    expect(setupRowControl(count)).toBe(control);
  });

  it('sends Kilter Homewall sizes to the checklist and every other row to a menu', () => {
    expect(setupRowControl(getBoardSizesForLayoutId('kilter', 8).length)).toBe('list');
    expect(setupRowControl(getBoardSizesForLayoutId('kilter', 1).length)).toBe('menu');
  });
});

describe('setupOptionRows', () => {
  it("lists a layout's sizes with art for each", () => {
    const rows = setupOptionRows('size', 'kilter', 8);
    expect(rows).toHaveLength(getBoardSizesForLayoutId('kilter', 8).length);
    for (const row of rows) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.art?.layoutId).toBe(8);
      expect(row.art?.sizeId).toBe(row.value);
    }
  });

  it('lists the layouts, each drawn at its first size', () => {
    const rows = setupOptionRows('layout', 'tension', null);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.art?.layoutId).toBe(row.value);
  });

  it('lists no sizes without a layout', () => {
    expect(setupOptionRows('size', 'kilter', null)).toEqual([]);
  });

  it.each([
    { value: '8', expected: 8 },
    { value: '', expected: null },
    { value: undefined, expected: null },
    { value: '1.5', expected: null },
    { value: 'abc', expected: null },
  ])('reads $value as $expected', ({ value, expected }) => {
    expect(readSetupOptionNumber(value)).toBe(expected);
  });
});
