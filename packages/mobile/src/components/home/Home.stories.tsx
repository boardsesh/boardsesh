import { selectByVariant } from '../../theme/variants';
import { useStoryBottomInset } from '../../dev/stories/use-story-bottom-inset';
import type { CrewFeedItem } from '@boardsesh/shared-schema';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { STORY_CLIMBS } from '../../dev/fixtures/climbs';
import { SessionFeedStoryCard } from '../../dev/fixtures/session-feed';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useVisibleArtReadiness } from '../../dev/stories/use-visible-art-readiness';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { useTheme } from '../../providers/theme-provider';
import { NotificationsToolbarActionView } from '../chrome/NotificationsToolbarActionView';
import { HomeTopChromeView } from '../feed/HomeTopChromeView';
import { STORY_FEED_SESSION } from '../session/workout/workout-story-fixtures';
import { UserAvatarToolbarActionView } from '../user-drawer/UserAvatarToolbarActionView';
import { HomeHeaderView } from './HomeHeaderView';
import { HomeView } from './HomeView';

const noop = () => {};
const feedAssetId = (item: CrewFeedItem) => item.id;
const ITEMS: CrewFeedItem[] = [0, 1, 2].map((index) => ({
  __typename: 'CrewSessionItem',
  id: `home-story-${index}`,
  occurredAt: '2026-10-26T10:00:00.000Z',
  session: {
    ...STORY_FEED_SESSION,
    hardestSend: {
      uuid: `tick-${index}`,
      userId: 'story-user',
      climbUuid: STORY_CLIMBS[0].uuid,
      climbName: STORY_CLIMBS[0].name,
      boardType: 'kilter',
      layoutId: 1,
      angle: 40,
      status: 'send',
      attemptCount: 3,
      difficultyName: STORY_CLIMBS[0].difficulty,
      isMirror: false,
      isBenchmark: false,
      isNoMatch: false,
      frames: STORY_CLIMBS[0].frames,
      climbedAt: '2026-10-26T10:00:00.000Z',
    },
    sessionId: `home-story-${index}`,
    socialEntityId: `home-story-${index}`,
  },
}));
const NO_ITEMS: CrewFeedItem[] = [];
type State = 'ready' | 'loading' | 'empty' | 'offline' | 'error' | 'signedOut';
function HomeStory({
  state = 'ready',
  onReady = noop,
  onError = noop,
}: { state?: State } & Partial<StoryRenderControls>) {
  const { t } = useTranslation('feed');
  const { variant } = useTheme();
  const nativeRootHeader = useNativeRootHeader();
  const { onDisplayed: markReady, onViewableItemsChanged } = useVisibleArtReadiness(feedAssetId, onReady);
  const insets = useSafeAreaInsets();
  const bottomInset = useStoryBottomInset();
  const [chromeHeight, setChromeHeight] = useState(insets.top + 56);
  const renderItem = useCallback(
    ({ item }: { item: CrewFeedItem }) =>
      item.__typename === 'CrewSessionItem' ? (
        <SessionFeedStoryCard session={item.session} onReady={() => markReady(item.id)} onError={onError} />
      ) : null,
    [markReady, onError],
  );
  const avatar = (
    <UserAvatarToolbarActionView
      avatarName="Alex"
      onPress={noop}
      variant={selectByVariant(variant, { material: 'material', liquidGlass: 'glass' } as const)}
    />
  );
  const [mode, setMode] = useState<'gym' | 'crew'>('gym');
  const scopeTitle = t(mode === 'gym' ? 'mobile.home.scope.everyone' : 'mobile.home.scope.myCrew');
  const scopeActions = [
    { label: t('mobile.home.scope.myCrew'), systemIcon: 'person.2.fill', selected: mode === 'crew' },
    { label: t('mobile.home.scope.everyone'), systemIcon: 'globe', selected: mode === 'gym' },
    { label: t('mobile.home.scope.findGym'), systemIcon: 'mappin.and.ellipse' },
  ];
  const onSelectScopeIndex = (index: number) => {
    if (index < 2) setMode(index === 0 ? 'crew' : 'gym');
  };
  const notifications = (
    <NotificationsToolbarActionView
      variant={selectByVariant(variant, { material: 'material', liquidGlass: 'glass' } as const)}
      unreadCount={0}
      onPress={noop}
    />
  );
  const chrome = (
    <HomeTopChromeView
      avatar={avatar}
      notifications={notifications}
      showScopeMenu
      scopeTitle={scopeTitle}
      scopeActions={scopeActions}
      onSelectScopeIndex={onSelectScopeIndex}
      onOpenSearch={noop}
      searchAccessibilityLabel={t('mobile.home.searchAction')}
      onHeightChange={setChromeHeight}
    />
  );
  return (
    <HomeView
      isAuthenticated={state !== 'signedOut'}
      feedItems={state === 'ready' ? ITEMS : NO_ITEMS}
      renderItem={renderItem}
      onViewableItemsChanged={onViewableItemsChanged}
      nativeRootHeader={nativeRootHeader}
      chromeHeight={chromeHeight}
      bottomInset={bottomInset}
      handleEndReached={noop}
      handleRefresh={noop}
      handleOpenCustomize={noop}
      handleBrowseEveryone={noop}
      loadNextPage={noop}
      onSignIn={noop}
      feedVisible
      homeEmpty={false}
      sectionsRefreshing={false}
      scopeReady
      requiresManualPage={false}
      mode={mode}
      selectedBoard={null}
      chrome={chrome}
      header={
        <HomeHeaderView
          scope={
            nativeRootHeader
              ? {
                  title: scopeTitle,
                  actions: scopeActions,
                  onSelectIndex: onSelectScopeIndex,
                  accessibilityHint: t('mobile.home.scope.hint'),
                }
              : undefined
          }
          showCustomize
          onCustomize={noop}
          heading={t(mode === 'gym' ? 'mobile.home.sessionsTitle' : 'mobile.home.feedTitle')}
        />
      }
      feedOffline={{
        isOffline: state === 'offline',
        isBlocked: state === 'offline',
        reason: state === 'offline' ? 'offline' : null,
      }}
      feed={{
        isRefetching: false,
        isLoading: state === 'loading',
        isError: state === 'error',
        isFetchingNextPage: false,
        refetch: noop,
      }}
    />
  );
}
const stories: StoryModule = {
  title: 'Home / Feed',
  stories: {
    feed: {
      name: 'Sessions from the crew',
      layout: 'fullscreen',
      tab: 'home',
      readiness: 'explicit',
      render: (controls) => <HomeStory {...controls} />,
    },
    loading: {
      name: 'Loading activity',
      layout: 'fullscreen',
      tab: 'home',
      render: () => <HomeStory state="loading" />,
    },
    empty: { name: 'No recent activity', layout: 'fullscreen', tab: 'home', render: () => <HomeStory state="empty" /> },
    offline: {
      name: 'Offline without cached activity',
      layout: 'fullscreen',
      tab: 'home',
      render: () => <HomeStory state="offline" />,
    },
    error: {
      name: 'Activity failed to load',
      layout: 'fullscreen',
      tab: 'home',
      render: () => <HomeStory state="error" />,
    },
    signedOut: {
      name: 'Sign in to see the crew',
      layout: 'fullscreen',
      tab: 'home',
      render: () => <HomeStory state="signedOut" />,
    },
  },
};
export default stories;
