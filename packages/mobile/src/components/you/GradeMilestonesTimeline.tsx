import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeTextColor } from '@boardsesh/play-view';
import type { RawGradeMilestone } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useVariantValue } from '../../theme/variants';
import { spacing, borderRadius } from '../../theme/tokens';
import { gradeBadgeColor } from './profile-chart-colors';

const MATERIAL = { material: true, liquidGlass: false } as const;
const RAIL_WIDTH = 18;
const DOT_SIZE = 10;

type TFunc = (key: string, options?: Record<string, unknown>) => string;

type GradeMilestonesTimelineProps = {
  milestones: RawGradeMilestone[];
};

// Literal t() keys (no dynamic lookups) so the catalog stays statically
// analysable — same pattern as the wall-rhythm weekday switch.
function monthAbbr(month: number, t: TFunc): string {
  switch (month) {
    case 1:
      return t('charts.month.jan');
    case 2:
      return t('charts.month.feb');
    case 3:
      return t('charts.month.mar');
    case 4:
      return t('charts.month.apr');
    case 5:
      return t('charts.month.may');
    case 6:
      return t('charts.month.jun');
    case 7:
      return t('charts.month.jul');
    case 8:
      return t('charts.month.aug');
    case 9:
      return t('charts.month.sep');
    case 10:
      return t('charts.month.oct');
    case 11:
      return t('charts.month.nov');
    default:
      return t('charts.month.dec');
  }
}

/**
 * Format a milestone's `YYYY-MM-DD` (already a LOCAL calendar date from the
 * builder) into "Mar '24". Parses the string parts directly rather than through
 * a Date/dayjs — there is no dayjs in mobile, and re-parsing a local date string
 * as UTC would shift it across a month boundary. Month names come from i18n
 * (dayjs locale isn't wired app-wide).
 */
function formatMilestoneDate(date: string, t: TFunc): string {
  const [year, month] = date.split('-');
  return t('charts.milestoneDate', { month: monthAbbr(Number(month), t), year: year.slice(2) });
}

/**
 * "Grade milestones" — a compact left-rail vertical timeline of the first send
 * at each grade (grade-ascending, so it reads bottom-of-the-pyramid → ceiling
 * top to bottom). Each row: a dot on the rail, the grade badge (`gradeBadgeColor`),
 * and the first-send month. Parent gates the empty case.
 */
export function GradeMilestonesTimeline({ milestones }: GradeMilestonesTimelineProps) {
  const { systemColors, m3 } = useTheme();
  const { t } = useTranslation('profile');
  const isMaterial = useVariantValue(MATERIAL);

  if (milestones.length === 0) return null;

  const railColor = isMaterial ? m3.outlineVariant : systemColors.separator;
  const dateColor = isMaterial ? m3.onSurfaceVariant : systemColors.secondaryLabel;

  return (
    <View accessibilityRole="image" accessibilityLabel={t('charts.milestonesA11y')}>
      {milestones.map((milestone, index) => {
        const isLast = index === milestones.length - 1;
        const badgeHex = gradeBadgeColor(milestone.label);
        const dateText = formatMilestoneDate(milestone.date, t);
        return (
          <View
            key={`${milestone.label}-${milestone.date}`}
            style={styles.row}
            accessibilityRole="text"
            accessibilityLabel={t('charts.milestoneA11y', { grade: milestone.label, date: dateText })}
          >
            <View style={styles.rail}>
              <View style={[styles.dot, { backgroundColor: badgeHex }]} />
              {!isLast ? <View style={[styles.connector, { backgroundColor: railColor }]} /> : null}
            </View>
            <View style={[styles.content, isLast ? undefined : styles.contentSpacing]}>
              <View style={[styles.badge, { backgroundColor: badgeHex }]}>
                <Text variant="caption1" color={getGradeTextColor(badgeHex)} style={styles.badgeText}>
                  {milestone.label}
                </Text>
              </View>
              <Text variant="footnote" color={dateColor}>
                {dateText}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
  rail: {
    width: RAIL_WIDTH,
    alignItems: 'center',
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: borderRadius.full,
    marginTop: 4,
  },
  connector: {
    flex: 1,
    width: 2,
    marginTop: 2,
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  contentSpacing: {
    paddingBottom: spacing[3],
  },
  badge: {
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    minWidth: 36,
    alignItems: 'center',
  },
  badgeText: {
    fontWeight: '700',
  },
});
