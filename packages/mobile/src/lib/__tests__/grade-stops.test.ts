import { describe, expect, it } from 'vitest';
import { getGradeColor } from '@boardsesh/board-constants/grade-colors';
import { buildGradeRailStops, gradeBoundLabels } from '../grade-stops';

const SCALE = [
  { difficultyId: 10, name: '4a/V0' },
  { difficultyId: 11, name: '4b/V0' },
  { difficultyId: 12, name: '4c/V0' },
  { difficultyId: 13, name: '5a/V1' },
  { difficultyId: 14, name: '5b/V1' },
  { difficultyId: 15, name: '5c/V2' },
];

describe('buildGradeRailStops', () => {
  it('makes one stop of the grades that read the same under V grades', () => {
    expect(
      buildGradeRailStops(SCALE, 'v-grade').map(({ minGradeId, maxGradeId, label, gradeColor }) => ({
        minGradeId,
        maxGradeId,
        label,
        gradeColor,
      })),
    ).toEqual([
      { minGradeId: 10, maxGradeId: 12, label: 'V0', gradeColor: getGradeColor('V0') },
      { minGradeId: 13, maxGradeId: 14, label: 'V1', gradeColor: getGradeColor('V1') },
      { minGradeId: 15, maxGradeId: 15, label: 'V2', gradeColor: getGradeColor('V2') },
    ]);
  });

  it('keeps a label for each grade of a group that names that grade alone', () => {
    const [v0, v1, v2] = buildGradeRailStops(SCALE, 'v-grade');
    expect(v0.gradeLabels).toEqual([
      { difficultyId: 10, label: 'V0 / 4A' },
      { difficultyId: 11, label: 'V0 / 4B' },
      { difficultyId: 12, label: 'V0 / 4C' },
    ]);
    expect(v1.gradeLabels).toEqual([
      { difficultyId: 13, label: 'V1 / 5A' },
      { difficultyId: 14, label: 'V1 / 5B' },
    ]);
    // A one-grade stop needs no second name.
    expect(v2.gradeLabels).toEqual([{ difficultyId: 15, label: 'V2' }]);
  });

  it('names a grouped stop with the plain label, not the "V0 / 4A" fallback', () => {
    const labels = buildGradeRailStops(SCALE, 'v-grade').map((stop) => stop.label);
    expect(labels).toEqual(['V0', 'V1', 'V2']);
  });

  it('keeps every grade its own stop under Font grades', () => {
    const stops = buildGradeRailStops(SCALE, 'font');
    expect(stops.map((stop) => stop.label)).toEqual(['4A', '4B', '4C', '5A', '5B', '5C']);
    expect(stops.every((stop) => stop.minGradeId === stop.maxGradeId)).toBe(true);
  });

  it('keeps every grade its own stop with both formats shown', () => {
    const stops = buildGradeRailStops(SCALE, 'both');
    expect(stops).toHaveLength(SCALE.length);
    expect(new Set(stops.map((stop) => stop.label)).size).toBe(SCALE.length);
  });

  it('orders stops easiest first whatever order the grades arrive in', () => {
    const shuffled = [SCALE[5], SCALE[1], SCALE[3], SCALE[0], SCALE[4], SCALE[2]];
    expect(buildGradeRailStops(shuffled, 'v-grade')).toEqual(buildGradeRailStops(SCALE, 'v-grade'));
  });

  it('only groups neighbours: the same label further up the scale starts a new stop', () => {
    const scaleWithRepeat = [
      { difficultyId: 10, name: '4a/V0' },
      { difficultyId: 11, name: '5a/V1' },
      { difficultyId: 12, name: '4c/V0' },
    ];
    expect(buildGradeRailStops(scaleWithRepeat, 'v-grade').map((stop) => [stop.minGradeId, stop.maxGradeId])).toEqual([
      [10, 10],
      [11, 11],
      [12, 12],
    ]);
  });

  it('falls back to the raw name when the format cannot read a grade', () => {
    const [stop] = buildGradeRailStops([{ difficultyId: 40, name: 'Project' }], 'v-grade');
    expect(stop.label).toBe('Project');
  });

  it('returns no stops for no grades', () => {
    expect(buildGradeRailStops([], 'v-grade')).toEqual([]);
  });
});

