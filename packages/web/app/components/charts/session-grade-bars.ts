import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import type { CssBarChartBar } from './css-bar-chart';
import { formatVGrade } from '@/app/lib/grade-colors';
import { themeTokens } from '@/app/theme/theme-config';

// Match profile page flash/redpoint colors (theme-derived, 60% opacity hex suffix)
const FLASH_COLOR = `${themeTokens.colors.success}99`;
const SEND_COLOR = `${themeTokens.colors.error}99`;
const ATTEMPT_COLOR = `${themeTokens.neutral[300]}99`;

export const SESSION_GRADE_LEGEND = [
  { label: 'Flash', color: FLASH_COLOR },
  { label: 'Send', color: SEND_COLOR },
  { label: 'Attempt', color: ATTEMPT_COLOR },
] as const;

/**
 * Convert session grade distribution data into CssBarChart bars.
 * Data arrives hardest-first from the backend; this reverses to easiest-first for display.
 */
export function buildSessionGradeBars(
  gradeDistribution: SessionGradeDistributionItem[],
): CssBarChartBar[] {
  const sorted = [...gradeDistribution].reverse();

  return sorted.map((item) => ({
    key: item.grade,
    label: formatVGrade(item.grade) ?? item.grade,
    segments: [
      { value: item.flash, color: FLASH_COLOR, label: 'Flash' },
      { value: item.send, color: SEND_COLOR, label: 'Send' },
      { value: item.attempt, color: ATTEMPT_COLOR, label: 'Attempt' },
    ],
  }));
}
