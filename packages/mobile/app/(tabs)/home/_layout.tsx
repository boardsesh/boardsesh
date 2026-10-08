import { useNativeRootHeader } from '../../../src/hooks/use-native-root-header';
import { NativeTabletContent } from '../../../src/components/navigation/NativeTabletContent';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';
import { NativeTabContentInsetProbe } from '../../../src/components/navigation/NativeTabContentInsetProbe';
import { BoardArtVisibilityProvider } from '../../../src/providers/board-art-visibility-provider';

export default function HomeLayout() {
  const { t } = useTranslation('common');
  const { t: tNotifications } = useTranslation('notifications');
  const screenOptions = useStackScreenOptions();
  const nativeRootHeader = useNativeRootHeader();
  return (
    <BoardArtVisibilityProvider tab="home">
      <NativeTabContentInsetProbe />
      <NativeTabletContent>
        <Stack screenOptions={screenOptions}>
          {/* UIKit titles every native root, including its signed-out empty state.
          HomeTopChrome adds account, scope and notifications actions when mounted. */}
          <Stack.Screen
            name="index"
            options={{
              title: t('mobile.nav.home'),
              headerShown: nativeRootHeader,
              headerLargeTitle: nativeRootHeader,
              headerTransparent: nativeRootHeader,
            }}
          />
          {/* Session detail keeps the native tab bar by living in this stack, while
          pushed-route accessory/queue chrome unmounts. It sets its own header
          title from the loaded session. */}
          <Stack.Screen name="session/[sessionId]" options={{ headerShown: true }} />
          {/* Notifications live in this stack too (reached from the bell in the Home
          chrome), so Back lands on the feed instead of the You screen. The
          Profile tab registers the same screen under its own stack. */}
          <Stack.Screen name="notifications" options={{ headerShown: true, title: tNotifications('title') }} />
          <Stack.Screen name="settings" options={{ headerShown: false }} />
        </Stack>
      </NativeTabletContent>
    </BoardArtVisibilityProvider>
  );
}
