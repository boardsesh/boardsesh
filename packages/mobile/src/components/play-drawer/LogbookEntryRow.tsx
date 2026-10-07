import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { LogbookEntry } from '@boardsesh/board-react';
import { parseTickTime } from '@boardsesh/profile-stats';
import { isTickOnEarlierVersion } from '@boardsesh/logbook';
import { Text } from '../Text';
import { normalizeAscentStatus } from '../../lib/ascent-status-utils';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type LogbookEntryRowProps = {
  entry: LogbookEntry;
  showMirrorTag: boolean;
  /**
   * The version the climb is on now (`Climb.revisionNumber`), or null when the
   * screen does not know it. A log known to be on a lower version carries the
   * "Earlier version" tag. A primitive, so the memo boundary holds.
   */
  climbCurrentRevision?: number | null;
  /** The climb's board, so the grade reads on that board's scale (MoonBoard's 6A is V2). */
  boardName?: string | null;
};

// Time of day only: the day line above the row already names the day.
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

/**
 * One of the climber's own logs, as words: the result ("Flash", "Sent in 3",
 * "5 tries, no send"), then in grey the grade they gave, their stars, the
 * mirror tag and "Earlier version" when the climb has been edited since, the
 * time on the right, and the note under it. The result is text, never a colour
 * or a glyph, so the row reads the same in any theme.
 */
export const LogbookEntryRow = memo(function LogbookEntryRow({
  entry,
  showMirrorTag,
  climbCurrentRevision,
  boardName,
}: LogbookEntryRowProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();

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
      result = t('mobile.logbook.entryNoSend', { count: tries });
  }

  const climbedAtLabel = useMemo(() => formatClimbedAt(entry.climbed_at), [entry.climbed_at]);

  const grade = formatGradeByDifficultyId(entry.difficulty, boardName);
  // The effective quality, so a Kilter-pulled tick (no per-tick quality)
  // surfaces the climber's own synced star rating. Sends only: a try that did
  // not go carries no rating.
  const quality = status === 'attempt' ? null : (entry.effectiveQuality ?? entry.quality);
  const stars = quality != null && quality > 0 ? quality : null;
  let mirrorTag: string | null = null;
  if (showMirrorTag) {
    mirrorTag = entry.is_mirror ? t('mobile.logbook.mirroredTag') : t('mobile.logbook.originalTag');
  }

  // Plain words, like the mirror tag beside it. No version numbers: the row
  // says the climb has changed since, not by how much.
  const onEarlierVersion = isTickOnEarlierVersion(entry.climb_revision, climbCurrentRevision);
  const earlierVersionTag = onEarlierVersion ? t('mobile.logbook.earlierVersionTag') : null;

  const details = [grade, stars === null ? null : `${stars}★`, mirrorTag, earlierVersionTag].filter((detail) =>
    Boolean(detail),
  );
  const accessibilityLabel = [
    result,
    grade,
    stars === null ? null : t('mobile.logbook.starsA11y', { count: stars }),
    mirrorTag,
    onEarlierVersion ? t('mobile.logbook.earlierVersionA11y') : null,
    climbedAtLabel,
    entry.comment,
  ]
    .filter((part) => Boolean(part))
    .join(', ');

  return (
    <View accessible accessibilityLabel={accessibilityLabel} style={styles.container}>
      <View style={styles.line}>
        <Text variant="subheadline" style={styles.result}>
          {result}
          {details.length > 0 ? (
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {details.map((detail) => ` · ${detail}`).join('')}
            </Text>
          ) : null}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.time}>
          {climbedAtLabel}
        </Text>
      </View>
      {entry.comment ? <Text variant="subheadline">{entry.comment}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingTop: 6,
    gap: 1,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing[2],
  },
  // Takes the free width and wraps inside it, so a long German result or a
  // large text size pushes onto a second line instead of squeezing the time.
  result: {
    flex: 1,
  },
  time: {
    fontVariant: ['tabular-nums'],
  },
});
