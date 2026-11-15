import { formatGrade } from '@boardsesh/play-view';
import type { BetaLink } from '@boardsesh/shared-schema';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { STORY_ASCENTS } from '../../dev/fixtures/ascents';
import { STORY_CLIMBS } from '../../dev/fixtures/climbs';
import { StoryBoard } from '../../dev/stories/StoryBoard';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useVisibleArtReadiness } from '../../dev/stories/use-visible-art-readiness';
import { buildShareBetaListItems, type ShareBetaListItem } from '../../lib/share-beta-list';
import { BetaVideoCardView } from '../play-drawer/BetaVideoCardView';
import { Text } from '../Text';
import { ProfileBetaShelfView } from '../you/ProfileBetaShelfView';
import { ShareBetaAscentRowView } from './ShareBetaAscentRowView';
import { ShareBetaView } from './ShareBetaView';
const noop = () => {};
const shareAssetId = (item: ShareBetaListItem) => (item.kind === 'ascent' ? item.ascent.uuid : null);
const formatStoryGrade = (grade: string | null | undefined, board?: string | null) =>
  formatGrade(grade, 'v-grade', board);
const noDifficultyGrade = () => null;
const clips: BetaLink[] = [0, 1, 2, 3].map((index) => ({
  climb_uuid: STORY_CLIMBS[0].uuid,
  link: `https://www.instagram.com/reel/story${index}/`,
  foreign_username: ['alex', 'morgan', 'sam', 'alex'][index],
  thumbnail: null,
  angle: 40,
  is_listed: true,
  created_at: '2026-10-26T10:00:00Z',
  tick_uuid: null,
  board_id: null,
}));
function ShareStory({ onReady, onError }: StoryRenderControls) {
  const { t } = useTranslation('session');
  const [searchText, setSearchText] = useState('');
  const [attached, setAttached] = useState(false);
  const { onDisplayed: markReady, onViewableItemsChanged } = useVisibleArtReadiness(shareAssetId, onReady);
  const ascents = useMemo(
    () => STORY_ASCENTS.filter((ascent) => ascent.climbName?.toLowerCase().includes(searchText.toLowerCase())),
    [searchText],
  );
  const listItems = useMemo(
    () => buildShareBetaListItems({ ascents, suggestions: ascents.slice(0, 1), isSearching: searchText.length > 0 }),
    [ascents, searchText],
  );

  const activate = useCallback(() => setAttached(true), []);
  const renderItem = useCallback(
    ({ item }: { item: ShareBetaListItem }) =>
      item.kind === 'section' ? (
        <Text variant="footnote" style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
          {item.source === 'suggested'
            ? t('mobile.betaVideos.shareSuggestedTitle')
            : t('mobile.betaVideos.shareOtherAscents')}
        </Text>
      ) : (
        <ShareBetaAscentRowView
          ascent={item.ascent}
          source={item.source}
          onActivate={activate}
          boardseshActive={false}
          formatGrade={formatStoryGrade}
          formatGradeByDifficultyId={noDifficultyGrade}
          relativeTime="2 hours ago"
          thumbnail={
            <View style={{ width: 60, height: 76 }}>
              <StoryBoard
                climb={STORY_CLIMBS[STORY_ASCENTS.findIndex((ascent) => ascent.uuid === item.ascent.uuid)]}
                onReady={() => markReady(item.ascent.uuid)}
                onError={onError}
              />
            </View>
          }
        />
      ),
    [activate, markReady, onError, t],
  );
  return (
    <ShareBetaView
      isAuthenticated
      onSignIn={noop}
      onClose={noop}
      thumbnail={null}
      caption={attached ? 'Beta attached' : 'Finally linked the moves. Keep the left heel high!'}
      link={clips[0].link}
      previewLoading={false}
      searchText={searchText}
      onSearchChange={setSearchText}
      attachError={null}
      attaching={false}
      loading={false}
      loadingMore={false}
      listItems={listItems}
      renderItem={renderItem}
      onViewableItemsChanged={onViewableItemsChanged}
      handleEndReached={noop}
      isSearching={searchText.length > 0}
    />
  );
}
function ShelfStory() {
  const [expanded, setExpanded] = useState(true);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <ProfileBetaShelfView
        count={clips.length}
        isLoading={false}
        isLoadingMore={false}
        expanded={expanded}
        onToggle={() => setExpanded((previous) => !previous)}
        onLoadMore={noop}
        onSeeAll={noop}
      >
        {clips.map((clip) => (
          <BetaVideoCardView key={clip.link} link={clip} size="compact" onPress={noop} />
        ))}
      </ProfileBetaShelfView>
    </View>
  );
}
const stories: StoryModule = {
  title: 'Beta / Sharing',
  stories: {
    share: {
      name: 'Attach shared beta to a logged climb',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <ShareStory {...controls} />,
    },
    shelf: { name: 'Recent beta clips', layout: 'fullscreen', render: () => <ShelfStory /> },
  },
};
export default stories;
