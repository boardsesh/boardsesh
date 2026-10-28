// "Your workout" on the post-session summary (#6903): a header and a card with
// one row per block. A workout has a handful of blocks (≤ 30 by the server's
// cap, ~3 in practice), so the rows map straight into the card.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card } from '../../Card';
import { SectionHeader } from '../../SectionHeader';
import { spacing } from '../../../theme/tokens';
import { WorkoutBlockRow } from './WorkoutBlockRow';
import type { SessionWorkoutView } from './types';

type WorkoutSummarySectionProps = {
  workout: SessionWorkoutView;
  /** Opens this block's climbs on first draw (stories, screenshots). */
  initiallyExpandedStageId?: string;
};

export const WorkoutSummarySection = memo(function WorkoutSummarySection({
  workout,
  initiallyExpandedStageId,
}: WorkoutSummarySectionProps) {
  const { t } = useTranslation('session');
  if (workout.stages.length === 0) return null;
  return (
    <View style={styles.section} testID="workout-summary-section">
      <SectionHeader title={t('mobile.session.workoutCardTitle')} />
      <Card style={styles.card}>
        {workout.stages.map((stage, index) => (
          <WorkoutBlockRow
            key={stage.id}
            stage={stage}
            separator={index < workout.stages.length - 1}
            initiallyExpanded={stage.id === initiallyExpandedStageId}
          />
        ))}
      </Card>
    </View>
  );
});

const styles = StyleSheet.create({
  section: {
    gap: spacing[2],
  },
  card: {
    paddingVertical: spacing[1],
  },
});
