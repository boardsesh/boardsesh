import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  presentGymAngleUsage,
  type GymAngleUsageBoardPresentation,
  type GymAngleUsageRowPresentation,
} from '@boardsesh/graphql';
import type { GymStats } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { Text } from '../Text';

export type GymAngleUsageListRow =
  | { key: string; kind: 'board'; board: GymAngleUsageBoardPresentation }
  | { key: string; kind: 'angle'; angle: GymAngleUsageRowPresentation }
  | { key: string; kind: 'unknown'; counts: NonNullable<GymAngleUsageBoardPresentation['unknown']> };

export function buildGymAngleUsageRows(stats: GymStats, locale: string): GymAngleUsageListRow[] {
  const scopeKey = `${stats.gymUuid}:${stats.boardUuid ?? 'all'}:${stats.periodDays}:${stats.asOf}`;
  const rows: GymAngleUsageListRow[] = [];
  for (const board of presentGymAngleUsage(stats, locale)) {
    const boardKey = `${scopeKey}:${board.boardUuid}`;
    rows.push({ key: boardKey, kind: 'board', board });
    for (const angle of board.rows) rows.push({ key: `${boardKey}:${angle.angle}`, kind: 'angle', angle });
    if (board.unknown) rows.push({ key: `${boardKey}:unknown`, kind: 'unknown', counts: board.unknown });
  }
  return rows;
}

function BoardSummary({ board }: { board: GymAngleUsageBoardPresentation }) {
  const { t } = useTranslation('boards');
  switch (board.summary) {
    case 'empty':
      return t('gymReporting.angleUsage.empty');
    case 'unknownOnly':
      return t('gymReporting.angleUsage.unknownOnly');
    case 'unidentified':
      return t('gymReporting.angleUsage.unidentified');
    case 'single':
      return t('gymReporting.angleUsage.single', { angle: board.leaders, countText: board.leadingClimbers });
    case 'tied':
      return t('gymReporting.angleUsage.tied', { angles: board.leaders, countText: board.leadingClimbers });
    case 'mostUsed':
      return t('gymReporting.angleUsage.mostUsed', { angle: board.leaders, countText: board.leadingClimbers });
  }
}

type RowProps = {
  row: GymAngleUsageListRow;
  expanded: boolean;
  onToggle: (key: string) => void;
};

export const GymAngleUsageListItem = memo(function GymAngleUsageListItem({ row, expanded, onToggle }: RowProps) {
  const { t } = useTranslation('boards');
  const { brandColors, systemColors } = useTheme();
  if (row.kind === 'board') {
    const { board } = row;
    return (
      <View style={styles.board}>
        <Text accessibilityRole="header" variant="headline">
          {board.boardName}
        </Text>
        <Text variant="subheadline">
          <BoardSummary board={board} />
        </Text>
        {board.rows.length > 0 && (
          <>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('gymReporting.angleUsage.sample', { countText: board.sample })}
            </Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('gymReporting.angleUsage.overlap')}
            </Text>
          </>
        )}
      </View>
    );
  }

  if (row.kind === 'unknown') {
    return (
      <View style={styles.details}>
        <Text variant="subheadline">{t('gymReporting.angleUsage.unknown')}</Text>
        <Text variant="footnote">{t('gymReporting.angleUsage.ticks', { countText: row.counts.ticks })}</Text>
        <Text variant="footnote">{t('gymReporting.sends', { countText: row.counts.sends })}</Text>
        <Text variant="footnote">{t('gymReporting.angleUsage.displays', { countText: row.counts.displays })}</Text>
      </View>
    );
  }

  const { angle } = row;
  const climbers = t('gymReporting.climbers', { countText: angle.climbers });
  const share = angle.isBelowMinimum
    ? t('gymReporting.angleUsage.belowShare', { percentage: angle.percentLabel })
    : angle.percentLabel;
  const shareText = share ? t('gymReporting.angleUsage.rowShare', { climbers, percentage: share }) : climbers;
  const leaderText = angle.isLeader ? t('gymReporting.angleUsage.leading') : null;
  const details = [
    t('gymReporting.angleUsage.climberDays', { countText: angle.climberDays }),
    t('gymReporting.angleUsage.ticks', { countText: angle.ticks }),
    t('gymReporting.sends', { countText: angle.sends }),
    t('gymReporting.angleUsage.displays', { countText: angle.displays }),
  ];
  if (angle.unresolvedDates !== null) {
    details.push(t('gymReporting.angleUsage.unresolvedDates', { countText: angle.unresolvedDates }));
  }

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={[angle.angleLabel, leaderText, shareText, ...details].filter(Boolean).join('. ')}
        onPress={() => onToggle(row.key)}
        style={styles.barButton}
      >
        <View style={styles.barLabel}>
          <Text variant="subheadline">{angle.angleLabel}</Text>
          {leaderText && (
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {leaderText}
            </Text>
          )}
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {shareText}
          </Text>
        </View>
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          style={[styles.barTrack, { backgroundColor: systemColors.tertiaryFill }]}
        >
          <View
            style={[
              styles.barFill,
              {
                width: `${(angle.share ?? 0) * 100}%`,
                backgroundColor: angle.isLeader ? brandColors.accent : brandColors.primary,
              },
            ]}
          />
        </View>
      </Pressable>
      {expanded && (
        <View style={styles.details}>
          {details.map((line) => (
            <Text key={line} variant="footnote">
              {line}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  board: { paddingTop: spacing[4], gap: spacing[1] },
  barButton: { minHeight: spacing[12], paddingVertical: spacing[1], justifyContent: 'center', gap: spacing[1] },
  barLabel: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: spacing[2] },
  barTrack: { height: spacing[2], borderRadius: borderRadius.sm },
  barFill: { height: '100%', borderRadius: borderRadius.sm },
  details: { gap: spacing[1], paddingVertical: spacing[2] },
});
