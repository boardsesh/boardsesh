import { Stack, router } from 'expo-router';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../src/components/Icon';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';

/**
 * Leave Settings. It normally sits on top of the tabs, so this pops it; a cold
 * deep link can open it with nothing underneath, and then it goes Home instead
 * of doing nothing.
 */
function leaveSettings() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/(tabs)/home');
  }
}

/**
 * Settings, as a ROOT stack rather than a branch of the You tab.
 *
 * It used to live at `(tabs)/profile/more` with every sub-page registered
 * flat beside it. That made Settings part of the You tab's own history: opening
 * it from the user drawer switched to You and left `more` on that tab's stack,
 * so the next tap on You reopened Settings instead of the profile. The
 * tab-blur pop-to-top only fires when the tab actually blurs, and a drawer route
 * opened over the same tab never blurs it.
 *
 * So Settings is a destination of its own now — pushed over the tabs like
 * `about` / `changelog`, covering the tab bar, with its sub-pages registered
 * flat in THIS stack. The first screen draws its own back chevron: it is the
 * only screen in this native stack, so iOS gives its header no back button
 * (the root stack's `HeaderBackContext` does not reach the native bar), and
 * without one Settings was a dead end.
 *
 * One consequence to keep in mind when adding a row: a `router.push` aimed at a
 * TAB route from here stacks a second `(tabs)` instance on top of Settings (the
 * cross-navigator trap in docs/mobile-sheets-vs-routes.md). Use `router.dismissTo`
 * for those — it pops back to the tabs already in the root stack and drops
 * Settings on the way.
 */
export default function SettingsLayout() {
  const { t } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const screenOptions = useStackScreenOptions();

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name="index"
        options={{
          title: t('mobile.settings.title'),
          headerLeft: ({ tintColor }) => (
            <Pressable
              onPress={leaveSettings}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('ariaLabels.back')}
            >
              <Icon name="back" size={22} color={tintColor} />
            </Pressable>
          ),
        }}
      />
      {/* Board look is a parent plus two leaves: the parent asks "which look?",
          and everything you can tune about one lives a tap away. Registered flat
          in this stack (no nested layout) so back-swipe and the header keep
          behaving. */}
      <Stack.Screen name="board-look/index" options={{ title: t('mobile.settings.boardLook.title') }} />
      <Stack.Screen name="board-look/custom" options={{ title: t('mobile.settings.boardLook.customLook.title') }} />
      <Stack.Screen
        name="board-look/accessibility"
        options={{ title: t('mobile.settings.boardLook.accessibility.title') }}
      />
      <Stack.Screen name="storage" options={{ title: t('mobile.settings.storage.title') }} />
      <Stack.Screen name="edit" options={{ title: tSettings('profile.editAction') }} />
      <Stack.Screen name="integrations" options={{ title: tSettings('integrations.title') }} />
      <Stack.Screen name="watch-pair" options={{ title: tSettings('watchPairing.title') }} />
      {/* i18n-ignore-next-line — preview-only screen */}
      <Stack.Screen name="branch-switcher" options={{ title: 'Branch Switcher' }} />
      <Stack.Screen name="dev-servers" options={{ title: t('mobile.settings.metroServersTitle') }} />
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
  );
}
