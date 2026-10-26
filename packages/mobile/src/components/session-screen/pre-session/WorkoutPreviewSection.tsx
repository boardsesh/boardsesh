import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import type { PlanFillSummary } from '@boardsesh/playlist-generator';
import { Card } from '../../Card';
import { SectionHeader } from '../../SectionHeader';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { WorkoutPreviewSummary } from './WorkoutPreviewSummary';
import type { StartQueueSummary } from './workout-start-queue';

type WorkoutPreviewSectionProps = {
  /** Board of the preview rows; the summary shows only once there is one and a row. */
  boardName: BoardName | null;
  hasPreviewItems: boolean;
  summary: PlanFillSummary;
  startQueue: StartQueueSummary;
  onShuffle: () => void;
  shuffleDisabled: boolean;
  /** Loading / empty / error copy shown while the preview has no rows. */
  stateMessage: string | null;
};

/**
 * The heading of the pre-session workout preview: its title, the plan summary
 * with Shuffle, and the loading / empty / error line. The planned climbs follow
 * it as list rows (`WorkoutPreviewListRow`). One component for both places the
 * preview goes: under the block cards, or the phone split's leading pane.
 */
export const WorkoutPreviewSection = memo(function WorkoutPreviewSection({
  boardName,
  hasPreviewItems,
  summary,
  startQueue,
  onShuffle,
  shuffleDisabled,
  stateMessage,
}: WorkoutPreviewSectionProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  return (
    <View>
      <SectionHeader title={t('mobile.session.preWorkoutPreviewTitle')} />
      {boardName && hasPreviewItems ? (
        <WorkoutPreviewSummary
          summary={summary}
          boardName={boardName}
          onShuffle={onShuffle}
          shuffleDisabled={shuffleDisabled}
          startQueue={startQueue}
        />
      ) : null}
      {stateMessage ? (
        <View style={styles.cardInset}>
          <Card>
            <Text variant="body" color={systemColors.secondaryLabel}>
              {stateMessage}
            </Text>
          </Card>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  // Matches the 16px screen gutter the SectionHeaders use, so cards line up.
  cardInset: {
    paddingHorizontal: spacing[4],
  },
});
