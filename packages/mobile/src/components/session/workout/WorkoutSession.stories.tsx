import { useStoryBottomInset } from '../../../dev/stories/use-story-bottom-inset';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionClimbsStoryItem, sessionRowAssetId } from '../../../dev/fixtures/session-detail';
import { SessionFeedStoryCard } from '../../../dev/fixtures/session-feed';
import { StoryVariant } from '../../../dev/stories/StoryCanvas';
import { StoryClimbArtObserverProvider } from '../../../dev/stories/StoryClimbRow';
import type { StoryModule, StoryRenderControls } from '../../../dev/stories/types';
import { readFlashListViewport, useVisibleArtReadiness } from '../../../dev/stories/use-visible-art-readiness';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { SectionHeader } from '../../SectionHeader';
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

function GroupedClimbs({ fromCoolDown = false, onReady, onError }: { fromCoolDown?: boolean } & StoryRenderControls) {
  const listRef = useRef<FlashListRef<WorkoutClimbsRow>>(null);
  const { onDisplayed, onViewableItemsChanged, onInitialViewport } = useVisibleArtReadiness(sessionRowAssetId, onReady);
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomInset = useStoryBottomInset();
  // Newest first, as the server lists them; Pinch Me's tick hidden from this
  // viewer (its row still says what the tally counted), and a crewmate's tick.
  const ticks = useMemo(() => {
    const own = storyDetailTicks().filter((tick) => tick.uuid !== 't-q-w3-0');
    const crewTick = { ...own[0]!, uuid: 't-crew', userId: 'story-crewmate', climbName: 'Jug Haul' };
    return [...own, crewTick].reverse();
  }, []);
  const { rows } = useMemo(() => buildWorkoutClimbRows(ticks, STORY_WORKOUT), [ticks]);
  const onLoad = useCallback(() => {
    if (listRef.current) onInitialViewport(readFlashListViewport(listRef.current, rows));
  }, [rows, onInitialViewport]);
  const renderItem = useCallback(({ item }: { item: WorkoutClimbsRow }) => <SessionClimbsStoryItem row={item} />, []);
  // The end of the list: the cool-down, then "Off plan" and the crew.
  const coolDownIndex = rows.findIndex((row) => row.type === 'block' && row.stage.isCoolDown);
  const header = useMemo(() => <SectionHeader title={t('detail.climbsCount', { count: ticks.length })} />, [t, ticks]);
  return (
    <StoryClimbArtObserverProvider onDisplayed={onDisplayed} onError={onError}>
      <View style={[styles.fill, { backgroundColor: systemColors.groupedBackground }]}>
        <FlashList<WorkoutClimbsRow>
          ref={listRef}
          onLoad={onLoad}
          onViewableItemsChanged={onViewableItemsChanged}
          data={rows}
          renderItem={renderItem}
          keyExtractor={workoutClimbsRowKey}
          getItemType={workoutClimbsRowType}
          ListHeaderComponent={header}
          initialScrollIndex={fromCoolDown && coolDownIndex >= 0 ? coolDownIndex : undefined}
          contentContainerStyle={{ paddingTop: insets.top, paddingBottom: bottomInset + spacing[6] }}
        />
      </View>
    </StoryClimbArtObserverProvider>
  );
}

const stories: StoryModule = {
  title: 'Session / Workout elsewhere',
  stories: {
    detailGrouped: {
      name: 'Session detail: climbs grouped by block, a hidden tick, a crewmate',
      layout: 'fullscreen',
      tab: 'home',
      tabRoot: false,
      readiness: 'explicit',
      render: (controls) => <GroupedClimbs {...controls} />,
    },
    detailGroupedEnd: {
      name: 'Session detail: the cool-down, Off plan and the crew',
      layout: 'fullscreen',
      tab: 'home',
      tabRoot: false,
      readiness: 'explicit',
      render: (controls) => <GroupedClimbs {...controls} fromCoolDown />,
    },
    feedCard: {
      name: 'Feed card with its workout line',
      render: () => (
        <>
          <StoryVariant label="one main block">
            <SessionFeedStoryCard session={STORY_FEED_SESSION} workoutHeadline={STORY_HEADLINE} />
          </StoryVariant>
          <StoryVariant label="more main blocks">
            <SessionFeedStoryCard
              session={{ ...STORY_FEED_SESSION, sessionId: 'story-feed-more', socialEntityId: 'story-feed-more' }}
              workoutHeadline={STORY_HEADLINE_MORE}
            />
          </StoryVariant>
          <StoryVariant label="no workout">
            <SessionFeedStoryCard
              session={{ ...STORY_FEED_SESSION, sessionId: 'story-feed-plain', socialEntityId: 'story-feed-plain' }}
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
