import { useNativeRootHeader } from '../../../src/hooks/use-native-root-header';
import { NativeTabletContent } from '../../../src/components/navigation/NativeTabletContent';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';
import { usePopToTopOnTabBlur } from '../../../src/hooks/use-pop-to-top-on-tab-blur';
import { NativeTabContentInsetProbe } from '../../../src/components/navigation/NativeTabContentInsetProbe';
import { BoardArtVisibilityProvider } from '../../../src/providers/board-art-visibility-provider';

export default function DiscoverLayout() {
  const { t } = useTranslation('playlists');
  const screenOptions = useStackScreenOptions();
  const nativeRootHeader = useNativeRootHeader();
  usePopToTopOnTabBlur('discover');

  return (
    <BoardArtVisibilityProvider tab="discover">
      <NativeTabContentInsetProbe />
      <NativeTabletContent>
        <Stack screenOptions={screenOptions}>
          <Stack.Screen
            name="index"
            options={{
              title: t('bottomTabBar.discover'),
              // UIKit owns the native large title before the library chrome mounts.
              // DiscoverTopChrome adds controls; Material retains its app bar.
              headerShown: nativeRootHeader,
              headerLargeTitle: nativeRootHeader,
              headerTransparent: nativeRootHeader,
            }}
          />
          <Stack.Screen
            name="all"
            options={{
              // "My Playlists" — a plain vertical list. A solid native header gives it
              // a title + automatic back button and avoids the transparent-blur top
              // inset the index screen manages with its floating chrome.
              headerShown: true,
              headerTransparent: false,
              title: t('library.allPlaylists.title'),
            }}
          />
          <Stack.Screen
            name="[playlist_uuid]"
            options={{
              // The detail view owns its full-bleed gradient hero with a floating
              // back FAB + action FABs, so it hides the native header bar.
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="smart/[type]"
            options={{
              headerShown: false,
            }}
          />
          <Stack.Screen name="settings" options={{ headerShown: false }} />
        </Stack>
      </NativeTabletContent>
    </BoardArtVisibilityProvider>
  );
}
