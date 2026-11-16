import { selectByVariant } from '../../theme/variants';
import { useStoryBottomInset } from '../../dev/stories/use-story-bottom-inset';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { profileStoryData } from '../../dev/fixtures/profile';
import type { StoryModule } from '../../dev/stories/types';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { useTheme } from '../../providers/theme-provider';
import { ReadableColumn } from '../ReadableColumn';
import { GlassActionToolbar } from '../chrome/GlassActionToolbar';
import { UserAvatarToolbarActionView } from '../user-drawer/UserAvatarToolbarActionView';
import { ProfileTopChromeView } from './ProfileTopChromeView';
import { ProgressView, type ProgressViewData } from './ProgressView';

const noop = () => {};
type State = 'ready' | 'loading' | 'empty' | 'offline' | 'error';
function ProgressStory({ state = 'ready' }: { state?: State }) {
  const { variant, systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomInset = useStoryBottomInset();
  const nativeRootHeader = useNativeRootHeader();
  const [topInset, setTopInset] = useState(insets.top + 96);
  const [model] = useState<ProgressViewData>(() => {
    const base = profileStoryData(state === 'empty');
    if (state === 'loading') return { ...base, loading: true, totalsStatus: 'loading' };
    if (state === 'offline') return { ...base, offline: { isOffline: true, isBlocked: true, reason: 'offline' } };
    if (state === 'error') return { ...base, totalsStatus: 'error' };
    return base;
  });
  const accountAction = (
    <UserAvatarToolbarActionView
      variant={selectByVariant(variant, { material: 'material', liquidGlass: 'glass' } as const)}
      avatarName="Alex"
      onPress={noop}
    />
  );
  return (
    <View style={[styles.fill, { backgroundColor: systemColors.background }]}>
      <ReadableColumn style={styles.fill}>
        <ProgressView
          data={model}
          topInset={topInset}
          bottomInset={bottomInset}
          nativeRootHeader={nativeRootHeader}
          listTopOffset={0}
          onOpenFilters={noop}
        />
      </ReadableColumn>
      <ProfileTopChromeView
        activeTab="progress"
        displayName="Alex"
        onSelectTab={noop}
        onHeightChange={setTopInset}
        accountAction={selectByVariant(variant, {
          material: accountAction,
          liquidGlass: <GlassActionToolbar actionCount={1}>{accountAction}</GlassActionToolbar>,
        })}
      />
    </View>
  );
}
const stories: StoryModule = {
  title: 'You / Progress',
  stories: {
    overview: {
      name: 'Sends, board totals and progress',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <ProgressStory />,
    },
    loading: {
      name: 'Loading the logbook',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <ProgressStory state="loading" />,
    },
    empty: {
      name: 'No sends yet',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <ProgressStory state="empty" />,
    },
    offline: {
      name: 'Offline with no cached logbook',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <ProgressStory state="offline" />,
    },
    totalsError: {
      name: 'Logbook available, totals unavailable',
      layout: 'fullscreen',
      tab: 'profile',
      render: () => <ProgressStory state="error" />,
    },
  },
};
const styles = StyleSheet.create({ fill: { flex: 1 } });
export default stories;
