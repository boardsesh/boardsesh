import type { GymGradeComparison } from '@boardsesh/shared-schema';

type SeriesPoint = { count: number; countText: string; shareText: string; width: number };
type ChartRow = { label: string | null; available: SeriesPoint; sends: SeriesPoint };

export function buildGymGradeComparisonRows(
  report: GymGradeComparison,
  locale: string,
  displayGrade: (difficultyId: number, boardType: string) => string | null,
): ChartRow[] {
  const counts = new Map<string | null, { order: number; available: number; sends: number }>();
  for (const grade of report.grades) {
    const label = grade.difficultyId == null ? null : displayGrade(grade.difficultyId, grade.boardType);
    const order = label === null ? Infinity : (grade.difficultyId ?? Infinity);
    const previous = counts.get(label) ?? { order, available: 0, sends: 0 };
    counts.set(label, {
      order: Math.min(order, previous.order),
      available: previous.available + grade.availableCount,
      sends: previous.sends + grade.sendCount,
    });
  }
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const point = (count: number, total: number): SeriesPoint => {
    const width = total === 0 ? 0 : count / total;
    return { count, countText: number.format(count), shareText: percent.format(width), width };
  };
  return [...counts]
    .sort(
      ([firstLabel, first], [secondLabel, second]) =>
        first.order - second.order || (firstLabel ?? '').localeCompare(secondLabel ?? '', locale),
    )
    .map(([label, buckets]) => ({
      label,
      available: point(buckets.available, report.availableCount),
      sends: point(buckets.sends, report.sendCount),
    }));
}
