import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { WeekDay, WeekSummary } from '@boardsesh/profile-stats';
import type { ActivityTick } from '../../db/queries/get-activity-ticks-local';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { track } from '../../lib/analytics';
import { hapticLight } from '../../lib/haptics';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { useScopedRouter as useRouter } from '../../lib/routing/scoped-navigation';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { StatusPill } from '../StatusPill';
import { Text } from '../Text';
import { localDateFromDayKey } from '../you/activity-heatmap-model';
import { HomeSectionFrame } from './HomeSectionFrame';
import { useWeekSummary } from './use-week-summary';

const DOT_SIZE = 28;
const TODAY_RING = 2;
/** A run of one week is just this week; the pill shows from the second. */
const MIN_WEEKS_SHOWN = 2;
const NARROW_WEEKDAY: Intl.DateTimeFormatOptions = { weekday: 'narrow' };
const LONG_WEEKDAY: Intl.DateTimeFormatOptions = { weekday: 'long' };

/**
 * "This week" (#7690): seven day dots for the current week, sessions and sends,
 * the hardest send, how many weeks in a row, and one record line.
 *
 * Weekly on purpose, never daily: a rest day is part of climbing, so no day
 * reads as missed, nothing compares with last week, and nothing is negative.
 * Drawn from the ticks on this phone, so it is there on a cold start and with
 * no signal. Hidden while signed out or while a first sync is still filling
 * the logbook.
 */
export const HomeWeekSection = memo(function HomeWeekSection() {
  const summary = useWeekSummary(true);
  const { t } = useTranslation('feed');
  if (!summary) return null;
  return (
    <HomeSectionFrame title={t('mobile.home.sections.week.title')} testID="home-section-week">
      <HomeWeekCard summary={summary} />
    </HomeSectionFrame>
  );
});

export const HomeWeekCard = memo(function HomeWeekCard({ summary }: { summary: WeekSummary<ActivityTick> }) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();

  const { record, hardestSend } = summary;
  const openRecord = useCallback(() => {
    if (!record) return;
    const { climbUuid, boardType, layoutId, angle } = record.entry;
    hapticLight();
    track(SHARED_EVENTS.HomeSectionTapped, { section: 'week', target: 'record' });
    openClimbInPlayDrawer({ kind: 'ref', climbUuid, boardType, layoutId, angle }, { openPlayDrawer, router });
  }, [record, openPlayDrawer, router]);

  // Quiet, and only a start line: dots would be a row of blanks.
  if (summary.isEmpty || summary.isDormant) {
    return (
      <Card>
        <Text variant="body" color={systemColors.secondaryLabel} testID="home-week-start">
          {t('mobile.home.sections.week.empty')}
        </Text>
      </Card>
    );
  }

  const totals = [
    t('mobile.home.sections.week.sessions', { count: summary.sessions }),
    t('mobile.home.sections.week.sends', { count: summary.sends }),
  ].join(' · ');
  const hardestGrade =
    hardestSend?.difficulty != null ? formatGradeByDifficultyId(hardestSend.difficulty, hardestSend.boardType) : null;
  const recordGrade =
    record?.entry.difficulty != null
      ? formatGradeByDifficultyId(record.entry.difficulty, record.entry.boardType)
      : null;
  const recordHeadline =
    record && recordGrade
      ? record.kind === 'firstGrade'
        ? t('mobile.home.sections.week.recordFirstGrade', { grade: recordGrade })
        : t('mobile.home.sections.week.recordHardestFlash', { grade: recordGrade })
      : null;
  const recordText =
    recordHeadline && record?.entry.climbName
      ? t('mobile.home.sections.week.recordClimb', { record: recordHeadline, climb: record.entry.climbName })
      : recordHeadline;

  return (
    <Card>
      <View style={styles.headline}>
        <View style={styles.totals}>
          {/* A week with nothing logged yet reads as a start, never as "0 sessions". */}
          {summary.sessions > 0 ? (
            <Text variant="headline" color={systemColors.label} testID="home-week-totals">
              {totals}
            </Text>
          ) : (
            <Text variant="body" color={systemColors.secondaryLabel} testID="home-week-start">
              {t('mobile.home.sections.week.empty')}
            </Text>
          )}
          {/* Wraps rather than truncates: a V-grade is never cut. */}
          {hardestGrade ? (
            <Text variant="subheadline" color={systemColors.secondaryLabel} testID="home-week-hardest">
              {t('mobile.home.sections.week.hardest', { grade: hardestGrade })}
            </Text>
          ) : null}
        </View>
        {summary.weeksRunning >= MIN_WEEKS_SHOWN ? (
          <StatusPill
            label={t('mobile.home.sections.week.weeksRunning', { count: summary.weeksRunning })}
            testID="home-week-running"
          />
        ) : null}
      </View>
      <WeekDots days={summary.days} />
      {recordText && record?.entry.climbName ? (
        <PressableSurface
          onPress={openRecord}
          feedback="opacity"
          rippleColor={systemColors.label as string}
          accessibilityRole="button"
          accessibilityLabel={recordText}
          accessibilityHint={t('mobile.home.sections.week.openRecord', { climb: record.entry.climbName })}
          style={styles.record}
          testID="home-week-record"
        >
          <Icon name="star.fill" size={16} color={systemColors.accent} />
          <Text variant="subheadline" color={systemColors.label} numberOfLines={2} style={styles.recordText}>
            {recordText}
          </Text>
          <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
        </PressableSurface>
      ) : recordText ? (
        // The board's catalogue is not on this phone: name the record, with nothing to open.
        <View style={styles.record} testID="home-week-record-text">
          <Icon name="star.fill" size={16} color={systemColors.accent} />
          <Text variant="subheadline" color={systemColors.label} numberOfLines={2} style={styles.recordText}>
            {recordText}
          </Text>
        </View>
      ) : null}
    </Card>
  );
});

