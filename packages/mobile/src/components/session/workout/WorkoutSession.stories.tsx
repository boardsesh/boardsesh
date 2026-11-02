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

function GroupedClimbs({ fromCoolDown = false }: { fromCoolDown?: boolean }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  // Newest first, as the server lists them; Pinch Me's tick hidden from this
  // viewer (its row still says what the tally counted), and a crewmate's tick.
  const ticks = useMemo(() => {
    const own = storyDetailTicks().filter((tick) => tick.uuid !== 't-q-w3-0');
    const crewTick = { ...own[0]!, uuid: 't-crew', userId: 'story-crewmate', climbName: 'Jug Haul' };
    return [...own, crewTick].reverse();
  }, []);
  const { rows } = useMemo(() => buildWorkoutClimbRows(ticks, STORY_WORKOUT), [ticks]);
  // The end of the list: the cool-down, then "Off plan" and the crew.
  const coolDownIndex = rows.findIndex((row) => row.type === 'block' && row.stage.isCoolDown);
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
        initialScrollIndex={fromCoolDown && coolDownIndex >= 0 ? coolDownIndex : undefined}
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + spacing[6] }}
      />
    </View>
  );
}

const stories: StoryModule = {
  title: 'Session / Workout elsewhere',
  stories: {
    detailGrouped: {
      name: 'Session detail: climbs grouped by block, a hidden tick, a crewmate',
      layout: 'fullscreen',
      render: () => <GroupedClimbs />,
    },
    detailGroupedEnd: {
      name: 'Session detail: the cool-down, Off plan and the crew',
      layout: 'fullscreen',
      render: () => <GroupedClimbs fromCoolDown />,
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
