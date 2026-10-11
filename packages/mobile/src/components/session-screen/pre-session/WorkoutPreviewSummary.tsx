import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import type { PlanFillSummary } from '@boardsesh/playlist-generator';
import { Card } from '../../Card';
import { Icon } from '../../Icon';
import { PressableSurface } from '../../PressableSurface';
import { Text } from '../../Text';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { hapticSelection } from '../../../lib/haptics';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';

type WorkoutPreviewSummaryProps = {
  summary: PlanFillSummary;
  boardName: BoardName;
  onShuffle: () => void;
  /** While the preview rebuilds or a row regenerates. */
  shuffleDisabled: boolean;
};

/**
 * The line above the preview rows that says what Start will queue: how many
 * climbs and over which grades, plus a Shuffle that re-picks every climb at the
 * same grades. When a thin catalogue left slots empty, a note says how many of
 * the planned climbs were found, because those are all Start will queue.
 */
export function WorkoutPreviewSummary({ summary, boardName, onShuffle, shuffleDisabled }: WorkoutPreviewSummaryProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors, opacity } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();

  if (summary.filled === 0) return null;

  const lowest = formatGradeByDifficultyId(summary.lowestGrade, boardName) ?? String(summary.lowestGrade);
  const highest = formatGradeByDifficultyId(summary.highestGrade, boardName) ?? String(summary.highestGrade);
  const grades = lowest === highest ? lowest : t('mobile.session.preWorkoutPreviewGradeSpan', { lowest, highest });

  return (
    <View style={styles.container}>
      <View style={styles.summaryRow}>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.summaryText}>
          {t('mobile.session.preWorkoutPreviewSummary', { count: summary.filled, grades })}
        </Text>
        <PressableSurface
          onPress={() => {
            hapticSelection();
            onShuffle();
          }}
          disabled={shuffleDisabled}
          feedback="opacity"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.session.preWorkoutPreviewShuffleAccessibilityLabel')}
          accessibilityState={{ disabled: shuffleDisabled }}
          style={[styles.shuffle, shuffleDisabled ? { opacity: opacity.disabled } : null]}
        >
          <Icon name="shuffle" size={15} color={brandColors.primary} />
          <Text variant="footnote" color={brandColors.primary} style={styles.shuffleText}>
            {t('mobile.session.preWorkoutPreviewShuffle')}
          </Text>
        </PressableSurface>
      </View>

      {summary.missing > 0 ? (
        <Card>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.session.preWorkoutPreviewShortfall', { filled: summary.filled, planned: summary.planned })}
          </Text>
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  // Shrinks before the Shuffle button does, so large text wraps the summary.
  summaryText: {
    flex: 1,
  },
  shuffle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    minHeight: 44,
  },
  shuffleText: {
    fontWeight: '600',
  },
});
