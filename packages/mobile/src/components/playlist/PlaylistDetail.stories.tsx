import { useStoryBottomInset } from '../../dev/stories/use-story-bottom-inset';
import { useNavigation } from 'expo-router';
import type { Climb } from '@boardsesh/queue';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStoryBoardFixture } from '../../dev/stories/story-board-fixture';
import { StoryClimbArtObserverProvider, StoryClimbRow } from '../../dev/stories/StoryClimbRow';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useVisibleArtReadiness } from '../../dev/stories/use-visible-art-readiness';
import { toQueueClimbs, toSchemaClimb } from '../../lib/climb-types';
import { PlaylistDetailPresentation } from './PlaylistDetailPresentation';
const noop = () => {};
const identity = (children: ReactNode) => children;
const assetId = (climb: Climb) => climb.uuid;
function PlaylistStory({ onReady, onError }: StoryRenderControls) {
  const fixture = useStoryBoardFixture();
  const CLIMBS = useMemo(() => toQueueClimbs(fixture.climbs.slice(0, 3)), [fixture]);
  const { onDisplayed, onViewableItemsChanged } = useVisibleArtReadiness(assetId, onReady);
  const { t } = useTranslation('playlists');
  const navigation = useNavigation();
  const setHeaderOptions = useCallback(
    (options: Record<string, unknown>) => navigation.setOptions(options),
    [navigation],
  );
  const bottomInset = useStoryBottomInset();
  const renderItem = useCallback(({ item }: { item: Climb }) => <StoryClimbRow climb={toSchemaClimb(item)} />, []);
  return (
    <StoryClimbArtObserverProvider onDisplayed={onDisplayed} onError={onError}>
      <PlaylistDetailPresentation
        hero={{
          name: 'Friday projects',
          climbCount: CLIMBS.length,
          color: '#7654A3',
          icon: 'flag',
          description: 'A few moves worth coming back for.',
        }}
        climbs={CLIMBS}
        renderBoard={null}
        isLoading={false}
        isFetchingNextPage={false}
        hasNextPage={false}
        fetchNextPage={noop}
        onActivateClimb={noop}
        emptyMessage={t('library.empty.title')}
        onQueueAll={noop}
        renderItem={renderItem}
        onViewableItemsChanged={onViewableItemsChanged}
        isDragging={false}
        listPaddingBottom={bottomInset + 24}
        onBack={noop}
        setHeaderOptions={setHeaderOptions}
        wrapList={identity}
        loadingRows={null}
      />
    </StoryClimbArtObserverProvider>
  );
}
const stories: StoryModule = {
  title: 'Discover / Playlist',
  stories: {
    populated: {
      name: 'Climbs for the next session',
      layout: 'fullscreen',
      tab: 'discover',
      tabRoot: false,
      readiness: 'explicit',
      render: (controls) => <PlaylistStory {...controls} />,
    },
  },
};
export default stories;
