import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';

export default function ProfileLayout() {
  const { t } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const screenOptions = useStackScreenOptions();

  return (
    <Stack screenOptions={screenOptions}>
      {/* The You screen owns its top via the floating ProfileTopChrome (large
          title collapsing into a glass capsule), like the Discover/Climbs tabs —
          so the stack header is hidden here. */}
      <Stack.Screen name="index" options={{ headerShown: false, title: t('mobile.nav.profile') }} />
      {/* Session detail keeps the native tab bar + bottom accessory by living in
          this stack. It sets its own header title from the loaded session. */}
      <Stack.Screen name="session/[sessionId]" options={{ headerShown: true }} />
      <Stack.Screen name="more" options={{ title: t('mobile.more.title') }} />
      <Stack.Screen name="accessibility" options={{ title: t('mobile.more.accessibility.title') }} />
      <Stack.Screen name="edit" options={{ title: tSettings('profile.editAction') }} />
      <Stack.Screen name="integrations" options={{ title: tSettings('integrations.title') }} />
      {/* i18n-ignore-next-line — preview-only screen */}
      <Stack.Screen name="branch-switcher" options={{ title: 'Branch Switcher' }} />
      <Stack.Screen name="dev-servers" options={{ title: t('mobile.more.metroServersTitle') }} />
      {/* i18n-ignore-next-line — tester-only screen */}
      <Stack.Screen name="channel-switcher" options={{ title: 'OTA Channel Switcher' }} />
      {/* i18n-ignore-next-line — tester-only screen */}
      <Stack.Screen name="feature-flags" options={{ title: 'Feature Flags' }} />
      <Stack.Screen name="delete-account" options={{ title: tSettings('deleteAccount.title') }} />
    </Stack>
  );
}
