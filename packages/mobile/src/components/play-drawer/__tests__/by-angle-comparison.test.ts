import { describe, it, expect } from 'vitest';
import type { BoardseshGradeAtAngle } from '@boardsesh/graphql/operations';
import type { AngleGradeBar } from '../community-utils';
import {
  buildDumbbellByAngleModel,
  buildDumbbellAxis,
  sizeBinForSends,
  hasAnyBoardseshDiamond,
  BLANK_TICK,
} from '../by-angle-comparison';
import { MAX_DIFFICULTY_ID, MIN_DIFFICULTY_ID } from '../../../lib/boardsesh-grade-display';

// 20 = 6c/V5, 22 = 7a/V6 on the shared difficulty scale.
function bsRow(overrides: Partial<BoardseshGradeAtAngle> = {}): BoardseshGradeAtAngle {
  return {
    angle: 40,
    localGrade: 20,
    universalGrade: 20,
    gradeLow: 20,
    gradeHigh: 20,
    confidence: 'confirmed',
    ascensionistCount: 30,
    modelVersion: 'v1',
    computedAt: '2026-01-01',
    ...overrides,
  };
}

function crowdBar(overrides: Partial<AngleGradeBar> = {}): AngleGradeBar {
  return { angle: 40, difficulty: 20, gradeName: 'V5', sends: 30, ...overrides };
}

describe('sizeBinForSends', () => {
  it('bins by ascent count: <5 small, 5–20 medium, >20 large', () => {
    expect(sizeBinForSends(0)).toBe('small');
    expect(sizeBinForSends(4)).toBe('small');
    expect(sizeBinForSends(5)).toBe('medium');
    expect(sizeBinForSends(20)).toBe('medium');
    expect(sizeBinForSends(21)).toBe('large');
    expect(sizeBinForSends(2000)).toBe('large');
  });
});