describe('gradeBoundLabels', () => {
  const stops = buildGradeRailStops(SCALE, 'v-grade');
  const labels = (minGradeId: number | undefined, maxGradeId: number | undefined) =>
    gradeBoundLabels(stops, { minGradeId, maxGradeId });

  it('names a bound that is one whole stop by the stop', () => {
    expect(labels(10, 12)).toEqual({ min: 'V0', max: 'V0' });
    expect(labels(13, 14)).toEqual({ min: 'V1', max: 'V1' });
    expect(labels(15, 15)).toEqual({ min: 'V2', max: 'V2' });
  });

  it('names a range across whole stops by its two stops', () => {
    expect(labels(10, 15)).toEqual({ min: 'V0', max: 'V2' });
    expect(labels(10, 14)).toEqual({ min: 'V0', max: 'V1' });
    expect(labels(13, 15)).toEqual({ min: 'V1', max: 'V2' });
  });

  // 4a alone is not "V0": the query still sends 4a only.
  it('names one grade inside a group precisely, never by the whole stop', () => {
    expect(labels(10, 10)).toEqual({ min: 'V0 / 4A', max: 'V0 / 4A' });
    expect(labels(11, 11)).toEqual({ min: 'V0 / 4B', max: 'V0 / 4B' });
    expect(labels(12, 12)).toEqual({ min: 'V0 / 4C', max: 'V0 / 4C' });
  });

  it('names both ends precisely when the bound covers only part of one group', () => {
    expect(labels(10, 11)).toEqual({ min: 'V0 / 4A', max: 'V0 / 4B' });
    expect(labels(11, 12)).toEqual({ min: 'V0 / 4B', max: 'V0 / 4C' });
  });

  it('names only the end that sits inside its group precisely, in a range across stops', () => {
    // The lower end starts above V0's lower edge.
    expect(labels(11, 15)).toEqual({ min: 'V0 / 4B', max: 'V2' });
    // The upper end stops below V1's upper edge.
    expect(labels(10, 13)).toEqual({ min: 'V0', max: 'V1 / 5A' });
    expect(labels(12, 13)).toEqual({ min: 'V0 / 4C', max: 'V1 / 5A' });
  });

  it('names an open-ended bound by the same rule for its one end', () => {
    expect(labels(10, undefined)).toEqual({ min: 'V0', max: undefined });
    expect(labels(11, undefined)).toEqual({ min: 'V0 / 4B', max: undefined });
    expect(labels(undefined, 12)).toEqual({ min: undefined, max: 'V0' });
    expect(labels(undefined, 11)).toEqual({ min: undefined, max: 'V0 / 4B' });
  });

  it('has no name for an end the rail has no chip for, or for Any', () => {
    expect(labels(99, 99)).toEqual({ min: undefined, max: undefined });
    expect(labels(10, 99)).toEqual({ min: 'V0', max: undefined });
    expect(labels(undefined, undefined)).toEqual({ min: undefined, max: undefined });
    expect(gradeBoundLabels(stops, { minGradeId: null, maxGradeId: null })).toEqual({ min: undefined, max: undefined });
  });

  it('never needs the precise names under Font grades, where no stop is a group', () => {
    const fontStops = buildGradeRailStops(SCALE, 'font');
    expect(gradeBoundLabels(fontStops, { minGradeId: 10, maxGradeId: 10 })).toEqual({ min: '4A', max: '4A' });
    expect(gradeBoundLabels(fontStops, { minGradeId: 11, maxGradeId: 13 })).toEqual({ min: '4B', max: '5A' });
  });
});
