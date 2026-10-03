import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { LedgerTotals } from '@boardsesh/profile-stats';
import { Text } from '../../Text';
import { GradePill } from '../../ascent-marks';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { useTheme } from '../../../providers/theme-provider';
import { spacing, borderRadius } from '../../../theme/tokens';

type LogbookStatTilesProps = {
  totals: LedgerTotals;
  boardAngle: number;
};

const VALUE_HEIGHT = 25;

function StatTile({
  label,
  accessibilityLabel,
  children,
}: {
  label: string;
  accessibilityLabel: string;
  children: ReactNode;
}) {
  const { systemColors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={[styles.tile, { backgroundColor: systemColors.elevatedSurface }]}
    >
      <View style={styles.value}>{children}</View>
      <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} adjustsFontSizeToFit>
        {label}
      </Text>
    </View>
  );
}

function StatNumber({ value }: { value: number }) {
  return (
    <Text variant="title3" style={styles.number} numberOfLines={1} adjustsFontSizeToFit>
      {value}
    </Text>
  );
}

/**
 * The four numbers under the verdict. The caption says what they cover: the
 * board's angle when the climber has logs there, every angle otherwise.
 */
export const LogbookStatTiles = memo(function LogbookStatTiles({ totals, boardAngle }: LogbookStatTilesProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();

  const triesLabel = t('mobile.logbook.statTries');
  const sessionsLabel = t('mobile.logbook.statSessions');
  const sendsLabel = t('mobile.logbook.statSends');
  const gradeLabel = t('mobile.logbook.statGrade');
  // The tile is one accessibility element, so the grade the pill draws has to
  // be in its label or VoiceOver reads "Your grade" and stops.
  const { formatGradeByDifficultyId } = useGradeFormat();

  return (
    <View style={styles.container}>
      <Text variant="caption1" color={systemColors.secondaryLabel}>
        {totals.scope === 'angle'
          ? t('mobile.logbook.tilesAtAngle', { angle: boardAngle })
          : t('mobile.logbook.tilesAllAngles')}
      </Text>
      <View style={styles.row}>
        <StatTile label={triesLabel} accessibilityLabel={`${triesLabel}: ${totals.tries}`}>
          <StatNumber value={totals.tries} />
        </StatTile>
        <StatTile label={sessionsLabel} accessibilityLabel={`${sessionsLabel}: ${totals.sessions}`}>
          <StatNumber value={totals.sessions} />
        </StatTile>
        <StatTile label={sendsLabel} accessibilityLabel={`${sendsLabel}: ${totals.sends}`}>
          <StatNumber value={totals.sends} />
        </StatTile>
        {totals.personalGrade == null ? (
          <StatTile label={gradeLabel} accessibilityLabel={`${gradeLabel}: ${t('mobile.logbook.statGradeNone')}`}>
            <Text variant="title3" color={systemColors.secondaryLabel}>
              –
            </Text>
          </StatTile>
        ) : (
          <StatTile
            label={gradeLabel}
            accessibilityLabel={`${gradeLabel}: ${formatGradeByDifficultyId(totals.personalGrade) ?? ''}`}
          >
            <GradePill difficultyId={totals.personalGrade} />
          </StatTile>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[1],
  },
  row: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  tile: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[1],
    paddingVertical: spacing[2],
  },
  value: {
    height: VALUE_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  number: {
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
