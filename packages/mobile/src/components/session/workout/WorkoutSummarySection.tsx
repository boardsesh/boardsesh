// "Your workout" on the post-session summary (#6903): a header and a card with
// one row per block. A workout has a handful of blocks (≤ 30 by the server's
// cap, ~3 in practice), so the rows map straight into the card.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card } from '../../Card';
import { Text } from '../../Text';
import { sectionHeaderText } from '../../section-header-text';
import { useTheme } from '../../../providers/theme-provider';
import { applySectionCaption } from '../../../theme/variants/variant-tokens';
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
      <WorkoutSectionHeading title={t('mobile.session.workoutCardTitle')} />
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

/**
 * `SectionHeader`'s look (per UI variant) with the header role, so VoiceOver's
 * rotor can jump to the workout.
 */
export function WorkoutSectionHeading({ title }: { title: string }) {
  const { systemColors, variant, m3, sectionCaption } = useTheme();
  const caption = applySectionCaption(title, sectionCaption);
  const headerText = sectionHeaderText(variant, {
    secondaryLabel: systemColors.secondaryLabel,
    onSurfaceVariant: m3.onSurfaceVariant,
  });
  return (
    <Text
      variant={headerText.textVariant}
      color={headerText.color}
      accessibilityRole="header"
      accessibilityLabel={title}
      style={[styles.heading, caption.style, { fontWeight: headerText.fontWeight }]}
    >
      {caption.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing[2],
  },
  heading: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
  },
  card: {
    paddingVertical: spacing[1],
  },
});
