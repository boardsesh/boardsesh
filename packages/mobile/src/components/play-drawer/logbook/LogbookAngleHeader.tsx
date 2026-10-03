import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { LogbookEntry } from '@boardsesh/board-react';
import type { LedgerAngleSection } from '@boardsesh/profile-stats';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { spacing, borderRadius } from '../../../theme/tokens';

type LogbookAngleHeaderProps = {
  section: LedgerAngleSection<LogbookEntry>;
  /** The board is set to this section's angle. */
  isBoardAngle: boolean;
};

/**
 * Heads one angle's sessions: the angle, a pill when the board is set to it,
 * and that angle's story so far, e.g. "Sent in session 3 · 13 tries over 3 sessions".
 */
export const LogbookAngleHeader = memo(function LogbookAngleHeader({ section, isBoardAngle }: LogbookAngleHeaderProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  let result: string;
  if (!section.firstSend) result = t('mobile.logbook.angleNoSend');
  else if (section.firstSend.flash) result = t('mobile.logbook.angleFlashed');
  else result = t('mobile.logbook.angleSentInSession', { session: section.firstSend.sessionNumber });

  // Segments pluralize individually; the TEMPLATES own word order and joining
  // so a locale can rearrange the clauses.
  const recap = t('mobile.logbook.lifetimeRecap', {
    tries: t('mobile.logbook.lifetimeTries', { count: section.totalTries }),
    sessions: t('mobile.logbook.lifetimeSessions', { count: section.sessionCount }),
  });
  const line = t('mobile.logbook.angleLine', { result, recap });
  const boardIsHere = t('mobile.logbook.boardIsHere');

  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={isBoardAngle ? `${section.angle}°, ${boardIsHere}, ${line}` : `${section.angle}°, ${line}`}
      style={[styles.header, { borderTopColor: systemColors.separator }]}
    >
      <View style={styles.lead}>
        <Text variant="headline">{`${section.angle}°`}</Text>
        {isBoardAngle ? (
          <View style={[styles.pill, { backgroundColor: systemColors.fill }]}>
            <Text variant="caption2" color={systemColors.accent} style={styles.pillLabel}>
              {boardIsHere}
            </Text>
          </View>
        ) : null}
      </View>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.line}>
        {line}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    // Wrap instead of colliding at accessibility type sizes: the story drops
    // below the angle when one line can't hold both.
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing[2],
    rowGap: spacing[1],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  lead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  pill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  pillLabel: {
    fontWeight: '600',
  },
  line: {
    flexShrink: 1,
    textAlign: 'right',
  },
});
