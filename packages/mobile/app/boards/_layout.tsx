import { Stack, router } from 'expo-router';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../src/components/Icon';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';

export default function BoardsLayout() {
  const { t } = useTranslation('common');
  const { t: tBoards } = useTranslation('boards');
  const screenOptions = useStackScreenOptions();

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen
        name="index"
        options={{
          title: t('mobile.nav.boards'),
          // A modal now, not a tab: give it an explicit close button (iOS
          // swipe-to-dismiss alone isn't discoverable for a primary entry point).
          headerLeft: ({ tintColor }) => (
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('ariaLabels.close')}
            >
              <Icon name="close" size={22} color={tintColor} />
            </Pressable>
          ),
        }}
      />
      {/* The full-screen board builder, pushed onto the boards stack (not a
          nested sheet): a back chevron is the drill-in affordance and there's no
          dueling pan-to-dismiss over the already-modal picker. */}
      <Stack.Screen name="create" options={{ title: tBoards('mobile.create.screenTitle') }} />
      {/* The full vertical board list with the per-board offline-download console,
          drilled into from "Your boards" on the picker. Editing, deleting and
          unfollowing live on the picker's cards (#4623). */}
      <Stack.Screen name="manage" options={{ title: t('myBoards.title') }} />
      <Stack.Screen name="edit" options={{ title: tBoards('mobile.edit.screenTitle') }} />
      {/* The add-a-wall flow, pushed like the builder above it. A ROUTE and not a
          sheet: two of its steps (the corner markers and the hold editor) are
          full-screen pan-and-pinch surfaces, which `docs/mobile-sheets-vs-routes.md`
          rule 3 keeps off a sheet's own drag. Flag-gated inside the screen — the
          route existing is not the same as the feature being reachable. */}
      <Stack.Screen name="spray/new" options={{ title: tBoards('sprayWizard.screenTitle') }} />
      {/* Resetting a wall — a new photograph of a wall that already carries
          climbs. Same route-not-sheet reasoning as the flow above: the corner
          markers and the compare view are both full-screen pan-and-pinch
          surfaces.

          NOTHING IN THE APP PUSHES THIS ROUTE YET, and that is deliberate rather
          than missing. The "New photo" row belongs to the wall's own page, which
          lives on a DIFFERENT stack (SW-11's `BoardDetailSheet` rows, still dark
          behind `SPRAY_DETAIL_ROWS_ENABLED = false`), and #5491 (SW-11b) wires
          the row to this route once both stacks have merged. A second entry point
          here would be a duplicate the moment that lands — and a worse one, since
          the wall uuid is on the detail sheet and not on this stack. Until then
          the route is exercised by its tests and reachable by deep link. */}
      <Stack.Screen name="spray/reset" options={{ title: tBoards('sprayReset.screenTitle') }} />
    </Stack>
  );
}
