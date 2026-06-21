import { describe, expect, it } from 'vitest';
import type { PlannedClimbSlot } from '@boardsesh/playlist-generator';
import { buildWorkoutGradeBars, buildWorkoutProgressionBars } from '../workout-type-shelf-data';

function slot(grade: number, index: number): PlannedClimbSlot {
  return { grade, section: 'main', index };
}

const formatDifficultyId = (difficultyId: number | null | undefined) =>
  difficultyId == null ? null : `V${difficultyId - 10}`;

describe('buildWorkoutGradeBars', () => {
  it('groups planned climbs by grade in easy-to-hard order', () => {
    const bars = buildWorkoutGradeBars([slot(13, 0), slot(11, 1), slot(13, 2), slot(12, 3)], formatDifficultyId);

    expect(bars?.map((bar) => ({ key: bar.key, label: bar.label, value: bar.segments[0].value }))).toEqual([
      { key: '11', label: 'V1', value: 1 },
      { key: '12', label: 'V2', value: 1 },
      { key: '13', label: 'V3', value: 2 },
    ]);
  });

  it('falls back to the difficulty id when no formatted grade is available', () => {
    const bars = buildWorkoutGradeBars([slot(20, 0)], () => null);

    expect(bars?.[0]).toMatchObject({
      key: '20',
      label: '20',
      segments: [{ value: 1, key: '20', label: '20' }],
    });
  });

  it('returns null when there are no planned slots', () => {
    expect(buildWorkoutGradeBars([], formatDifficultyId)).toBeNull();
  });
});

describe('buildWorkoutProgressionBars', () => {
  const grades = [10, 11, 12, 13].map((difficulty_id) => ({ difficulty_id }));

  it('uses climb number on x and normalized grade order on y', () => {
    const bars = buildWorkoutProgressionBars(
      [slot(11, 0), slot(12, 1), slot(13, 2), slot(12, 3), slot(11, 4)],
      formatDifficultyId,
      grades,
    );

    expect(bars?.map((bar) => ({ label: bar.label, value: bar.segments[0].value }))).toEqual([
      { label: '1', value: 1 },
      { label: '2', value: 2 },
      { label: '3', value: 3 },
      { label: '4', value: 2 },
      { label: '5', value: 1 },
    ]);
    expect(bars?.map((bar) => bar.segments[0].label)).toEqual(['V1', 'V2', 'V3', 'V2', 'V1']);
  });

  it('returns null when there are no planned slots', () => {
    expect(buildWorkoutProgressionBars([], formatDifficultyId, grades)).toBeNull();
  });
});
