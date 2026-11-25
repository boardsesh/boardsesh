import { Stack, router } from 'expo-router';
import { SprayWizardExitButton } from '../../src/components/spray-wall/SprayWizardExitButton';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { useTranslation } from 'react-i18next';
import { HeaderLeadingButton } from '../../src/components/HeaderActionButtons';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import { isFirstBoardMode, isNoBoardEntry } from '../../src/lib/boards/first-board-mode';
import { noteFirstBoardCloseTapped } from '../../src/lib/onboarding/first-board-picker-analytics';
import { holdUntilLaunchReady } from '../../src/components/launch-update/hold-until-launch-ready';
import { GymRouteStackContext } from '../../src/components/gym-page/use-gym-route-stack';
import { sprayFlowScreenOptions } from '../../src/lib/spray/spray-flow-presentation';

/**
 * How the picker was opened, from its params, read defensively: `route.params`
 * is untyped here, and a malformed value must fall back to the ordinary picker
 * rather than throw.
 */
function readPickerEntry(params: object | undefined): 'first_board' | 'no_board' | 'ordinary' {
  if (!params) return 'ordinary';
  const { source, firstBoard } = params as { source?: unknown; firstBoard?: unknown };
  const sourceParam = typeof source === 'string' ? source : undefined;
  if (isFirstBoardMode({ source: sourceParam, firstBoard: typeof firstBoard === 'string' ? firstBoard : undefined })) {
    return 'first_board';
  }
  return isNoBoardEntry({ source: sourceParam }) ? 'no_board' : 'ordinary';
}

/**
 * The X in first-board mode (#5654) is "Not now", and it lands on Climbs rather
 * than on whatever was underneath: the launch gate opened this picker by itself,
 * and Climbs is where a climber with no board is pointed to their wall.
 */
function closeFirstBoardPicker() {
  noteFirstBoardCloseTapped();
  router.dismissTo('/(tabs)/climbs');
}

/**
 * Climbs' "Find my board" opened this one, so the X is an ordinary Close back
 * to Climbs. It still notes itself: when the account has no boards the picker
 * shows the same "Where do you climb?" block, whose skip names the X.
 */
function closeNoBoardPicker() {
  noteFirstBoardCloseTapped();
  router.back();
}

