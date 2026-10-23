import { useNativeRootHeader } from '../../../src/hooks/use-native-root-header';
import { NativeTabletContent } from '../../../src/components/navigation/NativeTabletContent';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';
import { usePopToTopOnTabBlur } from '../../../src/hooks/use-pop-to-top-on-tab-blur';
import { NativeTabContentInsetProbe } from '../../../src/components/navigation/NativeTabContentInsetProbe';
import { BoardArtVisibilityProvider } from '../../../src/providers/board-art-visibility-provider';

// The anchor a push from another tab lands on top of (`withAnchor`), so Back from
// a playlist opened on Home or from the account menu reaches Discover's main page.
export const unstable_settings = { initialRouteName: 'index' };

export default function DiscoverLayout() {
  const { t } = useTranslation('playlists');
  const { t: tCommon } = useTranslation('common');
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
            name="community"
            options={{
              // The full Community Playlists list behind the shelf's "See all":
              // a solid header with a back button, like "My Playlists".
              headerShown: true,
              headerTransparent: false,
              title: t('library.sections.community'),
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
          {/* A playlist's and a smart list's filter pickers (#6651): pushed routes
              over the suspended filter sheet, as on the Climbs stack (native
              sheets can't stack). Native header (title + back chevron), opaque
              so the board or the search bar sits below the bar. */}
          <Stack.Screen
            name="playlist-setters"
            options={{ title: tCommon('mobile.nav.setters'), headerShown: true, headerTransparent: false }}
          />
          <Stack.Screen
            name="holds"
            options={{ title: tCommon('mobile.nav.holdFilter'), headerShown: true, headerTransparent: false }}
          />
          <Stack.Screen
            name="zone"
            options={{ title: tCommon('mobile.nav.zoneFilter'), headerShown: true, headerTransparent: false }}
          />
          {/* A For You setter card's list. The Climbs tab's setter route renders the
              same screen on the same stack defaults, and its view sets the header. */}
          <Stack.Screen name="setter/[username]" />
          <Stack.Screen name="settings" options={{ headerShown: false }} />
        </Stack>
      </NativeTabletContent>
    </BoardArtVisibilityProvider>
  );
}
