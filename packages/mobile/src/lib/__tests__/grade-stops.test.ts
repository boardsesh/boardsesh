import { describe, expect, it } from 'vitest';
import { getGradeColor } from '@boardsesh/board-constants/grade-colors';
import { buildGradeRailStops, gradeRailStopLabel } from '../grade-stops';

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
    expect(buildGradeRailStops(SCALE, 'v-grade')).toEqual([
      { minGradeId: 10, maxGradeId: 12, label: 'V0', gradeColor: getGradeColor('V0') },
      { minGradeId: 13, maxGradeId: 14, label: 'V1', gradeColor: getGradeColor('V1') },
      { minGradeId: 15, maxGradeId: 15, label: 'V2', gradeColor: getGradeColor('V2') },
    ]);
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

describe('gradeRailStopLabel', () => {
  const stops = buildGradeRailStops(SCALE, 'v-grade');

  it('names any grade of a group by the group', () => {
    expect(gradeRailStopLabel(stops, 10)).toBe('V0');
    expect(gradeRailStopLabel(stops, 11)).toBe('V0');
    expect(gradeRailStopLabel(stops, 12)).toBe('V0');
    expect(gradeRailStopLabel(stops, 15)).toBe('V2');
  });

  it('has no name for a grade the rail has no chip for', () => {
    expect(gradeRailStopLabel(stops, 99)).toBeUndefined();
  });
});
