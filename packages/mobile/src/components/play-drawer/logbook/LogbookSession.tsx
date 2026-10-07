import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { LogbookEntry } from '@boardsesh/board-react';
import type { LedgerSession } from '@boardsesh/profile-stats';
import { Text } from '../../Text';
import { LogbookEntryRow } from '../LogbookEntryRow';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';

type LogbookSessionProps = {
  session: LedgerSession<LogbookEntry>;
  /** "Today", "Yesterday" or a date, resolved by the caller. */
  dayLabel: string;
  showMirrorTag: boolean;
  /**
   * Prints the day's try count beside the day. Callers pass true only when the
   * angle has more than one day: with a single day the count repeats the line
   * under the verdict.
   */
  showDayTries: boolean;
  /** Rows shown before the rest collapse into one caption. Omit to show them all. */
  maxEntries?: number;
  /** The version the climb is on now; see `LogbookEntryRow`. */
  climbCurrentRevision?: number | null;
  /** The climb's board; see `LogbookEntryRow`. */
  boardName?: string | null;
};

/** One day on the climb: the day as a bold line, then that day's logs as words. */
export const LogbookSession = memo(function LogbookSession({
  session,
  dayLabel,
  showMirrorTag,
  showDayTries,
  maxEntries,
  climbCurrentRevision,
  boardName,
}: LogbookSessionProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  const triesLabel = showDayTries ? t('mobile.logbook.tries', { count: session.totalTries }) : null;
  const shownEntries = maxEntries === undefined ? session.entries : session.entries.slice(0, maxEntries);
  const hiddenCount = session.entries.length - shownEntries.length;

  return (
    <View testID="logbook-session">
      <View accessible accessibilityLabel={triesLabel ? `${dayLabel}, ${triesLabel}` : dayLabel} style={styles.header}>
        <Text variant="footnote" style={styles.day}>
          {dayLabel}
        </Text>
        {triesLabel ? (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {triesLabel}
          </Text>
        ) : null}
      </View>
      {shownEntries.map((entry) => (
        <LogbookEntryRow
          key={entry.uuid}
          entry={entry}
          showMirrorTag={showMirrorTag}
          climbCurrentRevision={climbCurrentRevision}
          boardName={boardName}
        />
      ))}
      {hiddenCount > 0 ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.more}>
          {t('mobile.logbook.moreLogsThatDay', { count: hiddenCount })}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    // Wraps at accessibility type sizes instead of squeezing the count off.
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: spacing[2],
  },
  day: {
    fontWeight: '600',
  },
  more: {
    paddingTop: 6,
  },
});
