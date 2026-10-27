import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SessionFeedParticipant } from '@boardsesh/shared-schema';
import type { StoryModule } from '../../../dev/stories/types';
import { StoryVariant } from '../../../dev/stories/StoryCanvas';
import { SectionHeader } from '../../SectionHeader';
import { SessionFeedCard } from '../../you/SessionFeedCard';
import { SessionClimbsListItem } from '../SessionClimbsListItem';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import {
  buildWorkoutClimbRows,
  workoutClimbsRowKey,
  workoutClimbsRowType,
  type WorkoutClimbsRow,
} from './workout-climb-rows';
import {
  STORY_FEED_SESSION,
  STORY_HEADLINE,
  STORY_HEADLINE_MORE,
  STORY_WORKOUT,
  storyDetailTicks,
} from './workout-story-fixtures';

// A workout session where other screens show it (#6903): the session detail's
// Climbs list grouped by block, and the feed card's workout line. Both draw from
// props; the screens get the same data through the workout seams once the data
// lands.

const NO_PARTICIPANTS: ReadonlyMap<string, SessionFeedParticipant> = new Map();
const noop = () => {};

function GroupedClimbs() {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const ticks = useMemo(() => storyDetailTicks().reverse(), []);
  const { rows } = useMemo(() => buildWorkoutClimbRows(ticks, STORY_WORKOUT), [ticks]);
  const header = useMemo(() => <SectionHeader title={t('detail.climbsCount', { count: ticks.length })} />, [t, ticks]);
  return (
    <View style={[styles.fill, { backgroundColor: systemColors.groupedBackground }]}>
      <FlashList<WorkoutClimbsRow>
        data={rows}
        renderItem={({ item }) => (
          <SessionClimbsListItem row={item} isMultiUser={false} participantById={NO_PARTICIPANTS} onPress={noop} />
        )}
        keyExtractor={workoutClimbsRowKey}
        getItemType={workoutClimbsRowType}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + spacing[6] }}
      />
    </View>
  );
}

const stories: StoryModule = {
  title: 'Session / Workout elsewhere',
  stories: {
    detailGrouped: {
      name: 'Session detail: climbs grouped by block',
      layout: 'fullscreen',
      render: () => <GroupedClimbs />,
    },
    feedCard: {
      name: 'Feed card with its workout line',
      render: () => (
        <>
          <StoryVariant label="one main block">
            <SessionFeedCard
              session={STORY_FEED_SESSION}
              onOpenComments={noop}
              onPress={noop}
              workoutHeadline={STORY_HEADLINE}
            />
          </StoryVariant>
          <StoryVariant label="more main blocks">
            <SessionFeedCard
              session={{ ...STORY_FEED_SESSION, sessionId: 'story-feed-more', socialEntityId: 'story-feed-more' }}
              onOpenComments={noop}
              onPress={noop}
              workoutHeadline={STORY_HEADLINE_MORE}
            />
          </StoryVariant>
          <StoryVariant label="no workout">
            <SessionFeedCard
              session={{ ...STORY_FEED_SESSION, sessionId: 'story-feed-plain', socialEntityId: 'story-feed-plain' }}
              onOpenComments={noop}
              onPress={noop}
            />
          </StoryVariant>
        </>
      ),
    },
  },
};

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});

export default stories;
