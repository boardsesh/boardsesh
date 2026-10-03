import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { LogbookEntry } from '@boardsesh/board-react';
import { parseTickTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { AscentStatusMark, GradePill, StarNumber } from '../ascent-marks';
import { normalizeAscentStatus } from '../../lib/ascent-status-utils';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type LogbookEntryRowProps = {
  entry: LogbookEntry;
  showMirrorTag: boolean;
};

// Time of day only: the session tile above the row already names the day.
// Hoisted so every row shares one cache lookup key instead of allocating a
// fresh options object per call (#3155). Note: the cache in
// intl-formatter-cache.ts keys only on (locale, options), not on the
// process's TZ — a formatter built under one TZ stays cached for that key
// even if TZ later changes, which is fine at runtime (TZ is fixed for the
// life of the app) but means tests exercising more than one TZ against this
// cache must call `vi.resetModules()` between them.
const CLIMBED_AT_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
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

/** One of the climber's own logs: result, grade given, stars, time, then the note. */
export const LogbookEntryRow = memo(function LogbookEntryRow({ entry, showMirrorTag }: LogbookEntryRowProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  const status = normalizeAscentStatus({ status: entry.status, isAscent: entry.is_ascent, tries: entry.tries });
  // Imported ticks can carry zero tries; a logged row is always at least one.
  const tries = Math.max(1, entry.tries);
  let result: string;
  switch (status) {
    case 'flash':
      result = t('mobile.logbook.entryFlash');
      break;
    case 'send':
      result = t('mobile.logbook.entrySentIn', { count: tries });
      break;
    default:
      result = t('mobile.logbook.tries', { count: tries });
  }

  const climbedAtLabel = useMemo(() => formatClimbedAt(entry.climbed_at), [entry.climbed_at]);

  return (
    <View style={[styles.container, { borderTopColor: systemColors.separator }]}>
      <View style={styles.headerRow}>
        <View style={styles.result}>
          <AscentStatusMark status={status} />
          <Text variant="subheadline" style={styles.resultLabel}>
            {result}
          </Text>
        </View>
        <GradePill difficultyId={entry.difficulty} />
        {showMirrorTag ? (
          <View style={styles.mirrorChip}>
            <Text variant="caption2" color={systemColors.secondaryLabel}>
              {entry.is_mirror ? t('mobile.logbook.mirroredTag') : t('mobile.logbook.originalTag')}
            </Text>
          </View>
        ) : null}
        {/* Show the effective quality so a Kilter-pulled tick (no per-tick
            quality) surfaces the climber's own synced star rating. Sends only:
            a try that did not go carries no rating. */}
        {status === 'attempt' ? null : <StarNumber quality={entry.effectiveQuality ?? entry.quality} />}
        <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.time}>
          {climbedAtLabel}
        </Text>
      </View>

      {entry.comment ? <Text variant="body">{entry.comment}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[1],
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    // Wraps at accessibility type sizes rather than squeezing the time off.
    flexWrap: 'wrap',
  },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  resultLabel: {
    fontWeight: '600',
  },
  mirrorChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
    borderRadius: borderRadius.full,
    backgroundColor: `${iosSystemColors.systemGray}24`,
  },
  time: {
    marginLeft: 'auto',
    fontVariant: ['tabular-nums'],
  },
});
