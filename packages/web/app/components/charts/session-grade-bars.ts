import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import type { CssBarChartBar } from './css-bar-chart';
import { formatVGrade } from '@/app/lib/grade-colors';
import { themeTokens } from '@/app/theme/theme-config';

// Flash/send legend colours (60% opacity). Scheme-neutral mid-tones so the bars stay
// legible on both the light and the dark card surface — the brand success/error tones
// are tuned per scheme and would wash out in the other one (these feed chart data, not
// CSS, so a scheme-aware var() can't be used here).
const FLASH_COLOR = '#10b98199';
const SEND_COLOR = '#ef444499';
const ATTEMPT_COLOR = `${themeTokens.neutral[300]}99`;

export const SESSION_GRADE_LEGEND = [
  { label: 'Flash', color: FLASH_COLOR },
  { label: 'Send', color: SEND_COLOR },
  { label: 'Attempt', color: ATTEMPT_COLOR },
] as const;

/**
 * Convert session grade distribution data into CssBarChart bars.
 * Data arrives hardest-first from the backend; this reverses to easiest-first for display.
 *
 * @param formatGradeFn - Optional formatter for grade labels. When omitted, falls back to
 *   formatVGrade. Components that have access to the useGradeFormat hook should pass
 *   their `formatGrade` function here so labels respect the user's display preference.
 */
export function buildSessionGradeBars(
  gradeDistribution: SessionGradeDistributionItem[],
  formatGradeFn?: (grade: string) => string | null,
): CssBarChartBar[] {
  const sorted = [...gradeDistribution].reverse();
  const fmt = formatGradeFn ?? ((g: string) => formatVGrade(g));

  return sorted.map((item) => ({
    key: item.grade,
    label: fmt(item.grade) ?? item.grade,
    segments: [
      { value: item.flash, color: FLASH_COLOR, label: 'Flash' },
      { value: item.send, color: SEND_COLOR, label: 'Send' },
      { value: item.attempt, color: ATTEMPT_COLOR, label: 'Attempt' },
    ],
  }));
}