const WeekDots = memo(function WeekDots({ days }: { days: readonly WeekDay[] }) {
  const { t, i18n } = useTranslation('feed');
  const { chartColors, brandColors, systemColors } = useTheme();
  const locale = i18n.language;
  const labels = useMemo(() => {
    const narrow = getCachedDateTimeFormat(locale, NARROW_WEEKDAY);
    const long = getCachedDateTimeFormat(locale, LONG_WEEKDAY);
    return days.map((day) => {
      const date = localDateFromDayKey(day.date);
      const name = long.format(date);
      return {
        letter: narrow.format(date),
        accessibilityLabel: day.active ? t('mobile.home.sections.week.dayClimbed', { day: name }) : name,
      };
    });
  }, [days, locale, t]);

  return (
    <View style={styles.dots} testID="home-week-dots">
      {days.map((day, index) => (
        <View
          key={day.date}
          style={styles.day}
          accessible
          accessibilityLabel={labels[index].accessibilityLabel}
          testID={day.active ? 'home-week-day-active' : 'home-week-day'}
        >
          <View
            style={[
              styles.dot,
              { backgroundColor: day.active ? chartColors.accent : systemColors.tertiaryFill },
              day.isToday ? { borderWidth: TODAY_RING, borderColor: brandColors.accent } : null,
              day.isFuture ? styles.future : null,
            ]}
          />
          <Text variant="caption2" color={day.isToday ? systemColors.label : systemColors.secondaryLabel}>
            {labels[index].letter}
          </Text>
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  headline: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  totals: {
    flex: 1,
    minWidth: 0,
    gap: spacing[1],
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: spacing[4],
  },
  day: {
    alignItems: 'center',
    gap: spacing[1],
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
  future: {
    opacity: 0.5,
  },
  record: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginTop: spacing[4],
    paddingTop: spacing[3],
  },
  recordText: {
    flex: 1,
    minWidth: 0,
  },
});
