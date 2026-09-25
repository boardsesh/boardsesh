import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';
import { usePopToTopOnTabBlur } from '../../../src/hooks/use-pop-to-top-on-tab-blur';
import { NativeTabContentInsetProbe } from '../../../src/components/navigation/NativeTabContentInsetProbe';
import { BoardArtVisibilityProvider } from '../../../src/providers/board-art-visibility-provider';

/**
 * The You tab: the profile itself and the two screens that belong to it. Settings
 * used to live here too (`more` plus a dozen sub-pages) and that is exactly why it
 * doesn't any more — opening it claimed this tab's stack, so the next tap on You
 * reopened Settings instead of the profile. It is a root destination now,
 * `app/settings/`.
 */
export default function ProfileLayout() {
  const { t } = useTranslation('common');
  const { t: tNotifications } = useTranslation('notifications');
  const screenOptions = useStackScreenOptions();
  usePopToTopOnTabBlur('profile');

  return (
    <BoardArtVisibilityProvider tab="profile">
      <NativeTabContentInsetProbe />
      <Stack screenOptions={screenOptions}>
        {/* The You screen owns its top via the floating ProfileTopChrome (large
          title collapsing into a glass capsule), like the Discover/Climbs tabs —
          so the stack header is hidden here. */}
        <Stack.Screen name="index" options={{ headerShown: false, title: t('mobile.nav.profile') }} />
        {/* Session detail keeps the native tab bar by living in this stack, while
          pushed-route accessory/queue chrome unmounts. It sets its own header
          title from the loaded session. */}
        <Stack.Screen name="session/[sessionId]" options={{ headerShown: true }} />
        {/* Same screen component as the Home tab's notifications route, registered
          here too so a push from this tab keeps its own back stack. */}
        <Stack.Screen name="notifications" options={{ headerShown: true, title: tNotifications('title') }} />
      </Stack>
    </BoardArtVisibilityProvider>
  );
}
