import { useNativeRootHeader } from '../../../src/hooks/use-native-root-header';
import { NativeTabletContent } from '../../../src/components/navigation/NativeTabletContent';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';
import { usePopToTopOnTabBlur } from '../../../src/hooks/use-pop-to-top-on-tab-blur';
import { NativeTabContentInsetProbe } from '../../../src/components/navigation/NativeTabContentInsetProbe';
import { BoardArtVisibilityProvider } from '../../../src/providers/board-art-visibility-provider';

/** The You stack keeps profile drilling and direct Settings under its tab bar. */
export default function ProfileLayout() {
  const { t } = useTranslation('common');
  const { t: tNotifications } = useTranslation('notifications');
  const screenOptions = useStackScreenOptions();
  const nativeRootHeader = useNativeRootHeader();
  usePopToTopOnTabBlur('profile');

  return (
    <BoardArtVisibilityProvider tab="profile">
      <NativeTabContentInsetProbe />
      <NativeTabletContent>
        <Stack screenOptions={screenOptions}>
          {/* UIKit owns the native root title even before profile chrome mounts. */}
          <Stack.Screen
            name="index"
            options={{
              headerShown: nativeRootHeader,
              headerLargeTitle: nativeRootHeader,
              headerTransparent: nativeRootHeader,
              title: t('mobile.nav.profile'),
            }}
          />
          {/* Session detail keeps the native tab bar by living in this stack, while
          pushed-route accessory/queue chrome unmounts. It sets its own header
          title from the loaded session. */}
          <Stack.Screen name="session/[sessionId]" options={{ headerShown: true }} />
          {/* Same screen component as the Home tab's notifications route, registered
          here too so a push from this tab keeps its own back stack. */}
          <Stack.Screen name="notifications" options={{ headerShown: true, title: tNotifications('title') }} />
          <Stack.Screen name="settings" options={{ headerShown: false }} />
        </Stack>
      </NativeTabletContent>
    </BoardArtVisibilityProvider>
  );
}
