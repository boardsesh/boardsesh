import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';

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
 * flat in THIS stack. The first screen still shows a back chevron: the root
 * stack hands its `HeaderBackContext` down, so the nested stack's first screen
 * pops the parent.
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
      <Stack.Screen name="index" options={{ title: t('mobile.more.title') }} />
      {/* Board look is a parent plus two leaves: the parent asks "which look?",
          and everything you can tune about one lives a tap away. Registered flat
          in this stack (no nested layout) so back-swipe and the header keep
          behaving. */}
      <Stack.Screen name="board-look/index" options={{ title: t('mobile.more.boardLook.title') }} />
      <Stack.Screen name="board-look/custom" options={{ title: t('mobile.more.boardLook.customLook.title') }} />
      <Stack.Screen
        name="board-look/accessibility"
        options={{ title: t('mobile.more.boardLook.accessibility.title') }}
      />
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
  );
}