describe('buildDumbbellByAngleModel', () => {
  it('returns an empty model for no data', () => {
    expect(buildDumbbellByAngleModel([], [], 'v-grade')).toEqual([]);
  });

  it('joins crowd and Boardsesh at the same angle and sorts by angle', () => {
    const rows = buildDumbbellByAngleModel(
      [bsRow({ angle: 45, universalGrade: 22 }), bsRow({ angle: 20, universalGrade: 20 })],
      [crowdBar({ angle: 45, difficulty: 22, gradeName: 'V6' }), crowdBar({ angle: 20, difficulty: 20 })],
      'v-grade',
    );
    expect(rows.map((row) => row.angle)).toEqual([20, 45]);
    expect(rows[0]).toMatchObject({
      angle: 20,
      crowdLabel: 'V5',
      boardseshLabel: 'V5',
      hasCrowd: true,
      hasBoardsesh: true,
    });
    expect(rows[1]).toMatchObject({ angle: 45, crowdLabel: 'V6', boardseshLabel: 'V6' });
  });

  it('detects agreement when crowd and Boardsesh round to the same grade', () => {
    const [row] = buildDumbbellByAngleModel(
      [bsRow({ universalGrade: 20.3 })],
      [crowdBar({ difficulty: 19.8 })],
      'v-grade',
    );
    // Both round to V5.
    expect(row.agree).toBe(true);
  });

  it('does not mark agreement when the grades round apart', () => {
    const [row] = buildDumbbellByAngleModel(
      [bsRow({ universalGrade: 20 })],
      [crowdBar({ difficulty: 22, gradeName: 'V6' })],
      'v-grade',
    );
    expect(row.agree).toBe(false);
    expect(row.crowdLabel).toBe('V6');
    expect(row.boardseshLabel).toBe('V5');
  });

  it('prefers the universal grade over the local grade for the diamond', () => {
    const [row] = buildDumbbellByAngleModel([bsRow({ universalGrade: 22, localGrade: 20 })], [], 'v-grade');
    expect(row.boardseshGrade).toBe(22);
    expect(row.boardseshLabel).toBe('V6');
  });

  it('falls back to the local grade when there is no universal grade', () => {
    const [row] = buildDumbbellByAngleModel([bsRow({ universalGrade: null, localGrade: 20 })], [], 'v-grade');
    expect(row.boardseshGrade).toBe(20);
    expect(row.boardseshLabel).toBe('V5');
  });

  it('draws no diamond for a setter_only Boardsesh row but keeps the crowd ring', () => {
    const [row] = buildDumbbellByAngleModel(
      [bsRow({ confidence: 'setter_only' })],
      [crowdBar({ difficulty: 20 })],
      'v-grade',
    );
    expect(row).toMatchObject({ hasCrowd: true, hasBoardsesh: false, tier: 'setter_only' });
    expect(row.boardseshGrade).toBeNull();
    expect(row.crowdLabel).toBe('V5');
  });

  it('drops an angle that has neither a crowd grade nor a Boardsesh diamond', () => {
    const rows = buildDumbbellByAngleModel([bsRow({ angle: 40, confidence: 'setter_only' })], [], 'v-grade');
    expect(rows).toEqual([]);
  });

  it('keeps a lone crowd ring when Boardsesh has no row at that angle', () => {
    const [row] = buildDumbbellByAngleModel([], [crowdBar({ angle: 30, difficulty: 20, sends: 12 })], 'v-grade');
    expect(row).toMatchObject({ angle: 30, hasCrowd: true, hasBoardsesh: false, tier: null, agree: false });
    expect(row.sizeBin).toBe('medium');
  });

  it('keeps a lone Boardsesh diamond when the crowd has no bar at that angle', () => {
    const [row] = buildDumbbellByAngleModel([bsRow({ angle: 35, universalGrade: 22 })], [], 'v-grade');
    expect(row).toMatchObject({ angle: 35, hasCrowd: false, hasBoardsesh: true, crowdGrade: null });
  });

  it('sizes a joined angle by the larger of crowd and Boardsesh counts', () => {
    const [row] = buildDumbbellByAngleModel([bsRow({ ascensionistCount: 40 })], [crowdBar({ sends: 3 })], 'v-grade');
    expect(row.sends).toBe(40);
    expect(row.sizeBin).toBe('large');
  });

  it('carries the provisional whisker bounds only when a diamond is drawn', () => {
    const [withDiamond] = buildDumbbellByAngleModel(
      [bsRow({ confidence: 'provisional', universalGrade: 20, gradeLow: 18, gradeHigh: 22 })],
      [],
      'v-grade',
    );
    expect(withDiamond).toMatchObject({ tier: 'provisional', gradeLow: 18, gradeHigh: 22 });

    const [setterOnly] = buildDumbbellByAngleModel(
      [bsRow({ confidence: 'setter_only', gradeLow: 18, gradeHigh: 22 })],
      [crowdBar()],
      'v-grade',
    );
    expect(setterOnly.gradeLow).toBeNull();
    expect(setterOnly.gradeHigh).toBeNull();
  });

  it('tints the diamond by its own grade colour', () => {
    const [row] = buildDumbbellByAngleModel([bsRow({ universalGrade: 20 })], [], 'v-grade');
    expect(row.boardseshColor).toMatch(/^#/);
  });
});

describe('hasAnyBoardseshDiamond', () => {
  it('is false when every row is crowd-only', () => {
    const rows = buildDumbbellByAngleModel([], [crowdBar({ angle: 30 }), crowdBar({ angle: 40 })], 'v-grade');
    expect(hasAnyBoardseshDiamond(rows)).toBe(false);
  });

  it('is true when any row carries a diamond', () => {
    const rows = buildDumbbellByAngleModel([bsRow({ angle: 40 })], [crowdBar({ angle: 30 })], 'v-grade');
    expect(hasAnyBoardseshDiamond(rows)).toBe(true);
  });
});

/** The ticks that actually print a grade — the rest are BLANK_TICK gridlines. */
const visibleLabels = (axis: { yAxisLabelTexts: string[] }): string[] =>
  axis.yAxisLabelTexts.filter((label) => label !== BLANK_TICK);

describe('buildDumbbellAxis', () => {
  it('spans the plotted values with grade headroom on each side', () => {
    const rows = buildDumbbellByAngleModel(
      [bsRow({ angle: 40, universalGrade: 22 })],
      [crowdBar({ angle: 40, difficulty: 20 })],
      'v-grade',
    );
    const axis = buildDumbbellAxis(rows, 'v-grade');
    // Values 20 and 22, padded by two ids each side → window contains 18..24.
    expect(axis.minId).toBeLessThanOrEqual(18);
    expect(axis.maxId).toBeGreaterThanOrEqual(24);
    expect(axis.yAxisLabelTexts).toHaveLength(axis.noOfSections + 1);
    // A V-grade spanning several ids is labelled once; the shown labels never repeat.
    const shown = visibleLabels(axis);
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown).size).toBe(shown.length);
    expect(axis.maxValue).toBe(axis.maxId - axis.minId);
  });

  it('includes the whisker bounds in the span', () => {
    const rows = buildDumbbellByAngleModel(
      [bsRow({ angle: 40, confidence: 'provisional', universalGrade: 20, gradeLow: 16, gradeHigh: 24 })],
      [],
      'v-grade',
    );
    const axis = buildDumbbellAxis(rows, 'v-grade');
    // gradeLow 16 and gradeHigh 24 both fall inside the padded window.
    expect(axis.minId).toBeLessThanOrEqual(16);
    expect(axis.maxId).toBeGreaterThanOrEqual(24);
  });

  it('blanks a repeated tick with a space, never an empty string', () => {
    // gifted prints its numeric fallback for an empty y label, so a bare "" tick
    // renders as a stray "0" (#4164). A V-grade covering three ids means repeats
    // are unavoidable once there is a gridline per id — they must blank as " ".
    const rows = buildDumbbellByAngleModel(
      [
        bsRow({ angle: 20, universalGrade: 12, gradeLow: 12, gradeHigh: 12 }),
        bsRow({ angle: 45, universalGrade: 22, gradeLow: 22, gradeHigh: 22 }),
      ],
      [
        crowdBar({ angle: 20, difficulty: 12, gradeName: 'V0' }),
        crowdBar({ angle: 45, difficulty: 22, gradeName: 'V6' }),
      ],
      'v-grade',
    );
    const axis = buildDumbbellAxis(rows, 'v-grade');
    const labels = axis.yAxisLabelTexts;
    expect(labels).toHaveLength(axis.noOfSections + 1);
    expect(labels).not.toContain('');
    expect(labels.filter((label) => label === BLANK_TICK).length).toBeGreaterThan(0);
    // Strictly increasing V-numbers bottom→top across the labelled ticks.
    const vNumbers = visibleLabels(axis).map((label) => Number.parseInt(label.replace(/[^0-9]/g, ''), 10));
    for (let i = 1; i < vNumbers.length; i++) expect(vNumbers[i]).toBeGreaterThan(vNumbers[i - 1]);
    // Marker geometry invariant: a grade float plots at `grade - minId` in the span.
    expect(axis.maxValue).toBe(axis.maxId - axis.minId);
  });

  it('puts a gridline on every Font grade so French readers see each one', () => {
    // The whole point of #4164 (3): difficulty ids map 1:1 to Font grades, so a
    // line per id means a labelled line per French grade — including the
    // climb's own, which the old evenly-spaced ticks could skip entirely.
    const rows = buildDumbbellByAngleModel(
      [bsRow({ angle: 40, universalGrade: 22, gradeLow: 22, gradeHigh: 22 })],
      [crowdBar({ angle: 40, difficulty: 20 })],
      'font',
    );
    const axis = buildDumbbellAxis(rows, 'font');
    const labels = axis.yAxisLabelTexts;
    // Every tick in this narrow window is its own Font grade — nothing blank.
    expect(labels).toHaveLength(axis.noOfSections + 1);
    expect(labels).not.toContain(BLANK_TICK);
    expect(new Set(labels).size).toBe(labels.length);
    // The climb's own grades (id 20 = 6C, id 22 = 7A) are both on a tick.
    expect(labels).toContain('6C');
    expect(labels).toContain('7A');
  });

  it('coarsens the gridlines on a very wide span, keeping the true top grade', () => {
    // A window spanning ~V0…V16 has far too many ids for one line each; the axis
    // steps up to 2 ids per line and eats the leftover at the BOTTOM so the top
    // tick still reads the hardest real grade.
    const rows = buildDumbbellByAngleModel(
      [
        bsRow({ angle: 20, universalGrade: 12, gradeLow: 12, gradeHigh: 12 }),
        bsRow({ angle: 45, universalGrade: 33, gradeLow: 33, gradeHigh: 33 }),
      ],
      [],
      'v-grade',
    );
    const axis = buildDumbbellAxis(rows, 'v-grade');
    const labels = axis.yAxisLabelTexts;
    expect(axis.noOfSections).toBeLessThanOrEqual(12); // capped
    expect(labels).toHaveLength(axis.noOfSections + 1);
    expect(labels).not.toContain('');
    expect(labels[labels.length - 1]).toBe('V16'); // truthful top grade
    const shown = visibleLabels(axis);
    expect(new Set(shown).size).toBe(shown.length); // no repeats among the labelled ticks
  });

  it('keeps a V0 climb off the x-axis instead of clamping the padding away', () => {
    // #4164 (2): the window used to clamp at the easiest real grade, so a V0
    // climb's markers landed exactly on the axis line, on top of the angle
    // labels. The bottom padding now runs below the scale, unlabelled.
    const rows = buildDumbbellByAngleModel(
      [bsRow({ angle: 40, universalGrade: 10, gradeLow: 10, gradeHigh: 10 })],
      [crowdBar({ angle: 40, difficulty: 10, gradeName: 'V0' })],
      'v-grade',
    );
    const axis = buildDumbbellAxis(rows, 'v-grade');
    expect(axis.minId).toBeLessThan(MIN_DIFFICULTY_ID); // real clearance under the marker
    expect(axis.yAxisLabelTexts[0]).toBe(BLANK_TICK); // no grade exists down there
    expect(axis.yAxisLabelTexts).not.toContain('');
    // The easiest real grade still gets its own labelled line.
    expect(visibleLabels(axis)[0]).toBe('V0');
  });

  it('widens the y-axis gutter for the longer both-formats labels', () => {
    const rows = buildDumbbellByAngleModel(
      [bsRow({ angle: 40, universalGrade: 30, gradeLow: 30, gradeHigh: 30 })],
      [crowdBar({ angle: 40, difficulty: 30 })],
      'both',
    );
    const single = buildDumbbellAxis(rows, 'v-grade');
    const both = buildDumbbellAxis(rows, 'both');
    expect(both.yAxisLabelWidth).toBeGreaterThan(single.yAxisLabelWidth);
    expect(visibleLabels(both)[0]).toContain(' / ');
  });

  it('never crowds past the gridline cap, for any pair of grades on the scale', () => {
    // The step coarsens to at most 3 ids per line and then stretches the window
    // down to a whole number of steps, which could in principle overshoot the
    // cap. Sweep every low/high pair the real scale can produce instead of
    // trusting one hand-picked span.
    for (let low = MIN_DIFFICULTY_ID; low <= MAX_DIFFICULTY_ID; low++) {
      for (let high = low; high <= MAX_DIFFICULTY_ID; high++) {
        const rows = buildDumbbellByAngleModel(
          [
            bsRow({ angle: 20, universalGrade: low, gradeLow: low, gradeHigh: low }),
            bsRow({ angle: 45, universalGrade: high, gradeLow: high, gradeHigh: high }),
          ],
          [],
          'v-grade',
        );
        const axis = buildDumbbellAxis(rows, 'v-grade');
        expect(axis.noOfSections).toBeLessThanOrEqual(12);
        expect(axis.noOfSections).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(axis.noOfSections)).toBe(true);
        // The invariant every marker's y position depends on.
        expect(axis.maxValue).toBe(axis.maxId - axis.minId);
        expect(axis.yAxisLabelTexts).toHaveLength(axis.noOfSections + 1);
        expect(axis.yAxisLabelTexts).not.toContain('');
        // The bottom always clears the lowest marker — that's the #4164 fix.
        expect(axis.minId).toBeLessThan(low);
        // The top only clears it while there's a harder grade to climb to. A V16
        // sits on the top line by design: the alternative is a top tick labelled
        // with a grade that doesn't exist, and unlike the bottom there's no axis
        // line or label row up there to collide with.
        if (high < MAX_DIFFICULTY_ID) expect(axis.maxId).toBeGreaterThan(high);
        else expect(axis.maxId).toBe(MAX_DIFFICULTY_ID);
      }
    }
  });

  it('returns a safe default window for an empty model', () => {
    const axis = buildDumbbellAxis([], 'v-grade');
    expect(axis.noOfSections).toBeGreaterThanOrEqual(1);
    expect(axis.yAxisLabelTexts).toHaveLength(axis.noOfSections + 1);
  });

  it('keeps the top tick truthful at the top of the scale', () => {
    // Boardsesh grades V6 (id 22) and V16 (id 33, the top of the scale). Padding
    // clamps the window to [20, 33]; the top id can't grow past 33, so the top
    // tick is a real V16 (never a clamped-from-34 false label) and the
    // marker-geometry invariant (maxId − minId === maxValue) holds.
    const rows = buildDumbbellByAngleModel(
      [
        bsRow({ angle: 20, universalGrade: 22, gradeLow: 22, gradeHigh: 22 }),
        bsRow({ angle: 45, universalGrade: 33, gradeLow: 33, gradeHigh: 33 }),
      ],
      [],
      'v-grade',
    );
    const axis = buildDumbbellAxis(rows, 'v-grade');
    expect(axis.maxId).toBeLessThanOrEqual(MAX_DIFFICULTY_ID); // never past the hardest real grade
    expect(axis.maxId).toBe(axis.minId + axis.maxValue); // marker geometry stays consistent
    expect(axis.yAxisLabelTexts[axis.yAxisLabelTexts.length - 1]).toBe('V16'); // truthful top tick
  });
});
