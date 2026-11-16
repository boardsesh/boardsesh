import { useCallback, type ReactNode } from 'react';
import { router, Stack, useGlobalSearchParams, useSegments, type Href } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { TabLayoutView } from '../../components/navigation/TabLayoutView';
import { MaterialTabBarView } from '../../components/navigation/MaterialTabBarView';
import { MaterialNavigationRailView } from '../../components/navigation/MaterialNavigationRailView';
import { NativeTabletContentView, PhoneSplitPaneView } from '../../components/navigation/NativeTabletContentView';
import { EmptyState } from '../../components/EmptyState';
import { useTabChrome } from '../../hooks/use-bottom-accessory';
import { useVerticalTabBar } from '../../hooks/use-vertical-tab-bar';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { useTheme } from '../../providers/theme-provider';
import { SIDEBAR_WIDTH } from '../../theme/layout';
import { loadStory } from './registry';
import { StoryTabRootContext, useStoryTabBarOverlay } from './use-story-bottom-inset';
import { resolveDetailPaneSurface, resolveDetailPaneWidth } from '../../theme/size-class';

function renderTabBar(props: BottomTabBarProps) {
  return <StoryMaterialTabBar {...props} />;
}

function StoryMaterialTabBar(props: BottomTabBarProps) {
  const overlay = useStoryTabBarOverlay();
  return <MaterialTabBarView {...props} overlay={overlay} hidden={false} />;
}

export function StoryPanePlaceholder() {
  const { t } = useTranslation('session');
  const insets = useSafeAreaInsets();
  return (
    <EmptyState
      size="screen"
      icon="search"
      title={t('playView.paneEmpty.title')}
      body={t('playView.paneEmpty.subtitle')}
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    />
  );
}

/** Uses the production navigator and adaptive shell, with injected presentation state. */
export function StoryTabLayout() {
  const { nativeTabBar, liquidGlassTabBar } = useTabChrome();
  const verticalTabBar = useVerticalTabBar();
  const deviceLayout = useDeviceLayout();
  const { width } = useWindowDimensions();
  const segments = useSegments();
  const params = useGlobalSearchParams<{ storyId?: string | string[] }>();
  const storyId = Array.isArray(params.storyId) ? params.storyId[0] : params.storyId;
  const tabRoot = !storyId || loadStory(storyId)?.story.tabRoot !== false;
  const activeSegment = segments[segments.indexOf('story-tabs') + 1] ?? 'home';
  const onNavigate = useCallback((segment: string) => router.navigate(`/dev/story-tabs/${segment}` as Href), []);
  const showDetailPane =
    resolveDetailPaneSurface({ width, widthClass: deviceLayout.widthClass, sidebarWidth: SIDEBAR_WIDTH }) === 'pane';
  return (
    <StoryTabRootContext value={tabRoot}>
      <TabLayoutView
        nativeTabBar={nativeTabBar}
        deviceLayout={deviceLayout}
        showRecordBadge={false}
        hasLiveSession={false}
        tabBarMinimizeBehavior={liquidGlassTabBar ? (verticalTabBar ? 'never' : 'onScrollDown') : undefined}
        accessoryNativeProps={undefined}
        prominentClimbsTab={liquidGlassTabBar && !deviceLayout.isPad && parseInt(String(Platform.Version), 10) >= 27}
        showDetailPane={showDetailPane}
        showWallColumn={false}
        wallDisplayOpen={false}
        playPaneWidth={resolveDetailPaneWidth({ width, sidebarWidth: SIDEBAR_WIDTH, wallColumnVisible: false })}
        renderTabBar={renderTabBar}
        sidebar={<MaterialNavigationRailView activeSegment={activeSegment} onNavigate={onNavigate} />}
        detailPane={<StoryPanePlaceholder />}
      />
    </StoryTabRootContext>
  );
}

function renderSplitPane(content: ReactNode | null) {
  return (
    <PhoneSplitPaneView content={content ?? <StoryPanePlaceholder />} partiallyFolded={false} fixedFooterBottom={0} />
  );
}

/** Each tab owns a real stack, so view headers configure native navigation normally. */
export function StoryTabStack() {
  const layout = useDeviceLayout();
  const { variant } = useTheme();
  const segments = useSegments();
  const tab = segments[segments.indexOf('story-tabs') + 1];
  const { t } = useTranslation(['common', 'session', 'playlists']);
  const title =
    tab === 'home'
      ? t('mobile.nav.home', { ns: 'common' })
      : tab === 'profile'
        ? t('mobile.nav.profile', { ns: 'common' })
        : tab === 'discover'
          ? t('bottomTabBar.discover', { ns: 'playlists' })
          : tab === 'record'
            ? t('mobile.session.headerStart', { ns: 'session' })
            : '';
  const stack = <Stack screenOptions={{ headerShown: false, title }} />;
  if (Platform.OS !== 'ios' || Platform.isPad || variant !== 'liquidGlass') return stack;
  return (
    <NativeTabletContentView phoneSplit={layout.phoneSplit} renderPane={renderSplitPane}>
      {stack}
    </NativeTabletContentView>
  );
}
