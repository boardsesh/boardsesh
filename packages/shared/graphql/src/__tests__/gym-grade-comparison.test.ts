import { describe, expect, it } from 'vite-plus/test';
import type { GymGradeComparison } from '@boardsesh/shared-schema';
import { buildGymGradeComparisonRows } from '../gym-grade-comparison';

const source: GymGradeComparison = {
  gymUuid: 'gym',
  asOf: '2026-11-23T10:00:00.000000Z',
  startAt: '2026-11-16T10:00:00.000000Z',
  timeZone: 'UTC',
  availableCount: 3,
  sendCount: 1,
  boards: [],
  grades: [
    { boardType: 'kilter', difficultyId: 18, availableCount: 1, sendCount: 0 },
    { boardType: 'moonboard', difficultyId: 19, availableCount: 1, sendCount: 1 },
    { boardType: 'spray', difficultyId: null, availableCount: 1, sendCount: 0 },
  ],
};

describe('paired grade comparison view', () => {
  it('merges labels across scales, preserves unknown, and uses distinct shares with unrounded bar widths', () => {
    const rows = buildGymGradeComparisonRows(source, 'en-US', (id, type) =>
      (id === 18 && type === 'kilter') || (id === 19 && type === 'moonboard') ? 'V4' : null,
    );
    expect(rows).toEqual([
      {
        label: 'V4',
        available: { count: 2, countText: '2', shareText: '66.7%', width: 2 / 3 },
        sends: { count: 1, countText: '1', shareText: '100%', width: 1 },
      },
      {
        label: null,
        available: { count: 1, countText: '1', shareText: '33.3%', width: 1 / 3 },
        sends: { count: 0, countText: '0', shareText: '0%', width: 0 },
      },
    ]);
  });

  it('keeps zero-send supply and returns no bars when the whole inventory is empty', () => {
    const noSends = { ...source, sendCount: 0, grades: source.grades.map((grade) => ({ ...grade, sendCount: 0 })) };
    const rows = buildGymGradeComparisonRows(noSends, 'en-US', (id) => String(id));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.sends.width === 0 && row.sends.shareText === '0%')).toBe(true);
    expect(
      buildGymGradeComparisonRows({ ...source, availableCount: 0, sendCount: 0, grades: [] }, 'en-US', String),
    ).toEqual([]);
  });
});
