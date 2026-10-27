// The feed card's workout line (#6903): "Workout · 4x4 at V4 · 3 blocks", one
// line under the card's header. Part of the card's tap target, so it is text
// only; the card's own label carries it for VoiceOver.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../Icon';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { withAlpha } from '../../../theme/colors';
import { borderRadius, spacing } from '../../../theme/tokens';
import type { WorkoutHeadlineView } from './types';
import { workoutHeadlineText } from './workout-summary-format';

export const WorkoutHeadlineChip = memo(function WorkoutHeadlineChip({ headline }: { headline: WorkoutHeadlineView }) {
  const { t } = useTranslation('session');
  const { brandColors } = useTheme();
  const { text, spoken } = workoutHeadlineText(headline, t);
  return (
    <View
      style={[styles.chip, { backgroundColor: withAlpha(brandColors.primary, 0.12) }]}
      accessible
      accessibilityLabel={spoken}
      testID="workout-headline-chip"
    >
      <Icon name="repeat" size={12} color={brandColors.primary} />
      <Text variant="caption1" color={brandColors.primary} numberOfLines={1} style={styles.text} numeric>
        {text}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    gap: spacing[1],
    paddingHorizontal: spacing[2],
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  text: {
    flexShrink: 1,
    fontWeight: '600',
  },
});
