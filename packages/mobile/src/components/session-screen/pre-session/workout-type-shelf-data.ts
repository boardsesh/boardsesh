import { DEFAULT_GRADE_COLOR, getGradeColor } from '@boardsesh/board-constants/grade-colors';
import type { GeneratorGradeScale, PlannedClimbSlot } from '@boardsesh/playlist-generator';
import type { ColoredBar } from '../../you/profile-chart-colors';

type FormatDifficultyId = (difficultyId: number | null | undefined) => string | null;

/**
 * Collapse planned workout slots into mini grade bars. The x-axis is ordered
 * easy-to-hard by difficulty id; each bar's y value is the number of planned
 * climbs at that grade.
 */
export function buildWorkoutGradeBars(
  slots: readonly PlannedClimbSlot[],
  formatDifficultyId: FormatDifficultyId,
): ColoredBar[] | null {
  const countByGrade = new Map<number, number>();
  for (const slot of slots) {
    countByGrade.set(slot.grade, (countByGrade.get(slot.grade) ?? 0) + 1);
  }

  const bars: ColoredBar[] = Array.from(countByGrade.entries())
    .sort(([firstGrade], [secondGrade]) => firstGrade - secondGrade)
    .map(([difficultyId, count]) => {
      const label = formatDifficultyId(difficultyId) ?? String(difficultyId);
      const key = String(difficultyId);
      return {
        key,
        label,
        segments: [{ value: count, key, label, color: getGradeColor(label) ?? DEFAULT_GRADE_COLOR }],
      };
    });

  return bars.length > 0 ? bars : null;
}

function getGradeOrdinal(difficultyId: number, grades: GeneratorGradeScale): number {
  const gradeIndex = grades.findIndex((grade) => grade.difficulty_id === difficultyId);
  return gradeIndex >= 0 ? gradeIndex : difficultyId;
}

/**
 * Render a workout progression as one bar per planned climb. The x-axis is the
 * climb number in the workout; the y value is the grade's order in the board's
 * grade scale, normalized to the grades present so the mini chart shape reads.
 */
export function buildWorkoutProgressionBars(
  slots: readonly PlannedClimbSlot[],
  formatDifficultyId: FormatDifficultyId,
  grades: GeneratorGradeScale,
): ColoredBar[] | null {
  if (slots.length === 0) return null;

  const ordinals = slots.map((slot) => getGradeOrdinal(slot.grade, grades));
  const minOrdinal = Math.min(...ordinals);
  const bars: ColoredBar[] = slots.map((slot, slotIndex) => {
    const gradeLabel = formatDifficultyId(slot.grade) ?? String(slot.grade);
    const key = String(slot.index);
    return {
      key,
      label: String(slotIndex + 1),
      segments: [
        {
          value: ordinals[slotIndex] - minOrdinal + 1,
          key: gradeLabel,
          label: gradeLabel,
          color: getGradeColor(gradeLabel) ?? DEFAULT_GRADE_COLOR,
        },
      ],
    };
  });

  return bars;
}