function BoardsLayout() {
  const { t } = useTranslation('common');
  const { t: tBoards } = useTranslation('boards');
  const { t: tSettings } = useTranslation('settings');
  const screenOptions = useStackScreenOptions();

  // Screens registered in this stack and the root one (the gym screens, Manage
  // access) read which they are in from here (useGymRouteStack), not from the
  // focused route.
  return (
    <GymRouteStackContext.Provider value="boards">
      <Stack screenOptions={screenOptions}>
        <Stack.Screen
          name="index"
          options={({ route }) => {
            const entry = readPickerEntry(route.params);
            const firstBoard = entry === 'first_board';
            return {
              title: t('mobile.nav.boards'),
              // A modal now, not a tab: give it an explicit close button (iOS
              // swipe-to-dismiss alone isn't discoverable for a primary entry point).
              headerLeft: () => (
                <HeaderLeadingButton
                  kind="close"
                  onPress={
                    firstBoard ? closeFirstBoardPicker : entry === 'no_board' ? closeNoBoardPicker : () => router.back()
                  }
                  accessibilityLabel={firstBoard ? tBoards('mobile.firstBoard.notNow') : t('ariaLabels.close')}
                />
              ),
            };
          }}
        />
        {/* The full-screen board builder, pushed onto the boards stack (not a
          nested sheet): a back chevron is the drill-in affordance and there's no
          dueling pan-to-dismiss over the already-modal picker. */}
        {/* The add-a-board wizard (flag add-board-wizard): Where's the board?,
          then the gym and its boards or the board type, then the builder.
          Pushed routes like the builder: the gym's boards are a list a climber
          reads and scrolls, not a quick choice. Step 1 has an X and the title;
          from step 2 the native back chevron and no title, as the body's
          "Step N of M" says where you are (mobile-sheets-vs-routes.md,
          "Multi-step flows"). Set up keeps its name in the bar. */}
        <Stack.Screen
          name="add/index"
          options={{
            title: tBoards('mobile.addWizard.title'),
            headerLeft: () => (
              <HeaderLeadingButton
                kind="close"
                onPress={() => router.back()}
                accessibilityLabel={t('ariaLabels.close')}
              />
            ),
          }}
        />
        <Stack.Screen name="add/gym" options={{ title: '' }} />
        <Stack.Screen name="add/gym-boards" options={{ title: '' }} />
        <Stack.Screen name="add/new-gym" options={{ title: '' }} />
        <Stack.Screen name="add/board" options={{ title: '' }} />
        <Stack.Screen name="add/setup-option" options={{ title: '' }} />
        {/* The retired gym-first routes (#8151), now redirects into the wizard
          for one release. They draw nothing: no title to flash. */}
        <Stack.Screen name="where" options={{ title: '' }} />
        <Stack.Screen name="find-wall" options={{ title: '' }} />
        <Stack.Screen name="create" options={{ title: tBoards('mobile.create.screenTitle') }} />
        {/* The full vertical board list with the per-board offline-download console,
          drilled into from "Your boards" on the picker. Editing, deleting and
          unfollowing live on the picker's cards (#4623). */}
        <Stack.Screen name="manage" options={{ title: t('myBoards.title') }} />
        <Stack.Screen name="edit" options={{ title: tBoards('mobile.edit.screenTitle') }} />
        {/* The builder's gym row: the gym step in pick mode, pushed rather than
          a searchable sheet on this sheet. It hands the gym back to the form
          that pushed it (gym-pick-handoff.ts). Its body carries the title. */}
        <Stack.Screen name="gym-picker" options={{ title: '' }} />
        {/* The gym screens' copies in this stack (gym-page-route.ts). A root
          route pushed from in here is presented as another sheet, because a
          modal sits under it (docs/mobile/mobile-sheets-vs-routes.md,
          "Same-navigator modal inheritance"). The gym page is gym/[gym]. Each
          screen sets its own title. */}
        <Stack.Screen name="gyms" />
        <Stack.Screen name="gyms/edit" />
        <Stack.Screen name="gyms/analytics" />
        {/* Edit board's "Manage access", the same screen as Settings' copy. */}
        <Stack.Screen name="privacy-access" options={{ title: tSettings('privacy.manageAccess') }} />
        <Stack.Screen
          name="spray/led-setup"
          options={{
            title: tBoards('sprayLedSetup.title'),
            headerBackButtonMenuEnabled: false,
            ...sprayFlowScreenOptions(),
          }}
        />
        {/* The add-a-wall flow, pushed like the builder above it. A ROUTE and not a
          sheet: two of its steps (the corner markers and the hold editor) are
          full-screen pan-and-pinch surfaces, which `docs/mobile/mobile-sheets-vs-routes.md`
          rule 3 keeps off a sheet's own drag.

          On iPad too they are plain pushes inside this sheet, with the back
          chevron and the same leave guard as on a phone
          (`sprayFlowScreenOptions` only fades the home indicator). A `modal`
          here was a card on the Boards card, a sheet on a sheet. Opened
          straight from the live board sheet, one is this stack's first screen:
          the Boards sheet itself. */}
        <Stack.Screen
          name="spray/new"
          options={({ route }) => ({
            ...sprayFlowScreenOptions(),
            // The same wizard builds a reset's replacement wall (`?resetOf=`).
            title:
              typeof (route.params as { resetOf?: unknown } | undefined)?.resetOf === 'string'
                ? tBoards('sprayWizard.reset.screenTitle')
                : tBoards('sprayWizard.screenTitle'),
            headerBackButtonMenuEnabled: false,
            headerLeft: () => {
              const { returnTo } = (route.params ?? {}) as { returnTo?: unknown };
              return (
                <SprayWizardExitButton
                  returnTo={resolveBoardReturnTo(typeof returnTo === 'string' ? returnTo : undefined)}
                />
              );
            },
          })}
        />
        <Stack.Screen
          name="spray/holds"
          options={{
            title: tBoards('sprayMaintenance.screenTitle'),
            headerBackButtonMenuEnabled: false,
            ...sprayFlowScreenOptions(),
          }}
        />
      </Stack>
    </GymRouteStackContext.Provider>
  );
}

// iOS presents this route as a native modal, above the launch update
// placeholder, and a URL can open it on a cold start. Held until launch is
// ready so a gate reload cannot land mid-tap (#6006).
export default holdUntilLaunchReady(BoardsLayout);
