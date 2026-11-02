import { useCallback, type ComponentProps } from 'react';
import { Stack, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { HeaderLeadingButton } from '../../src/components/HeaderActionButtons';
import { settingsPageTitle } from '../../src/components/settings/root/settings-pages';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import { useKeepBoardsOffline } from '../../src/offline/use-keep-boards-offline';

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

type SettingsScreenOptionsFactory = Extract<
  ComponentProps<typeof Stack>['screenOptions'],
  (...args: never[]) => unknown
>;
type SettingsScreenOptionsArgs = Parameters<SettingsScreenOptionsFactory>[0];

/**
 * Whether `route` is the bottom screen of this stack. Compares the route's key
 * with the stack's first route rather than reading the focused `index`: options
 * are worked out for every screen in the stack, including the one covered by a
 * push, and the covered root must keep its back button for the back-swipe that
 * reveals it.
 */
function isStackRoot({ navigation, route }: Pick<SettingsScreenOptionsArgs, 'navigation' | 'route'>): boolean {
  return navigation.getState().routes[0]?.key === route.key;
}

/**
 * "Keep boards offline" downloads every board in My Boards while any settings
 * page is open. Mounted here, beside the stack, so it runs once whichever page is
 * showing, and in a component of its own so its profile, My Boards and download
 * state re-render only this, not the whole stack and every screen's options.
 */
function KeepBoardsOffline() {
  useKeepBoardsOffline();
  return null;
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
 * flat in THIS stack. Whichever screen sits at the bottom of this stack draws
 * its own back chevron: it is the only screen in this native stack, so iOS gives
 * its header no back button (the root stack's `HeaderBackContext` does not reach
 * the native bar), and without one it was a dead end. That is usually the
 * Settings index, but a sub-page opened directly (Edit profile from the You tab,
 * Climb list from the climb view's eye, Manage access from a privacy control)
 * is the bottom screen too. A screen pushed on top keeps the native back chevron.
 *
 * One consequence to keep in mind when adding a row: a `router.push` aimed at a
 * TAB route from here stacks a second `(tabs)` instance on top of Settings (the
 * cross-navigator trap in docs/mobile-sheets-vs-routes.md). Use `router.dismissTo`
 * for those — it pops back to the tabs already in the root stack and drops
 * Settings on the way.
 *
 * Each page the Settings root lists takes its title from `settingsPageTitle`,
 * the same function that labels its root row, so the row a climber taps and the
 * title they land on always match.
 */
export default function SettingsLayout() {
  const { t } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const stackScreenOptions = useStackScreenOptions();
  const backLabel = t('ariaLabels.back');
  // Memoised: a `screenOptions` that changes identity every render re-applies
  // every screen's header.
  const screenOptions = useCallback(
    ({ navigation, route }: SettingsScreenOptionsArgs) =>
      isStackRoot({ navigation, route })
        ? {
            ...stackScreenOptions,
            headerLeft: () => (
              <HeaderLeadingButton kind="back" onPress={leaveSettings} accessibilityLabel={backLabel} />
            ),
          }
        : stackScreenOptions,
    [stackScreenOptions, backLabel],
  );

  return (
    <>
      <KeepBoardsOffline />
      <Stack screenOptions={screenOptions}>
        <Stack.Screen name="index" options={{ title: t('mobile.settings.title') }} />
        {/* The pages the Settings root lists, in its order. */}
        <Stack.Screen name="general" options={{ title: settingsPageTitle('general', t) }} />
        <Stack.Screen name="privacy" options={{ title: settingsPageTitle('privacy', t) }} />
        {/* No title here: the page names itself after the list it shows. */}
        <Stack.Screen name="privacy-people" />
        <Stack.Screen name="account" options={{ title: settingsPageTitle('account', t) }} />
        <Stack.Screen name="integrations" options={{ title: settingsPageTitle('integrations', t) }} />
        {/* Board is a parent plus two leaves: the parent asks "which look?" and
          holds the lighting and Bluetooth switches, and everything you can tune
          about a look lives a tap away. The route keeps its old `board-look`
          name. Registered flat in this stack (no nested layout) so back-swipe
          and the header keep behaving. */}
        <Stack.Screen name="board-look/index" options={{ title: settingsPageTitle('board', t) }} />
        <Stack.Screen name="board-look/custom" options={{ title: t('mobile.settings.boardLook.customLook.title') }} />
        <Stack.Screen
          name="board-look/accessibility"
          options={{ title: t('mobile.settings.boardLook.accessibility.pageTitle') }}
        />
        <Stack.Screen name="climbs" options={{ title: settingsPageTitle('climbs', t) }} />
        <Stack.Screen name="home" options={{ title: settingsPageTitle('home', t) }} />
        <Stack.Screen name="timers" options={{ title: settingsPageTitle('timers', t) }} />
        <Stack.Screen name="early-access" options={{ title: settingsPageTitle('earlyAccess', t) }} />
        <Stack.Screen name="developer" options={{ title: settingsPageTitle('developer', t) }} />
        {/* The pages those pages open. */}
        <Stack.Screen name="climb-list" options={{ title: t('mobile.settings.climbList.title') }} />
        <Stack.Screen name="climb-view" options={{ title: t('mobile.settings.climbView.title') }} />
        <Stack.Screen name="quick-filters" options={{ title: t('mobile.settings.quickFilters.title') }} />
        <Stack.Screen name="storage" options={{ title: t('mobile.settings.storage.title') }} />
        <Stack.Screen name="privacy-access" options={{ title: tSettings('privacy.manageAccess') }} />
        <Stack.Screen name="edit" options={{ title: tSettings('profile.editAction') }} />
        <Stack.Screen name="export" options={{ title: tSettings('export.title') }} />
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
    </>
  );
}
