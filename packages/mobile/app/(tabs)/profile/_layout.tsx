import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';
import { NativeTabContentInsetProbe } from '../../../src/components/navigation/NativeTabContentInsetProbe';
import { BoardArtVisibilityProvider } from '../../../src/providers/board-art-visibility-provider';

export default function ProfileLayout() {
  const { t } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const { t: tNotifications } = useTranslation('notifications');
  const screenOptions = useStackScreenOptions();

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
        <Stack.Screen name="more" options={{ title: t('mobile.more.title') }} />
        <Stack.Screen name="board-look" options={{ title: t('mobile.more.boardLook.title') }} />
        {/* Redirects straight to "board-look" — no header of its own to flash. */}
        <Stack.Screen name="accessibility" options={{ headerShown: false }} />
        <Stack.Screen name="storage" options={{ title: t('mobile.more.storage.title') }} />
        <Stack.Screen name="edit" options={{ title: tSettings('profile.editAction') }} />
        <Stack.Screen name="integrations" options={{ title: tSettings('integrations.title') }} />
        <Stack.Screen name="watch-pair" options={{ title: tSettings('watchPairing.title') }} />
        {/* i18n-ignore-next-line — preview-only screen */}
        <Stack.Screen name="branch-switcher" options={{ title: 'Branch Switcher' }} />
        <Stack.Screen name="dev-servers" options={{ title: t('mobile.more.metroServersTitle') }} />
        {/* i18n-ignore-next-line — tester-only screen */}
        <Stack.Screen name="feature-flags" options={{ title: 'Feature Flags' }} />
        {/* i18n-ignore-next-line — tester-only screen */}
        <Stack.Screen name="dev-offline-writes" options={{ title: 'Offline Writes' }} />
        {/* i18n-ignore-next-line — tester-only screen */}
        <Stack.Screen name="sentry-diagnostics" options={{ title: 'Sentry Diagnostics' }} />
        {/* i18n-ignore-next-line — admin-only screen */}
        <Stack.Screen name="outline-editor" options={{ title: 'Hold Outlines' }} />
        {/* i18n-ignore-next-line — admin-only screen */}
        <Stack.Screen name="outline-canvas" options={{ title: 'Outline Editor' }} />
        <Stack.Screen name="delete-account" options={{ title: tSettings('deleteAccount.title') }} />
      </Stack>
    </BoardArtVisibilityProvider>
  );
}
