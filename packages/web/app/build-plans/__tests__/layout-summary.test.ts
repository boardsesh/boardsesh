import { describe, it, expect } from 'vite-plus/test';
import { readLayoutSummary } from '../configurator/layout-summary';

/**
 * A trimmed but otherwise faithful `LayoutResponse` from the pack generator:
 * snake_case Python, a `wall` block, a `bom_preview` block, a panel array and
 * a warnings array. Kept as a fixture rather than built field by field in each
 * test so the shape this module actually reads is written down once.
 */
const GENERATOR_LAYOUT = {
  wall: { width_mm: 3048, height_mm: 3658, kicker_height_mm: 305 },
  bom_preview: { sheets: 6, tnut_count: 812, led_count: 411, skipped_seam_leds: 7 },
  panels: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
  warnings: ['Kicker clearance is below the recommended 60 mm'],
  // A field this module has never heard of. The generator adds these as it
  // learns to build more walls, and none of them may break the summary.
  toolpath_hints: { plunge_rate_mm_s: 4 },
};

describe('readLayoutSummary', () => {
  it('pulls every summary number out of a generator response', () => {
    expect(readLayoutSummary(GENERATOR_LAYOUT)).toEqual({
      wallWidthMm: 3048,
      wallHeightMm: 3658,
      kickerHeightMm: 305,
      panelCount: 4,
      panels: [
        { index: 0, id: null, role: null, xMm: null, yMm: null, widthMm: null, heightMm: null },
        { index: 1, id: null, role: null, xMm: null, yMm: null, widthMm: null, heightMm: null },
        { index: 2, id: null, role: null, xMm: null, yMm: null, widthMm: null, heightMm: null },
        { index: 3, id: null, role: null, xMm: null, yMm: null, widthMm: null, heightMm: null },
      ],
      sheets: 6,
      tnutCount: 812,
      ledCount: 411,
      skippedSeamLeds: 7,
      warnings: ['Kicker clearance is below the recommended 60 mm'],
    });
  });

  it('is unaffected by a field the generator added', () => {
    const withNewField = { ...GENERATOR_LAYOUT, bom_preview: { ...GENERATOR_LAYOUT.bom_preview, glue_litres: 2.5 } };

    expect(readLayoutSummary(withNewField).sheets).toBe(6);
  });

  it('nulls a renamed field instead of crashing the configurator', () => {
    // The cost of a generator rename is one missing row in a preview card, not
    // a page that fails to render before anyone can buy anything.
    const renamed = { ...GENERATOR_LAYOUT, wall: { width_millimetres: 3048, height_mm: 3658 } };

    const summary = readLayoutSummary(renamed);
    expect(summary.wallWidthMm).toBeNull();
    expect(summary.wallHeightMm).toBe(3658);
  });

  it('rejects numbers that are not finite', () => {
    const broken = { wall: { width_mm: Number.NaN, height_mm: Number.POSITIVE_INFINITY } };

    expect(readLayoutSummary(broken).wallWidthMm).toBeNull();
    expect(readLayoutSummary(broken).wallHeightMm).toBeNull();
  });

  it('drops non-string warnings rather than rendering them', () => {
    const noisy = { ...GENERATOR_LAYOUT, warnings: ['a real warning', 42, null, { message: 'an object' }] };

    expect(readLayoutSummary(noisy).warnings).toEqual(['a real warning']);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not a layout'],
    ['an array', []],
    ['an empty object', {}],
  ])('returns an all-null summary for %s', (_label, layout) => {
    expect(readLayoutSummary(layout)).toEqual({
      wallWidthMm: null,
      wallHeightMm: null,
      kickerHeightMm: null,
      panelCount: null,
      panels: [],
      sheets: null,
      tnutCount: null,
      ledCount: null,
      skippedSeamLeds: null,
      warnings: [],
    });
  });
});
