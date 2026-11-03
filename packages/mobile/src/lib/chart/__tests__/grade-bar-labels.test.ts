// Issue #4164 (4), second attempt. The first fix stood the grade labels on end
// when they outgrew their column; on a real board — fifteen angles, each bar
// about 14px — that produced a row of unreadable vertical smudges (Marco's
// screenshot on the PR). Grades repeat across neighbouring angles, so printing
// fewer of them upright beats printing all of them sideways. These pin that.
import { describe, expect, it } from 'vitest';
import { buildGradeBarLabels } from '../grade-bar-labels';

/** A 15-angle board on a phone: ~14px bars with a 6px gap. */
const PHONE_BAR = 14;
const PHONE_COLUMN = 20;
/** A 5-angle climb: bars are roughly four times as wide. */
const ROOMY_BAR = 56;
const ROOMY_COLUMN = 68;

/** Grades rising with angle, the way a real climb's do. */
const RISING = ['V3', 'V3', 'V4', 'V4', 'V5', 'V5', 'V6', 'V6', 'V7', 'V7', 'V8', 'V9', 'V10', 'V10', 'V10'];

const labelled = (labels: { linesByBar: string[][] }): number =>
  labels.linesByBar.filter((lines) => lines.length > 0).length;

describe('buildGradeBarLabels', () => {
  it('labels every bar when the grade fits its own column', () => {
    const labels = buildGradeBarLabels(['V4', 'V5', 'V6'], ROOMY_BAR, ROOMY_COLUMN);
    expect(labels.columnsPerLabel).toBe(1);
    expect(labels.stacked).toBe(false);
    expect(labels.linesByBar).toEqual([['V4'], ['V5'], ['V6']]);
    expect(labels.headroom).toBe(0);
  });

  it('thins the row out rather than rotating when fifteen angles crowd it', () => {
    const labels = buildGradeBarLabels(RISING, PHONE_BAR, PHONE_COLUMN);
    // "V10" is wider than a 20px column, so labels have to be spaced out.
    expect(labels.columnsPerLabel).toBeGreaterThan(1);
    expect(labelled(labels)).toBeLessThan(RISING.length);
    // Whatever survives is upright and whole — never a fragment.
    for (const lines of labels.linesByBar) {
      for (const line of lines) expect(RISING).toContain(line);
    }
  });

  it('leaves at least one column of clear air between the labels it keeps', () => {
    const labels = buildGradeBarLabels(RISING, PHONE_BAR, PHONE_COLUMN);
    const indices = labels.linesByBar.flatMap((lines, index) => (lines.length > 0 ? [index] : []));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i] - indices[i - 1]).toBeGreaterThanOrEqual(labels.columnsPerLabel);
    }
  });

  it('always names the first bar, so the row starts with a grade', () => {
    const labels = buildGradeBarLabels(RISING, PHONE_BAR, PHONE_COLUMN);
    expect(labels.linesByBar[0]).toEqual(['V3']);
  });

  it('spends its labels on grade changes, not on repeats', () => {
    const labels = buildGradeBarLabels(RISING, PHONE_BAR, PHONE_COLUMN);
    const shown = labels.linesByBar.flatMap((lines) => lines);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('stacks a both-formats grade instead of thinning, when stacking is enough', () => {
    const both = Array.from({ length: 15 }, () => 'V6 / 7A');
    const labels = buildGradeBarLabels(both, PHONE_BAR, PHONE_COLUMN);
    // "V6 / 7A" is 41px, but "V6" and "7A" are 18px — inside a 20px column.
    expect(labels.stacked).toBe(true);
    expect(labels.columnsPerLabel).toBe(1);
    expect(labels.linesByBar[0]).toEqual(['V6', '7A']);
    expect(labelled(labels)).toBe(15);
    expect(labels.headroom).toBeGreaterThan(0);
  });

  it('stacks AND thins when even the halves outgrow a column', () => {
    const grades = ['V12 / 8A+', 'V12 / 8A+', 'V13 / 8B+', 'V13 / 8B+', 'V14 / 8B+'];
    const labels = buildGradeBarLabels(grades, 10, 14);
    expect(labels.stacked).toBe(true);
    expect(labels.columnsPerLabel).toBeGreaterThan(1);
    expect(labels.linesByBar[0]).toEqual(['V12', '8A+']);
  });

  it('keeps a one-line row one line high, so the plot keeps its height', () => {
    expect(buildGradeBarLabels(['V4', 'V5'], ROOMY_BAR, ROOMY_COLUMN).headroom).toBe(0);
  });

  it('centres a wider-than-bar box over the bar it belongs to', () => {
    const labels = buildGradeBarLabels(RISING, PHONE_BAR, PHONE_COLUMN);
    expect(labels.width).toBeGreaterThanOrEqual(PHONE_BAR);
    expect(labels.left).toBe(Math.round((PHONE_BAR - labels.width) / 2));
  });

  it('has nothing to say about an empty chart', () => {
    const labels = buildGradeBarLabels([], PHONE_BAR, PHONE_COLUMN);
    expect(labels.linesByBar).toEqual([]);
    expect(labels.columnsPerLabel).toBe(1);
  });
});
