import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { LogbookEntry } from '@boardsesh/board-react';
import type { LedgerSession } from '@boardsesh/profile-stats';
import { Text } from '../../Text';
import { LogbookEntryRow } from '../LogbookEntryRow';
import { TryDots } from './TryDots';
import { useTheme } from '../../../providers/theme-provider';
import { spacing, borderRadius } from '../../../theme/tokens';

type LogbookSessionTileProps = {
  session: LedgerSession<LogbookEntry>;
  /** "Today", "Yesterday" or a date, resolved by the caller. */
  dayLabel: string;
  showMirrorTag: boolean;
  /** Rows shown before the rest collapse into one caption. Omit to show them all. */
  maxEntries?: number;
};

/** One day on the climb: the day, a mark per try, then that day's logs. */
export const LogbookSessionTile = memo(function LogbookSessionTile({
  session,
  dayLabel,
  showMirrorTag,
  maxEntries,
}: LogbookSessionTileProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  const triesLabel = t('mobile.logbook.tries', { count: session.totalTries });
  let summary: string;
  switch (session.outcome) {
    case 'flash':
      summary = t('mobile.logbook.sessionFlash', { tries: triesLabel });
      break;
    case 'send':
      summary = t('mobile.logbook.sessionSent', { tries: triesLabel });
      break;
    default:
      summary = triesLabel;
  }

  const shownEntries = maxEntries === undefined ? session.entries : session.entries.slice(0, maxEntries);
  const hiddenCount = session.entries.length - shownEntries.length;

  return (
    <View testID="logbook-session-tile" style={[styles.tile, { backgroundColor: systemColors.elevatedSurface }]}>
      <View accessible accessibilityLabel={`${dayLabel}, ${summary}`} style={styles.header}>
        <Text variant="footnote" style={styles.day}>
          {dayLabel}
        </Text>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {summary}
        </Text>
      </View>
      <TryDots marks={session.marks} overflowTries={session.overflowTries} />
      <View style={styles.entries}>
        {shownEntries.map((entry) => (
          <LogbookEntryRow key={entry.uuid} entry={entry} showMirrorTag={showMirrorTag} />
        ))}
        {hiddenCount > 0 ? (
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.more}>
            {t('mobile.logbook.moreLogsThatDay', { count: hiddenCount })}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  tile: {
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    paddingTop: spacing[3],
    paddingBottom: spacing[1],
  },
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing[2],
    marginBottom: spacing[2],
  },
  day: {
    fontWeight: '600',
  },
  entries: {
    marginTop: spacing[2],
  },
  more: {
    paddingBottom: spacing[2],
  },
});
