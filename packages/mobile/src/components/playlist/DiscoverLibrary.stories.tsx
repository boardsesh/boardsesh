import { selectByVariant } from '../../theme/variants';
import { useStoryBottomInset } from '../../dev/stories/use-story-bottom-inset';
import { CollapsingTopChromeView } from '../chrome/CollapsingTopChromeView';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { GlassActionToolbar, GlassToolbarAction } from '../chrome/GlassActionToolbar';
import { ChromeIconButton } from '../ChromeIconButton';
import { UserAvatarToolbarActionView } from '../user-drawer/UserAvatarToolbarActionView';
import { Text } from '../Text';
import { useCallback, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { StoryModule } from '../../dev/stories/types';
import { DiscoverLibraryView, type DiscoverLibraryViewProps } from './DiscoverLibraryView';
import { DiscoverPlaylistCard } from './DiscoverPlaylistCard';
import { PlaylistShelf } from './PlaylistShelf';

import { MaterialAppBarTitle } from '../chrome/MaterialAppBarTitle';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

const noop = () => {};
const PLAYLISTS = [
  { uuid: 'projects', name: 'Next session', climbCount: 18, icon: 'flag', color: '#9C75D5' },
  { uuid: 'warmup', name: 'Warm-up laps', climbCount: 24, icon: 'flash', color: '#F0AE57' },
  { uuid: 'crew', name: 'Friday crew', climbCount: 32, icon: 'people', color: '#6CBAA3' },
];
const keyExtractor = (playlist: (typeof PLAYLISTS)[number]) => playlist.uuid;
function DiscoverStory({ state = 'none' }: { state?: DiscoverLibraryViewProps['emptyState'] }) {
  const { t } = useTranslation('playlists');
  const { t: tSession } = useTranslation('session');
  const { t: tBoards } = useTranslation('boards');
  const { t: tSettings } = useTranslation('settings');
  const { systemColors, variant } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomInset = useStoryBottomInset();
  const nativeHeader = useNativeRootHeader();
  const [chromeHeight, setChromeHeight] = useState(insets.top + 56);
  const renderItem = useCallback(
    ({ item, index }: { item: (typeof PLAYLISTS)[number]; index: number }) => (
      <DiscoverPlaylistCard {...item} variant="scroll" index={index} onOpen={noop} />
    ),
    [],
  );
  return (
    <View style={[styles.fill, { backgroundColor: systemColors.background }]}>
      <DiscoverLibraryView
        nativeRootHeader={nativeHeader}
        chromeHeight={chromeHeight}
        bottomInset={bottomInset}
        refreshing={false}
        onRefresh={noop}
        showSignInPrompt={false}
        onSignIn={noop}
        emptyState={state}
        offlineReason="offline"
        effectiveOffline={state === 'offline'}
        onRetry={noop}
        onCreate={noop}
        chrome={
          <CollapsingTopChromeView
            presentation={selectByVariant(variant, {
              material: 'material',
              liquidGlass: nativeHeader ? 'native' : 'floating',
            } as const)}
            onHeightChange={setChromeHeight}
            materialActions={
              <>
                <UserAvatarToolbarActionView variant="material" onPress={noop} avatarUrl={null} avatarName="Alex" />
                <MaterialAppBarTitle title={t('bottomTabBar.discover')} subtitle="Kilter Original" onPress={noop} />
                <ChromeIconButton
                  icon="angle"
                  onPress={noop}
                  accessibilityLabel={tSession('mobile.angleSelector.buttonAria', { angle: 40 })}
                />
                <ChromeIconButton
                  icon="lightbulb"
                  onPress={noop}
                  accessibilityLabel={tSettings('ble.lighting.title')}
                />
              </>
            }
            leftActions={
              <GlassActionToolbar actionCount={nativeHeader ? 3 : 2}>
                <UserAvatarToolbarActionView variant="glass" onPress={noop} avatarUrl={null} avatarName="Alex" />
                {nativeHeader ? (
                  <GlassToolbarAction
                    onPress={noop}
                    accessibilityLabel={tSession('mobile.angleSelector.buttonAria', { angle: 40 })}
                  >
                    <Text>40°</Text>
                  </GlassToolbarAction>
                ) : null}
                <ChromeIconButton icon="plus" onPress={noop} accessibilityLabel={t('library.createFab.ariaLabel')} />
              </GlassActionToolbar>
            }
            rightActions={
              <GlassActionToolbar actionCount={nativeHeader ? 2 : 3}>
                {nativeHeader ? null : (
                  <GlassToolbarAction
                    onPress={noop}
                    accessibilityLabel={tSession('mobile.angleSelector.buttonAria', { angle: 40 })}
                  >
                    <Text>40°</Text>
                  </GlassToolbarAction>
                )}
                <ChromeIconButton icon="boards" onPress={noop} accessibilityLabel={tBoards('boardPill.switchHint')} />
                <ChromeIconButton
                  icon="lightbulb"
                  onPress={noop}
                  accessibilityLabel={tSettings('ble.lighting.title')}
                />
              </GlassActionToolbar>
            }
          />
        }
        pinned={
          state === 'none'
            ? PLAYLISTS.slice(0, 2).map((playlist, index) => (
                <View key={playlist.uuid} style={styles.gridItem}>
                  <DiscoverPlaylistCard
                    {...playlist}
                    variant="grid"
                    index={index}
                    onOpen={noop}
                    isPinned
                    onPin={noop}
                  />
                </View>
              ))
            : undefined
        }
        ownedShelf={
          state === 'none' ? (
            <PlaylistShelf
              title={t('library.allPlaylists.title')}
              items={PLAYLISTS}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              hasMore={false}
              onEndReached={noop}
            />
          ) : undefined
        }
        communityShelf={
          state === 'none' ? (
            <PlaylistShelf
              title={t('library.sections.community')}
              items={PLAYLISTS}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              hasMore={false}
              onEndReached={noop}
            />
          ) : undefined
        }
      />
    </View>
  );
}
const stories: StoryModule = {
  title: 'Discover / Library',
  stories: {
    library: {
      name: 'Pinned and shared playlists',
      layout: 'fullscreen',
      tab: 'discover',
      render: () => <DiscoverStory />,
    },
    loading: {
      name: 'Loading the library',
      layout: 'fullscreen',
      tab: 'discover',
      render: () => <DiscoverStory state="loading" />,
    },
    empty: {
      name: 'Build your first playlist',
      layout: 'fullscreen',
      tab: 'discover',
      render: () => <DiscoverStory state="empty" />,
    },
    offline: {
      name: 'Library unavailable offline',
      layout: 'fullscreen',
      tab: 'discover',
      render: () => <DiscoverStory state="offline" />,
    },
    error: {
      name: 'Retry loading the library',
      layout: 'fullscreen',
      tab: 'discover',
      render: () => <DiscoverStory state="error" />,
    },
  },
};
const styles = StyleSheet.create({ fill: { flex: 1 }, gridItem: { width: '50%', paddingEnd: spacing[3] } });
export default stories;
