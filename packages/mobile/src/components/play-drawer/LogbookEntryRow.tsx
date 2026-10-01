import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { LogbookEntry } from '@boardsesh/board-react';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { parseTickTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { normalizeAscentStatus, type AscentStatusValue } from '../../lib/ascent-status-utils';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type LogbookEntryRowProps = {
  entry: LogbookEntry;
  showMirrorTag: boolean;
  /** False when an angle section header above already names the angle. */
  showAngleChip?: boolean;
};

// Hoisted so every row shares one cache lookup key instead of allocating a
// fresh options object per call (#3155). Note: the cache in
// intl-formatter-cache.ts keys only on (locale, options), not on the
// process's TZ — a formatter built under one TZ stays cached for that key
// even if TZ later changes, which is fine at runtime (TZ is fixed for the
// life of the app) but means tests exercising more than one TZ against this
// cache must call `vi.resetModules()` between them.
const CLIMBED_AT_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

// `entry.climbed_at` is a naive `boardsesh_ticks.climbed_at` string with no
// `Z`/offset (see @boardsesh/profile-stats/format-tick-time). Parsing it with
// a bare `new Date(iso)` gets it interpreted as browser/device-local time
// instead of UTC, which silently displays the raw UTC digits as if they were
// already local (#3569). `parseTickTime` recovers the true UTC instant and
// converts it to local before we ever hand a `Date` to `Intl.DateTimeFormat`.
function formatClimbedAt(iso: string): string {
  if (!iso) return iso;
  const date = parseTickTime(iso).toDate();
  if (Number.isNaN(date.getTime())) return iso;
  return getCachedDateTimeFormat(undefined, CLIMBED_AT_FORMAT_OPTIONS).format(date);
}

// Canonical difficulty_id → "6a/V3" name, which always carries both scales so
// the grade color resolves regardless of the user's display-format preference.
const GRADE_NAME_BY_DIFFICULTY_ID = new Map<number, string>(
  BOULDER_GRADES.map((grade) => [grade.difficulty_id, grade.difficulty_name]),
);

const STATUS_ICON: Record<AscentStatusValue, { name: 'flash' | 'tick' | 'close'; color: string }> = {
  flash: { name: 'flash', color: iosSystemColors.systemYellow },
  send: { name: 'tick', color: iosSystemColors.systemGreen },
  attempt: { name: 'close', color: iosSystemColors.systemOrange },
};

export const LogbookEntryRow = memo(function LogbookEntryRow({
  entry,
  showMirrorTag,
  showAngleChip = true,
}: LogbookEntryRowProps) {
  const { t } = useTranslation('session');
  const { formatGradeByDifficultyId } = useGradeFormat();

  const status = normalizeAscentStatus({ status: entry.status, isAscent: entry.is_ascent, tries: entry.tries });
  const statusIcon = STATUS_ICON[status];
  const isSuccess = status !== 'attempt';

  // The grade the climber gave this ascent. Null when they logged no personal
  // grade (typical for attempts), in which case the chip is hidden.
  const gradeLabel = useMemo(
    () => formatGradeByDifficultyId(entry.difficulty),
    [formatGradeByDifficultyId, entry.difficulty],
  );
  // Color keys off the raw difficulty id (via its canonical name), not the
  // display-formatted label — so a "V6 / 7a" combined-format label still paints
  // the right color. Falls back for no-grade rows / unknown ids.
  const gradeColor = useMemo(() => {
    if (entry.difficulty == null) return DEFAULT_GRADE_COLOR;
    const difficultyName = GRADE_NAME_BY_DIFFICULTY_ID.get(entry.difficulty);
    return (difficultyName ? getGradeColor(difficultyName) : undefined) ?? DEFAULT_GRADE_COLOR;
  }, [entry.difficulty]);

  const stars = useMemo(() => {
    // Show the effective quality so a Kilter-pulled tick (no per-tick quality)
    // surfaces the climber's own synced star rating.
    const displayQuality = entry.effectiveQuality ?? entry.quality;
    if (!isSuccess || displayQuality == null || displayQuality <= 0) return null;
    return Array.from({ length: 5 }, (_, index) => (
      <Icon
        key={index}
        name={index < displayQuality ? 'star.fill' : 'star'}
        size={12}
        color={index < displayQuality ? iosSystemColors.starGold : iosSystemColors.systemGray4}
      />
    ));
  }, [isSuccess, entry.effectiveQuality, entry.quality]);

  const climbedAtLabel = useMemo(() => formatClimbedAt(entry.climbed_at), [entry.climbed_at]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Icon name={statusIcon.name} size={16} color={statusIcon.color} />
        <Text variant="subheadline" style={styles.date} numberOfLines={1}>
          {climbedAtLabel}
        </Text>
        {showAngleChip ? (
          <View style={styles.angleChip}>
            <Text variant="caption2" color={iosSystemColors.white}>
              {`${entry.angle}°`}
            </Text>
          </View>
        ) : null}
        {gradeLabel ? (
          <View style={styles.gradeChip}>
            <Text variant="caption2" color={gradeColor} style={styles.gradeText}>
              {gradeLabel}
            </Text>
          </View>
        ) : null}
        {showMirrorTag ? (
          <View style={styles.mirrorChip}>
            <Text variant="caption2" color={iosSystemColors.systemGray}>
              {entry.is_mirror ? t('mobile.logbook.mirroredTag') : t('mobile.logbook.originalTag')}
            </Text>
          </View>
        ) : null}
      </View>

      {stars ? <View style={styles.starsRow}>{stars}</View> : null}

      <Text variant="footnote" color={iosSystemColors.systemGray}>
        {t('mobile.logbook.tries', { count: entry.tries })}
      </Text>

      {entry.comment ? <Text variant="footnote">{entry.comment}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[1],
    paddingVertical: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    flexWrap: 'wrap',
  },
  date: {
    flexShrink: 1,
  },
  angleChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
    backgroundColor: iosSystemColors.systemBlue,
  },
  gradeChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
    backgroundColor: `${iosSystemColors.systemGray}1F`,
  },
  gradeText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  mirrorChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
    backgroundColor: `${iosSystemColors.systemGray}24`,
  },
  starsRow: {
    flexDirection: 'row',
    gap: 2,
  },
});
